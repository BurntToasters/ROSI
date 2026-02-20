const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const buildScriptsDir = __dirname;
const x64Binary = path.join(projectRoot, 'assets', 'yt-dlp.exe');
const arm64Binary = path.join(projectRoot, 'assets', 'yt-dlp_arm64.exe');
const x64BackupPath = path.join(buildScriptsDir, 'yt-dlp.exe.bak');

if (fs.existsSync(x64Binary)) {
  console.log('Backing up x64 binary for ARM64 build...');
  fs.copyFileSync(x64Binary, x64BackupPath);
  fs.unlinkSync(x64Binary);
}

if (!fs.existsSync(arm64Binary)) {
  console.error('ERROR: yt-dlp_arm64.exe (ARM64) not found!');
  process.exit(1);
}

// extraResources uses a glob filter ('yt-dlp*.exe') so only the
// binaries that remain in assets/ after the backup removal are copied.
// No config patching needed — removing the x64 binary above is enough.

const appOutDir = path.join(projectRoot, 'dist', 'win-arm64-unpacked');
if (fs.existsSync(appOutDir)) {
  console.log(`Ensuring ARM64 binary exists in ${appOutDir}`);
  const destPath = path.join(appOutDir, 'yt-dlp_arm64.exe');
  if (!fs.existsSync(destPath)) {
    fs.copyFileSync(arm64Binary, destPath);
    console.log(`Copied yt-dlp_arm64.exe to ${destPath}`);
  }
}

console.log('Prepared for ARM64 build');
