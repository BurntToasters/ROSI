const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const buildScriptsDir = __dirname;
const x64Binary = path.join(projectRoot, 'assets', 'yt-dlp_linux');
const arm64Binary = path.join(projectRoot, 'assets', 'yt-dlp_linux_aarch64');
const arm64BackupPath = path.join(buildScriptsDir, 'yt-dlp_linux_aarch64.bak');

// Backup ARM64 binary if it exists
if (fs.existsSync(arm64Binary)) {
  console.log('Backing up Linux ARM64 binary for x64 build...');
  fs.copyFileSync(arm64Binary, arm64BackupPath);
  fs.unlinkSync(arm64Binary);
}

// Verify x64 binary exists
if (!fs.existsSync(x64Binary)) {
  console.error('ERROR: yt-dlp_linux (x64) not found!');
  process.exit(1);
}

// extraResources uses a glob filter ('yt-dlp_linux*') so only the
// binaries that remain in assets/ after the backup removal are copied.
// No config patching needed.

console.log('Prepared for Linux x64 build');
