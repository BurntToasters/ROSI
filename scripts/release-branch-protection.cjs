#!/usr/bin/env node
"use strict";

const { githubApi, assertGitHubCliAuthenticated } = require("./github-cli.cjs");

const DEFAULT_OWNER = "BurntToasters";
const DEFAULT_REPO = "ROSI";
const REQUIRED_CHECK = "ci-gate";
const REQUIRED_CHECK_APP_ID = 15368;
const PROTECTED_RELEASE_BRANCHES = ["main"];

function repositoryTarget(env = process.env) {
  return {
    owner: String(env.GH_REPO_OWNER || DEFAULT_OWNER).trim(),
    repo: String(env.GH_REPO_NAME || DEFAULT_REPO).trim(),
  };
}

function branchProtectionEndpoint(branch, env = process.env) {
  const { owner, repo } = repositoryTarget(env);
  return `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`;
}

function requiredStatusCheckNames(protection) {
  const checks = protection?.required_status_checks?.checks;
  const contexts = protection?.required_status_checks?.contexts;
  return new Set(
    [
      ...(Array.isArray(checks)
        ? checks.map((check) => String(check?.context || "").trim())
        : []),
      ...(Array.isArray(contexts)
        ? contexts.map((context) => String(context || "").trim())
        : []),
    ].filter(Boolean),
  );
}

function assertProtectionResponse(branch, protection) {
  if (!protection?.required_status_checks) {
    throw new Error(
      `${branch} is protected but does not require status checks. Require ${REQUIRED_CHECK} before releasing.`,
    );
  }
  if (protection.required_status_checks.strict !== true) {
    throw new Error(
      `${branch} branch protection must require the branch to be up to date before ${REQUIRED_CHECK} can pass.`,
    );
  }
  const names = requiredStatusCheckNames(protection);
  if (!names.has(REQUIRED_CHECK)) {
    throw new Error(
      `${branch} branch protection does not require ${REQUIRED_CHECK}.`,
    );
  }
  const checks = protection.required_status_checks.checks;
  const requiredCheck = Array.isArray(checks)
    ? checks.find(
        (check) => String(check?.context || "").trim() === REQUIRED_CHECK,
      )
    : null;
  if (requiredCheck?.app_id !== REQUIRED_CHECK_APP_ID) {
    throw new Error(
      `${branch} branch protection must bind ${REQUIRED_CHECK} to GitHub Actions app ${REQUIRED_CHECK_APP_ID}.`,
    );
  }
  if (protection.allow_force_pushes?.enabled !== false) {
    throw new Error(`${branch} branch protection must disable force pushes.`);
  }
  if (protection.allow_deletions?.enabled !== false) {
    throw new Error(`${branch} branch protection must disable deletion.`);
  }
  return protection;
}

function assertReleaseBranchProtection(
  branch,
  { api = githubApi, env = process.env } = {},
) {
  // Beta is an intentionally mutable staging branch. Release preparation still
  // requires a clean checkout whose HEAD exactly matches origin/beta, but beta
  // may remain unprotected and deletable. Stable releases keep the strict main
  // branch policy below.
  if (branch === "beta") return null;

  let protection;
  try {
    protection = api("GET", branchProtectionEndpoint(branch, env));
  } catch (error) {
    if (error?.statusCode === 404) {
      const { owner, repo } = repositoryTarget(env);
      throw new Error(
        `${owner}/${repo}:${branch} is not protected. Run npm run repo:protect-release-branches with repository admin access first.`,
      );
    }
    throw error;
  }
  return assertProtectionResponse(branch, protection);
}

function desiredProtection() {
  return {
    required_status_checks: {
      strict: true,
      checks: [{ context: REQUIRED_CHECK, app_id: REQUIRED_CHECK_APP_ID }],
    },
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
}

function configureReleaseBranchProtection({
  api = githubApi,
  env = process.env,
} = {}) {
  for (const branch of PROTECTED_RELEASE_BRANCHES) {
    api("PUT", branchProtectionEndpoint(branch, env), desiredProtection());
    assertReleaseBranchProtection(branch, { api, env });
    console.log(
      `release-branch-protection: protected ${repositoryTarget(env).owner}/${repositoryTarget(env).repo}:${branch} with required ${REQUIRED_CHECK}`,
    );
  }
}

if (require.main === module) {
  try {
    if (!process.argv.includes("--apply")) {
      throw new Error(
        "Refusing to change GitHub settings without --apply. Use `npm run repo:protect-release-branches`.",
      );
    }
    assertGitHubCliAuthenticated();
    configureReleaseBranchProtection();
  } catch (error) {
    console.error(
      `release-branch-protection: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_OWNER,
  DEFAULT_REPO,
  PROTECTED_RELEASE_BRANCHES,
  REQUIRED_CHECK,
  REQUIRED_CHECK_APP_ID,
  assertProtectionResponse,
  assertReleaseBranchProtection,
  branchProtectionEndpoint,
  configureReleaseBranchProtection,
  desiredProtection,
  repositoryTarget,
  requiredStatusCheckNames,
};
