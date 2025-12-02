const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const projectRoot = path.resolve(__dirname, '..');
const x64Binary = path.join(projectRoot, 'yt-dlp_linux');
const arm64Binary = path.join(projectRoot, 'yt-dlp_linux_aarch64');
const x64BackupPath = path.join(projectRoot, 'build-scripts', 'yt-dlp_linux.bak');

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

// Update package.json asarUnpack for Linux ARM64
const packageJsonPath = path.join(projectRoot, 'package.json');
const packageJson = require(packageJsonPath);
packageJson.build.linux.asarUnpack = ['yt-dlp_linux_aarch64'];
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

// Update electron-builder.base.yml if it exists
const baseConfigPath = path.join(projectRoot, 'electron-builder.base.yml');
if (fs.existsSync(baseConfigPath)) {
  const config = yaml.load(fs.readFileSync(baseConfigPath, 'utf8'));
  if (config.linux) {
    config.linux.asarUnpack = ['yt-dlp_linux_aarch64'];
  }
  fs.writeFileSync(baseConfigPath, yaml.dump(config));
}

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
