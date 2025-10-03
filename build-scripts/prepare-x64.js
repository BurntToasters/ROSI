const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const projectRoot = path.resolve(__dirname, '..');
const x64Binary = path.join(projectRoot, 'yt-dlp.exe');
const arm64Binary = path.join(projectRoot, 'yt-dlp_arm64.exe');
const arm64BackupPath = path.join(projectRoot, 'build-scripts', 'yt-dlp_arm64.exe.bak');

if (fs.existsSync(arm64Binary)) {
  console.log('Backing up ARM64 binary for x64 build...');
  fs.copyFileSync(arm64Binary, arm64BackupPath);
  fs.unlinkSync(arm64Binary);
}

if (!fs.existsSync(x64Binary)) {
  console.error('ERROR: yt-dlp.exe (x64) not found!');
  process.exit(1);
}

const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = require(packageJsonPath);
packageJson.build.asarUnpack = ['yt-dlp.exe'];
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

const msStoreConfigPath = path.join(__dirname, '..', 'electron-builder.msstore.yml');
if (fs.existsSync(msStoreConfigPath)) {
  const config = yaml.load(fs.readFileSync(msStoreConfigPath, 'utf8'));
  if (!config.asarUnpack) config.asarUnpack = [];
  if (!config.asarUnpack.includes('yt-dlp.exe')) {
    config.asarUnpack.push('yt-dlp.exe');
  }
  fs.writeFileSync(msStoreConfigPath, yaml.dump(config));
}

console.log('Prepared for x64 build');