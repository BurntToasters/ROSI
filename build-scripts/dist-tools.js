const fs = require('fs');
const path = require('path');

const FLATPAK_BUILD_DIR_PREFIX = 'build-dir';
const RENDERER_MODULES_DIR = path.join('src', 'renderer', 'modules');

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
  const dirs = ['dist', ...listFlatpakBuildDirs()];
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
    }
  }

  cleanRendererModuleArtifacts();
}

function cleanReleaseArtifacts() {
  const dirs = ['release'];
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
    }
  }
}

function cleanRendererModuleArtifacts() {
  let entries = [];
  try {
    entries = fs.readdirSync(RENDERER_MODULES_DIR, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const stem = entry.name.slice(0, -3);
    const targets = [`${stem}.js`, `${stem}.js.map`];

    for (const target of targets) {
      const artifactPath = path.join(RENDERER_MODULES_DIR, target);
      try {
        fs.rmSync(artifactPath, { force: true, maxRetries: 8, retryDelay: 100 });
      } catch (error) {
        if (error && error.code === 'ENOENT') continue;
      }
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

if (mode === 'clean-release') {
  cleanReleaseArtifacts();
  process.exit(0);
}

if (mode === 'copy') {
  copyRuntimeAssets();
  process.exit(0);
}

console.error('Usage: node build-scripts/dist-tools.js <clean|clean-release|copy>');
process.exit(1);
