const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const projectRoot = path.resolve(__dirname, '..');
const buildScriptsDir = __dirname;

const backupMappings = [
  { backup: path.join(buildScriptsDir, 'yt-dlp.exe.bak'), original: path.join(projectRoot, 'yt-dlp.exe') },
  { backup: path.join(buildScriptsDir, 'yt-dlp_arm64.exe.bak'), original: path.join(projectRoot, 'yt-dlp_arm64.exe') },
  { backup: path.join(buildScriptsDir, 'yt-dlp_linux.bak'), original: path.join(projectRoot, 'yt-dlp_linux') },
  { backup: path.join(buildScriptsDir, 'yt-dlp_linux_aarch64.bak'), original: path.join(projectRoot, 'yt-dlp_linux_aarch64') },
];

let restoredCount = 0;

backupMappings.forEach(({ backup, original }) => {
  if (fs.existsSync(backup)) {
    const binaryName = path.basename(original);
    console.log(`Restoring ${binaryName}...`);

    fs.copyFileSync(backup, original);

    fs.unlinkSync(backup);
    
    console.log(`✓ Restored ${binaryName}`);
    restoredCount++;
  }
});

const packageJsonPath = path.join(projectRoot, 'package.json');
const packageJson = require(packageJsonPath);

packageJson.build.win = packageJson.build.win || {};
packageJson.build.win.asarUnpack = ['yt-dlp.exe', 'yt-dlp_arm64.exe'];

packageJson.build.linux = packageJson.build.linux || {};
packageJson.build.linux.asarUnpack = ['yt-dlp_linux', 'yt-dlp_linux_aarch64'];

fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

const baseConfigPath = path.join(projectRoot, 'electron-builder.base.yml');
if (fs.existsSync(baseConfigPath)) {
  const config = yaml.load(fs.readFileSync(baseConfigPath, 'utf8'));
  
  if (config.win) {
    config.win.asarUnpack = ['yt-dlp.exe', 'yt-dlp_arm64.exe'];
  }
  if (config.linux) {
    config.linux.asarUnpack = ['yt-dlp_linux', 'yt-dlp_linux_aarch64'];
  }
  
  fs.writeFileSync(baseConfigPath, yaml.dump(config));
}

if (restoredCount > 0) {
  console.log(`\n✓ Restored ${restoredCount} backed up binaries and reset config files`);
} else {
  console.log('No backup files found to restore');
}
