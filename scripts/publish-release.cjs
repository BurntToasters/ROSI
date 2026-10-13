// Publishes the fully-verified draft for the current package version.
// Order is the whole point: verify:draft must pass before the flip is sent.
// Usage: npm run release:publish   (after every platform VM has signed)

const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const { assertGitHubCliAuthenticated, githubApi } = require("./github-cli.cjs");
const { assertStableReleaseOverridesAllowed } = require("./release-policy.cjs");
const { assertReleaseTagMatchesHead } = require("./release-git-tag.cjs");
const {
  assertExpectedRelease,
  assertReleaseTagName,
  isExpectedRelease,
} = require("./release-draft-metadata.cjs");

const REPO_OWNER = process.env.GH_REPO_OWNER || "BurntToasters";
const REPO_NAME = process.env.GH_REPO_NAME || "ROSI";
const packageJson = require("../package.json");
const VERSION = packageJson.version;
const TAG_NAME = "v" + VERSION;

function currentReleaseCommit() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("Could not resolve an exact release commit from git HEAD.");
  }
  return commit;
}

function runVerifyDraft() {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "verify-release-draft.js"), "--verify-artifacts"],
    { stdio: "inherit", cwd: path.resolve(__dirname, "..") },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "release:verify:draft failed; fix the draft instead of publishing it.",
    );
  }
}

function runReleasePreflight() {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "release-preflight.js")],
    { stdio: "inherit", cwd: path.resolve(__dirname, "..") },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "release:preflight failed; publication requires current clean-source and hosted-CI proof.",
    );
  }
}

async function main() {
  assertStableReleaseOverridesAllowed(process.env, VERSION);
  assertGitHubCliAuthenticated();
  const commit = currentReleaseCommit();
  runVerifyDraft();

  const initialTagCommit = assertReleaseTagMatchesHead({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    tag: TAG_NAME,
    headCommit: commit,
    api: githubApi,
    // Draft releases can receive their tag only when GitHub publishes them.
    allowMissing: true,
  });

  const releases = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = githubApi(
      "GET",
      `/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  const drafts = releases.filter(
    (release) =>
      release?.draft && isExpectedRelease(release, TAG_NAME, VERSION),
  );
  if (drafts.length > 1) {
    throw new Error(
      `Multiple draft releases exist for ${TAG_NAME}. Resolve duplicates before publishing.`,
    );
  }
  if (drafts.length === 0) {
    throw new Error(`No draft exists for ${TAG_NAME}.`);
  }
  const draft = assertExpectedRelease(
    drafts[0],
    TAG_NAME,
    VERSION,
    "Publishing draft",
  );
  const expectedPrerelease = /-beta\.\d+$/.test(VERSION);
  if (Boolean(draft.prerelease) !== expectedPrerelease) {
    throw new Error(
      `Draft ${TAG_NAME} prerelease=${draft.prerelease}, expected ${expectedPrerelease}; re-run npm run release:draft.`,
    );
  }
  if (draft.target_commitish !== commit) {
    throw new Error(
      `Draft ${TAG_NAME} targets ${draft.target_commitish}, not HEAD ${commit}.`,
    );
  }

  // This invokes the same current branch/tree/hosted-CI gate used by release
  // preparation. It stays adjacent to the publish request so old build-time
  // evidence cannot authorize a later direct publication.
  runReleasePreflight();
  const currentCommit = currentReleaseCommit();
  if (currentCommit !== commit) {
    throw new Error(
      `HEAD changed during publication checks: expected ${commit}, now ${currentCommit}.`,
    );
  }
  const prePublishTagCommit = assertReleaseTagMatchesHead({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    tag: TAG_NAME,
    headCommit: currentCommit,
    api: githubApi,
    allowMissing: true,
  });
  if (initialTagCommit !== null && prePublishTagCommit !== initialTagCommit) {
    throw new Error(
      `Release tag ${TAG_NAME} changed while publication checks were running.`,
    );
  }

  const published = githubApi(
    "PATCH",
    `/repos/${REPO_OWNER}/${REPO_NAME}/releases/${draft.id}`,
    {
      tag_name: TAG_NAME,
      target_commitish: commit,
      draft: false,
      prerelease: expectedPrerelease,
    },
  );
  const validated = assertReleaseTagName(
    published,
    TAG_NAME,
    "Published release",
  );
  assertReleaseTagMatchesHead({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    tag: TAG_NAME,
    headCommit: commit,
    api: githubApi,
  });
  console.log(`Published ${TAG_NAME}: ${validated.html_url}`);
  console.log(
    "Next: npm run release:verify:published (live updater feed + signature proof).",
  );
}

main().catch((error) => {
  console.error(
    "✗ ERROR: Failed to publish release: " +
      (error && error.message ? error.message : String(error)),
  );
  process.exit(1);
});
