"use strict";

/**
 * yt-dlp offline integrity gate.
 *
 * Checks the committed manifest (assets/ytdlp-checksums.json) against the
 * binaries and license file on disk, and checks that the Tauri resource path
 * names the same license file. It does not contact the network.
 *
 * Provenance comes from scripts/fetch-ytdlp.cjs, which verifies each binary
 * against the GPG-signed upstream SHA2-256SUMS before writing it. Run
 * `npm run ytdlp:fetch:all` to (re)populate assets/ from the manifest.
 *
 * Usage:
 *   node scripts/check-ytdlp.cjs    verify (default; exits 1 on any mismatch)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const ASSETS_DIR = path.join(ROOT, "assets");
const MANIFEST_PATH = path.join(ASSETS_DIR, "ytdlp-checksums.json");
const TAURI_CONF_PATH = path.join(ROOT, "src-tauri", "tauri.conf.json");

// All per-platform yt-dlp binaries ROSI can ship (mirrors fetch-ytdlp.cjs).
const BINARY_NAMES = [
  "yt-dlp.exe",
  "yt-dlp_arm64.exe",
  "yt-dlp_macos",
  "yt-dlp_linux",
  "yt-dlp_linux_aarch64",
];

const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/;

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

/**
 * @param {{assetsDir?: string, manifestPath?: string, tauriConfPath?: string}} [paths]
 * @returns {{errors: string[], warnings: string[], verified: string[]}}
 */
function verifyAssets(paths = {}) {
  const assetsDir = paths.assetsDir || ASSETS_DIR;
  const manifestPath = paths.manifestPath || MANIFEST_PATH;
  const tauriConfPath = paths.tauriConfPath || TAURI_CONF_PATH;
  const errors = [];
  const warnings = [];
  const verified = [];

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      errors: [
        `Could not read yt-dlp manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      ],
      warnings,
      verified,
    };
  }

  if (manifest && manifest.binaries && !manifest.files) {
    errors.push(
      "yt-dlp manifest is in the old format (binaries key). Re-fetch with: npm run ytdlp:fetch:all",
    );
    return { errors, warnings, verified };
  }
  if (!manifest || !VERSION_PATTERN.test(manifest.version || "")) {
    errors.push("yt-dlp manifest has no valid version");
    return { errors, warnings, verified };
  }
  const files = manifest.files || {};
  const license = manifest.license || {};
  const licenseName = `yt-dlp-${manifest.version}-THIRD_PARTY_LICENSES.txt`;
  if (license.file !== licenseName) {
    errors.push(
      `yt-dlp manifest license file ${license.file} does not match version ${manifest.version}`,
    );
  }

  const present = BINARY_NAMES.filter((name) =>
    fs.existsSync(path.join(assetsDir, name)),
  );
  if (present.length === 0) {
    errors.push(
      "No yt-dlp binaries found in assets/. Fetch them with: npm run ytdlp:fetch",
    );
  }

  for (const name of present) {
    const expected = files[name];
    if (!expected) {
      errors.push(`${name}: present on disk but missing from the manifest`);
      continue;
    }
    const actual = sha256(path.join(assetsDir, name));
    if (actual !== expected) {
      errors.push(
        `${name}: SHA-256 mismatch (expected ${expected}, actual ${actual}). Re-fetch with: npm run ytdlp:fetch:all`,
      );
      continue;
    }
    verified.push(name);
  }

  for (const name of Object.keys(files)) {
    if (!present.includes(name)) {
      warnings.push(`${name} is in the manifest but not present on disk`);
    }
  }

  const licensePath = path.join(assetsDir, license.file || "");
  if (!license.file || !fs.existsSync(licensePath)) {
    errors.push(`yt-dlp license file missing: assets/${license.file}`);
  } else if (sha256(licensePath) !== license.sha256) {
    errors.push(
      `yt-dlp license file ${license.file}: SHA-256 mismatch against the manifest`,
    );
  }

  if (!fs.existsSync(tauriConfPath)) {
    errors.push(`Tauri config not found: ${tauriConfPath}`);
  } else {
    const conf = fs.readFileSync(tauriConfPath, "utf8");
    if (!conf.includes(`"../assets/${license.file}"`)) {
      errors.push(
        `src-tauri/tauri.conf.json does not bundle ../assets/${license.file}`,
      );
    }
  }

  return { errors, warnings, verified };
}

function main() {
  const { errors, warnings, verified } = verifyAssets();
  for (const warning of warnings) {
    console.warn(`  (note) ${warning}.`);
  }
  if (errors.length > 0) {
    console.error("\n✗ yt-dlp integrity check failed:");
    for (const item of errors) {
      console.error(`- ${item}`);
    }
    process.exit(1);
  }
  console.log(`✓ yt-dlp integrity verified (${verified.length} binaries).`);
}

module.exports = { BINARY_NAMES, verifyAssets };

if (require.main === module) {
  main();
}
