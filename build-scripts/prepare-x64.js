const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const buildScriptsDir = __dirname;
const x64Binary = path.join(projectRoot, 'assets', 'yt-dlp.exe');
const arm64Binary = path.join(projectRoot, 'assets', 'yt-dlp_arm64.exe');
const arm64BackupPath = path.join(buildScriptsDir, 'yt-dlp_arm64.exe.bak');

if (fs.existsSync(arm64Binary)) {
  console.log('Backing up ARM64 binary for x64 build...');
  fs.copyFileSync(arm64Binary, arm64BackupPath);
  fs.unlinkSync(arm64Binary);
}

if (!fs.existsSync(x64Binary)) {
  console.error('ERROR: yt-dlp.exe (x64) not found!');
  process.exit(1);
}

// extraResources uses a glob filter ('yt-dlp*.exe') so only the
// binaries that remain in assets/ after the backup removal are copied.
// No config patching needed — removing the arm64 binary above is enough.

console.log('Prepared for x64 build');
