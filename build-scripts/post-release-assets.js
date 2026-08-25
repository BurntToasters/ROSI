const fs = require('fs');
const path = require('path');

require('dotenv').config();

const RELEASE_DIR = path.join(__dirname, '..', 'release');

const BUILD_ONLY_DIRECTORIES = [
  'mac-universal',
  'win-unpacked',
  'win-arm64-unpacked',
  'linux-unpacked',
  'linux-arm64-unpacked',
];

const BUILD_ONLY_FILES = ['builder-debug.yml', 'builder-effective-config.yaml'];

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

function cleanReleaseArtifacts(releaseDir = RELEASE_DIR) {
  for (const dir of BUILD_ONLY_DIRECTORIES) {
    removePath(path.join(releaseDir, dir));
  }

  for (const file of BUILD_ONLY_FILES) {
    removePath(path.join(releaseDir, file));
  }
}

function getAfterPackLocation(env = process.env) {
  const value = env.AFTER_PACK_LOC;
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function isBetaReleaseVersion(version) {
  const numeric = '(?:0|[1-9]\\d*)';
  return new RegExp(`^${numeric}\\.${numeric}\\.${numeric}-beta\\.${numeric}$`).test(
    String(version ?? '')
  );
}

function readPackageVersion(repositoryRoot = path.join(__dirname, '..')) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
  );
  return typeof packageJson.version === 'string' ? packageJson.version : '';
}

function shouldSkipBetaMirror(env = process.env, version) {
  if (!isBetaReleaseVersion(version)) {
    return false;
  }
  return String(env.OVERRIDE_BETA_MIRROR_SKIP ?? '').trim() !== '1';
}

function comparablePath(value, platform = process.platform) {
  let resolved = path.resolve(value);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // Destinations and test paths may not exist yet.
  }
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathsEqual(left, right, platform = process.platform) {
  return comparablePath(left, platform) === comparablePath(right, platform);
}

function getReleaseEntries(releaseDir) {
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`release directory does not exist: ${releaseDir}`);
  }
  const entries = fs.readdirSync(releaseDir);
  if (entries.length === 0) {
    throw new Error(`release directory is empty: ${releaseDir}`);
  }
  return entries;
}

function verifyCopiedPath(sourcePath, destinationPath) {
  const source = fs.statSync(sourcePath);
  let destination;
  try {
    destination = fs.statSync(destinationPath);
  } catch {
    throw new Error(`mirrored path is missing: ${destinationPath}`);
  }
  if (source.isDirectory() !== destination.isDirectory()) {
    throw new Error(`mirrored path type differs: ${destinationPath}`);
  }
  if (source.isFile() && source.size !== destination.size) {
    throw new Error(
      `mirrored file size differs: ${destinationPath} (${destination.size} bytes; expected ${source.size})`
    );
  }
  if (source.isDirectory()) {
    for (const entry of fs.readdirSync(sourcePath)) {
      verifyCopiedPath(path.join(sourcePath, entry), path.join(destinationPath, entry));
    }
  }
}

function copyReleaseAssets(releaseDir = RELEASE_DIR, destination) {
  if (!destination) {
    throw new Error('AFTER_PACK_LOC is empty');
  }

  const resolvedReleaseDir = path.resolve(releaseDir);
  const resolvedDestination = path.resolve(destination);

  if (pathsEqual(resolvedDestination, resolvedReleaseDir)) {
    throw new Error('AFTER_PACK_LOC cannot be the release directory');
  }

  const releasePrefix = `${resolvedReleaseDir}${path.sep}`;
  const destinationForComparison =
    process.platform === 'win32' ? resolvedDestination.toLowerCase() : resolvedDestination;
  const releasePrefixForComparison =
    process.platform === 'win32' ? releasePrefix.toLowerCase() : releasePrefix;
  if (destinationForComparison.startsWith(releasePrefixForComparison)) {
    throw new Error('AFTER_PACK_LOC cannot be inside the release directory');
  }

  const entries = getReleaseEntries(resolvedReleaseDir);
  fs.mkdirSync(resolvedDestination, { recursive: true });

  for (const entry of entries) {
    const sourcePath = path.join(resolvedReleaseDir, entry);
    const destinationPath = path.join(resolvedDestination, entry);
    fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true, errorOnExist: false });
    verifyCopiedPath(sourcePath, destinationPath);
  }
  return entries.length;
}

function run({ releaseDir = RELEASE_DIR, env = process.env, version = readPackageVersion() } = {}) {
  cleanReleaseArtifacts(releaseDir);
  if (shouldSkipBetaMirror(env, version)) {
    console.warn(
      `beta version ${version}; skipping AFTER_PACK_LOC mirror (set OVERRIDE_BETA_MIRROR_SKIP=1 to force).`
    );
    return { mirrored: false, destination: null, skippedBetaMirror: true };
  }
  const destination = getAfterPackLocation(env);
  if (!destination) {
    return { mirrored: false, destination: null, skippedBetaMirror: false };
  }

  const copiedEntries = copyReleaseAssets(releaseDir, destination);
  return {
    mirrored: true,
    destination: path.resolve(destination),
    copiedEntries,
    skippedBetaMirror: false,
  };
}

function finalizeReleaseAssets({
  releaseDir = RELEASE_DIR,
  env = process.env,
  version = readPackageVersion(),
} = {}) {
  const result = run({ releaseDir, env, version });
  if (result.mirrored) {
    console.log(
      `Mirrored and verified ${result.copiedEntries} cleaned release entries to: ${result.destination}`
    );
  } else if (result.skippedBetaMirror) {
    console.warn(
      `WARNING: Cleaned release assets without mirroring (beta version ${version}; set OVERRIDE_BETA_MIRROR_SKIP=1 to force).`
    );
  } else {
    console.warn(
      'WARNING: Cleaned release assets, but AFTER_PACK_LOC is not set; mirror intentionally skipped.'
    );
  }
  return result;
}

if (require.main === module) {
  try {
    finalizeReleaseAssets();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`Failed to finalize release assets: ${message}`);
    console.error(`Source release directory: ${RELEASE_DIR}`);
    console.error(`Configured AFTER_PACK_LOC: ${JSON.stringify(getAfterPackLocation())}`);
    console.error(`Platform: ${process.platform}; Node: ${process.version}; cwd: ${process.cwd()}`);
    process.exit(1);
  }
}

module.exports = {
  RELEASE_DIR,
  BUILD_ONLY_DIRECTORIES,
  BUILD_ONLY_FILES,
  cleanReleaseArtifacts,
  getAfterPackLocation,
  isBetaReleaseVersion,
  readPackageVersion,
  shouldSkipBetaMirror,
  comparablePath,
  pathsEqual,
  getReleaseEntries,
  verifyCopiedPath,
  copyReleaseAssets,
  run,
  finalizeReleaseAssets,
};
