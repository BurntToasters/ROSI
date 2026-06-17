'use strict';

/**
 * yt-dlp binary integrity gate.
 *
 * The yt-dlp binaries are committed under assets/ and shipped verbatim inside
 * the signed installers. This script verifies each committed binary against a
 * checksum manifest (assets/ytdlp-checksums.json) so a corrupted, truncated, or
 * tampered binary cannot be packaged unnoticed.
 *
 * Usage:
 *   node build-scripts/check-ytdlp.js              verify (default; fails on mismatch/missing manifest)
 *   node build-scripts/check-ytdlp.js --generate   (re)write the manifest from the current binaries
 *
 * NOTE ON PROVENANCE: --generate records the hashes of whatever binaries are
 * currently on disk (a self-attested baseline that detects later drift). It does
 * NOT prove the binaries match an upstream yt-dlp release. When updating yt-dlp,
 * download the official binaries, verify them against yt-dlp's published
 * SHA2-256SUMS (and its GPG signature), then run --generate to record the new
 * baseline.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const assetsDir = path.join(__dirname, '..', 'assets');
const manifestPath = path.join(assetsDir, 'ytdlp-checksums.json');

// All per-platform yt-dlp binaries ROSI ships (mirrors getYtdlpBinaryName()).
const BINARY_NAMES = [
  'yt-dlp.exe',
  'yt-dlp_arm64.exe',
  'yt-dlp_macos',
  'yt-dlp_linux',
  'yt-dlp_linux_aarch64',
];

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function presentBinaries() {
  return BINARY_NAMES.filter((name) => fs.existsSync(path.join(assetsDir, name)));
}

function generate() {
  const present = presentBinaries();
  if (present.length === 0) {
    console.error('✗ No yt-dlp binaries found in assets/; nothing to record.');
    process.exit(1);
  }
  const binaries = {};
  for (const name of present) {
    binaries[name] = sha256(path.join(assetsDir, name));
  }
  const manifest = {
    _comment:
      'SHA-256 of the committed yt-dlp binaries. Regenerate ONLY after verifying ' +
      'the binaries against yt-dlp upstream SHA2-256SUMS. See build-scripts/check-ytdlp.js.',
    generatedAt: new Date().toISOString(),
    binaries,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`✓ Wrote ${path.basename(manifestPath)} for ${present.length} binaries.`);
}

function verify() {
  if (!fs.existsSync(manifestPath)) {
    console.error(`✗ yt-dlp checksum manifest not found: ${manifestPath}`);
    console.error('  Generate it with: node build-scripts/check-ytdlp.js --generate');
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    console.error(`✗ Could not parse ${manifestPath}: ${error.message}`);
    process.exit(1);
  }

  const expected = (manifest && manifest.binaries) || {};
  const errors = [];
  const present = presentBinaries();

  if (present.length === 0) {
    console.error('✗ No yt-dlp binaries found in assets/.');
    process.exit(1);
  }

  for (const name of present) {
    const expectedHash = expected[name];
    if (!expectedHash) {
      errors.push(`${name}: present on disk but missing from the manifest`);
      continue;
    }
    const actual = sha256(path.join(assetsDir, name));
    if (actual !== expectedHash) {
      errors.push(
        `${name}: SHA-256 mismatch\n    expected: ${expectedHash}\n    actual:   ${actual}`
      );
    }
  }

  // A manifest entry without a binary on disk is only an error when that binary
  // is required for the current build; here we just warn so single-arch checkouts
  // (where other-arch binaries were temporarily removed) do not fail.
  for (const name of Object.keys(expected)) {
    if (!present.includes(name)) {
      console.warn(`  (note) ${name} is in the manifest but not present on disk.`);
    }
  }

  if (errors.length > 0) {
    console.error('\n✗ yt-dlp integrity check failed:');
    for (const item of errors) {
      console.error(`- ${item}`);
    }
    console.error(
      '\nIf you intentionally updated yt-dlp, verify the new binaries against upstream\n' +
        'SHA2-256SUMS, then run: node build-scripts/check-ytdlp.js --generate'
    );
    process.exit(1);
  }

  console.log(`✓ yt-dlp integrity verified (${present.length} binaries).`);
}

if (process.argv.includes('--generate')) {
  generate();
} else {
  verify();
}
