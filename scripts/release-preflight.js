import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentReleaseIdentity } from "./release-session.js";
import githubCli from "./github-cli.cjs";
import {
  isIgnorableReleaseDirtyPath,
  porcelainPaths,
} from "./release-session.js";

const require = createRequire(import.meta.url);
const {
  REQUIRED_CHECK_APP_ID,
  repositoryTarget,
} = require("./release-branch-protection.cjs");
const {
  assertStableReleaseOverridesAllowed,
  isExplicitTruthy,
} = require("./release-policy.cjs");

const CI_GATE_CHECK = "ci-gate";
const UNVERIFIED_CI_OVERRIDE = "ROSI_RELEASE_ALLOW_UNVERIFIED_CI";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);

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

function assertZstdRunnable() {
  try {
    execFileSync("zstd", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "zstd was not found or cannot run. Install it with: brew install zstd",
    );
  }
}

// Returns the event of the workflow run behind a check run, or null when it
// cannot be resolved. Callers treat null as a failure.
function workflowRunEvent({ run, owner, repo, api }) {
  const suiteId = Number(run.check_suite?.id);
  if (!Number.isSafeInteger(suiteId) || suiteId <= 0) return null;
  const response = api(
    "GET",
    `/repos/${owner}/${repo}/actions/runs?check_suite_id=${suiteId}&per_page=100`,
  );
  const workflowRuns = (
    Array.isArray(response?.workflow_runs) ? response.workflow_runs : []
  ).filter((entry) => Number(entry?.check_suite_id) === suiteId);
  if (workflowRuns.length !== 1) return null;
  const event = workflowRuns[0].event;
  return typeof event === "string" && event ? event : null;
}

/**
 * Reads the hosted `ci-gate` check run for `sha` and returns a reason string
 * when it does not prove a green CI run, or null when it does. Only the newest
 * run from the GitHub Actions app counts, so a same-named check from another
 * app or an older failed run cannot stand in for a passing one. Runs from the
 * weekly scheduled workflow never count: they skip the heavy jobs. A run whose
 * workflow event cannot be resolved fails closed.
 */
function hostedCiProblem({ sha, owner, repo, api }) {
  const endpoint =
    `/repos/${owner}/${repo}/commits/${sha}/check-runs` +
    `?check_name=${CI_GATE_CHECK}&per_page=100`;
  const response = api("GET", endpoint);
  const runs = (Array.isArray(response?.check_runs) ? response.check_runs : [])
    .filter(
      (run) =>
        run?.name === CI_GATE_CHECK &&
        String(run.head_sha || "").toLowerCase() === sha.toLowerCase() &&
        Number(run.app?.id) === REQUIRED_CHECK_APP_ID,
    )
    .sort((left, right) => Number(right.id) - Number(left.id));
  if (runs.length === 0) {
    return `no ${CI_GATE_CHECK} check run from GitHub Actions exists for this commit`;
  }
  let run = null;
  for (const candidate of runs) {
    const event = workflowRunEvent({ run: candidate, owner, repo, api });
    if (!event) {
      return `could not resolve the workflow event of ${CI_GATE_CHECK} run ${candidate.id}`;
    }
    if (event !== "schedule") {
      run = candidate;
      break;
    }
  }
  if (!run) {
    return `only scheduled ${CI_GATE_CHECK} runs exist for this commit, and they do not run the full gate`;
  }
  if (run.status !== "completed") {
    return `${CI_GATE_CHECK} is ${run.status || "not completed"}`;
  }
  if (run.conclusion !== "success") {
    return `${CI_GATE_CHECK} concluded ${run.conclusion || "without a conclusion"}`;
  }
  return null;
}

/**
 * Requires a green hosted `ci-gate` on the exact release commit. Missing,
 * pending, failed, or unreadable CI fails closed. The explicit
 * ROSI_RELEASE_ALLOW_UNVERIFIED_CI=1 override (beta only; stable refuses it)
 * prints a loud warning and continues.
 */
function assertHostedCiPassed({
  sha,
  owner,
  repo,
  api,
  env = process.env,
  log = console,
}) {
  let problem = null;
  try {
    problem = hostedCiProblem({ sha, owner, repo, api });
  } catch (error) {
    problem = `could not read check runs (${error instanceof Error ? error.message : String(error)})`;
  }
  if (!problem) {
    return { verified: true, overridden: false };
  }
  const detail = `Hosted ${CI_GATE_CHECK} is not green for ${sha.slice(0, 12)}: ${problem}.`;
  if (isExplicitTruthy(env[UNVERIFIED_CI_OVERRIDE])) {
    log.warn(
      `WARNING: ${UNVERIFIED_CI_OVERRIDE}=1 is set. ${detail} Continuing with UNVERIFIED CI.`,
    );
    return { verified: false, overridden: true };
  }
  throw new Error(
    `${detail} Wait for CI on this commit to pass, or (beta only) set ${UNVERIFIED_CI_OVERRIDE}=1 to override.`,
  );
}

/**
 * Release source checks: the right branch, a clean tree, HEAD pushed to its
 * upstream, and a green hosted `ci-gate` on that HEAD commit. Dependencies are
 * injectable so tests can stub git and GitHub.
 */
function runPreflight({
  git: runGit = git,
  github = githubCli,
  identity = () => currentReleaseIdentity(root),
  env = process.env,
  log = console,
  platform = process.platform,
  version = String(packageJson.version ?? ""),
  assertZstd = assertZstdRunnable,
} = {}) {
  // macOS updater archives need the zstd CLI; fail before any mac build starts.
  if (platform === "darwin") {
    assertZstd();
  }
  assertStableReleaseOverridesAllowed(env, version);

  const expectedBranch = expectedReleaseBranch(version);
  const branch = runGit(["branch", "--show-current"]);
  if (branch !== expectedBranch) {
    throw new Error(
      `${version} must be released from ${expectedBranch}, not ${branch || "detached HEAD"}.`,
    );
  }

  const dirty = runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
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

  runGit(["fetch", "--quiet", "origin"]);
  const upstream = runGit(["rev-parse", "--abbrev-ref", "@{upstream}"]);
  const expectedUpstream = `origin/${expectedBranch}`;
  if (upstream !== expectedUpstream) {
    throw new Error(
      `${expectedBranch} must track ${expectedUpstream}; current upstream is ${upstream}.`,
    );
  }

  const head = runGit(["rev-parse", "HEAD"]);
  const upstreamHead = runGit(["rev-parse", "@{upstream}"]);
  if (head !== upstreamHead) {
    throw new Error(
      `HEAD ${head.slice(0, 12)} does not match pushed ${expectedUpstream} ${upstreamHead.slice(0, 12)}.`,
    );
  }

  github.assertGitHubCliAuthenticated();
  const releaseIdentity = identity();
  if (releaseIdentity.commit !== head) {
    throw new Error(
      "Local release identity changed while preflight was running.",
    );
  }

  const { owner, repo } = repositoryTarget(env);
  const ci = assertHostedCiPassed({
    sha: head,
    owner,
    repo,
    api: github.githubApi,
    env,
    log,
  });
  if (ci.verified) {
    log.log(
      `release-preflight: ${CI_GATE_CHECK} is green on ${head.slice(0, 12)}`,
    );
  }

  log.log(
    `release-preflight: ok (${version}, ${expectedBranch}@${head.slice(0, 12)}${ci.verified ? "" : ", UNVERIFIED CI"})`,
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

export { assertHostedCiPassed, expectedReleaseBranch, runPreflight };
