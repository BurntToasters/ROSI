const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const projectRoot = path.resolve(__dirname, '..');
const x64Binary = path.join(projectRoot, 'yt-dlp_linux');
const arm64Binary = path.join(projectRoot, 'yt-dlp_linux_aarch64');
const arm64BackupPath = path.join(projectRoot, 'build-scripts', 'yt-dlp_linux_aarch64.bak');

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

// Update package.json asarUnpack for Linux x64
const packageJsonPath = path.join(projectRoot, 'package.json');
const packageJson = require(packageJsonPath);
packageJson.build.linux.asarUnpack = ['yt-dlp_linux'];
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

const baseConfigPath = path.join(projectRoot, 'electron-builder.base.yml');
if (fs.existsSync(baseConfigPath)) {
  const config = yaml.load(fs.readFileSync(baseConfigPath, 'utf8'));
  if (config.linux) {
    config.linux.asarUnpack = ['yt-dlp_linux'];
  }
  fs.writeFileSync(baseConfigPath, yaml.dump(config));
}

console.log('Prepared for Linux x64 build');
