import fs from "node:fs";
import {
  RELEASE_DIR,
  finalizeReleaseAssets,
  getAfterPackLocation,
  readPackageVersion,
  shouldSkipBetaMirror,
} from "./post-release-assets.js";
import { assertStableReleaseOverridesAllowed } from "./release-policy.cjs";

// Dedicated entry point: never gate on argv/path identity (Windows ESM footgun).
function banner(message) {
  // writeSync so the line is on the console even if Node later aborts in native fs.
  fs.writeSync(2, `[release:mirror] ${message}\n`);
}

const version = readPackageVersion();
assertStableReleaseOverridesAllowed(process.env, version);
banner("starting");
banner(`platform=${process.platform}; node=${process.version}`);
banner(`cwd=${process.cwd()}`);
banner(`releaseDir=${RELEASE_DIR}`);
banner(`version=${JSON.stringify(version)}`);
banner(`AFTER_PACK_LOC=${JSON.stringify(getAfterPackLocation())}`);
banner(
  `OVERRIDE_BETA_MIRROR_SKIP=${JSON.stringify(process.env.OVERRIDE_BETA_MIRROR_SKIP ?? "")}`,
);
if (shouldSkipBetaMirror(process.env, version) && getAfterPackLocation()) {
  banner(
    `beta version ${version}; AFTER_PACK_LOC mirror will be skipped unless OVERRIDE_BETA_MIRROR_SKIP=1`,
  );
}

function allowSkipMirror(env = process.env) {
  return /^(1|true|yes|on)$/i.test(
    String(env.SKIP_RELEASE_MIRROR ?? "").trim(),
  );
}

try {
  const skipBeta = shouldSkipBetaMirror(process.env, version);
  const skipForced = allowSkipMirror();
  if (!skipBeta && !skipForced && !getAfterPackLocation()) {
    throw new Error(
      `Stable release ${version} requires AFTER_PACK_LOC so artifacts are mirrored before git clean. Set AFTER_PACK_LOC. Beta versions (X.Y.Z-beta.N) skip the mirror by default.`,
    );
  }
  const result = finalizeReleaseAssets({ logger: console, version });
  if (!skipBeta && !skipForced && !result.mirrored) {
    throw new Error(
      `Stable release ${version} did not mirror to AFTER_PACK_LOC.`,
    );
  }
  banner(
    `finished ok; copied=${result.copiedEntries ?? 0}; dest=${result.destination}; skippedBetaMirror=${result.skippedBetaMirror}`,
  );
  process.exit(0);
} catch (error) {
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error);
  banner(`FAILED: ${message}`);
  process.exit(1);
}
