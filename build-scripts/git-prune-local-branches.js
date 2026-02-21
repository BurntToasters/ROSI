const { spawnSync } = require('child_process');

const SCRIPT_VERSION = '1.0.0';

function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
    windowsHide: true,
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const ok = !result.error && result.status === 0;

  return { ok, stdout, stderr, status: result.status, error: result.error };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    remote: 'origin',
    dryRun: false,
    force: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if ((arg === '--remote' || arg === '-r') && next) {
      options.remote = next;
      i++;
      continue;
    }
    if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--force' || arg === '-f') {
      options.force = true;
      continue;
    }
  }

  return options;
}

function parseLines(value) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function stripRemotePrefix(ref, remote) {
  const prefix = `${remote}/`;
  if (!ref.startsWith(prefix)) return null;
  const name = ref.slice(prefix.length);
  if (!name || name === 'HEAD') return null;
  return name;
}

function selectBranchesToDelete(localBranches, remoteBranches, currentBranch) {
  const remoteSet = new Set(remoteBranches);
  return localBranches.filter((branch) => branch !== currentBranch && !remoteSet.has(branch));
}

function ensureRemoteExists(remote) {
  const remotes = runGit(['remote']);
  if (!remotes.ok) {
    throw new Error(remotes.stderr.trim() || 'Failed to list git remotes');
  }
  const remoteList = parseLines(remotes.stdout);
  if (!remoteList.includes(remote)) {
    throw new Error(`Remote "${remote}" does not exist in this repository`);
  }
}

function getCurrentBranch() {
  const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!result.ok) {
    throw new Error(result.stderr.trim() || 'Failed to detect current branch');
  }
  return result.stdout.trim();
}

function getLocalBranches() {
  const result = runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (!result.ok) {
    throw new Error(result.stderr.trim() || 'Failed to list local branches');
  }
  return parseLines(result.stdout);
}

function getRemoteBranches(remote) {
  const result = runGit(['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}`]);
  if (!result.ok) {
    throw new Error(result.stderr.trim() || `Failed to list remote branches for ${remote}`);
  }
  return parseLines(result.stdout)
    .map((ref) => stripRemotePrefix(ref, remote))
    .filter((name) => typeof name === 'string');
}

function fetchPruned(remote) {
  const result = runGit(['fetch', remote, '--prune']);
  if (!result.ok) {
    throw new Error(result.stderr.trim() || `Failed to fetch/prune remote ${remote}`);
  }
}

function deleteBranches(branches, { force = false, dryRun = false } = {}) {
  const deleted = [];
  const skipped = [];
  const flag = force ? '-D' : '-d';

  for (const branch of branches) {
    if (dryRun) {
      deleted.push(branch);
      continue;
    }

    const result = runGit(['branch', flag, branch]);
    if (result.ok) {
      deleted.push(branch);
      continue;
    }

    skipped.push({
      branch,
      reason: result.stderr.trim() || result.error?.message || 'Unknown git error',
    });
  }

  return { deleted, skipped };
}

function printSummary({
  remote,
  currentBranch,
  localBranches,
  remoteBranches,
  targetBranches,
  dryRun,
  force,
  deleted,
  skipped,
}) {
  console.log(`IYERIS gitprune`);
  console.log(`Script Version: ${SCRIPT_VERSION}`);
  console.log(`Remote: ${remote}`);
  console.log(`Current branch: ${currentBranch}`);
  console.log(`Local branches: ${localBranches.length}`);
  console.log(`Remote branches (${remote}): ${remoteBranches.length}`);
  console.log(`Target branches: ${targetBranches.length}`);
  console.log(`Mode: ${dryRun ? 'dry-run' : force ? 'force delete (-D)' : 'safe delete (-d)'}`);
  console.log('');

  if (targetBranches.length === 0) {
    console.log('No local-only branches found.');
    return;
  }

  if (deleted.length > 0) {
    const label = dryRun ? 'Would delete:' : 'Deleted:';
    console.log(label);
    for (const branch of deleted) {
      console.log(`- ${branch}`);
    }
    console.log('');
  }

  if (skipped.length > 0) {
    console.log('Skipped:');
    for (const item of skipped) {
      console.log(`- ${item.branch}: ${item.reason}`);
    }
    console.log('');
  }
}

function main(argv = process.argv) {
  const options = parseArgs(argv);

  ensureRemoteExists(options.remote);
  fetchPruned(options.remote);

  const currentBranch = getCurrentBranch();
  const localBranches = getLocalBranches();
  const remoteBranches = getRemoteBranches(options.remote);
  const targetBranches = selectBranchesToDelete(localBranches, remoteBranches, currentBranch);

  const { deleted, skipped } = deleteBranches(targetBranches, {
    force: options.force,
    dryRun: options.dryRun,
  });

  printSummary({
    remote: options.remote,
    currentBranch,
    localBranches,
    remoteBranches,
    targetBranches,
    dryRun: options.dryRun,
    force: options.force,
    deleted,
    skipped,
  });

  return skipped.length > 0 && !options.dryRun ? 1 : 0;
}

module.exports = {
  parseArgs,
  stripRemotePrefix,
  selectBranchesToDelete,
  deleteBranches,
  main,
};

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`gitprune failed: ${error && error.message ? error.message : error}`);
    process.exit(1);
  }
}
