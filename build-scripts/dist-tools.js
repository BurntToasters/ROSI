/**
 * dist-tools.js — clean build artifacts and copy renderer assets after tsc
 *
 * Usage:
 *   node build-scripts/dist-tools.js clean      — remove dist/
 *   node build-scripts/dist-tools.js cleanall    — remove dist/ and release/
 *   node build-scripts/dist-tools.js copy         — copy renderer assets (no-op currently)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const RELEASE = path.join(ROOT, 'release');

const command = process.argv[2];

function rmdir(dir, label) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`  cleaned ${label}/`);
  }
}

function clean() {
  rmdir(DIST, 'dist');
}

function cleanall() {
  rmdir(DIST, 'dist');
  rmdir(RELEASE, 'release');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function copy() {
  // Renderer files are loaded via loadFile and stay as-is (no tsc).
  // They are referenced from dist/main/main.js via relative path ../../src/renderer/
  // so they don't need to be copied to dist/. But we keep this step for future flexibility.
  console.log('  copy step complete (renderer files referenced in-place from src/)');
}

switch (command) {
  case 'clean':
    clean();
    break;
  case 'cleanall':
    cleanall();
    break;
  case 'copy':
    copy();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Usage: node build-scripts/dist-tools.js [clean|cleanall|copy]');
    process.exit(1);
}
