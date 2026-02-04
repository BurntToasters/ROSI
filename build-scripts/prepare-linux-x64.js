const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const projectRoot = path.resolve(__dirname, '..');
const buildScriptsDir = __dirname;
const x64Binary = path.join(projectRoot, 'assets', 'yt-dlp_linux');
const arm64Binary = path.join(projectRoot, 'assets', 'yt-dlp_linux_aarch64');
const arm64BackupPath = path.join(buildScriptsDir, 'yt-dlp_linux_aarch64.bak');

const packageJsonPath = path.join(projectRoot, 'package.json');
const packageJsonBackup = path.join(buildScriptsDir, 'package.json.bak');
const baseConfigPath = path.join(projectRoot, 'electron-builder.base.yml');
const baseConfigBackup = path.join(buildScriptsDir, 'electron-builder.base.yml.bak');

if (!fs.existsSync(packageJsonBackup)) {
  console.log('Backing up package.json...');
  fs.copyFileSync(packageJsonPath, packageJsonBackup);
}

if (fs.existsSync(baseConfigPath) && !fs.existsSync(baseConfigBackup)) {
  console.log('Backing up electron-builder.base.yml...');
  fs.copyFileSync(baseConfigPath, baseConfigBackup);
}

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
const packageJson = require(packageJsonPath);
packageJson.build.linux.asarUnpack = ['assets/yt-dlp_linux'];
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

if (fs.existsSync(baseConfigPath)) {
  const config = yaml.load(fs.readFileSync(baseConfigPath, 'utf8'));
  if (config.linux) {
    config.linux.asarUnpack = ['assets/yt-dlp_linux'];
  }
  fs.writeFileSync(baseConfigPath, yaml.dump(config));
}

console.log('Prepared for Linux x64 build');
