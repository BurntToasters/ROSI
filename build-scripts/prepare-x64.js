const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const projectRoot = path.resolve(__dirname, '..');
const buildScriptsDir = __dirname;
const x64Binary = path.join(projectRoot, 'assets', 'yt-dlp.exe');
const arm64Binary = path.join(projectRoot, 'assets', 'yt-dlp_arm64.exe');
const arm64BackupPath = path.join(buildScriptsDir, 'yt-dlp_arm64.exe.bak');

const baseConfigPath = path.join(projectRoot, 'electron-builder.base.yml');
const baseConfigBackup = path.join(buildScriptsDir, 'electron-builder.base.yml.bak');

console.log('Backing up electron-builder.base.yml...');
fs.copyFileSync(baseConfigPath, baseConfigBackup);

if (fs.existsSync(arm64Binary)) {
  console.log('Backing up ARM64 binary for x64 build...');
  fs.copyFileSync(arm64Binary, arm64BackupPath);
  fs.unlinkSync(arm64Binary);
}

if (!fs.existsSync(x64Binary)) {
  console.error('ERROR: yt-dlp.exe (x64) not found!');
  process.exit(1);
}

const config = yaml.load(fs.readFileSync(baseConfigPath, 'utf8'));
config.win.asarUnpack = ['assets/yt-dlp.exe'];
fs.writeFileSync(baseConfigPath, yaml.dump(config));

const msStoreConfigPath = path.join(__dirname, '..', 'electron-builder.msstore.yml');
if (fs.existsSync(msStoreConfigPath)) {
  const msConfig = yaml.load(fs.readFileSync(msStoreConfigPath, 'utf8'));
  if (!msConfig.asarUnpack) msConfig.asarUnpack = [];
  if (!msConfig.asarUnpack.includes('assets/yt-dlp.exe')) {
    msConfig.asarUnpack.push('assets/yt-dlp.exe');
    fs.writeFileSync(msStoreConfigPath, yaml.dump(msConfig));
  }
}

console.log('Prepared for x64 build');
