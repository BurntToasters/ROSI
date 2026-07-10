// @ts-check
'use strict';

/**
 * get-ffmpeg.js
 *
 * Downloads ffmpeg/ffprobe binaries from the internal server defined by
 * FFMPEG_DL_SERVER in .env, then extracts them into resources/ffmpeg/.
 *
 * Usage:
 *   node build-scripts/get-ffmpeg.js               # current OS (x64 and arm64)
 *   node build-scripts/get-ffmpeg.js --all          # all 6 platform/arch combos
 *   node build-scripts/get-ffmpeg.js --target mac:arm64 --target win:x64
 *
 * Requires: 7z or 7zz installed and on PATH
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFileSync } = require('child_process');

// Load .env (FFMPEG_DL_SERVER lives here)
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const projectRoot = path.resolve(__dirname, '..');

// ─── Platform / arch maps ────────────────────────────────────────────────────

/** Maps process.platform / user-facing aliases → internal dir name */
const PLATFORM_DIR = {
  win32: 'win',
  darwin: 'mac',
  linux: 'linux',
  win: 'win',
  mac: 'mac',
};

/** Maps internal dir name → server filename segment */
const PLATFORM_URL_SEGMENT = {
  win: 'win',
  mac: 'macOS',
  linux: 'linux',
};

const ARCH_ALIASES = {
  x64: 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
};

/** All supported targets */
const ALL_TARGETS = [
  { platform: 'win', arch: 'x64' },
  { platform: 'win', arch: 'arm64' },
  { platform: 'mac', arch: 'x64' },
  { platform: 'mac', arch: 'arm64' },
  { platform: 'linux', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePlatform(value) {
  return PLATFORM_DIR[value] || null;
}

function normalizeArch(value) {
  return ARCH_ALIASES[value] || null;
}

function usage() {
  console.error(
    'Usage: node build-scripts/get-ffmpeg.js [--all] [--target <platform:arch>]...\n' +
      '  Platforms: win, mac, linux\n' +
      '  Architectures: x64, arm64\n' +
      '  Default: current OS (x64 and arm64)\n' +
      '\n' +
      '  Requires FFMPEG_DL_SERVER to be set in .env'
  );
  process.exit(1);
}

function parseArgs(args) {
  let explicitAll = false;
  const targets = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      explicitAll = true;
      continue;
    }
    if (arg === '--target') {
      const value = args[i + 1];
      if (!value) usage();
      const parts = value.split(':');
      if (parts.length !== 2) {
        console.error(`Invalid target format "${value}". Expected <platform:arch>, e.g. mac:arm64`);
        process.exit(1);
      }
      const platform = normalizePlatform(parts[0]);
      const arch = normalizeArch(parts[1]);
      if (!platform || !arch) {
        console.error(
          `Invalid target "${value}". Valid platforms: win, mac, linux. Valid arches: x64, arm64.`
        );
        process.exit(1);
      }
      targets.push({ platform, arch });
      i++;
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    usage();
  }

  if (explicitAll) {
    return ALL_TARGETS;
  }

  if (targets.length > 0) {
    // Deduplicate
    const seen = new Set();
    return targets.filter(({ platform, arch }) => {
      const key = `${platform}:${arch}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Default: current OS, both x64 and arm64 architectures
  const platform = normalizePlatform(process.platform);
  if (!platform) {
    console.error(`Unsupported current platform: ${process.platform}`);
    process.exit(1);
  }
  return [
    { platform, arch: 'x64' },
    { platform, arch: 'arm64' },
  ];
}

/** Download a URL to a local file path, following redirects. */
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let receivedBytes = 0;
    let totalBytes = 0;
    let lastLoggedPercent = -1;

    function doRequest(requestUrl) {
      const proto = requestUrl.startsWith('https://') ? https : http;
      proto
        .get(requestUrl, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
            const location = res.headers['location'];
            if (!location) {
              reject(new Error(`Redirect with no Location header from ${requestUrl}`));
              return;
            }
            res.resume();
            doRequest(location);
            return;
          }

          if (res.statusCode !== 200) {
            file.close();
            fs.unlink(destPath, () => {});
            reject(new Error(`HTTP ${res.statusCode} for ${requestUrl}`));
            return;
          }

          totalBytes = parseInt(res.headers['content-length'] || '0', 10);

          res.on('data', (chunk) => {
            receivedBytes += chunk.length;
            if (totalBytes > 0) {
              const pct = Math.floor((receivedBytes / totalBytes) * 100);
              if (pct !== lastLoggedPercent && pct % 10 === 0) {
                process.stdout.write(`  ${pct}%\r`);
                lastLoggedPercent = pct;
              }
            }
          });

          res.pipe(file);
          file.on('finish', () => {
            file.close(() => resolve());
          });
          file.on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
          });
        })
        .on('error', (err) => {
          file.close();
          fs.unlink(destPath, () => {});
          reject(err);
        });
    }

    doRequest(url);
  });
}

/** Find the 7z executable: prefer 7zz (standalone), fall back to 7z. */
function find7z() {
  for (const bin of ['7zz', '7z']) {
    try {
      execFileSync(bin, ['i'], { stdio: 'ignore' });
      return bin;
    } catch {
      // not found or errored — try next
    }
  }
  return null;
}

/** Extract a .7z archive into a destination directory. */
function extract7z(sevenZipBin, archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync(sevenZipBin, ['x', archivePath, `-o${destDir}`, '-y'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Validate FFMPEG_DL_SERVER
  const serverBase = process.env.FFMPEG_DL_SERVER;
  if (!serverBase) {
    console.error('\nError: FFMPEG_DL_SERVER is not set.');
    console.error('Add it to your .env file:');
    console.error('  FFMPEG_DL_SERVER=https://your-server.example/ffmpeg/latest/');
    process.exit(1);
  }
  const base = serverBase.replace(/\/$/, ''); // strip trailing slash

  // Validate 7z
  const sevenZipBin = find7z();
  if (!sevenZipBin) {
    console.error('\nError: 7z (or 7zz) not found on PATH.');
    console.error('Install it first:');
    console.error('  macOS:  brew install sevenzip');
    console.error('  Linux:  sudo apt install p7zip-full');
    console.error('  Win:    winget install 7zip.7zip');
    process.exit(1);
  }

  const targets = parseArgs(process.argv.slice(2));

  console.log(
    `\nDownloading ffmpeg binaries for: ${targets.map((t) => `${t.platform}:${t.arch}`).join(', ')}`
  );
  console.log(`Server: ${base}\n`);

  for (const { platform, arch } of targets) {
    const urlSegment = PLATFORM_URL_SEGMENT[platform];
    const filename = `ffmpeg_${urlSegment}_${arch}.7z`;
    const url = `${base}/${filename}`;
    const tmpFile = path.join(projectRoot, filename);
    const destDir = path.join(projectRoot, 'resources', 'ffmpeg', platform, arch);

    console.log(`[${platform}:${arch}] Downloading ${filename} ...`);
    try {
      await download(url, tmpFile);
    } catch (err) {
      console.error(`\n[${platform}:${arch}] Download failed: ${err.message}`);
      process.exit(1);
    }
    console.log(`[${platform}:${arch}] Download complete.`);

    console.log(`[${platform}:${arch}] Extracting to resources/ffmpeg/${platform}/${arch}/ ...`);
    try {
      extract7z(sevenZipBin, tmpFile, destDir);
    } catch (err) {
      console.error(`\n[${platform}:${arch}] Extraction failed: ${err.message}`);
      // Clean up archive
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
      process.exit(1);
    }

    // Clean up archive
    try {
      fs.unlinkSync(tmpFile);
    } catch (err) {
      console.warn(`[${platform}:${arch}] Warning: could not delete temp archive: ${err.message}`);
    }

    console.log(`[${platform}:${arch}] Done.\n`);
  }

  console.log(
    `✓ ffmpeg binaries ready for: ${targets.map((t) => `${t.platform}:${t.arch}`).join(', ')}`
  );
  console.log(`  Run 'npm run ffmpeg:check:current' to verify.\n`);
}

main().catch((err) => {
  console.error('\nUnexpected error:', err);
  process.exit(1);
});
