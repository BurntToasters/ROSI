const path = require('node:path');
const skipWindowsCodeSigning = process.env.SKIP_WIN_CODESIGN?.trim() === '1';

const required = [
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_ARTIFACT_SIGNING_ENDPOINT',
  'AZURE_ARTIFACT_SIGNING_ACCOUNT',
  'AZURE_ARTIFACT_SIGNING_PROFILE',
  'AZURE_ARTIFACT_SIGNING_PUBLISHER',
];
const missing = skipWindowsCodeSigning ? [] : required.filter((name) => !process.env[name]?.trim());
if (process.platform !== 'win32') throw new Error('Signed Windows builds must run on Windows.');
if (missing.length)
  throw new Error(`Missing Artifact Signing environment variables: ${missing.join(', ')}`);
if (skipWindowsCodeSigning)
  console.warn('[electron-builder] SKIP_WIN_CODESIGN=1; producing unsigned Windows artifacts.');

module.exports = {
  extends: path.resolve(
    process.env.ELECTRON_BUILDER_WINDOWS_BASE_CONFIG || 'electron-builder.base.yml'
  ),
  forceCodeSigning: !skipWindowsCodeSigning,
  win: {
    ...(skipWindowsCodeSigning
      ? {
          signtoolOptions: {
            signingHashAlgorithms: ['sha256'],
            sign: path.join(__dirname, 'electron-builder-artifact-sign.cjs'),
          },
        }
      : {
          signtoolOptions: {
            publisherName: process.env.AZURE_ARTIFACT_SIGNING_PUBLISHER.trim(),
            signingHashAlgorithms: ['sha256'],
            sign: path.join(__dirname, 'electron-builder-artifact-sign.cjs'),
          },
        }),
  },
};
