#!/usr/bin/env node
/**
 * Read-only check of published Tauri updater manifests on GitHub.
 * Does not build or release packages; CI smoke only.
 *
 * Usage:
 *   node scripts/validate-updater-live.js --shape-only
 *   node scripts/validate-updater-live.js --expected-version=current
 *   EXPECTED_UPDATER_VERSION=0.6.0-beta.16 \
 *     REQUIRED_UPDATER_TARGETS=windows-beta-x86_64 \
 *     node scripts/validate-updater-live.js
 *
 * Missing manifests (HTTP 404) are skipped with a warning during the soft CI
 * smoke. Present manifests must pass the same shape checks as
 * validate-updater-manifest.js. `--expected-version=current` requires ROSI's
 * standard release matrix for that channel; stable candidates also require
 * beta-target transition endpoints. REQUIRE_UPDATER_LIVE=1 requires both
 * standard live channel matrices when no expected version is supplied.
 * REQUIRED_UPDATER_TARGETS adds intentional optional targets (for example,
 * Linux ARM64) to the required set.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { spawnSync } from "child_process";
import { verifyUpdaterSignatures } from "./updater-signature-verifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const validator = path.join(root, "scripts", "validate-updater-manifest.js");
const requireLive = process.env.REQUIRE_UPDATER_LIVE === "1";
const args = process.argv.slice(2);
const shapeOnly = args.includes("--shape-only");

function optionValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function currentPackageVersion() {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  return String(packageJson.version || "").trim();
}

function parseTargets(value) {
  return Array.from(
    new Set(
      String(value || "")
        .split(",")
        .map((target) => target.trim())
        .filter(Boolean),
    ),
  );
}

const TARGETS = [
  "windows-x86_64",
  "windows-aarch64",
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
  "linux-aarch64",
  "windows-beta-x86_64",
  "windows-beta-x86_64-nsis",
  "windows-beta-aarch64",
  "windows-beta-aarch64-nsis",
  "darwin-beta-aarch64",
  "darwin-beta-aarch64-app",
  "darwin-beta-x86_64",
  "darwin-beta-x86_64-app",
  "linux-beta-x86_64",
  "linux-beta-x86_64-appimage",
  "linux-beta-aarch64",
  "linux-beta-aarch64-appimage",
];

const STANDARD_STABLE_TARGETS = [
  "windows-x86_64",
  "windows-aarch64",
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
];

const STANDARD_BETA_TARGETS = [
  "windows-beta-x86_64",
  "windows-beta-x86_64-nsis",
  "windows-beta-aarch64",
  "windows-beta-aarch64-nsis",
  "darwin-beta-aarch64",
  "darwin-beta-aarch64-app",
  "darwin-beta-x86_64",
  "darwin-beta-x86_64-app",
  "linux-beta-x86_64",
  "linux-beta-x86_64-appimage",
];

const requestedExpectedVersion =
  optionValue("--expected-version") ||
  process.env.EXPECTED_UPDATER_VERSION ||
  "";
const expectedVersion =
  requestedExpectedVersion === "current"
    ? currentPackageVersion()
    : requestedExpectedVersion.trim();
const explicitlyRequiredTargets = parseTargets(
  process.env.REQUIRED_UPDATER_TARGETS,
);
const expectedIsBeta = /-beta\.\d+$/.test(expectedVersion);
const standardRequiredTargets =
  requestedExpectedVersion === "current"
    ? expectedIsBeta
      ? STANDARD_BETA_TARGETS
      : [...STANDARD_STABLE_TARGETS, ...STANDARD_BETA_TARGETS]
    : requireLive
      ? expectedVersion
        ? expectedIsBeta
          ? STANDARD_BETA_TARGETS
          : [...STANDARD_STABLE_TARGETS, ...STANDARD_BETA_TARGETS]
        : [...STANDARD_STABLE_TARGETS, ...STANDARD_BETA_TARGETS]
      : [];
const requiredTargets = Array.from(
  new Set([...standardRequiredTargets, ...explicitlyRequiredTargets]),
);
const selectedTargets =
  requiredTargets.length > 0
    ? requiredTargets
    : expectedVersion
      ? TARGETS.filter((target) => target.includes("-beta-") === expectedIsBeta)
      : TARGETS;

const BASE = (
  process.env.UPDATER_LIVE_BASE_URL ||
  "https://github.com/BurntToasters/ROSI/releases/latest/download"
).replace(/\/+$/, "");

async function fetchManifest(target) {
  const url = `${BASE}/latest-${target}.json`;
  const headers = {
    Accept: "application/json",
    "User-Agent": "rosi-ci",
  };
  const response = await fetch(url, {
    headers,
    redirect: "follow",
  });
  if (response.status === 404) {
    return { target, url, status: 404, body: null };
  }
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  const body = await response.text();
  return { target, url, status: response.status, body };
}

function assertExpectedVersion(target, body) {
  if (!expectedVersion) return;
  let manifest;
  try {
    manifest = JSON.parse(body);
  } catch (error) {
    throw new Error(
      `latest-${target}.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `latest-${target}.json reports version ${JSON.stringify(manifest.version)}, expected ${expectedVersion}.`,
    );
  }
}

export function shouldVerifyLiveArtifacts({
  shapeOnly: shapeOnlyFlag,
  requestedExpectedVersion: requested,
} = {}) {
  return !shapeOnlyFlag && requested === "current";
}

export function collectManifestArtifactRefs(bodies) {
  const artifacts = new Map();
  for (const body of bodies) {
    let manifest;
    try {
      manifest = JSON.parse(body);
    } catch (error) {
      throw new Error(
        `updater-live: manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const [target, entry] of Object.entries(manifest.platforms || {})) {
      if (
        !entry ||
        typeof entry.url !== "string" ||
        typeof entry.signature !== "string"
      ) {
        throw new Error(`updater-live: invalid platform entry for ${target}.`);
      }
      let name;
      try {
        name = decodeURIComponent(
          new URL(entry.url).pathname.split("/").pop() || "",
        );
      } catch {
        throw new Error(
          `updater-live: invalid artifact URL for ${target}: ${entry.url}`,
        );
      }
      if (!name) {
        throw new Error(
          `updater-live: artifact URL for ${target} has no filename`,
        );
      }
      // The decoded URL component becomes a local filename below. Reject
      // traversal, separators, drive prefixes, and control names before any
      // filesystem operation can see it.
      if (
        name !== path.posix.basename(name) ||
        name !== path.win32.basename(name) ||
        path.posix.isAbsolute(name) ||
        path.win32.isAbsolute(name) ||
        name.includes("/") ||
        name.includes("\\") ||
        name.includes(":") ||
        name === "." ||
        name === ".."
      ) {
        throw new Error(
          `updater-live: unsafe artifact filename for ${target}: ${entry.url}`,
        );
      }
      const previous = artifacts.get(name);
      if (previous && previous.url !== entry.url) {
        throw new Error(`updater-live: conflicting URLs for ${name}`);
      }
      artifacts.set(name, { url: entry.url, signature: entry.signature });
    }
  }
  return artifacts;
}

export function resolveLiveUpdaterTargets(name) {
  const lower = String(name || "").toLowerCase();
  if (
    lower.endsWith(".sig") ||
    lower.endsWith(".asc") ||
    lower.endsWith(".json") ||
    /^sha256sums/i.test(name)
  ) {
    return [];
  }
  if (/\.(exe|msi|dmg|flatpak|appimage|zip)$/i.test(name)) {
    return [{ os: "live", arch: "artifact" }];
  }
  return [];
}

async function downloadToFile(url, dest) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "rosi-ci",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()), {
    flag: "wx",
  });
}

async function verifyDownloadedArtifacts(manifestBodies) {
  const artifacts = collectManifestArtifactRefs(manifestBodies);
  if (artifacts.size === 0) {
    throw new Error(
      "updater-live: no updater artifacts referenced by manifests",
    );
  }
  const artifactDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosi-updater-live-artifacts-"),
  );
  try {
    const byName = new Map();
    const signatureByBaseName = new Map();
    for (const [name, { url, signature }] of artifacts) {
      const dest = path.join(artifactDir, name);
      console.log(`updater-live: downloading ${url}`);
      await downloadToFile(url, dest);
      byName.set(name, dest);
      const sigPath = path.join(artifactDir, `${name}.sig`);
      fs.writeFileSync(sigPath, signature);
      signatureByBaseName.set(name, sigPath);
    }
    verifyUpdaterSignatures({
      root,
      releaseDir: artifactDir,
      byName,
      signatureByBaseName,
      resolveUpdaterTargets: resolveLiveUpdaterTargets,
    });
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-updater-live-"));
  const files = [];
  const skipped = [];
  // process.exit() would skip the finally cleanup; every early exit goes here.
  const exitWith = (code) => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(code);
  };

  try {
    for (const target of selectedTargets) {
      const result = await fetchManifest(target);
      if (result.status === 404) {
        console.warn(`updater-live: skip missing ${result.url}`);
        skipped.push(target);
        continue;
      }
      assertExpectedVersion(target, result.body);
      const filePath = path.join(tmpDir, `latest-${target}.json`);
      fs.writeFileSync(filePath, result.body, "utf8");
      files.push(filePath);
      console.log(`updater-live: fetched ${result.url}`);
    }

    if (files.length === 0) {
      const message =
        "updater-live: no published manifests found (all 404); nothing to validate";
      if (requireLive || expectedVersion || requiredTargets.length > 0) {
        const requirements = [
          requireLive && "REQUIRE_UPDATER_LIVE=1",
          expectedVersion && `expected version ${expectedVersion}`,
          requiredTargets.length > 0 &&
            `required targets ${requiredTargets.join(", ")}`,
        ].filter(Boolean);
        console.error(`${message} (${requirements.join("; ")})`);
        exitWith(1);
      }
      console.warn(message);
      exitWith(0);
    }
    if (requiredTargets.length > 0 && skipped.length > 0) {
      console.error(
        `updater-live: required manifest${skipped.length === 1 ? " is" : "s are"} missing: ${skipped.join(", ")}.`,
      );
      exitWith(1);
    }

    // Soft CI smoke still shape-checks whatever /latest has. When no explicit
    // --expected-version was set, also fail if a same-channel feed is stale
    // relative to package.json (avoids all-404 soft-pass hiding a wrong beta).
    if (!requestedExpectedVersion && !shapeOnly) {
      const pkg = currentPackageVersion();
      const pkgIsBeta = /-beta\.\d+$/.test(pkg);
      for (const filePath of files) {
        const base = path.basename(filePath, ".json"); // latest-<target>
        const target = base.replace(/^latest-/, "");
        if (target.includes("-beta-") !== pkgIsBeta) continue;
        const body = fs.readFileSync(filePath, "utf8");
        let manifest;
        try {
          manifest = JSON.parse(body);
        } catch (error) {
          console.error(
            `updater-live: ${base}.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          );
          exitWith(1);
        }
        if (manifest.version !== pkg) {
          console.error(
            `updater-live: ${base}.json reports version ${JSON.stringify(manifest.version)}, expected package.json ${pkg} (same-channel stale feed). Pass --expected-version=… to override.`,
          );
          exitWith(1);
        }
      }
    }

    const check = spawnSync(process.execPath, [validator, ...files], {
      encoding: "utf8",
    });
    if (check.stdout) process.stdout.write(check.stdout);
    if (check.stderr) process.stderr.write(check.stderr);
    if (check.status !== 0) {
      exitWith(check.status ?? 1);
    }
    if (
      shouldVerifyLiveArtifacts({
        shapeOnly,
        requestedExpectedVersion,
      })
    ) {
      const bodies = files.map((filePath) => fs.readFileSync(filePath, "utf8"));
      await verifyDownloadedArtifacts(bodies);
    }
    console.log(
      `updater-live: ok (${files.length} published, ${skipped.length} missing${expectedVersion ? `, version ${expectedVersion}` : ""})`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function isDirectExecution() {
  return Boolean(
    process.argv[1] &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url,
  );
}

if (isDirectExecution()) {
  await run();
}
