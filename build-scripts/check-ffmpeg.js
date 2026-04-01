const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectRoot = path.resolve(__dirname, '..');
const checksumsPath = path.join(projectRoot, 'resources', 'ffmpeg', 'checksums.json');

const REQUIRED_BINARIES = {
  win: {
    x64: 'resources/ffmpeg/win/x64/ffmpeg.exe',
    arm64: 'resources/ffmpeg/win/arm64/ffmpeg.exe',
  },
  mac: {
    x64: 'resources/ffmpeg/mac/x64/ffmpeg',
    arm64: 'resources/ffmpeg/mac/arm64/ffmpeg',
  },
  linux: {
    x64: 'resources/ffmpeg/linux/x64/ffmpeg',
    arm64: 'resources/ffmpeg/linux/arm64/ffmpeg',
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
    'Usage: node build-scripts/check-ffmpeg.js [--all] [--current] [--target <platform:arch>]... [--generate-checksums]'
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

  return { targets: resolvedTargets, generateChecksums };
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
    const relativePath = REQUIRED_BINARIES[target.platform][target.arch];
    const absolutePath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
      console.error(`Cannot generate checksum — binary missing: ${relativePath}`);
      process.exit(1);
    }
    const key = `${target.platform}:${target.arch}`;
    manifest[key] = {
      path: relativePath,
      sha256: computeSha256(absolutePath),
    };
  }
  fs.writeFileSync(checksumsPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Checksums written to resources/ffmpeg/checksums.json`);
}

function validateTargets(targets) {
  const missing = [];
  const checksumErrors = [];
  const manifest = loadChecksums();

  for (const target of targets) {
    const relativePath = REQUIRED_BINARIES[target.platform][target.arch];
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

    if (manifest) {
      const key = `${target.platform}:${target.arch}`;
      const entry = manifest[key];
      if (!entry) {
        checksumErrors.push(`${key} -> no checksum entry in manifest`);
      } else {
        const actual = computeSha256(absolutePath);
        if (actual !== entry.sha256) {
          checksumErrors.push(
            `${key} -> SHA-256 mismatch\n  expected: ${entry.sha256}\n  actual:   ${actual}`
          );
        }
      }
    }
  }

  if (missing.length > 0) {
    console.error('\nFFmpeg prebuild check failed.');
    console.error('Missing required binaries for target architectures:');
    for (const item of missing) {
      console.error(`- ${item}`);
    }
    console.error('\nSee resources/ffmpeg/README.md for the required structure.');
    process.exit(1);
  }

  if (checksumErrors.length > 0) {
    console.error('\nFFmpeg checksum verification failed.');
    for (const item of checksumErrors) {
      console.error(`- ${item}`);
    }
    console.error('\nRegenerate with: node build-scripts/check-ffmpeg.js --generate-checksums');
    process.exit(1);
  }
}

const { targets, generateChecksums: shouldGenerate } = parseArgs(process.argv.slice(2));
if (shouldGenerate) {
  validateTargets(targets);
  generateChecksumManifest(targets);
} else {
  validateTargets(targets);
}
const checksumNote = loadChecksums() ? ' (checksums verified)' : ' (no checksum manifest found)';
console.log(
  `FFmpeg prebuild check passed for: ${targets.map((t) => `${t.platform}:${t.arch}`).join(', ')}${checksumNote}`
);
