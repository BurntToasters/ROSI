import fs from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPOSITORY_ROOT = path.join(__dirname, "..");
const RELEASE_DIR = path.join(__dirname, "..", "release");

const BUILD_ONLY_DIRECTORIES = [
  "app",
  "appimage",
  "deb",
  "dmg",
  "macos",
  "msi",
  "nsis",
  "rpm",
];
const BUILD_ONLY_FILES = [
  "builder-debug.yml",
  "builder-effective-config.yaml",
  ".build-session.json",
];
const CLI_FLAG = "--finalize-release-assets";
const HASH_BUFFER_BYTES = 1024 * 1024;

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  const fd = fs.openSync(filePath, "r");
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function removePath(targetPath) {
  fs.rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
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
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function isBetaReleaseVersion(version) {
  const numeric = "(?:0|[1-9]\\d*)";
  return new RegExp(
    `^${numeric}\\.${numeric}\\.${numeric}-beta\\.${numeric}$`,
  ).test(String(version ?? ""));
}

function readPackageVersion(repositoryRoot = REPOSITORY_ROOT) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  return typeof packageJson.version === "string" ? packageJson.version : "";
}

function shouldSkipBetaMirror(env = process.env, version) {
  if (!isBetaReleaseVersion(version)) {
    return false;
  }
  return String(env.OVERRIDE_BETA_MIRROR_SKIP ?? "").trim() !== "1";
}

function pathsEqual(left, right, platform = process.platform) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (platform === "win32") {
    return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  }
  return resolvedLeft === resolvedRight;
}

function pathIsSameOrInside(candidate, parent, platform = process.platform) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedParent = path.resolve(parent);
  const normalize = (value) =>
    platform === "win32" ? value.toLowerCase() : value;
  const candidateForComparison = normalize(resolvedCandidate);
  const parentForComparison = normalize(resolvedParent);
  return (
    candidateForComparison === parentForComparison ||
    candidateForComparison.startsWith(`${parentForComparison}${path.sep}`)
  );
}

function isDirectExecution(argv = process.argv, platform = process.platform) {
  if (argv.includes(CLI_FLAG)) {
    return true;
  }
  const entry = argv[1];
  if (!entry) {
    return false;
  }
  // Basename-only check: full-path identity breaks on Windows ESM
  // (argv vs import.meta.url / slash / case / symlink mismatches) and
  // previously caused a silent no-op with zero log output.
  // Use the platform's path module so tests can simulate win32 on darwin/linux.
  const basename =
    platform === "win32" ? path.win32.basename(entry) : path.basename(entry);
  return basename.toLowerCase() === "post-release-assets.js";
}

function isMirrorableReleaseEntry(name) {
  // Dotfiles are build/session markers (e.g. .build-session.json), never ship artifacts.
  return Boolean(name) && !name.startsWith(".");
}

function getReleaseEntries(releaseDir) {
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`release directory does not exist: ${releaseDir}`);
  }

  const entries = fs.readdirSync(releaseDir).filter(isMirrorableReleaseEntry);
  if (!entries.length) {
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
  if (source.isFile()) {
    if (source.size !== destination.size) {
      throw new Error(
        `mirrored file size differs: ${destinationPath} (${destination.size} bytes; expected ${source.size})`,
      );
    }
    const sourceDigest = sha256File(sourcePath);
    const destinationDigest = sha256File(destinationPath);
    if (sourceDigest !== destinationDigest) {
      throw new Error(`mirrored file hash differs: ${destinationPath}`);
    }
  }

  if (source.isDirectory()) {
    const sourceEntries = fs.readdirSync(sourcePath);
    for (const entry of sourceEntries) {
      verifyCopiedPath(
        path.join(sourcePath, entry),
        path.join(destinationPath, entry),
      );
    }
  }
}

function progress(logger, message) {
  if (logger && typeof logger.error === "function") {
    logger.error(`[release:mirror] ${message}`);
  }
}

/**
 * Copy without fs.cpSync's native recursive fast-path.
 * On Windows mapped drives (Z:), that native path can abort the whole Node
 * process instead of throwing a catchable error, which matched the
 * "banners print, then silent exit, nothing mirrored" failure mode.
 */
function copyFileForMirror(sourcePath, destinationPath) {
  try {
    fs.copyFileSync(sourcePath, destinationPath);
  } catch (error) {
    // SMB/CIFS often rejects permission-bit preservation; plain bytes work.
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code !== "EPERM" && code !== "EACCES") {
      throw error;
    }
    fs.writeFileSync(destinationPath, fs.readFileSync(sourcePath));
  }
}

function copyPathRecursive(sourcePath, destinationPath) {
  const source = fs.statSync(sourcePath);
  if (source.isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyPathRecursive(
        path.join(sourcePath, entry),
        path.join(destinationPath, entry),
      );
    }
    return;
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  copyFileForMirror(sourcePath, destinationPath);
}

function uniqueMirrorSibling(destinationPath, label) {
  const dir = path.dirname(destinationPath);
  const base = path.basename(destinationPath);
  return path.join(
    dir,
    `.rosi-mirror-${label}-${process.pid}-${crypto.randomBytes(6).toString("hex")}-${base}`,
  );
}

function copyReleaseEntryToMirror(sourcePath, destinationPath) {
  const stagingPath = uniqueMirrorSibling(destinationPath, "new");
  const rollbackPath = uniqueMirrorSibling(destinationPath, "old");
  removePath(stagingPath);
  copyPathRecursive(sourcePath, stagingPath);
  try {
    verifyCopiedPath(sourcePath, stagingPath);
  } catch (error) {
    removePath(stagingPath);
    throw error;
  }

  const hadPrevious = fs.existsSync(destinationPath);
  if (hadPrevious) {
    removePath(rollbackPath);
    fs.renameSync(destinationPath, rollbackPath);
  }
  try {
    fs.renameSync(stagingPath, destinationPath);
  } catch (error) {
    if (hadPrevious && fs.existsSync(rollbackPath)) {
      try {
        fs.renameSync(rollbackPath, destinationPath);
      } catch {
        // Leave rollback beside dest for manual recovery.
      }
    }
    removePath(stagingPath);
    throw error;
  }
  verifyCopiedPath(sourcePath, destinationPath);
  if (hadPrevious) {
    removePath(rollbackPath);
  }
}

function resolveMirrorPaths(releaseDir = RELEASE_DIR, destination) {
  if (!destination) {
    throw new Error("AFTER_PACK_LOC is empty");
  }
  if (!path.isAbsolute(destination)) {
    throw new Error(
      `AFTER_PACK_LOC must be an absolute path on this platform: ${destination}`,
    );
  }

  const requestedReleaseDir = path.resolve(releaseDir);
  if (
    !fs.existsSync(requestedReleaseDir) ||
    !fs.statSync(requestedReleaseDir).isDirectory()
  ) {
    throw new Error(`release directory does not exist: ${requestedReleaseDir}`);
  }
  const resolvedReleaseDir = fs.realpathSync.native(requestedReleaseDir);
  const requestedDestination = path.resolve(destination);
  if (
    fs.existsSync(requestedDestination) &&
    fs.lstatSync(requestedDestination).isSymbolicLink()
  ) {
    throw new Error(
      `AFTER_PACK_LOC must not be a symbolic link: ${requestedDestination}`,
    );
  }
  const missingSegments = [];
  let existingAncestor = requestedDestination;
  while (!fs.existsSync(existingAncestor)) {
    missingSegments.unshift(path.basename(existingAncestor));
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const resolvedDestination = path.join(
    fs.realpathSync.native(existingAncestor),
    ...missingSegments,
  );
  if (pathsEqual(resolvedDestination, resolvedReleaseDir)) {
    throw new Error("AFTER_PACK_LOC cannot be the release directory");
  }

  const resolvedRepositoryRoot = fs.realpathSync.native(REPOSITORY_ROOT);
  if (pathIsSameOrInside(resolvedDestination, resolvedRepositoryRoot)) {
    throw new Error(
      `AFTER_PACK_LOC must be outside the repository: ${resolvedRepositoryRoot}`,
    );
  }

  const releasePrefix = `${resolvedReleaseDir}${path.sep}`;
  const destinationForComparison =
    process.platform === "win32"
      ? resolvedDestination.toLowerCase()
      : resolvedDestination;
  const releasePrefixForComparison =
    process.platform === "win32" ? releasePrefix.toLowerCase() : releasePrefix;
  if (destinationForComparison.startsWith(releasePrefixForComparison)) {
    throw new Error("AFTER_PACK_LOC cannot be inside the release directory");
  }

  return { resolvedReleaseDir, resolvedDestination };
}

function copyReleaseAssets(
  releaseDir = RELEASE_DIR,
  destination,
  { logger = console } = {},
) {
  const { resolvedReleaseDir, resolvedDestination } = resolveMirrorPaths(
    releaseDir,
    destination,
  );
  progress(
    logger,
    `copy resolve: src=${resolvedReleaseDir} dest=${resolvedDestination}`,
  );

  const entries = getReleaseEntries(resolvedReleaseDir);
  fs.mkdirSync(resolvedDestination, { recursive: true });
  progress(
    logger,
    `copying ${entries.length} entries to shared mirror (overwrite same names only)`,
  );
  for (const entry of entries) {
    const sourcePath = path.join(resolvedReleaseDir, entry);
    const destinationPath = path.join(resolvedDestination, entry);
    progress(logger, `copy ${entry}`);
    copyReleaseEntryToMirror(sourcePath, destinationPath);
    progress(logger, `verified ${entry}`);
  }

  return entries.length;
}

function run({
  releaseDir = RELEASE_DIR,
  env = process.env,
  logger = console,
  version = readPackageVersion(),
} = {}) {
  let destination = getAfterPackLocation(env);
  let skippedBetaMirror = false;
  if (destination && shouldSkipBetaMirror(env, version)) {
    skippedBetaMirror = true;
    progress(
      logger,
      `beta version ${version}; skipping AFTER_PACK_LOC mirror (set OVERRIDE_BETA_MIRROR_SKIP=1 to force).`,
    );
    destination = "";
  } else if (!destination) {
    progress(
      logger,
      "AFTER_PACK_LOC is not set; skipping the verified mirror (clean only).",
    );
  } else {
    // Resolve every boundary before removing build-only files. A malformed,
    // repository-local, or symlinked destination must leave `release/` intact.
    resolveMirrorPaths(releaseDir, destination);
  }

  progress(logger, "cleaning build-only release artifacts");
  cleanReleaseArtifacts(releaseDir);
  progress(logger, "clean complete");

  if (!destination) {
    return {
      mirrored: false,
      destination: "",
      copiedEntries: 0,
      skippedBetaMirror,
    };
  }

  const copiedEntries = copyReleaseAssets(releaseDir, destination, { logger });
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
  logger = console,
  version = readPackageVersion(),
} = {}) {
  const result = run({ releaseDir, env, logger, version });
  if (!result.mirrored) {
    if (result.skippedBetaMirror) {
      logger.log(
        `Cleaned release assets without mirroring (beta version ${version}; set OVERRIDE_BETA_MIRROR_SKIP=1 to force).`,
      );
    } else {
      logger.log(
        "Cleaned release assets without mirroring (AFTER_PACK_LOC unset).",
      );
    }
    return result;
  }
  logger.log(
    `Mirrored and verified ${result.copiedEntries} cleaned release entries to: ${result.destination}`,
  );
  return result;
}

function main() {
  try {
    return finalizeReleaseAssets();
  } catch (error) {
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : String(error);
    console.error(`Failed to finalize release assets: ${message}`);
    console.error(`Source release directory: ${RELEASE_DIR}`);
    console.error(
      `Configured AFTER_PACK_LOC: ${JSON.stringify(getAfterPackLocation())}`,
    );
    console.error(
      `Platform: ${process.platform}; Node: ${process.version}; cwd: ${process.cwd()}`,
    );
    console.error(
      "The following git reset/clean was blocked. Correct the problem and rerun npm run release:finalize.",
    );
    process.exitCode = 1;
    return null;
  }
}

if (isDirectExecution()) main();

export {
  REPOSITORY_ROOT,
  RELEASE_DIR,
  BUILD_ONLY_DIRECTORIES,
  BUILD_ONLY_FILES,
  CLI_FLAG,
  cleanReleaseArtifacts,
  getAfterPackLocation,
  isBetaReleaseVersion,
  readPackageVersion,
  shouldSkipBetaMirror,
  pathsEqual,
  pathIsSameOrInside,
  isDirectExecution,
  isMirrorableReleaseEntry,
  getReleaseEntries,
  resolveMirrorPaths,
  verifyCopiedPath,
  copyReleaseEntryToMirror,
  copyReleaseAssets,
  run,
  finalizeReleaseAssets,
  main,
};
