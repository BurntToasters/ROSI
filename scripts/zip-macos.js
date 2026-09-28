import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { isDeepStrictEqual } from "util";

if (process.platform !== "darwin") {
  console.log("zip-macos can only run on macOS.");
  process.exit(0);
}

const root = process.cwd();
const targetArg = process.argv.indexOf("--target");
const target =
  targetArg >= 0 ? process.argv[targetArg + 1] : "universal-apple-darwin";
if (!target || target.startsWith("--")) {
  console.error("Usage: node scripts/zip-macos.js [--target <rust-target>]");
  process.exit(1);
}

const appPath = path.join(
  root,
  "src-tauri",
  "target",
  target,
  "release",
  "bundle",
  "macos",
  "ROSI.app",
);
if (!fs.existsSync(appPath)) {
  console.error(`Expected macOS bundle was not found: ${appPath}`);
  process.exit(1);
}

const tauriConfig = JSON.parse(
  fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
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

function parseMachOMinimumVersion(otoolOutput) {
  const buildVersion = otoolOutput.match(
    /cmd LC_BUILD_VERSION[\s\S]*?\bminos\s+(\d+(?:\.\d+)*)/,
  );
  if (buildVersion?.[1]) return buildVersion[1];
  // Binaries built for older deployment targets (for example the upstream
  // yt-dlp x86_64 slice) carry the legacy LC_VERSION_MIN_MACOSX command.
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

function verifyMachOCompatibility(binary) {
  for (const arch of ["x86_64", "arm64"]) {
    const minos = readMachOMinimumVersion(binary, arch);
    if (compareVersions(minos, requiredMacOS) > 0) {
      throw new Error(
        `${path.basename(binary)} (${arch}) requires macOS ${minos}, above ROSI's declared ${requiredMacOS} floor`,
      );
    }
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

const infoPlist = path.join(appPath, "Contents", "Info.plist");
const bundleVersion = readPlistValue(infoPlist, "CFBundleVersion");
if (!/^\d+(?:\.\d+){0,2}$/.test(bundleVersion)) {
  throw new Error(`CFBundleVersion must be numeric: ${bundleVersion}`);
}
if (bundleVersion !== expectedBundleVersion) {
  throw new Error(
    `CFBundleVersion ${bundleVersion} does not match configured ${expectedBundleVersion}`,
  );
}
const marketingVersion = readPlistValue(
  infoPlist,
  "CFBundleShortVersionString",
);
if (marketingVersion !== expectedMarketingVersion) {
  throw new Error(
    `CFBundleShortVersionString ${marketingVersion} does not match expected ${expectedMarketingVersion}`,
  );
}

const hostBinary = path.join(appPath, "Contents", "MacOS", "rosi");
verifyMachOCompatibility(hostBinary);
// Tauri installs externalBin sidecars next to the host with the target triple
// stripped. yt-dlp, FFmpeg, and ffprobe must all be universal Mach-O files.
const sidecars = ["rosi-yt-dlp", "rosi-ffmpeg", "rosi-ffprobe"].map((name) =>
  path.join(appPath, "Contents", "MacOS", name),
);
for (const sidecar of sidecars) {
  if (!fs.existsSync(sidecar)) {
    throw new Error(`Missing bundled sidecar: ${sidecar}`);
  }
  const head = fs.readFileSync(sidecar).subarray(0, 4096).toString("latin1");
  if (head.includes("ROSI-SIDECAR-STUB")) {
    throw new Error(`Bundled sidecar is a development stub: ${sidecar}`);
  }
  verifyMachOCompatibility(sidecar);
}

execFileSync(
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", appPath],
  { stdio: "inherit" },
);
const hostTeam = verifyDeveloperIdSignature(appPath, "macOS app");
const hostEntitlements = readEntitlementsTemplate(
  path.join(root, "src-tauri", "entitlements.plist"),
);
verifySignedEntitlements(appPath, hostEntitlements);
// Tauri signs externalBin sidecars with the same entitlements.plist as the app;
// the PyInstaller yt-dlp runtime needs disable-library-validation to load.
for (const sidecar of sidecars) {
  verifySignedEntitlements(sidecar, hostEntitlements);
  const sidecarTeam = verifyDeveloperIdSignature(
    sidecar,
    `${path.basename(sidecar)} sidecar`,
  );
  if (sidecarTeam !== hostTeam) {
    throw new Error(
      `${path.basename(sidecar)} TeamIdentifier ${sidecarTeam} does not match host ${hostTeam}.`,
    );
  }
}
execFileSync("xcrun", ["stapler", "validate", appPath], { stdio: "inherit" });
execFileSync(
  "spctl",
  ["--assess", "--type", "execute", "--verbose=2", appPath],
  {
    stdio: "inherit",
  },
);

const baseName = path.basename(appPath, ".app");
const zipPath = path.join(path.dirname(appPath), `${baseName}.zip`);
execFileSync(
  "ditto",
  ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath],
  { stdio: "inherit" },
);

console.log(`Created ${zipPath}`);
