'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Re-sign bundled helper binaries after electron-builder signs the app.
 * PyInstaller sidecars (yt-dlp) extract a Python runtime at launch; without
 * disable-library-validation they fail with Team ID mismatches on macOS.
 */
exports.default = async function signMacHelpers(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const entitlements = path.join(__dirname, '..', 'build', 'entitlements.helper.plist');
  if (!fs.existsSync(entitlements)) {
    console.warn(`[sign-mac-helpers] Entitlements not found: ${entitlements}`);
    return;
  }

  const identity = process.env.CSC_NAME || process.env.APPLE_SIGNING_IDENTITY;
  if (!identity) {
    console.warn('[sign-mac-helpers] No signing identity found; skipping helper re-sign');
    return;
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  const helpers = [
    path.join(resourcesPath, 'assets', 'yt-dlp_macos'),
    path.join(resourcesPath, 'ffmpeg', 'ffmpeg'),
    path.join(resourcesPath, 'ffmpeg', 'ffprobe'),
  ];

  for (const target of helpers) {
    if (!fs.existsSync(target)) {
      console.log(`[sign-mac-helpers] Skipping missing helper: ${target}`);
      continue;
    }

    console.log(`[sign-mac-helpers] Signing ${target}`);
    execFileSync(
      'codesign',
      [
        '--force',
        '--options',
        'runtime',
        '--entitlements',
        entitlements,
        '--sign',
        identity,
        target,
      ],
      { stdio: 'inherit' }
    );
  }
};
