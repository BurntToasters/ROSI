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

// The bundled 7-Zip packs ARM64 executables with its ARM64 filter, which the
// NSIS 7z plugin cannot decode: the installer skips Rosi.exe and every ARM64
// DLL, then exits 0. BCJ2 is what v4.0.x shipped and the plugin reads it.
// build-scripts/check-nsis-payload.js rejects any payload that regresses.
process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ2';

module.exports = {
  extends: path.resolve(
    process.env.ELECTRON_BUILDER_WINDOWS_BASE_CONFIG || 'electron-builder.base.yml'
  ),
  forceCodeSigning: !skipWindowsCodeSigning,
  win: {
    ...(skipWindowsCodeSigning
      ? {
          signExecutable: false,
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
