const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectRoot = path.resolve(__dirname, '..');
const checksumsPath = path.join(projectRoot, 'resources', 'ffmpeg', 'checksums.json');

const REQUIRED_BINARIES = {
  win: {
    x64: {
      ffmpeg: 'resources/ffmpeg/win/x64/ffmpeg.exe',
      ffprobe: 'resources/ffmpeg/win/x64/ffprobe.exe',
    },
    arm64: {
      ffmpeg: 'resources/ffmpeg/win/arm64/ffmpeg.exe',
      ffprobe: 'resources/ffmpeg/win/arm64/ffprobe.exe',
    },
  },
  mac: {
    x64: {
      ffmpeg: 'resources/ffmpeg/mac/x64/ffmpeg',
      ffprobe: 'resources/ffmpeg/mac/x64/ffprobe',
    },
    arm64: {
      ffmpeg: 'resources/ffmpeg/mac/arm64/ffmpeg',
      ffprobe: 'resources/ffmpeg/mac/arm64/ffprobe',
    },
  },
  linux: {
    x64: {
      ffmpeg: 'resources/ffmpeg/linux/x64/ffmpeg',
      ffprobe: 'resources/ffmpeg/linux/x64/ffprobe',
    },
    arm64: {
      ffmpeg: 'resources/ffmpeg/linux/arm64/ffmpeg',
      ffprobe: 'resources/ffmpeg/linux/arm64/ffprobe',
    },
  },
};

const PLATFORM_ALIASES = {
  win32: 'win',
  darwin: 'mac',
  linux: 'linux',
  win: 'win',
  mac: 'mac',
};

const ARCH_ALIASES = {
  x64: 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
};

function normalizePlatform(value) {
  return PLATFORM_ALIASES[value] || null;
}

function normalizeArch(value) {
  return ARCH_ALIASES[value] || null;
}

function usage() {
  console.error(
    'Usage: node build-scripts/check-ffmpeg.js [--all] [--current] [--target <platform:arch>]... [--generate-checksums] [--require-checksums]\n' +
      '  Checksum mismatches are warnings by default; add --require-checksums to make them fatal.'
  );
  process.exit(1);
}

function allTargets() {
  const targets = [];
  for (const [platform, archMap] of Object.entries(REQUIRED_BINARIES)) {
    for (const arch of Object.keys(archMap)) {
      targets.push({ platform, arch });
    }
  }
  return targets;
}

function parseTarget(rawTarget) {
  const parts = rawTarget.split(':');
  if (parts.length !== 2) {
    return null;
  }

  const platform = normalizePlatform(parts[0]);
  const arch = normalizeArch(parts[1]);
  if (!platform || !arch) {
    return null;
  }
  if (!REQUIRED_BINARIES[platform] || !REQUIRED_BINARIES[platform][arch]) {
    return null;
  }
  return { platform, arch };
}

function dedupeTargets(targets) {
  const seen = new Set();
  const unique = [];
  for (const target of targets) {
    const key = `${target.platform}:${target.arch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(target);
  }
  return unique;
}

function parseArgs(args) {
  let explicitAll = false;
  let includeCurrent = false;
  let generateChecksums = false;
  let requireChecksums = false;
  const targets = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--all') {
      explicitAll = true;
      continue;
    }
    if (arg === '--current') {
      includeCurrent = true;
      continue;
    }
    if (arg === '--generate-checksums') {
      generateChecksums = true;
      continue;
    }
    if (arg === '--require-checksums') {
      requireChecksums = true;
      continue;
    }
    if (arg === '--target') {
      const value = args[i + 1];
      if (!value) usage();
      const parsed = parseTarget(value);
      if (!parsed) {
        console.error(
          `Invalid target "${value}". Expected one of: win:x64, win:arm64, mac:x64, mac:arm64, linux:x64, linux:arm64.`
        );
        process.exit(1);
      }
      targets.push(parsed);
      i += 1;
      continue;
    }
    usage();
  }

  let resolvedTargets;
  if (explicitAll) {
    resolvedTargets = allTargets();
  } else if (includeCurrent) {
    const platform = normalizePlatform(process.platform);
    const arch = normalizeArch(process.arch);
    if (!platform || !arch || !REQUIRED_BINARIES[platform]?.[arch]) {
      console.error(`Current runtime target is unsupported: ${process.platform}:${process.arch}`);
      process.exit(1);
    }
    targets.push({ platform, arch });
    resolvedTargets = dedupeTargets(targets);
  } else if (targets.length === 0) {
    resolvedTargets = allTargets();
  } else {
    resolvedTargets = dedupeTargets(targets);
  }

  return { targets: resolvedTargets, generateChecksums, requireChecksums };
}

function computeSha256(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function loadChecksums() {
  if (!fs.existsSync(checksumsPath)) return null;
  return JSON.parse(fs.readFileSync(checksumsPath, 'utf8'));
}

function generateChecksumManifest(targets) {
  const manifest = loadChecksums() || {};
  for (const target of targets) {
    const required = REQUIRED_BINARIES[target.platform][target.arch];
    const key = `${target.platform}:${target.arch}`;
    const binaries = {};

    for (const [binaryName, relativePath] of Object.entries(required)) {
      const absolutePath = path.join(projectRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        console.error(`Cannot generate checksum - binary missing: ${relativePath}`);
        process.exit(1);
      }
      binaries[binaryName] = {
        path: relativePath,
        sha256: computeSha256(absolutePath),
      };
    }

    manifest[key] = {
      binaries,
    };
  }
  fs.writeFileSync(checksumsPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Checksums written to resources/ffmpeg/checksums.json`);
}

function validateTargets(targets, requireChecksums = false) {
  const missing = [];
  const checksumErrors = [];
  const manifest = loadChecksums();

  if (requireChecksums && !manifest) {
    console.error('\nFFmpeg/ffprobe checksum verification failed.');
    console.error('- resources/ffmpeg/checksums.json is missing');
    console.error('\nGenerate with: node build-scripts/check-ffmpeg.js --all --generate-checksums');
    process.exit(1);
  }

  for (const target of targets) {
    const key = `${target.platform}:${target.arch}`;
    const required = REQUIRED_BINARIES[target.platform][target.arch];
    const entry = manifest?.[key];

    for (const [binaryName, relativePath] of Object.entries(required)) {
      const absolutePath = path.join(projectRoot, relativePath);
      if (!fs.existsSync(absolutePath)) {
        missing.push(`${target.platform}:${target.arch} -> ${relativePath}`);
        continue;
      }

      const stats = fs.statSync(absolutePath);
      if (!stats.isFile()) {
        missing.push(`${target.platform}:${target.arch} -> ${relativePath} (not a file)`);
        continue;
      }

      if (!manifest) {
        continue;
      }

      if (!entry) {
        checksumErrors.push(`${key} -> no checksum entry in manifest`);
        continue;
      }

      const binaryEntry =
        entry.binaries?.[binaryName] ??
        (binaryName === 'ffmpeg' && entry.path && entry.sha256
          ? { path: entry.path, sha256: entry.sha256 }
          : null);

      if (!binaryEntry) {
        checksumErrors.push(`${key} -> no checksum entry for ${binaryName}`);
        continue;
      }

      if (binaryEntry.path !== relativePath) {
        checksumErrors.push(
          `${key} -> checksum path mismatch for ${binaryName}\n  expected path: ${relativePath}\n  manifest path: ${binaryEntry.path}`
        );
        continue;
      }

      const actual = computeSha256(absolutePath);
      if (actual !== binaryEntry.sha256) {
        checksumErrors.push(
          `${key} -> SHA-256 mismatch for ${binaryName}\n  expected: ${binaryEntry.sha256}\n  actual:   ${actual}`
        );
      }
    }

    if (manifest && entry && entry.binaries) {
      for (const binaryName of Object.keys(entry.binaries)) {
        if (!Object.prototype.hasOwnProperty.call(required, binaryName)) {
          checksumErrors.push(
            `${key} -> unexpected checksum entry for ${binaryName} (remove stale manifest entry)`
          );
        }
      }
    }
  }

  if (missing.length > 0) {
    console.error('\nFFmpeg/ffprobe prebuild check failed.');
    console.error('Missing required binaries for target architectures:');
    for (const item of missing) {
      console.error(`- ${item}`);
    }
    console.error('\nSee resources/ffmpeg/README.md for the required structure.');
    process.exit(1);
  }

  if (checksumErrors.length > 0) {
    if (requireChecksums) {
      console.error('\nFFmpeg/ffprobe checksum verification failed.');
      for (const item of checksumErrors) {
        console.error(`- ${item}`);
      }
      console.error('\nRegenerate with: node build-scripts/check-ffmpeg.js --generate-checksums');
      process.exit(1);
    } else {
      console.warn(
        '\nFFmpeg/ffprobe checksum warnings (non-fatal; pass --require-checksums to enforce):'
      );
      for (const item of checksumErrors) {
        console.warn(`- ${item}`);
      }
    }
  }
}

const {
  targets,
  generateChecksums: shouldGenerate,
  requireChecksums,
} = parseArgs(process.argv.slice(2));
if (shouldGenerate) {
  validateTargets(targets, requireChecksums);
  generateChecksumManifest(targets);
} else {
  validateTargets(targets, requireChecksums);
}
const checksumNote = loadChecksums() ? ' (checksums verified)' : ' (no checksum manifest found)';
console.log(
  `FFmpeg/ffprobe prebuild check passed for: ${targets.map((t) => `${t.platform}:${t.arch}`).join(', ')}${checksumNote}`
);
