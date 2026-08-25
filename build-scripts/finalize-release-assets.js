const fs = require('fs');
const {
  RELEASE_DIR,
  finalizeReleaseAssets,
  getAfterPackLocation,
  readPackageVersion,
  shouldSkipBetaMirror,
} = require('./post-release-assets.js');

function banner(message) {
  fs.writeSync(2, `[release:mirror] ${message}\n`);
}

function allowSkipMirror(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.SKIP_RELEASE_MIRROR ?? '').trim());
}

const version = readPackageVersion();
banner('starting');
banner(`platform=${process.platform}; node=${process.version}`);
banner(`cwd=${process.cwd()}`);
banner(`releaseDir=${RELEASE_DIR}`);
banner(`version=${JSON.stringify(version)}`);
banner(`AFTER_PACK_LOC=${JSON.stringify(getAfterPackLocation())}`);

try {
  const skipBeta = shouldSkipBetaMirror(process.env, version);
  const skipForced = allowSkipMirror();
  if (!skipBeta && !skipForced && !getAfterPackLocation()) {
    throw new Error(
      `Stable release ${version} requires AFTER_PACK_LOC so artifacts are mirrored. Set AFTER_PACK_LOC or SKIP_RELEASE_MIRROR=1. Beta versions (X.Y.Z-beta.N) skip the mirror by default.`
    );
  }
  const result = finalizeReleaseAssets({ version });
  if (!skipBeta && !skipForced && !result.mirrored) {
    throw new Error(`Stable release ${version} did not mirror to AFTER_PACK_LOC.`);
  }
  banner(
    `finished ok; copied=${result.copiedEntries ?? 0}; dest=${result.destination}; skippedBetaMirror=${result.skippedBetaMirror}`
  );
  process.exit(0);
} catch (error) {
  const message = error && error.message ? error.message : String(error);
  banner(`FAILED: ${message}`);
  process.exit(1);
}
