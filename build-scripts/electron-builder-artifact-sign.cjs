const { spawnSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function artifactSign(configuration) {
  if (process.platform !== 'win32') {
    throw new Error('Azure Artifact Signing must run on Windows.');
  }
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'windows-artifact-sign.ps1'),
      '-FilePath',
      configuration.path,
    ],
    { stdio: 'inherit', env: process.env }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Artifact Signing failed for ${configuration.path} (exit ${result.status})`);
  }
};
