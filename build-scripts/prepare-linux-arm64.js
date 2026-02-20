const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const buildScriptsDir = __dirname;
const x64Binary = path.join(projectRoot, 'assets', 'yt-dlp_linux');
const arm64Binary = path.join(projectRoot, 'assets', 'yt-dlp_linux_aarch64');
const x64BackupPath = path.join(buildScriptsDir, 'yt-dlp_linux.bak');

// Backup x64 binary if it exists
if (fs.existsSync(x64Binary)) {
  console.log('Backing up Linux x64 binary for ARM64 build...');
  fs.copyFileSync(x64Binary, x64BackupPath);
  fs.unlinkSync(x64Binary);
}

// Verify ARM64 binary exists
if (!fs.existsSync(arm64Binary)) {
  console.error('ERROR: yt-dlp_linux_aarch64 (ARM64) not found!');
  process.exit(1);
}

// extraResources uses a glob filter ('yt-dlp_linux*') so only the
// binaries that remain in assets/ after the backup removal are copied.
// No config patching needed.

const appOutDir = path.join(projectRoot, 'dist', 'linux-arm64-unpacked');
if (fs.existsSync(appOutDir)) {
  console.log(`Ensuring ARM64 binary exists in ${appOutDir}`);
  const destPath = path.join(appOutDir, 'yt-dlp_linux_aarch64');
  if (!fs.existsSync(destPath)) {
    fs.copyFileSync(arm64Binary, destPath);
    console.log(`Copied yt-dlp_linux_aarch64 to ${destPath}`);
  }
}

console.log('Prepared for Linux ARM64 build');
