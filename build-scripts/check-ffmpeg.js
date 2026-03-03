const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

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
    'Usage: node build-scripts/check-ffmpeg.js [--all] [--current] [--target <platform:arch>]...'
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

  if (explicitAll) {
    return allTargets();
  }

  if (includeCurrent) {
    const platform = normalizePlatform(process.platform);
    const arch = normalizeArch(process.arch);
    if (!platform || !arch || !REQUIRED_BINARIES[platform]?.[arch]) {
      console.error(`Current runtime target is unsupported: ${process.platform}:${process.arch}`);
      process.exit(1);
    }
    targets.push({ platform, arch });
  }

  if (targets.length === 0) {
    return allTargets();
  }

  return dedupeTargets(targets);
}

function validateTargets(targets) {
  const missing = [];

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
}

const targets = parseArgs(process.argv.slice(2));
validateTargets(targets);
console.log(
  `FFmpeg prebuild check passed for: ${targets.map((t) => `${t.platform}:${t.arch}`).join(', ')}`
);
