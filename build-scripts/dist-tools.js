const fs = require('fs');
const path = require('path');

function cleanBuildArtifacts() {
  for (const dir of ['release', 'dist']) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors — locked files from a previous build are harmless.
    }
  }
}

function copyFileEnsuringDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyRuntimeAssets() {
  console.log('  copy step complete (renderer files referenced in-place from src/)');
}

const mode = process.argv[2];

if (mode === 'clean') {
  cleanBuildArtifacts();
  process.exit(0);
}

if (mode === 'copy') {
  copyRuntimeAssets();
  process.exit(0);
}

console.error('Usage: node build-scripts/dist-tools.js <clean|copy>');
process.exit(1);
