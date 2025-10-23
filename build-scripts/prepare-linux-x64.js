const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const x64Binary = path.join(projectRoot, 'yt-dlp_linux');
const arm64Binary = path.join(projectRoot, 'yt-dlp_linux_aarch64');
const arm64BackupPath = path.join(projectRoot, 'build-scripts', 'yt-dlp_linux_aarch64.bak');

if (fs.existsSync(arm64Binary)) {
  console.log('Backing up ARM64 binary for x64 build...');
  fs.copyFileSync(arm64Binary, arm64BackupPath);
  fs.unlinkSync(arm64Binary);
}

if (!fs.existsSync(x64Binary)) {
  console.error('ERROR: yt-dlp_linux (x64) not found!');
  process.exit(1);
}

const packageJsonPath = path.join(projectRoot, 'package.json');
const packageJson = require(packageJsonPath);
packageJson.build.linux.asarUnpack = ['yt-dlp_linux'];

if (packageJson.build && packageJson.build.linux) {
  const config = packageJson.build.linux;
  if (config.asarUnpack && !config.asarUnpack.includes('yt-dlp_linux')) {
    config.asarUnpack = ['yt-dlp_linux'];
  }
}

fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

console.log('Prepared for Linux x64 build');
