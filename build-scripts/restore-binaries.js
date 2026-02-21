const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const buildScriptsDir = __dirname;

const binaryBackups = [
  {
    backup: path.join(buildScriptsDir, 'yt-dlp.exe.bak'),
    original: path.join(projectRoot, 'assets', 'yt-dlp.exe'),
  },
  {
    backup: path.join(buildScriptsDir, 'yt-dlp_arm64.exe.bak'),
    original: path.join(projectRoot, 'assets', 'yt-dlp_arm64.exe'),
  },
  {
    backup: path.join(buildScriptsDir, 'yt-dlp_linux.bak'),
    original: path.join(projectRoot, 'assets', 'yt-dlp_linux'),
  },
  {
    backup: path.join(buildScriptsDir, 'yt-dlp_linux_aarch64.bak'),
    original: path.join(projectRoot, 'assets', 'yt-dlp_linux_aarch64'),
  },
];

const configBackups = [];

let restoredBinaries = 0;
let restoredConfigs = 0;

binaryBackups.forEach(({ backup, original }) => {
  if (fs.existsSync(backup)) {
    const binaryName = path.basename(original);
    console.log(`Restoring ${binaryName}...`);
    fs.copyFileSync(backup, original);
    fs.unlinkSync(backup);
    console.log(`✓ Restored ${binaryName}`);
    restoredBinaries++;
  }
});

configBackups.forEach(({ backup, original }) => {
  if (fs.existsSync(backup)) {
    const configName = path.basename(original);
    console.log(`Restoring ${configName}...`);
    fs.copyFileSync(backup, original);
    fs.unlinkSync(backup);
    console.log(`✓ Restored ${configName}`);
    restoredConfigs++;
  }
});

if (restoredBinaries > 0 || restoredConfigs > 0) {
  console.log(`\n✓ Restored ${restoredBinaries} binaries and ${restoredConfigs} config files`);
} else {
  console.log('No backup files found to restore');
}
