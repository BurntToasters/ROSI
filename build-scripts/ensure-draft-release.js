const fs = require('fs');
const path = require('path');

require('dotenv').config();
const { assertGitHubCliAuthenticated, githubApi } = require('./github-cli');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const CHANGELOG_PATH = path.join(REPOSITORY_ROOT, 'CHANGELOG.md');

const REPO_OWNER = 'BurntToasters';
const REPO_NAME = 'ROSI';
const GH_REQUEST_RETRIES = Number.parseInt(process.env.GH_REQUEST_RETRIES || '3', 10);
const GH_REQUEST_RETRY_DELAY_MS = Number.parseInt(
  process.env.GH_REQUEST_RETRY_DELAY_MS || '1500',
  10
);

// --wait mode: how long mac/linux will wait for the Windows machine to create
const WAIT_MODE = process.argv.slice(2).includes('--wait');
const WAIT_TIMEOUT_MS = Number.parseInt(process.env.RELEASE_DRAFT_WAIT_TIMEOUT_MS || '1800000', 10);
const WAIT_POLL_INTERVAL_MS = Number.parseInt(
  process.env.RELEASE_DRAFT_WAIT_POLL_MS || '15000',
  10
);

const packageJson = require('../package.json');
const VERSION = packageJson.version;
const TAG_NAME = 'v' + VERSION;
const IS_PRERELEASE = VERSION.includes('beta') || VERSION.includes('alpha');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readChangelogReleaseBody(changelogPath = CHANGELOG_PATH) {
  let body;
  try {
    body = fs.readFileSync(changelogPath, 'utf8');
  } catch (error) {
    throw new Error(
      'CHANGELOG.md is required for GitHub release notes: ' +
        (error && error.message ? error.message : String(error)),
      { cause: error }
    );
  }
  if (!body.trim()) {
    throw new Error('CHANGELOG.md is empty; refusing to set blank release notes.');
  }
  return body;
}

async function syncReleaseNotesBody(release, body) {
  if (!release || typeof release.id !== 'number') {
    throw new Error('Cannot sync release notes without a GitHub release id.');
  }
  const updated = await githubRequestWithRetry(
    'PATCH',
    '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases/' + release.id,
    { body }
  );
  console.log(
    '   Synced CHANGELOG.md into release notes (' +
      body.length +
      ' chars) for ' +
      (release.name || TAG_NAME) +
      '.'
  );
  return updated;
}

function isRetryableGithubError(error) {
  if (!error) return false;

  const retryableStatusCodes = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
  const retryableCodes = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'EPIPE',
  ]);

  if (typeof error.statusCode === 'number' && retryableStatusCodes.has(error.statusCode)) {
    return true;
  }
  if (typeof error.code === 'string' && retryableCodes.has(error.code)) {
    return true;
  }

  const msg = String(error.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('socket hang up') || msg.includes('aborted');
}

function githubRequest(method, endpoint, body) {
  return Promise.resolve(githubApi(method, endpoint, body));
}

async function githubRequestWithRetry(method, endpoint, body) {
  const attempts = Math.max(1, GH_REQUEST_RETRIES);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await githubRequest(method, endpoint, body);
    } catch (error) {
      const canRetry = attempt < attempts && isRetryableGithubError(error);
      if (!canRetry) {
        throw error;
      }

      const backoffMs = GH_REQUEST_RETRY_DELAY_MS * attempt;
      console.log(
        '   Retry ' +
          attempt +
          '/' +
          (attempts - 1) +
          ' in ' +
          backoffMs +
          'ms (' +
          error.message +
          ')'
      );
      await sleep(backoffMs);
    }
  }
}

async function findExistingRelease() {
  // Draft releases are not returned by the "get release by tag" endpoint
  // (no git tag exists yet), so we list and match on tag_name.
  const releases = await githubRequestWithRetry(
    'GET',
    '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases?per_page=100'
  );

  if (!Array.isArray(releases)) {
    throw new Error('Unexpected releases payload type');
  }

  const matching = releases.filter((r) => r.tag_name === TAG_NAME);
  if (matching.length === 0) {
    return null;
  }

  // Prefer a draft (electron-builder publishes into drafts); fall back to any.
  const draft = matching.find((r) => r.draft);
  return draft || matching[0];
}

async function ensureDraftRelease() {
  console.log('Ensuring draft release exists for ' + TAG_NAME + '...');
  const body = readChangelogReleaseBody();

  const existing = await findExistingRelease();
  if (existing) {
    console.log(
      '   Draft already exists: ' +
        (existing.name || TAG_NAME) +
        ' (id ' +
        existing.id +
        ', ' +
        (existing.assets ? existing.assets.length : 0) +
        ' assets) - refreshing release notes.'
    );
    return syncReleaseNotesBody(existing, body);
  }

  console.log('   No release found. Creating draft...');
  try {
    const release = await githubRequestWithRetry(
      'POST',
      '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases',
      {
        // Match electron-builder's createRelease() so it reuses this draft:
        // tag = "v" + version, name defaults to the version, draft:true.
        tag_name: TAG_NAME,
        name: VERSION,
        body,
        draft: true,
        prerelease: IS_PRERELEASE,
      }
    );
    console.log(
      '   Created draft release: ' +
        (release.name || TAG_NAME) +
        ' (id ' +
        release.id +
        ') with CHANGELOG.md release notes.'
    );
    return release;
  } catch (error) {
    // Another concurrent run may have created it (422 already_exists) - re-fetch.
    if (error.statusCode === 422) {
      console.log('   Create returned 422; re-checking for existing draft...');
      await sleep(2000);
      const afterRetry = await findExistingRelease();
      if (afterRetry) {
        console.log('   Found existing draft after retry: id ' + afterRetry.id);
        return syncReleaseNotesBody(afterRetry, body);
      }
    }
    throw error;
  }
}

async function waitForDraftRelease() {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  console.log(
    'Waiting for draft release ' +
      TAG_NAME +
      ' (created by the Windows machine); will NOT create it here...'
  );

  let attempt = 0;
  for (;;) {
    attempt += 1;
    const existing = await findExistingRelease();
    if (existing) {
      console.log(
        '   Found draft: ' +
          (existing.name || TAG_NAME) +
          ' (id ' +
          existing.id +
          ', ' +
          (existing.assets ? existing.assets.length : 0) +
          ' assets). Proceeding.'
      );
      return existing;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        'Timed out after ' +
          Math.round(WAIT_TIMEOUT_MS / 1000) +
          's waiting for draft ' +
          TAG_NAME +
          '. Run "npm run release:draft" on the Windows machine first (or run it here once), then retry.'
      );
    }

    console.log(
      '   Draft not found yet (attempt ' +
        attempt +
        '); re-checking in ' +
        Math.round(WAIT_POLL_INTERVAL_MS / 1000) +
        's...'
    );
    await sleep(WAIT_POLL_INTERVAL_MS);
  }
}

async function main() {
  assertGitHubCliAuthenticated();

  if (WAIT_MODE) {
    await waitForDraftRelease();
  } else {
    await ensureDraftRelease();
  }
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error('✗ ERROR: Failed to ensure draft release: ' + message);
  process.exit(1);
});
