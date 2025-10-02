const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const x64Binary = path.join(projectRoot, 'yt-dlp.exe');
const arm64Binary = path.join(projectRoot, 'yt-dlp_arm64.exe');
const x64BackupPath = path.join(projectRoot, 'build-scripts', 'yt-dlp.exe.bak');
const arm64BackupPath = path.join(projectRoot, 'build-scripts', 'yt-dlp_arm64.exe.bak');

if (fs.existsSync(x64Binary)) {
  console.log('Backing up x64 binary for ARM64 build...');
  fs.copyFileSync(x64Binary, x64BackupPath);
  fs.unlinkSync(x64Binary);
}

if (fs.existsSync(arm64BackupPath) && !fs.existsSync(arm64Binary)) {
  console.log('Restoring ARM64 binary...');
  fs.copyFileSync(arm64BackupPath, arm64Binary);
}

if (!fs.existsSync(arm64Binary)) {
  console.error('ERROR: yt-dlp_arm64.exe not found!');
  process.exit(1);
}

const packageJsonPath = path.join(projectRoot, 'package.json');
const packageJson = require(packageJsonPath);
packageJson.build.asarUnpack = ['yt-dlp_arm64.exe'];
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

console.log('Prepared for ARM64 build');