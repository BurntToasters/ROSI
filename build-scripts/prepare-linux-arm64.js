const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const x64Binary = path.join(projectRoot, 'yt-dlp_linux');
const arm64Binary = path.join(projectRoot, 'yt-dlp_linux_aarch64');
const x64BackupPath = path.join(projectRoot, 'build-scripts', 'yt-dlp_linux.bak');

if (fs.existsSync(x64Binary)) {
  console.log('Backing up x64 binary for ARM64 build...');
  fs.copyFileSync(x64Binary, x64BackupPath);
  fs.unlinkSync(x64Binary);
}

if (!fs.existsSync(arm64Binary)) {
  console.error('ERROR: yt-dlp_linux_aarch64 (ARM64) not found!');
  process.exit(1);
}

const packageJsonPath = path.join(projectRoot, 'package.json');
const packageJson = require(packageJsonPath);
packageJson.build.linux.asarUnpack = ['yt-dlp_linux_aarch64'];

if (packageJson.build && packageJson.build.linux) {
  const config = packageJson.build.linux;
  if (config.asarUnpack && !config.asarUnpack.includes('yt-dlp_linux_aarch64')) {
    config.asarUnpack = ['yt-dlp_linux_aarch64'];
  }
}

fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

console.log('Prepared for Linux ARM64 build');
