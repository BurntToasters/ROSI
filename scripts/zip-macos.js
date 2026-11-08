#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { isDeepStrictEqual } from "util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MACOS_TARGETS = Object.freeze({
  "universal-apple-darwin": Object.freeze({
    assetArch: "universal",
    architectures: Object.freeze(["x86_64", "arm64"]),
  }),
  "aarch64-apple-darwin": Object.freeze({
    assetArch: "arm64",
    architectures: Object.freeze(["arm64"]),
  }),
  "x86_64-apple-darwin": Object.freeze({
    assetArch: "x64",
    architectures: Object.freeze(["x86_64"]),
  }),
});

export function macosPackageName(target, extension) {
  const targetConfig = MACOS_TARGETS[target];
  if (!targetConfig) throw new Error(`unsupported macOS target: ${target}`);
  if (extension !== "dmg" && extension !== "zip") {
    throw new Error(`unsupported macOS package extension: ${extension}`);
  }
  return `ROSI-MacOS-${targetConfig.assetArch}.${extension}`;
}

export function assertArchitectureCompatibility(
  architectures,
  target,
  { allowAdditional = false, label = "binary" } = {},
) {
  const targetConfig = MACOS_TARGETS[target];
  if (!targetConfig) throw new Error(`unsupported macOS target: ${target}`);
  const observed = Array.isArray(architectures)
    ? architectures.map(String)
    : String(architectures || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
  const required = targetConfig.architectures;
  const compatible =
    required.every((arch) => observed.includes(arch)) &&
    (allowAdditional || observed.length === required.length);
  if (!compatible) {
    throw new Error(
      `${label} has architectures "${observed.join(" ")}", expected ${allowAdditional ? "to include " : ""}"${required.join(" ")}" for ${target}`,
    );
  }
  return observed;
}

function parseTargetArguments(args) {
  const targetIndex = args.indexOf("--target");
  const target =
    targetIndex >= 0 ? args[targetIndex + 1] : "universal-apple-darwin";
  if (!target || target.startsWith("--") || !MACOS_TARGETS[target]) {
    throw new Error(
      "Usage: node scripts/zip-macos.js [--target universal-apple-darwin|aarch64-apple-darwin|x86_64-apple-darwin]",
    );
  }
  return target;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

export function assertMinimumMacOSVersion(binary, arch, minimum, required) {
  if (compareVersions(minimum, required) > 0) {
    throw new Error(
      `${path.basename(binary)} (${arch}) requires macOS ${minimum}, above ROSI's declared ${required} floor`,
    );
  }
}

function parseMachOMinimumVersion(otoolOutput) {
  const buildVersion = otoolOutput.match(
    /cmd LC_BUILD_VERSION[\s\S]*?\bminos\s+(\d+(?:\.\d+)*)/,
  );
  if (buildVersion?.[1]) return buildVersion[1];
  // Upstream yt-dlp x86_64 may use the legacy LC_VERSION_MIN_MACOSX command.
  const legacy = otoolOutput.match(
    /cmd LC_VERSION_MIN_MACOSX[\s\S]*?\bversion\s+(\d+(?:\.\d+)*)/,
  );
  return legacy?.[1] ?? null;
}

function readMachOMinimumVersion(binary, arch) {
  const output = execFileSync("otool", ["-arch", arch, "-l", binary], {
    encoding: "utf8",
  });
  const minimum = parseMachOMinimumVersion(output);
  if (!minimum) {
    throw new Error(
      `Could not read the minimum macOS version for ${binary} (${arch})`,
    );
  }
  return minimum;
}

function verifyMachOCompatibility(binary, target, requiredMacOS, options = {}) {
  const targetConfig = MACOS_TARGETS[target];
  const architectures = execFileSync("lipo", ["-archs", binary], {
    encoding: "utf8",
  }).trim();
  assertArchitectureCompatibility(architectures, target, {
    ...options,
    label: path.basename(binary),
  });
  for (const arch of targetConfig.architectures) {
    const minos = readMachOMinimumVersion(binary, arch);
    assertMinimumMacOSVersion(binary, arch, minos, requiredMacOS);
  }
}

function verifySignedEntitlements(targetPath, expected) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosi-entitlements-"),
  );
  const plistPath = path.join(temporaryDirectory, "entitlements.plist");
  try {
    // Without --xml, modern codesign writes a textual DER dump that starts
    // with "[Dict]" and cannot be parsed by plutil.
    const inspection = spawnSync(
      "codesign",
      ["--display", "--entitlements", plistPath, "--xml", targetPath],
      { encoding: "utf8" },
    );
    if (inspection.error || inspection.status !== 0) {
      throw (
        inspection.error ??
        new Error(
          `Could not inspect entitlements for ${targetPath}: ${inspection.stderr}`,
        )
      );
    }
    const actual = fs.existsSync(plistPath)
      ? JSON.parse(
          execFileSync("plutil", ["-convert", "json", "-o", "-", plistPath], {
            encoding: "utf8",
          }),
        )
      : {};
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(
        `Unexpected signed entitlements for ${targetPath}: ${JSON.stringify(actual)}`,
      );
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function verifyDeveloperIdSignature(targetPath, label) {
  const inspection = spawnSync(
    "codesign",
    ["--display", "--verbose=4", targetPath],
    { encoding: "utf8" },
  );
  if (inspection.error || inspection.status !== 0) {
    throw inspection.error ?? new Error(inspection.stderr);
  }
  const details = `${inspection.stdout}${inspection.stderr}`;
  if (
    /Signature=adhoc/i.test(details) ||
    !/Authority=Developer ID Application:/i.test(details)
  ) {
    throw new Error(
      `${label} is not signed with a Developer ID Application certificate.`,
    );
  }
  const teamIdentifier = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (!teamIdentifier || teamIdentifier === "not set") {
    throw new Error(`${label} signature has no TeamIdentifier.`);
  }
  return teamIdentifier;
}

function readEntitlementsTemplate(templatePath) {
  return JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", templatePath], {
      encoding: "utf8",
    }),
  );
}

function readPlistValue(plistPath, key) {
  return execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print:${key}`, plistPath],
    { encoding: "utf8" },
  ).trim();
}

function validateVersion(
  infoPlist,
  { expectedBundleVersion, expectedMarketingVersion },
) {
  const bundleVersion = readPlistValue(infoPlist, "CFBundleVersion");
  const marketingVersion = readPlistValue(
    infoPlist,
    "CFBundleShortVersionString",
  );
  assertBundleVersions(
    { bundleVersion, marketingVersion },
    { expectedBundleVersion, expectedMarketingVersion },
  );
}

export function assertBundleVersions(
  actual,
  { expectedBundleVersion, expectedMarketingVersion },
) {
  const { bundleVersion, marketingVersion } = actual;
  if (!/^\d+(?:\.\d+){0,2}$/.test(bundleVersion)) {
    throw new Error(`CFBundleVersion must be numeric: ${bundleVersion}`);
  }
  if (bundleVersion !== expectedBundleVersion) {
    throw new Error(
      `CFBundleVersion ${bundleVersion} does not match configured ${expectedBundleVersion}`,
    );
  }
  if (marketingVersion !== expectedMarketingVersion) {
    throw new Error(
      `CFBundleShortVersionString ${marketingVersion} does not match expected ${expectedMarketingVersion}`,
    );
  }
}

export function verifyAppBundle(
  appPath,
  target,
  tauriConfig,
  repositoryRoot = root,
) {
  const requiredMacOS = tauriConfig.bundle?.macOS?.minimumSystemVersion;
  const expectedBundleVersion = tauriConfig.bundle?.macOS?.bundleVersion;
  const marketingVersionMatch = tauriConfig.version?.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(?:0|[1-9]\d*))?$/,
  );
  const expectedMarketingVersion = marketingVersionMatch
    ? `${marketingVersionMatch[1]}.${marketingVersionMatch[2]}.${marketingVersionMatch[3]}`
    : undefined;
  if (!requiredMacOS || !expectedBundleVersion || !expectedMarketingVersion) {
    throw new Error(
      "tauri.conf.json must define a supported version, bundle.macOS.minimumSystemVersion, and bundleVersion",
    );
  }

  validateVersion(path.join(appPath, "Contents", "Info.plist"), {
    expectedBundleVersion,
    expectedMarketingVersion,
  });

  const hostBinary = path.join(appPath, "Contents", "MacOS", "rosi");
  verifyMachOCompatibility(hostBinary, target, requiredMacOS);
  // yt-dlp is upstream universal2. It may retain its other slice in a native
  // installer, but it must include the requested architecture and meet its OS floor.
  const sidecars = [
    { name: "rosi-yt-dlp", allowAdditional: true },
    { name: "rosi-ffmpeg", allowAdditional: false },
    { name: "rosi-ffprobe", allowAdditional: false },
  ].map(({ name, allowAdditional }) => ({
    filePath: path.join(appPath, "Contents", "MacOS", name),
    allowAdditional,
  }));
  for (const { filePath, allowAdditional } of sidecars) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing bundled sidecar: ${filePath}`);
    }
    const head = fs.readFileSync(filePath).subarray(0, 4096).toString("latin1");
    if (head.includes("ROSI-SIDECAR-STUB")) {
      throw new Error(`Bundled sidecar is a development stub: ${filePath}`);
    }
    verifyMachOCompatibility(filePath, target, requiredMacOS, {
      allowAdditional,
    });
  }

  execFileSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    { stdio: "inherit" },
  );
  const hostTeam = verifyDeveloperIdSignature(appPath, "macOS app");
  const hostEntitlements = readEntitlementsTemplate(
    path.join(repositoryRoot, "src-tauri", "entitlements.plist"),
  );
  verifySignedEntitlements(appPath, hostEntitlements);
  // Tauri signs externalBin sidecars with the app's entitlements; the
  // PyInstaller yt-dlp runtime needs disable-library-validation to load.
  for (const { filePath } of sidecars) {
    verifySignedEntitlements(filePath, hostEntitlements);
    const sidecarTeam = verifyDeveloperIdSignature(
      filePath,
      `${path.basename(filePath)} sidecar`,
    );
    if (sidecarTeam !== hostTeam) {
      throw new Error(
        `${path.basename(filePath)} TeamIdentifier ${sidecarTeam} does not match host ${hostTeam}.`,
      );
    }
  }
  execFileSync("xcrun", ["stapler", "validate", appPath], {
    stdio: "inherit",
  });
  execFileSync(
    "spctl",
    ["--assess", "--type", "execute", "--verbose=2", appPath],
    { stdio: "inherit" },
  );
}

export function packageOutputPath(appPath, target) {
  return path.join(path.dirname(appPath), macosPackageName(target, "zip"));
}

export function normalizeDmgPackage(appPath, target) {
  const dmgDirectory = path.join(path.dirname(appPath), "..", "dmg");
  if (!fs.existsSync(dmgDirectory)) return null;
  const candidates = fs
    .readdirSync(dmgDirectory, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dmg"),
    )
    .map((entry) => path.join(dmgDirectory, entry.name));
  if (candidates.length === 0) return null;
  const destination = path.join(dmgDirectory, macosPackageName(target, "dmg"));
  if (candidates.length > 1) {
    const rawCandidates = candidates.filter(
      (candidate) => path.resolve(candidate) !== path.resolve(destination),
    );
    // A prior packaging pass may have left the normalized name beside the
    // newly written Tauri DMG. Replace that known output; other duplicates are
    // ambiguous and must be resolved by the caller.
    if (candidates.includes(destination) && rawCandidates.length === 1) {
      fs.rmSync(destination, { force: true });
      fs.renameSync(rawCandidates[0], destination);
      return destination;
    }
    throw new Error(
      `Expected one DMG for ${target} in ${dmgDirectory}, found ${candidates.map((candidate) => path.basename(candidate)).join(", ")}`,
    );
  }
  if (path.resolve(candidates[0]) === path.resolve(destination))
    return destination;
  fs.rmSync(destination, { force: true });
  fs.renameSync(candidates[0], destination);
  return destination;
}

export function zipMacosApp({
  target,
  repositoryRoot = root,
  run = execFileSync,
}) {
  if (process.platform !== "darwin") {
    throw new Error("zip-macos can only run on macOS.");
  }
  if (!MACOS_TARGETS[target])
    throw new Error(`unsupported macOS target: ${target}`);
  const appPath = path.join(
    repositoryRoot,
    "src-tauri",
    "target",
    target,
    "release",
    "bundle",
    "macos",
    "ROSI.app",
  );
  if (!fs.existsSync(appPath)) {
    throw new Error(`Expected macOS bundle was not found: ${appPath}`);
  }
  const tauriConfig = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, "src-tauri", "tauri.conf.json"),
      "utf8",
    ),
  );
  verifyAppBundle(appPath, target, tauriConfig, repositoryRoot);
  normalizeDmgPackage(appPath, target);
  const zipPath = packageOutputPath(appPath, target);
  run(
    "ditto",
    ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath],
    { stdio: "inherit" },
  );
  console.log(`Created ${zipPath}`);
  return zipPath;
}

function main() {
  const target = parseTargetArguments(process.argv.slice(2));
  zipMacosApp({ target });
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    console.error(
      `zip-macos: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
