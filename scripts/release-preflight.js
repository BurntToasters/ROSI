import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentReleaseIdentity } from "./release-session.js";
import githubCli from "./github-cli.cjs";
import {
  isIgnorableReleaseDirtyPath,
  porcelainPaths,
} from "./release-session.js";
import {
  STABLE_MIN_BETA_SOAK_DAYS,
  STABLE_SOAK_WAIVER_ENV,
  STABLE_SOAK_WAIVER_MIN_LENGTH,
  isExplicitTruthy,
  isStableReleaseVersion,
} from "./release-policy.cjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const DAY_MS = 24 * 60 * 60 * 1000;

function expectedReleaseBranch(version) {
  const numeric = "(?:0|[1-9]\\d*)";
  if (
    new RegExp(`^${numeric}\\.${numeric}\\.${numeric}-beta\\.${numeric}$`).test(
      version,
    )
  ) {
    return "beta";
  }
  if (new RegExp(`^${numeric}\\.${numeric}\\.${numeric}$`).test(version)) {
    return "main";
  }
  throw new Error(
    `Unsupported release version '${version}'; ROSI releases use beta or stable only.`,
  );
}

function git(args) {
  // trimEnd only  -  see release-session.js command() for porcelain reasons.
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * An annotated tag's own date, else the commit's date. Null when git gave no
 * usable timestamp; callers must not treat that as an age.
 */
export function tagDateFromRecord({ objectType, taggerUnix, commitUnix }) {
  const unix = objectType === "tag" && taggerUnix ? taggerUnix : commitUnix;
  if (unix === undefined || unix === null || String(unix).trim() === "") {
    return null;
  }
  const date = new Date(Number(unix) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The highest-numbered `vX.Y.Z-beta.N` tag for the stable base version. */
export function newestBetaTag(stableVersion, tags) {
  const pattern = new RegExp(
    `^v${escapeRegExp(stableVersion)}-beta\\.(0|[1-9]\\d*)$`,
  );
  let newest = null;
  for (const tag of tags) {
    const match = pattern.exec(tag.name);
    if (!match) continue;
    const beta = Number(match[1]);
    if (!newest || beta > newest.beta) {
      newest = { name: tag.name, beta, date: tag.date ?? null };
    }
  }
  return newest;
}

/** Reads local beta tags for a stable base through `git for-each-ref`. */
export function readLocalBetaTags(version, runGit = git) {
  const output = runGit([
    "for-each-ref",
    "--format=%(refname:short)|%(objecttype)|%(taggerdate:unix)|%(*committerdate:unix)|%(committerdate:unix)",
    `refs/tags/v${version}-beta.*`,
  ]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, objectType, taggerUnix, peeledUnix, commitUnix] =
        line.split("|");
      return {
        name,
        date: tagDateFromRecord({
          objectType,
          taggerUnix,
          commitUnix: peeledUnix || commitUnix,
        }),
      };
    });
}

/**
 * Reads the emergency soak waiver. Null when unset or blank; the trimmed reason
 * when valid. A set but invalid value throws, so it never silently passes and
 * never silently fails open: a bare flag ("1", "true"), a reason shorter than
 * STABLE_SOAK_WAIVER_MIN_LENGTH, or a reason with line breaks or control
 * characters (it is printed in the release log) is rejected.
 */
export function readSoakWaiver(env = process.env) {
  const raw = String(env[STABLE_SOAK_WAIVER_ENV] ?? "").trim();
  if (!raw) return null;
  if (isExplicitTruthy(raw)) {
    throw new Error(
      `${STABLE_SOAK_WAIVER_ENV} must be a written reason, not a flag like '${raw}'.`,
    );
  }
  if (raw.length < STABLE_SOAK_WAIVER_MIN_LENGTH) {
    throw new Error(
      `${STABLE_SOAK_WAIVER_ENV} must be a reason of at least ${STABLE_SOAK_WAIVER_MIN_LENGTH} characters.`,
    );
  }
  if (/\p{Cc}/u.test(raw)) {
    throw new Error(`${STABLE_SOAK_WAIVER_ENV} must be a single line of text.`);
  }
  return raw;
}

/** The loud line printed by runPreflight when the soak waiver was used. */
export function formatSoakWaiverWarning({ tag, ageDays, reason }) {
  const days = Math.floor(ageDays);
  return `release-preflight: WARNING: stable beta soak WAIVED (${tag}, ${days} ${days === 1 ? "day" : "days"} old; reason: ${reason})`;
}

/**
 * Stable soak gate: the newest local beta tag must be at least
 * STABLE_MIN_BETA_SOAK_DAYS old. Fails closed on every missing or unreadable
 * input.
 *
 * The only exception is the emergency waiver in ROSI_STABLE_SOAK_WAIVER, and
 * it waives only the age check. Every other check runs first and still throws.
 * A waiver on a tag that is already old enough is not used, so the result is
 * waived: false and no warning is printed.
 */
export function assertStableBetaSoak({
  version,
  listBetaTags = (stable) => readLocalBetaTags(stable),
  now = new Date(),
  env = process.env,
} = {}) {
  if (!isStableReleaseVersion(version)) {
    throw new Error(
      `Beta soak applies to stable versions only; '${version}' is not one.`,
    );
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Beta soak needs a valid current time.");
  }
  const waiver = readSoakWaiver(env);
  const newest = newestBetaTag(version, listBetaTags(version));
  if (!newest) {
    throw new Error(
      `Stable ${version} needs an accepted beta tag v${version}-beta.N, but none exists locally. Run git fetch --tags origin, or release and soak a beta first.`,
    );
  }
  if (!(newest.date instanceof Date) || Number.isNaN(newest.date.getTime())) {
    throw new Error(
      `Could not read the date of ${newest.name}; refusing to assume its age.`,
    );
  }
  const ageMs = now.getTime() - newest.date.getTime();
  if (ageMs < 0) {
    throw new Error(
      `${newest.name} is dated in the future; check the tag date and the system clock.`,
    );
  }
  const requiredMs = STABLE_MIN_BETA_SOAK_DAYS * DAY_MS;
  if (ageMs < requiredMs) {
    if (waiver) {
      return {
        tag: newest.name,
        ageDays: ageMs / DAY_MS,
        waived: true,
        reason: waiver,
      };
    }
    const remainingDays = Math.ceil((requiredMs - ageMs) / DAY_MS);
    throw new Error(
      `Stable ${version} needs ${newest.name} to be at least ${STABLE_MIN_BETA_SOAK_DAYS} days old; it is ${Math.floor(ageMs / DAY_MS)} days old. Wait ${remainingDays} more day(s) before releasing.`,
    );
  }
  return { tag: newest.name, ageDays: ageMs / DAY_MS, waived: false };
}

/**
 * Release source checks: the right branch, a clean tree, and HEAD pushed to
 * its upstream. Hosted CI is not required here; it runs on pushes but does
 * not gate releases.
 */
function runPreflight() {
  const version = String(packageJson.version ?? "");
  const expectedBranch = expectedReleaseBranch(version);
  const branch = git(["branch", "--show-current"]);
  if (branch !== expectedBranch) {
    throw new Error(
      `${version} must be released from ${expectedBranch}, not ${branch || "detached HEAD"}.`,
    );
  }

  const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty) {
    const dirtyPaths = porcelainPaths(dirty).filter(
      (filePath) => !isIgnorableReleaseDirtyPath(filePath),
    );
    if (dirtyPaths.length > 0) {
      throw new Error(
        `Working tree is not clean. Commit and push the exact release source first:\n${dirty}`,
      );
    }
  }

  git(["fetch", "--quiet", "origin"]);
  const upstream = git(["rev-parse", "--abbrev-ref", "@{upstream}"]);
  const expectedUpstream = `origin/${expectedBranch}`;
  if (upstream !== expectedUpstream) {
    throw new Error(
      `${expectedBranch} must track ${expectedUpstream}; current upstream is ${upstream}.`,
    );
  }

  const head = git(["rev-parse", "HEAD"]);
  const upstreamHead = git(["rev-parse", "@{upstream}"]);
  if (head !== upstreamHead) {
    throw new Error(
      `HEAD ${head.slice(0, 12)} does not match pushed ${expectedUpstream} ${upstreamHead.slice(0, 12)}.`,
    );
  }

  if (isStableReleaseVersion(version)) {
    const soak = assertStableBetaSoak({ version });
    if (soak.waived) {
      console.warn(formatSoakWaiverWarning(soak));
    } else {
      console.log(
        `release-preflight: beta soak ok (${soak.tag}, ${Math.floor(soak.ageDays)} days old)`,
      );
    }
  }

  githubCli.assertGitHubCliAuthenticated();
  const identity = currentReleaseIdentity(root);
  if (identity.commit !== head) {
    throw new Error(
      "Local release identity changed while preflight was running.",
    );
  }

  console.log(
    `release-preflight: ok (${version}, ${expectedBranch}@${head.slice(0, 12)})`,
  );
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    runPreflight();
  } catch (error) {
    console.error(
      `release-preflight: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

export { expectedReleaseBranch };
