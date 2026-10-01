#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync, spawnSync } from "child_process";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";
import {
  normalizeUpdaterSignature,
  verifyUpdaterSignatures,
} from "./updater-signature-verifier.js";
import { verifyReleaseSession } from "./release-session.js";
import githubCli from "./github-cli.cjs";
import { assertStableReleaseOverridesAllowed } from "./release-policy.cjs";
import draftMetadata from "./release-draft-metadata.cjs";

const { assertGitHubCliAuthenticated, githubApi, uploadReleaseAsset } =
  githubCli;
const {
  assertExpectedRelease,
  assertNoMisnamedVersionDrafts,
  isExpectedRelease,
} = draftMetadata;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const releaseDir = path.join(root, "release");
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf-8"),
);

const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const NUMERIC_VERSION = "(?:0|[1-9]\\d*)";
const BETA_VERSION = new RegExp(
  `^${NUMERIC_VERSION}\\.${NUMERIC_VERSION}\\.${NUMERIC_VERSION}-beta\\.${NUMERIC_VERSION}$`,
);
const STABLE_VERSION = new RegExp(
  `^${NUMERIC_VERSION}\\.${NUMERIC_VERSION}\\.${NUMERIC_VERSION}$`,
);
if (!BETA_VERSION.test(VERSION) && !STABLE_VERSION.test(VERSION)) {
  throw new Error(
    `Unsupported release version '${VERSION}'; ROSI releases use beta or stable only.`,
  );
}
const IS_PRERELEASE = BETA_VERSION.test(VERSION);
const EXPECTED_TAG = (process.env.EXPECTED_TAG || "").trim();

const GPG_KEY_ID = process.env.GPG_KEY_ID;
const GPG_PASSPHRASE = process.env.GPG_PASSPHRASE;
const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "ROSI";
const TAG_DOWNLOAD_BASE_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${encodeURIComponent(TAG)}`;
const RELEASE_DOWNLOAD_BASE_URL = (
  process.env.RELEASE_DOWNLOAD_BASE_URL || TAG_DOWNLOAD_BASE_URL
).replace(/\/+$/, "");
const RELEASE_NOTES = process.env.RELEASE_NOTES || "";
const RELEASE_PUB_DATE =
  process.env.RELEASE_PUB_DATE || new Date().toISOString();
function isExplicitTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function currentReleaseCommit() {
  const commit = execSync("git rev-parse HEAD", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("Could not resolve an exact release commit from git HEAD.");
  }
  return commit;
}

function assertReleaseTargetsCommit(
  release,
  commit,
  env = process.env,
  log = console,
) {
  if (release?.target_commitish === commit) return release;
  if (isExplicitTruthy(env.FORCE_UPLOAD)) {
    log.warn(
      `WARNING: Draft release ${TAG} targets ${release?.target_commitish || "an unknown commit"}, not checked-out commit ${commit}. FORCE_UPLOAD=1 bypassing commit check.`,
    );
    return release;
  }
  throw new Error(
    `Draft release ${TAG} targets ${release?.target_commitish || "an unknown commit"}, not checked-out commit ${commit}. Delete or retarget stale draft before uploading assets. Or set FORCE_UPLOAD=1 to bypass.`,
  );
}

const ALLOW_ASSET_REPLACE = isExplicitTruthy(process.env.ALLOW_ASSET_REPLACE);
const REQUIRED_LINUX_TARGETS = (
  process.env.REQUIRED_LINUX_TARGETS || ""
).trim();
const REQUIRE_LINUX_AARCH64 = isExplicitTruthy(
  process.env.REQUIRE_LINUX_AARCH64,
);
const REQUIRED_UPDATER_TARGETS = (
  process.env.REQUIRED_UPDATER_TARGETS || ""
).trim();
const ENFORCE_LINUX_X64_PACKAGE_SET = !/^(0|false|no|off)$/i.test(
  String(process.env.ENFORCE_LINUX_X64_PACKAGE_SET || "").trim(),
);

const ext = (e) => (n) => n.toLowerCase().endsWith(e);
const rx = (r) => (n) => r.test(n);
const exact = (f) => (n) => n === f;
const isPerTargetManifest = rx(/^latest-[a-z0-9_-]+\.json$/i);
const isChecksumTextName = rx(
  // Target keys include prerelease names such as darwin-beta-aarch64.
  /^SHA256SUMS(?:-[a-z0-9_-]+)?\.txt$/i,
);

const ARTIFACT_RULES = [
  rx(/-setup\.exe$/i),
  rx(/^ROSI-Windows-(?:x64|arm64)\.exe$/i),
  ext(".msi"),
  ext(".dmg"),
  ext(".deb"),
  ext(".rpm"),
  ext(".flatpak"),
  rx(/\.appimage$/i),

  rx(/^ROSI(?:-MacOS-universal)?\.zip$/i),

  rx(/\.nsis\.zip$/i),
  rx(/\.app\.tar\.gz$/i),
  rx(/\.appimage\.tar\.gz$/i),

  rx(/\.(?:exe|msi|dmg|deb|rpm|flatpak|appimage)\.sig$/i),
  rx(/^ROSI(?:-MacOS-universal)?\.zip\.sig$/i),
  rx(/\.nsis\.zip\.sig$/i),
  rx(/\.tar\.gz\.sig$/i),

  exact("latest.json"),
  isPerTargetManifest,
];

const SIGN_RULES = [
  ext(".exe"),
  ext(".msi"),
  ext(".dmg"),
  ext(".deb"),
  ext(".rpm"),
  ext(".flatpak"),
  rx(/\.appimage$/i),
  rx(/^ROSI(?:-MacOS-universal)?\.zip$/i),
  rx(/\.nsis\.zip$/i),
  rx(/\.app\.tar\.gz$/i),
  rx(/\.appimage\.tar\.gz$/i),
];

// hdiutil leaves a read-write `rw.<pid>.<name>.dmg` scratch image behind when a
// DMG bundling attempt fails. It must never be collected or signed.
const isBundlerScratchFile = rx(/^rw\.\d+\./i);
const isArtifact = (name) =>
  !isBundlerScratchFile(name) && ARTIFACT_RULES.some((r) => r(name));
const isSignable = (name) => SIGN_RULES.some((r) => r(name));

function releaseArtifactSearchDirs() {
  const targetRoot = path.join(root, "src-tauri", "target");
  const dirs = [
    path.join(targetRoot, "release", "bundle"),
    path.join(root, "dist"),
  ];
  try {
    for (const entry of fs.readdirSync(targetRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      dirs.push(path.join(targetRoot, entry.name, "release", "bundle"));
    }
  } catch {}
  return dirs;
}

// Search only canonical release bundle roots. Recursing all of target/ can pick
// up stale debug outputs, fixtures, or unrelated zip files with misleading names.
const SEARCH_DIRS = releaseArtifactSearchDirs();

function artifactMatchesVersion(name, releaseVersion = VERSION) {
  if (name === "latest.json" || isPerTargetManifest(name)) return true;
  if (/\.rpm(?:\.sig)?$/i.test(name)) {
    return rpmArtifactMatchesVersion(name, releaseVersion);
  }
  const versions = name.match(
    /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/g,
  );
  if (!versions || versions.length === 0) return true;
  return versions.some((candidate) => candidate === releaseVersion);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rpmArtifactMatchesVersion(name, releaseVersion = VERSION) {
  if (!/\.rpm(?:\.sig)?$/i.test(name)) return false;

  const numericVersions = name.match(/\d+\.\d+\.\d+/g);
  if (!numericVersions || numericVersions.length === 0) return true;

  const betaMatch = releaseVersion.match(
    /^(\d+\.\d+\.\d+)-beta\.(0|[1-9]\d*)$/,
  );
  const stableMatch = releaseVersion.match(/^(\d+\.\d+\.\d+)$/);
  if (!betaMatch && !stableMatch) return false;

  const numericVersion = betaMatch?.[1] ?? stableMatch[1];
  const escapedNumericVersion = escapeRegExp(numericVersion);
  const versionPattern = betaMatch
    ? `${escapedNumericVersion}(?:-beta\\.${betaMatch[2]}|[._~]beta[._-]${betaMatch[2]})`
    : escapedNumericVersion;
  // RPM names conventionally end in NAME-VERSION-RELEASE.ARCH.rpm. Tauri and
  // distro tooling vary the release and architecture tokens, and updater
  // signatures append another .sig. A release must begin with a digit, which
  // keeps a sanitized beta marker from matching a stable application version.
  const rpmRelease = "[0-9][0-9A-Za-z_+~%^.-]*";
  const rpmArch =
    "(?:x86_64|amd64|aarch64|arm64|i[3-6]86|noarch|ppc64le|ppc64|s390x|riscv64|armv[67]hl)";
  return new RegExp(
    `(?:^|[^0-9A-Za-z])${versionPattern}(?:-${rpmRelease})?(?:\\.${rpmArch})?\\.rpm(?:\\.sig)?$`,
    "i",
  ).test(name);
}

const SIDECAR_MANIFEST = path.join(
  root,
  "src-tauri",
  "binaries",
  ".sidecar-manifest.json",
);

/** Release bundles must never contain the development FFmpeg stubs. */
function assertNoStubSidecars(manifestPath = SIDECAR_MANIFEST) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Prepared sidecar manifest is missing or invalid (${manifestPath}). Run npm run prepare:sidecars before building: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const stubs = Object.entries(manifest)
    .filter(([, entry]) => entry?.stub === true)
    .map(([name]) => name);
  if (stubs.length > 0) {
    throw new Error(
      `Refusing to sign a release built with development sidecar stubs: ${stubs.join(", ")}. Fetch FFmpeg (npm run get:ffmpeg) and rebuild.`,
    );
  }
}

function readBuildSession() {
  try {
    return verifyReleaseSession(root);
  } catch (error) {
    throw new Error(
      `Release build session is missing or invalid. Run npm run release:prepare before building: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function wasBuiltInSession(filePath, session) {
  try {
    // Permit coarse filesystem timestamp resolution without accepting an old build.
    return fs.statSync(filePath).mtimeMs >= session.startedAt - 2000;
  } catch {
    return false;
  }
}

function clearReleaseStaging() {
  if (!fs.existsSync(releaseDir)) return;
  for (const name of fs.readdirSync(releaseDir)) {
    const fullPath = path.join(releaseDir, name);
    let isFile = false;
    try {
      isFile = fs.statSync(fullPath).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    if (isArtifact(name) || name.endsWith(".asc") || isChecksumTextName(name)) {
      fs.rmSync(fullPath, { force: true });
    }
  }
}

function clearPreStagedUpdaterManifests() {
  if (!fs.existsSync(releaseDir)) return;
  const removed = [];
  for (const name of fs.readdirSync(releaseDir)) {
    // `latest.json` matches artifact rules but no endpoint reads it; treat it
    // like the discovery path, which deletes it outright.
    if (!isPerTargetManifest(name) && name !== "latest.json") continue;
    const fullPath = path.join(releaseDir, name);
    let isFile = false;
    try {
      isFile = fs.statSync(fullPath).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    fs.rmSync(fullPath, { force: true });
    removed.push(name);
  }
  if (removed.length > 0) {
    console.log(
      `  ~ Removed ${removed.length} stale updater manifest(s) from release/`,
    );
  }
}

function pickNewestByBasename(paths) {
  const latest = new Map();
  for (const filePath of paths) {
    const name = path.basename(filePath);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    const current = latest.get(name);
    if (!current || stat.mtimeMs > current.mtimeMs) {
      latest.set(name, { filePath, mtimeMs: stat.mtimeMs });
    }
  }
  return Array.from(latest.values()).map((entry) => entry.filePath);
}

function walk(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, results);
    } else if (entry.isFile() && isArtifact(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function cleanArtifactBaseName(name) {
  if (/\.tar\.gz$/i.test(name)) return name;
  if (/\.nsis\.zip$/i.test(name)) return name;

  if (/\.dmg$/i.test(name)) return "ROSI-MacOS-universal.dmg";
  if (/^ROSI\.zip$/i.test(name)) return "ROSI-MacOS-universal.zip";

  if (/x64-setup\.exe$/i.test(name)) return "ROSI-Windows-x64.exe";
  if (/arm64-setup\.exe$/i.test(name)) return "ROSI-Windows-arm64.exe";

  if (/amd64\.AppImage$/i.test(name)) return "ROSI-Linux-x64.AppImage";
  if (/aarch64\.AppImage$/i.test(name)) return "ROSI-Linux-arm64.AppImage";

  if (/amd64\.deb$/i.test(name)) return "ROSI-Linux-x64.deb";
  if (/aarch64\.deb$/i.test(name)) return "ROSI-Linux-arm64.deb";

  if (/x86_64\.rpm$/i.test(name)) return "ROSI-Linux-x64.rpm";
  if (/aarch64\.rpm$/i.test(name)) return "ROSI-Linux-arm64.rpm";

  // The public Flatpak release currently targets Linux x64 only. Normalize
  // generic files left by older build scripts to the documented asset name.
  if (/^ROSI-Linux\.flatpak$/i.test(name)) return "ROSI-Linux-x64.flatpak";

  return name;
}

function cleanArtifactName(name) {
  if (name === "latest.json") return name;
  if (name.endsWith(".sig")) {
    const base = name.slice(0, -4);
    return `${cleanArtifactBaseName(base)}.sig`;
  }
  return cleanArtifactBaseName(name);
}

const FALLBACK_INSTALLER_PRIORITY = {
  windows: { nsis: 3, msi: 2 },
  linux: { appimage: 3, deb: 2, rpm: 1 },
  darwin: { app: 3 },
};

function inferArchFromName(name) {
  if (/(?:^|[-_.])(aarch64|arm64)(?:[-_.]|$)/i.test(name)) return "aarch64";
  if (/(?:^|[-_.])(x86_64|amd64|x64)(?:[-_.]|$)/i.test(name)) return "x86_64";
  if (/(?:^|[-_.])(i686|x86)(?:[-_.]|$)/i.test(name)) return "i686";
  return null;
}

function normalizeArchToken(token) {
  const normalized = token.toLowerCase();
  if (normalized === "aarch64" || normalized === "arm64") return "aarch64";
  if (normalized === "x86_64" || normalized === "amd64" || normalized === "x64")
    return "x86_64";
  if (normalized === "i686" || normalized === "x86") return "i686";
  return null;
}

function requiredLinuxTargetKeys(channelVariants, byName) {
  const tokens = REQUIRED_LINUX_TARGETS.split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (REQUIRE_LINUX_AARCH64) tokens.push("aarch64");
  // Platform release commands sign independently. Automatically require an
  // AppImage updater for each Linux architecture represented in this signing
  // session, while allowing Windows/macOS-only sessions to proceed. Operators
  // can still demand additional architectures through the environment.
  for (const [name] of byName) {
    if (name.endsWith(".sig")) continue;
    for (const target of resolveUpdaterTargets(name)) {
      if (target.os === "linux") tokens.push(target.arch);
    }
  }
  const targetKeys = new Set();
  for (const token of tokens) {
    const explicitMatch = token
      .toLowerCase()
      .match(/^(linux(?:-beta)?)-([a-z0-9_]+)$/);
    if (explicitMatch) {
      const targetName = explicitMatch[1];
      const arch = normalizeArchToken(explicitMatch[2]);
      if (!arch) {
        throw new Error(`Invalid REQUIRED_LINUX_TARGETS entry "${token}".`);
      }
      targetKeys.add(`${targetName}-${arch}`);
      continue;
    }
    const arch = normalizeArchToken(token);
    if (!arch) {
      throw new Error(`Invalid REQUIRED_LINUX_TARGETS entry "${token}".`);
    }
    for (const channel of channelVariants) {
      targetKeys.add(`linux${channel.targetSuffix}-${arch}`);
    }
  }
  return targetKeys;
}

function canPopulateFallbackTarget(_target) {
  return true;
}

function assertLinuxX64PackageSet(byName) {
  if (!ENFORCE_LINUX_X64_PACKAGE_SET) return;
  const installers = new Set();
  for (const [name] of byName) {
    if (name.endsWith(".sig")) continue;
    const targets = resolveUpdaterTargets(name);
    for (const target of targets) {
      if (target.os === "linux" && target.arch === "x86_64") {
        installers.add(target.installer);
      }
    }
  }
  if (installers.size === 0) return;
  const requiredInstallers = ["appimage", "deb", "rpm"];
  const missing = requiredInstallers.filter((i) => !installers.has(i));
  if (missing.length > 0) {
    throw new Error(
      `Incomplete Linux x86_64 bundle set: missing ${missing.join(", ")} artifact(s).`,
    );
  }
}

function resolveUpdaterTargets(name) {
  const targets = [];
  if (/\.app\.tar\.gz$/i.test(name)) {
    const arch = inferArchFromName(name);
    const arches = arch ? [arch] : ["x86_64", "aarch64"];
    for (const a of arches) {
      targets.push({ os: "darwin", arch: a, installer: "app" });
    }
    return targets;
  }

  if (/\.exe$/i.test(name)) {
    const arch = inferArchFromName(name);
    if (!arch) return targets;
    targets.push({ os: "windows", arch, installer: "nsis" });
    return targets;
  }

  if (/\.msi$/i.test(name)) {
    const arch = inferArchFromName(name);
    if (!arch) return targets;
    targets.push({ os: "windows", arch, installer: "msi" });
    return targets;
  }

  if (/\.appimage$/i.test(name)) {
    const arch = inferArchFromName(name);
    if (!arch) return targets;
    targets.push({ os: "linux", arch, installer: "appimage" });
    return targets;
  }

  if (/\.deb$/i.test(name)) {
    const arch = inferArchFromName(name);
    if (!arch) return targets;
    targets.push({ os: "linux", arch, installer: "deb" });
    return targets;
  }

  if (/\.rpm$/i.test(name)) {
    const arch = inferArchFromName(name);
    if (!arch) return targets;
    targets.push({ os: "linux", arch, installer: "rpm" });
    return targets;
  }

  return targets;
}

function releaseAssetUrl(fileName, baseUrl = RELEASE_DOWNLOAD_BASE_URL) {
  return `${baseUrl}/${encodeURIComponent(fileName)}`;
}

function updaterChannelVariants(
  _isPrerelease,
  releaseBaseUrl = RELEASE_DOWNLOAD_BASE_URL,
  tagBaseUrl = TAG_DOWNLOAD_BASE_URL,
) {
  // Stable releases also publish beta-target endpoints. Beta clients use
  // those endpoints and must be able to move from the final beta to stable.
  return [
    { targetSuffix: "", baseUrl: releaseBaseUrl },
    { targetSuffix: "-beta", baseUrl: tagBaseUrl },
  ];
}

function generateUpdaterManifests(files) {
  const byName = new Map();
  for (const filePath of files) {
    byName.set(path.basename(filePath), filePath);
  }
  assertLinuxX64PackageSet(byName);

  const signatureByBaseName = new Map();
  for (const [name, filePath] of byName) {
    if (name.endsWith(".sig")) {
      signatureByBaseName.set(name.slice(0, -4), filePath);
    }
  }
  verifyUpdaterSignatures({
    root,
    releaseDir,
    byName,
    signatureByBaseName,
    resolveUpdaterTargets,
  });

  const manifests = new Map();
  const requiredTargetKeys = new Set();
  const channelVariants = updaterChannelVariants(IS_PRERELEASE);
  const expectedLinuxTargetKeys = requiredLinuxTargetKeys(
    channelVariants,
    byName,
  );
  const generatedLinuxAppImageTargets = new Set();
  const missingSignatures = [];

  for (const [name] of byName) {
    if (name.endsWith(".sig")) continue;
    const targets = resolveUpdaterTargets(name);
    if (targets.length === 0) continue;
    for (const target of targets) {
      for (const channel of channelVariants) {
        requiredTargetKeys.add(
          `${target.os}${channel.targetSuffix}-${target.arch}`,
        );
      }
    }

    const sigPath = signatureByBaseName.get(name);
    if (!sigPath) {
      missingSignatures.push(`${name}.sig`);
      continue;
    }

    const signature = normalizeUpdaterSignature(sigPath);
    for (const target of targets) {
      for (const channel of channelVariants) {
        const targetName = `${target.os}${channel.targetSuffix}`;
        const manifestName = `latest-${targetName}-${target.arch}.json`;
        if (!manifests.has(manifestName)) {
          manifests.set(manifestName, {
            version: VERSION,
            notes: RELEASE_NOTES,
            pub_date: RELEASE_PUB_DATE,
            platforms: {},
            fallbackPriority: -1,
          });
        }

        const manifest = manifests.get(manifestName);
        const url = releaseAssetUrl(name, channel.baseUrl);
        const installerKey = `${targetName}-${target.arch}-${target.installer}`;
        const fallbackKey = `${targetName}-${target.arch}`;
        manifest.platforms[installerKey] = { url, signature };
        if (channel.targetSuffix) {
          // A beta check uses the full installer-aware key as its custom Tauri
          // target. Give that key its own endpoint manifest so DEB/RPM installs
          // never fall through to the AppImage fallback (and vice versa).
          const installerManifestName = `latest-${installerKey}.json`;
          manifests.set(installerManifestName, {
            version: VERSION,
            notes: RELEASE_NOTES,
            pub_date: RELEASE_PUB_DATE,
            platforms: { [installerKey]: { url, signature } },
            fallbackPriority: -1,
          });
        }
        if (target.os === "linux" && target.installer === "appimage") {
          generatedLinuxAppImageTargets.add(fallbackKey);
        }

        const priority =
          FALLBACK_INSTALLER_PRIORITY[target.os]?.[target.installer] ?? 0;
        if (
          priority > 0 &&
          canPopulateFallbackTarget(target) &&
          (!manifest.platforms[fallbackKey] ||
            priority > manifest.fallbackPriority)
        ) {
          manifest.platforms[fallbackKey] = { url, signature };
          manifest.fallbackPriority = priority;
        }

        if (
          channel.targetSuffix &&
          priority > 0 &&
          canPopulateFallbackTarget(target) &&
          (!manifest.platforms[targetName] ||
            priority > (manifest._bareKeyPriority ?? -1))
        ) {
          manifest.platforms[targetName] = { url, signature };
          manifest._bareKeyPriority = priority;
        }
      }
    }
  }

  if (missingSignatures.length > 0) {
    throw new Error(
      `Missing updater signature file(s): ${Array.from(
        new Set(missingSignatures),
      )
        .sort()
        .join(", ")}.`,
    );
  }

  const generated = [];
  const generatedTargetKeys = new Set();
  for (const manifestName of Array.from(manifests.keys()).sort()) {
    const manifest = manifests.get(manifestName);
    const output = {
      version: manifest.version,
      pub_date: manifest.pub_date,
      platforms: manifest.platforms,
    };
    if (manifest.notes) {
      output.notes = manifest.notes;
    }
    const dest = path.join(releaseDir, manifestName);
    fs.writeFileSync(dest, JSON.stringify(output, null, 2) + "\n");
    console.log(
      `  + ${manifestName} (${Object.keys(output.platforms).length} platform entries)`,
    );
    generated.push(dest);
    const targetKey = parseManifestTargetKey(manifestName);
    if (targetKey) generatedTargetKeys.add(targetKey);
  }

  const missingTargets = Array.from(requiredTargetKeys)
    .filter((k) => !generatedTargetKeys.has(k))
    .sort();
  if (missingTargets.length > 0) {
    throw new Error(
      `Updater manifest generation incomplete: ${missingTargets.join(", ")}.`,
    );
  }

  const missingLinuxTargets = Array.from(expectedLinuxTargetKeys)
    .filter((k) => !generatedLinuxAppImageTargets.has(k))
    .sort();
  if (missingLinuxTargets.length > 0) {
    throw new Error(
      `Missing required Linux AppImage updater target(s): ${missingLinuxTargets.join(", ")}.`,
    );
  }

  const validation = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "validate-updater-manifest.js"), ...generated],
    { cwd: root, encoding: "utf8" },
  );
  if (validation.error) throw validation.error;
  if (validation.status !== 0) {
    throw new Error(
      `Generated updater manifest validation failed: ${validation.stderr || validation.stdout}`,
    );
  }

  return generated;
}

function parseManifestTargetKey(name) {
  const m = name.match(/^latest-([a-z0-9_-]+)\.json$/i);
  if (!m) return null;
  return m[1].toLowerCase();
}

function checksumTargetKeysForArtifactName(
  name,
  channelVariants = updaterChannelVariants(IS_PRERELEASE),
) {
  const manifestKey = parseManifestTargetKey(name);
  if (manifestKey) return [manifestKey];

  const baseName = name.endsWith(".sig") ? name.slice(0, -4) : name;
  return Array.from(
    new Set(
      resolveUpdaterTargets(baseName).flatMap((target) =>
        channelVariants.map(
          (channel) => `${target.os}${channel.targetSuffix}-${target.arch}`,
        ),
      ),
    ),
  );
}

function normalizePreStagedArtifacts(staged) {
  const selected = new Map();
  for (const filePath of staged) {
    const originalName = path.basename(filePath);
    const cleanName = cleanArtifactName(originalName);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    const current = selected.get(cleanName);
    if (!current || stat.mtimeMs > current.mtimeMs) {
      selected.set(cleanName, {
        filePath,
        mtimeMs: stat.mtimeMs,
        originalName,
      });
    }
  }
  const canonicalPaths = new Set();
  for (const [cleanName, entry] of selected) {
    const dest = path.join(releaseDir, cleanName);
    canonicalPaths.add(path.resolve(dest));
    if (path.resolve(entry.filePath) !== path.resolve(dest)) {
      fs.copyFileSync(entry.filePath, dest);
      console.log(`  + ${entry.originalName} → ${cleanName}`);
    }
  }
  for (const filePath of staged) {
    if (!canonicalPaths.has(path.resolve(filePath))) {
      fs.rmSync(filePath, { force: true });
    }
  }
  return Array.from(selected.keys())
    .sort()
    .map((name) => path.join(releaseDir, name));
}

function collectArtifacts() {
  fs.mkdirSync(releaseDir, { recursive: true });
  const buildSession = readBuildSession();

  const discovered = SEARCH_DIRS.flatMap((d) => walk(d));
  const found = discovered.filter(
    (filePath) =>
      artifactMatchesVersion(path.basename(filePath)) &&
      wasBuiltInSession(filePath, buildSession),
  );
  if (found.length > 0) {
    clearReleaseStaging();
    if (found.length < discovered.length) {
      console.log(
        `  ~ Skipped ${discovered.length - found.length} artifact(s) not matching ${VERSION}`,
      );
    }

    const selected = pickNewestByBasename(found);
    const collected = [];
    for (const src of selected) {
      const originalName = path.basename(src);
      const cleanName = cleanArtifactName(originalName);
      const dest = path.join(releaseDir, cleanName);
      fs.copyFileSync(src, dest);
      if (cleanName !== originalName) {
        console.log(`  + ${originalName} → ${cleanName}`);
      } else {
        console.log(`  + ${originalName}`);
      }
      collected.push(dest);
    }
    const manifests = generateUpdaterManifests(collected);
    return [...collected, ...manifests];
  }

  clearPreStagedUpdaterManifests();
  const staged = fs
    .readdirSync(releaseDir)
    .filter(
      (n) =>
        isArtifact(n) &&
        artifactMatchesVersion(n) &&
        !isPerTargetManifest(n) &&
        !n.endsWith(".asc") &&
        !isChecksumTextName(n),
    )
    .map((n) => path.join(releaseDir, n));

  const currentStaged = staged.filter((filePath) =>
    wasBuiltInSession(filePath, buildSession),
  );

  if (currentStaged.length === 0) {
    console.error(
      "No build artifacts found in:",
      [...SEARCH_DIRS, releaseDir].join(", "),
    );
    process.exit(1);
  }

  console.log(
    `  Found ${currentStaged.length} current pre-staged artifact(s) in release/`,
  );
  const normalizedStaged = normalizePreStagedArtifacts(currentStaged);
  const manifests = generateUpdaterManifests(normalizedStaged);
  return Array.from(new Set([...normalizedStaged, ...manifests]));
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function generateChecksums(files) {
  const candidates = files.filter((f) => {
    const name = path.basename(f);
    return !name.endsWith(".asc") && !isChecksumTextName(name);
  });
  const channelVariants = updaterChannelVariants(IS_PRERELEASE);

  const manifestTargetKeys = Array.from(
    new Set(
      candidates
        .map((f) => parseManifestTargetKey(path.basename(f)))
        .filter(Boolean),
    ),
  );

  const buckets = new Map();
  const addToBucket = (targetKey, filePath) => {
    if (!buckets.has(targetKey)) {
      buckets.set(targetKey, []);
    }
    buckets.get(targetKey).push(filePath);
  };

  for (const filePath of candidates) {
    const name = path.basename(filePath);
    let targetKeys = checksumTargetKeysForArtifactName(name, channelVariants);
    if (targetKeys.length === 0 && manifestTargetKeys.length > 0) {
      targetKeys = manifestTargetKeys;
    }
    if (targetKeys.length === 0) {
      targetKeys = ["generic"];
    }
    for (const targetKey of targetKeys) {
      addToBucket(targetKey, filePath);
    }
  }

  const outputs = [];
  for (const targetKey of Array.from(buckets.keys()).sort()) {
    const uniqueFiles = Array.from(new Set(buckets.get(targetKey)));
    const entries = uniqueFiles
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
      .map((f) => `${sha256(f)}  ${path.basename(f)}`);
    const fileName = `SHA256SUMS-${targetKey}.txt`;
    const out = path.join(releaseDir, fileName);
    fs.writeFileSync(out, entries.join("\n") + "\n");
    console.log(`  + ${fileName} (${entries.length} entries)`);
    outputs.push(out);
  }
  return outputs;
}

function signFile(filePath) {
  const asc = `${filePath}.asc`;
  const args = ["--batch", "--yes", "--armor", "--detach-sign"];
  if (GPG_KEY_ID) {
    args.push("--local-user", GPG_KEY_ID);
  }
  const usePassphraseStdin = Boolean(GPG_PASSPHRASE);
  if (usePassphraseStdin) {
    args.push("--pinentry-mode", "loopback", "--passphrase-fd", "0");
  }
  args.push("--output", asc, filePath);

  const result = spawnSync("gpg", args, {
    stdio: "pipe",
    input: usePassphraseStdin ? `${GPG_PASSPHRASE}\n` : undefined,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `GPG signing failed: ${result.stderr?.toString() || "unknown error"}`,
    );
  }
  return asc;
}

function signArtifacts(files) {
  const ascFiles = [];
  for (const f of files) {
    if (isSignable(path.basename(f))) {
      ascFiles.push(signFile(f));
      console.log(`  + ${path.basename(f)}.asc`);
    }
  }
  return ascFiles;
}

function ghRequest(method, endpoint, body) {
  return Promise.resolve(githubApi(method, endpoint, body));
}

// gh reports "HTTP 422"; statusCode is parsed by github-cli.cjs.
function isGitHubConflict(error) {
  if (error?.statusCode === 422) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\((?:HTTP )?422\)|"status"\s*:\s*"?422"?/.test(message);
}

/**
 * Walk GitHub list endpoints page-by-page until an empty page or a short page.
 * `fetchPage(page, perPage)` should return the parsed JSON body for that page.
 */
async function listAllGithubPages(fetchPage, { perPage = 100 } = {}) {
  const pageSize = Math.max(1, Number(perPage) || 100);
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchPage(page, pageSize);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < pageSize) break;
  }
  return items;
}

async function getOrCreateRelease() {
  const commit = currentReleaseCommit();
  const findExisting = async () => {
    try {
      return await ghRequest(
        "GET",
        `/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${TAG}`,
      );
    } catch (error) {
      if (error?.statusCode !== 404) throw error;
    }

    const releases = await listAllGithubPages((page, perPage) =>
      ghRequest(
        "GET",
        `/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=${perPage}&page=${page}`,
      ),
    );
    assertNoMisnamedVersionDrafts(releases, TAG, VERSION);
    // Duplicate drafts are a known GitHub failure; match ensure-draft-release.
    const drafts = releases.filter(
      (release) => release?.draft && isExpectedRelease(release, TAG, VERSION),
    );
    if (drafts.length > 1) {
      throw new Error(
        `Multiple draft releases exist for ${TAG}. Resolve duplicates before signing.`,
      );
    }
    return drafts[0] || null;
  };

  const existing = await findExisting();
  if (existing) {
    return assertReleaseTargetsCommit(
      assertExpectedRelease(existing, TAG, VERSION, "Signing release"),
      commit,
    );
  }

  throw new Error(
    `No GitHub release exists for ${TAG}. Create the draft with npm run release:draft on Windows first; Mac/Linux wait for that draft.`,
  );
}

async function uploadAssetOnce(uploadUrl, filePath) {
  const uploaded = uploadReleaseAsset(uploadUrl, filePath);
  if (!uploaded || typeof uploaded.id !== "number") {
    throw new Error(
      `Upload ${path.basename(filePath)} succeeded but GitHub returned no asset id.`,
    );
  }
  return uploaded;
}

async function uploadAsset(uploadUrl, filePath) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await uploadAssetOnce(uploadUrl, filePath);
    } catch (error) {
      lastError = error;
      if (isGitHubConflict(error) || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

async function listReleaseAssets(releaseId) {
  return listAllGithubPages((page, perPage) =>
    ghRequest(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${releaseId}/assets?per_page=${perPage}&page=${page}`,
    ),
  );
}

async function downloadUrlToFile(url, destination) {
  const headers = {
    Accept: "application/octet-stream",
    "User-Agent": "ROSI-Release",
  };
  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download ${url} failed with HTTP ${response.status}.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, bytes);
}

async function replaceReleaseAssetsTransactionally(
  release,
  files,
  { assertStillHeld = null } = {},
) {
  if (files.length === 0) return;
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosi-release-replace-"),
  );
  const token = crypto.randomBytes(8).toString("hex");
  const staged = [];
  const swapped = [];
  try {
    const assets = await listReleaseAssets(release.id);
    for (const filePath of files) {
      const name = path.basename(filePath);
      const existing = assets.find((asset) => asset?.name === name);
      // GitHub strips leading/trailing periods from asset names, so keep
      // staging/backup names alphanumeric (see upload-a-release-asset docs).
      const stagedName = `rosi-pending-${token}-${name}`;
      const stagedPath = path.join(temporaryDirectory, stagedName);
      fs.copyFileSync(filePath, stagedPath);
      const uploaded = await uploadAsset(release.upload_url, stagedPath);
      if (!uploaded || typeof uploaded.id !== "number") {
        throw new Error(`GitHub did not identify staged asset ${stagedName}.`);
      }
      staged.push({
        name,
        existing: existing && typeof existing.id === "number" ? existing : null,
        uploaded,
        backupName: `rosi-previous-${token}-${name}`,
        previousRenamed: false,
      });
    }

    // Re-check fence ownership after the (possibly long) staging uploads and
    // immediately before live-name renames.
    if (typeof assertStillHeld === "function") {
      await assertStillHeld();
    }

    // Upload every replacement before touching a live name. GitHub has no
    // atomic asset swap, so two adjacent rename requests create the narrowest
    // possible gap; the previous implementation deleted before a full upload.
    for (const item of staged) {
      if (item.existing) {
        await ghRequest(
          "PATCH",
          `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.existing.id}`,
          { name: item.backupName },
        );
        item.previousRenamed = true;
      }
      try {
        await ghRequest(
          "PATCH",
          `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.uploaded.id}`,
          { name: item.name },
        );
      } catch (error) {
        if (item.existing) {
          await ghRequest(
            "PATCH",
            `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.existing.id}`,
            { name: item.name },
          );
          item.previousRenamed = false;
        }
        throw error;
      }
      swapped.push(item);
    }

    // All live names now point at the verified new set. Old renamed assets are
    // cleanup-only; failure leaves a harmless hidden backup rather than undoing
    // an already complete feed swap.
    for (const item of staged) {
      if (!item.existing) continue;
      try {
        await ghRequest(
          "DELETE",
          `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.existing.id}`,
        );
      } catch (error) {
        console.warn(
          `  ! could not remove previous feed asset ${item.backupName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of swapped.reverse()) {
      try {
        if (item.existing) {
          await ghRequest(
            "PATCH",
            `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.uploaded.id}`,
            { name: `rosi-rollback-${token}-${item.name}` },
          );
          try {
            await ghRequest(
              "PATCH",
              `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.existing.id}`,
              { name: item.name },
            );
          } catch (restoreError) {
            await ghRequest(
              "PATCH",
              `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.uploaded.id}`,
              { name: item.name },
            );
            throw restoreError;
          }
          item.previousRenamed = false;
        }
        await ghRequest(
          "DELETE",
          `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.uploaded.id}`,
        );
      } catch (rollbackError) {
        rollbackErrors.push(
          `${item.name}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    const swappedIds = new Set(swapped.map((item) => item.uploaded.id));
    for (const item of staged) {
      if (swappedIds.has(item.uploaded.id)) continue;
      try {
        if (item.existing && item.previousRenamed) {
          await ghRequest(
            "PATCH",
            `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.existing.id}`,
            { name: item.name },
          );
          item.previousRenamed = false;
        }
        await ghRequest(
          "DELETE",
          `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${item.uploaded.id}`,
        );
      } catch (cleanupError) {
        rollbackErrors.push(
          `${item.name} staged cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${
        rollbackErrors.length
          ? `; live-feed rollback failed: ${rollbackErrors.join("; ")}`
          : ""
      }`,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const BETA_SYNC_LOCK_NAME = "rosi-beta-manifest-sync-lock";
const BETA_SYNC_LOCK_RETRIES = 30;

function isTransactionalStagingAssetName(name) {
  return /^(?:default\.)?rosi-(?:pending|previous|rollback)-/i.test(name);
}

async function removeAssetBestEffort(asset, label) {
  if (!asset || typeof asset.id !== "number") return;
  try {
    await ghRequest(
      "DELETE",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${asset.id}`,
    );
  } catch (error) {
    console.warn(
      `  ! could not remove ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function findBetaManifestSyncLock(releaseId) {
  const assets = await listReleaseAssets(releaseId);
  return assets.find((asset) => asset?.name === BETA_SYNC_LOCK_NAME) ?? null;
}

/** Fail closed if another operator or process deleted our lock asset. */
async function assertOwnsBetaManifestSyncLock(release, acquired) {
  if (!acquired || typeof acquired.id !== "number") {
    throw new Error("Beta-manifest synchronization lock was not acquired.");
  }
  const current = await findBetaManifestSyncLock(release.id);
  if (!current || current.id !== acquired.id) {
    throw new Error(
      "Lost the beta-manifest synchronization lock before mutating live feeds.",
    );
  }
}

async function withBetaManifestSyncLock(release, operation) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosi-beta-sync-lock-"),
  );
  const lockToken = crypto.randomBytes(16).toString("hex");
  const lockPath = path.join(temporaryDirectory, BETA_SYNC_LOCK_NAME);
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      tag: TAG,
      pid: process.pid,
      token: lockToken,
      createdAt: new Date(),
    }) + "\n",
  );

  let acquired = null;
  try {
    for (let attempt = 1; attempt <= BETA_SYNC_LOCK_RETRIES; attempt += 1) {
      try {
        acquired = await uploadAsset(release.upload_url, lockPath);
        break;
      } catch (error) {
        if (!isGitHubConflict(error)) throw error;
        if (attempt === BETA_SYNC_LOCK_RETRIES) {
          const lock = await findBetaManifestSyncLock(release.id);
          const createdAt = lock?.created_at
            ? ` (created ${lock.created_at})`
            : "";
          throw new Error(
            `Timed out waiting for another release VM to finish beta-manifest synchronization${createdAt}. ` +
              `If no release signer is still running, manually delete the GitHub release asset named ` +
              `"${BETA_SYNC_LOCK_NAME}" from the latest stable release, then retry. ` +
              "Never remove the lock while another signer is active.",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    if (!acquired) {
      throw new Error(
        "Could not acquire the beta-manifest synchronization lock.",
      );
    }
    await assertOwnsBetaManifestSyncLock(release, acquired);
    return await operation({
      assertStillHeld: () => assertOwnsBetaManifestSyncLock(release, acquired),
    });
  } finally {
    // Never delete a replacement lock created during manual recovery.
    if (acquired && typeof acquired.id === "number") {
      const current = await findBetaManifestSyncLock(release.id);
      if (current?.id === acquired.id) {
        await removeAssetBestEffort(acquired, "beta-manifest sync lock");
      }
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function cleanupTransactionalStagingAssets(release) {
  const assets = await listReleaseAssets(release.id);
  for (const asset of assets.filter((item) =>
    isTransactionalStagingAssetName(item?.name ?? ""),
  )) {
    await removeAssetBestEffort(asset, `orphan feed asset ${asset.name}`);
  }
}

async function uploadAssetWithReplace(
  release,
  filePath,
  { allowPublishedReplace = false } = {},
) {
  try {
    await uploadAsset(release.upload_url, filePath);
  } catch (err) {
    if (!isGitHubConflict(err)) throw err;

    const fileName = path.basename(filePath);
    const assets = await listReleaseAssets(release.id);
    const existing = assets.find(
      (asset) => asset?.name === fileName && typeof asset.id === "number",
    );
    if (!existing) throw err;
    if (!release.draft && !allowPublishedReplace) {
      throw new Error(
        `Refusing to replace existing asset "${fileName}" on published release ${TAG}. Set ALLOW_ASSET_REPLACE=true to override.`,
      );
    }

    await ghRequest(
      "DELETE",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${existing.id}`,
    );
    await uploadAsset(release.upload_url, filePath);
  }
}

async function syncBetaManifestsToLatestStable(
  uploadedFiles,
  currentReleaseId,
) {
  const betaManifests = uploadedFiles.filter((filePath) =>
    /^latest-[a-z0-9]+-beta-[a-z0-9_-]+\.json$/i.test(path.basename(filePath)),
  );
  if (betaManifests.length === 0) return;

  let latestStable;
  try {
    latestStable = await ghRequest(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
    );
  } catch (err) {
    throw new Error(
      `Could not load latest stable release for beta manifest sync: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!latestStable?.id || !latestStable?.upload_url) return;
  if (latestStable.id === currentReleaseId) {
    console.warn(
      "  ! syncBetaManifests: latest stable is the current release; sync skipped. Publish a stable release before running beta builds.",
    );
    return;
  }

  await withBetaManifestSyncLock(latestStable, async ({ assertStillHeld }) => {
    await assertStillHeld();
    await replaceReleaseAssetsTransactionally(latestStable, betaManifests, {
      assertStillHeld,
    });
    await assertStillHeld();
    await cleanupTransactionalStagingAssets(latestStable);
  });
  for (const filePath of betaManifests) {
    console.log(
      `  ~ synced ${path.basename(filePath)} to latest stable release`,
    );
  }
}

function requiredPublishedBetaManifestNames() {
  const targets = new Set([
    "windows-beta-x86_64",
    "windows-beta-x86_64-nsis",
    "windows-beta-aarch64",
    "windows-beta-aarch64-nsis",
    "darwin-beta-x86_64",
    "darwin-beta-x86_64-app",
    "darwin-beta-aarch64",
    "darwin-beta-aarch64-app",
    "linux-beta-x86_64",
    "linux-beta-x86_64-appimage",
    "linux-beta-x86_64-deb",
    "linux-beta-x86_64-rpm",
  ]);
  if (REQUIRE_LINUX_AARCH64) {
    for (const suffix of ["", "-appimage", "-deb", "-rpm"]) {
      targets.add(`linux-beta-aarch64${suffix}`);
    }
  }
  for (const target of REQUIRED_UPDATER_TARGETS.split(/[,\s]+/).filter(
    Boolean,
  )) {
    if (!/^[a-z0-9_-]+$/i.test(target)) {
      throw new Error(`Invalid REQUIRED_UPDATER_TARGETS entry "${target}".`);
    }
    targets.add(target);
  }
  return Array.from(targets, (target) => `latest-${target}.json`).sort();
}

function expectedPublishedBetaManifestNames(actualNames = []) {
  const expected = new Set(requiredPublishedBetaManifestNames());
  const optionalGroups = [
    ["", "-appimage", "-deb", "-rpm"].map(
      (suffix) => `latest-linux-beta-aarch64${suffix}.json`,
    ),
  ];
  for (const group of optionalGroups) {
    const present = group.filter((name) => actualNames.includes(name));
    if (present.length === 0) continue;
    if (present.length !== group.length) {
      throw new Error(
        `Published beta manifest set contains an incomplete optional target group. Required together: ${group.join(", ")}. Found: ${present.join(", ")}.`,
      );
    }
    for (const name of group) expected.add(name);
  }
  return Array.from(expected).sort();
}

function validatePublishedBetaManifest({ name, contents, releaseAssetNames }) {
  let manifest;
  try {
    manifest = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}`);
  }
  if (manifest?.version !== VERSION) {
    throw new Error(
      `${name} reports version ${JSON.stringify(manifest?.version)}, expected ${VERSION}.`,
    );
  }
  const platforms = Object.entries(manifest?.platforms || {});
  if (platforms.length === 0) {
    throw new Error(`${name} has no updater platform entries.`);
  }
  const referencedArtifacts = [];
  for (const [target, entry] of platforms) {
    if (
      !entry ||
      typeof entry.url !== "string" ||
      typeof entry.signature !== "string"
    ) {
      throw new Error(`${name} has an invalid platform entry for ${target}.`);
    }
    const url = new URL(entry.url);
    const expectedPrefix = `/${REPO_OWNER}/${REPO_NAME}/releases/download/${TAG}/`;
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port !== "" ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.toLowerCase().startsWith(expectedPrefix.toLowerCase())
    ) {
      throw new Error(`${name} points outside the published ${TAG} release.`);
    }
    const artifactName = decodeURIComponent(url.pathname.split("/").at(-1));
    if (
      artifactName !== path.posix.basename(artifactName) ||
      artifactName !== path.win32.basename(artifactName) ||
      path.posix.isAbsolute(artifactName) ||
      path.win32.isAbsolute(artifactName) ||
      artifactName.includes("/") ||
      artifactName.includes("\\") ||
      artifactName.includes(":") ||
      artifactName === "." ||
      artifactName === ".."
    ) {
      throw new Error(
        `${name} has an unsafe artifact filename ${artifactName}.`,
      );
    }
    if (!releaseAssetNames.has(artifactName)) {
      throw new Error(
        `${name} references missing release asset ${artifactName}.`,
      );
    }
    referencedArtifacts.push({
      name: artifactName,
      url: entry.url,
      signature: entry.signature,
    });
  }
  return referencedArtifacts;
}

async function loadAndVerifyPublishedBetaManifests(currentRelease) {
  const assets = await listReleaseAssets(currentRelease.id);
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  const actualNames = assets
    .map((asset) => asset.name)
    .filter((name) => /^latest-[a-z0-9]+-beta-[a-z0-9_-]+\.json$/i.test(name))
    .sort();
  const expectedNames = expectedPublishedBetaManifestNames(actualNames);
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `Published beta manifest set is incomplete or unexpected. Expected: ${expectedNames.join(", ")}. Found: ${actualNames.join(", ")}.`,
    );
  }

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosi-beta-finalize-"),
  );
  try {
    const manifests = [];
    const artifactRecords = new Map();
    for (const name of expectedNames) {
      const asset = byName.get(name);
      const manifestPath = path.join(temporaryDirectory, name);
      await downloadUrlToFile(asset.browser_download_url, manifestPath);
      const contents = fs.readFileSync(manifestPath, "utf8");
      const referenced = validatePublishedBetaManifest({
        name,
        contents,
        releaseAssetNames: new Set(byName.keys()),
      });
      manifests.push(manifestPath);
      for (const record of referenced) {
        const previous = artifactRecords.get(record.name);
        if (previous && previous.signature !== record.signature) {
          throw new Error(
            `Published beta manifests disagree on the updater signature for ${record.name}.`,
          );
        }
        artifactRecords.set(record.name, record);
      }
    }

    const shapeValidation = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts", "validate-updater-manifest.js"),
        ...manifests,
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (shapeValidation.status !== 0) {
      throw new Error(
        `Published updater manifest validation failed: ${shapeValidation.stderr || shapeValidation.stdout}`,
      );
    }

    const localArtifacts = new Map();
    const localSignatures = new Map();
    for (const record of artifactRecords.values()) {
      const artifactPath = path.join(temporaryDirectory, record.name);
      // Public, unauthenticated fetch proves clients can actually download it.
      await downloadUrlToFile(record.url, artifactPath);
      const signaturePath = `${artifactPath}.sig`;
      fs.writeFileSync(signaturePath, `${record.signature}\n`);
      localArtifacts.set(record.name, artifactPath);
      localSignatures.set(record.name, signaturePath);
    }
    verifyUpdaterSignatures({
      root,
      releaseDir: temporaryDirectory,
      byName: new Map([
        ...localArtifacts,
        ...Array.from(localSignatures, ([name, filePath]) => [
          `${name}.sig`,
          filePath,
        ]),
      ]),
      signatureByBaseName: localSignatures,
      resolveUpdaterTargets,
    });
    return manifests.map((manifestPath) => {
      const destination = path.join(releaseDir, path.basename(manifestPath));
      fs.copyFileSync(manifestPath, destination);
      return destination;
    });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function buildUploadList({
  artifacts,
  checksumFiles,
  signatureFiles,
  stagingDirectory = releaseDir,
}) {
  const resolvedStagingDirectory = path.resolve(stagingDirectory);
  const unsigned = new Set(
    [...artifacts, ...checksumFiles].map((filePath) => path.resolve(filePath)),
  );
  const groups = [
    [artifacts, (name) => isArtifact(name), "artifact or manifest"],
    [checksumFiles, (name) => isChecksumTextName(name), "checksum manifest"],
    [
      signatureFiles,
      (name, filePath) =>
        name.endsWith(".asc") &&
        unsigned.has(path.resolve(filePath.slice(0, -4))),
      "signature of a vetted file",
    ],
  ];
  const vetted = [];
  const seen = new Set();
  for (const [files, isExpected, description] of groups) {
    for (const filePath of files) {
      const resolved = path.resolve(filePath);
      if (
        path.dirname(resolved) !== resolvedStagingDirectory ||
        !isExpected(path.basename(resolved), resolved)
      ) {
        throw new Error(
          `Refusing unvetted release upload ${filePath}; expected ${description} in ${stagingDirectory}.`,
        );
      }
      if (!seen.has(resolved)) {
        seen.add(resolved);
        vetted.push(resolved);
      }
    }
  }
  return vetted;
}

async function main() {
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  console.log(`\nROSI ${VERSION}: release pipeline\n`);
  assertGitHubCliAuthenticated();

  if (EXPECTED_TAG && EXPECTED_TAG !== TAG) {
    throw new Error(
      `Version/tag mismatch: package.json is ${TAG} but workflow ref is ${EXPECTED_TAG}.`,
    );
  }

  console.log("[1/5] Checking GPG...");
  if (!GPG_KEY_ID) {
    console.error("GPG_KEY_ID is required.");
    process.exit(1);
  }
  if (!GPG_PASSPHRASE) {
    console.error("GPG_PASSPHRASE is required.");
    process.exit(1);
  }
  try {
    execSync("gpg --version", { stdio: "pipe" });
  } catch {
    console.error("gpg not found. Install GnuPG and try again.");
    process.exit(1);
  }

  console.log("[2/5] Collecting artifacts...");
  assertNoStubSidecars();
  const artifacts = collectArtifacts();

  console.log("[3/5] Generating checksums...");
  const checksumFiles = generateChecksums(artifacts);

  console.log("[4/5] Signing...");
  const ascFiles = signArtifacts(artifacts);
  for (const checksumFile of checksumFiles) {
    ascFiles.push(signFile(checksumFile));
    console.log(`  + ${path.basename(checksumFile)}.asc`);
  }

  console.log("[5/5] Uploading to GitHub...");
  const release = await getOrCreateRelease();
  if (!release?.draft && !ALLOW_ASSET_REPLACE) {
    throw new Error(
      `Release ${TAG} already exists as published. Refusing to mutate it without ALLOW_ASSET_REPLACE=true.`,
    );
  }
  console.log(`  Release: ${release.html_url || TAG}`);

  const everything = buildUploadList({
    artifacts,
    checksumFiles,
    signatureFiles: ascFiles,
  });
  for (const f of everything) {
    await uploadAssetWithReplace(release, f);
    console.log(`  ^ ${path.basename(f)}`);
  }
  // Beta clients poll /releases/latest for latest-*-beta-*.json. Sync those
  // manifests onto the latest *stable* release during every beta sign upload,
  // including while this tag is still a draft. That is intentional: each
  // release:*:continue VM should publish its platform feed as soon as it
  // signs, preserving the established automatic beta-feed behavior.
  // Keep release:sync-beta-manifests for recovery/re-sync only.
  if (IS_PRERELEASE) {
    await syncBetaManifestsToLatestStable(everything, release.id);
  }

  console.log(
    `\nDone: ${TAG} uploaded as ${release.draft ? "draft" : "published"}.\n`,
  );
}

async function syncBetaManifestsAfterPublish() {
  if (!IS_PRERELEASE) {
    throw new Error(
      "release:sync-beta-manifests is only for beta versions (syncs latest-*-beta-*.json onto /releases/latest).",
    );
  }
  assertGitHubCliAuthenticated();
  let currentRelease;
  try {
    currentRelease = await ghRequest(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${TAG}`,
    );
  } catch (error) {
    if (error?.statusCode === 404) {
      throw new Error(
        `Published release ${TAG} not found. Publish the draft on GitHub, then re-run release:sync-beta-manifests.`,
      );
    }
    throw error;
  }
  if (currentRelease.draft) {
    throw new Error(
      `Release ${TAG} is still a draft. Publish it on GitHub before syncing beta manifests to /latest.`,
    );
  }
  if (!currentRelease.published_at) {
    throw new Error(`Release ${TAG} has no published timestamp.`);
  }
  const betaManifests =
    await loadAndVerifyPublishedBetaManifests(currentRelease);

  console.log(
    `Syncing ${betaManifests.length} beta updater manifest(s) from ${TAG} onto /releases/latest…`,
  );
  await syncBetaManifestsToLatestStable(betaManifests, currentRelease.id);
  console.log("Done: beta manifests synced to latest stable release.\n");
}

function isDirectExecution() {
  return Boolean(
    process.argv[1] &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url,
  );
}

if (isDirectExecution()) {
  const syncOnly = process.argv.includes("--sync-beta-manifests");
  const run = syncOnly ? syncBetaManifestsAfterPublish : main;
  run().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

export {
  artifactMatchesVersion,
  assertNoStubSidecars,
  cleanArtifactName,
  generateUpdaterManifests,
  isArtifact,
  assertReleaseTargetsCommit,
  buildUploadList,
  checksumTargetKeysForArtifactName,
  isChecksumTextName,
  isDirectExecution,
  isExplicitTruthy,
  isGitHubConflict,
  isTransactionalStagingAssetName,
  listAllGithubPages,
  rpmArtifactMatchesVersion,
  expectedPublishedBetaManifestNames,
  requiredPublishedBetaManifestNames,
  requiredLinuxTargetKeys,
  resolveUpdaterTargets,
  validatePublishedBetaManifest,
  syncBetaManifestsToLatestStable,
  updaterChannelVariants,
};
