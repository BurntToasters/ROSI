import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  clearHostedCiProof,
  currentReleaseIdentity,
  recordHostedCiProof,
} from "./release-session.js";
import githubCli from "./github-cli.cjs";
import {
  isIgnorableReleaseDirtyPath,
  porcelainPaths,
} from "./release-session.js";

const require = createRequire(import.meta.url);
const {
  assertReleaseBranchProtection,
  REQUIRED_CHECK,
  REQUIRED_CHECK_APP_ID,
  repositoryTarget,
} = require("./release-branch-protection.cjs");

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

function githubList(endpoint, key, api = githubCli.githubApi) {
  const values = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const result = api(
      "GET",
      `${endpoint}${separator}per_page=100&page=${page}`,
    );
    const entries = result?.[key];
    if (!Array.isArray(entries)) {
      throw new Error(
        `GitHub API returned no ${key} list for hosted CI proof.`,
      );
    }
    values.push(...entries);
    if (
      values.length >= Number(result.total_count || 0) ||
      entries.length === 0
    ) {
      return values;
    }
  }
  throw new Error(
    "GitHub returned more hosted CI records than the proof can inspect.",
  );
}

function requireSuccessfulHostedCi(
  branch,
  head,
  identity,
  api = githubCli.githubApi,
) {
  const { owner, repo } = repositoryTarget(process.env);
  const repository = `${owner}/${repo}`;
  const checkRuns = githubList(
    `/repos/${owner}/${repo}/commits/${encodeURIComponent(head)}/check-runs`,
    "check_runs",
    api,
  );
  const candidates = checkRuns
    .filter(
      (check) =>
        check?.name === REQUIRED_CHECK &&
        check.head_sha === head &&
        check.app?.id === REQUIRED_CHECK_APP_ID,
    )
    .sort(
      (left, right) =>
        Date.parse(right.started_at || right.created_at || "") -
        Date.parse(left.started_at || left.created_at || ""),
    );
  const aggregate = candidates[0];
  if (!aggregate) {
    throw new Error(
      `No GitHub Actions ${REQUIRED_CHECK} check run exists for exact HEAD ${head}. Push this source and wait for its aggregate CI run before release preparation.`,
    );
  }
  if (
    aggregate.status !== "completed" ||
    aggregate.conclusion !== "success" ||
    !Number.isFinite(Date.parse(aggregate.completed_at || ""))
  ) {
    throw new Error(
      `The newest exact-HEAD ${REQUIRED_CHECK} check run is ${aggregate.status}/${aggregate.conclusion || "pending"}; a successful hosted aggregate is required.`,
    );
  }

  const actionRuns = githubList(
    `/repos/${owner}/${repo}/actions/runs?head_sha=${encodeURIComponent(head)}`,
    "workflow_runs",
    api,
  );
  const workflowRun = actionRuns
    .filter(
      (run) =>
        run?.check_suite_id === aggregate.check_suite?.id &&
        run.head_sha === head &&
        run.head_branch === branch &&
        run.event === "push" &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        String(run.path || "").split("@")[0] === ".github/workflows/ci.yml" &&
        run.head_commit?.tree_id === identity.sourceTree,
    )
    .sort(
      (left, right) =>
        Number(right.run_attempt || 1) - Number(left.run_attempt || 1),
    )[0];
  if (!workflowRun) {
    throw new Error(
      `The exact ${REQUIRED_CHECK} check is not tied to a successful push workflow for ${branch}@${head} and the current source tree.`,
    );
  }

  const completedAt = Date.parse(aggregate.completed_at);
  const age = Date.now() - completedAt;
  if (age < 0 || age > 24 * 60 * 60 * 1000) {
    throw new Error(
      "Hosted ci-gate evidence is older than 24 hours; wait for a fresh exact-HEAD CI run.",
    );
  }
  const runUrl = new URL(String(workflowRun.html_url || ""));
  if (
    runUrl.protocol !== "https:" ||
    runUrl.hostname !== "github.com" ||
    runUrl.pathname !== `/${owner}/${repo}/actions/runs/${workflowRun.id}`
  ) {
    throw new Error("GitHub returned an unexpected workflow-run evidence URL.");
  }

  const proof = recordHostedCiProof(
    {
      repository,
      version: identity.version,
      headSha: head,
      sourceTree: identity.sourceTree,
      branch,
      event: workflowRun.event,
      packageLockSha256: identity.packageLockSha256,
      cargoLockSha256: identity.cargoLockSha256,
      checkName: REQUIRED_CHECK,
      status: aggregate.status,
      conclusion: aggregate.conclusion,
      appId: aggregate.app.id,
      checkRunId: aggregate.id,
      checkSuiteId: aggregate.check_suite.id,
      checkUrl: aggregate.html_url,
      workflowRunId: workflowRun.id,
      workflowPath: workflowRun.path,
      workflowRunStatus: workflowRun.status,
      workflowRunConclusion: workflowRun.conclusion,
      url: workflowRun.html_url,
      completedAt,
      workflowRunUpdatedAt: Date.parse(workflowRun.updated_at),
    },
    root,
  );
  return proof;
}

function runPreflight() {
  clearHostedCiProof(root);
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

  assertReleaseBranchProtection(expectedBranch);
  githubCli.assertGitHubCliAuthenticated();
  const identity = currentReleaseIdentity(root);
  if (identity.commit !== head) {
    throw new Error(
      "Local release identity changed while preflight was running.",
    );
  }
  const hostedCi = requireSuccessfulHostedCi(expectedBranch, head, identity);

  console.log(
    `release-preflight: ok (${version}, ${expectedBranch}@${head.slice(0, 12)}, hosted ci-gate #${hostedCi.checkRunId})`,
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

export { expectedReleaseBranch, githubList, requireSuccessfulHostedCi };
