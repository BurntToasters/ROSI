const fs = require('fs');
const path = require('path');

const FLATPAK_BUILD_DIR_PREFIX = 'build-dir';

function listFlatpakBuildDirs() {
  try {
    return fs
      .readdirSync('.', { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (entry.name === FLATPAK_BUILD_DIR_PREFIX ||
            entry.name.startsWith(`${FLATPAK_BUILD_DIR_PREFIX}-`))
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function cleanBuildArtifacts() {
  const dirs = ['release', 'dist', ...listFlatpakBuildDirs()];
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
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
