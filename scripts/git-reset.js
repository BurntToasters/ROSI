// Re-sync a clone with its remote after the remote history was rewritten
// (docs/HISTORY-PRUNE.md), then free the space the old history used.
// Failure modes: scripts/git-reset.failure-modes.md.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SEP = "\x1f";
const END = "\x1e";

function runGit(args) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: "pipe",
    shell: false,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || (result.error ? String(result.error) : ""),
  };
}

function gitOrThrow(args, what) {
  const result = runGit(args);
  if (!result.ok) {
    throw new Error(`${what} failed: ${result.stderr.trim() || "git error"}`);
  }
  return result.stdout;
}

export function parseArgs(argv) {
  const options = { remote: "origin", dryRun: false, force: false, gc: true };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--remote" || arg === "-r") && args[i + 1]) {
      options.remote = args[++i];
    } else if (arg === "--dry-run" || arg === "-n") {
      options.dryRun = true;
    } else if (arg === "--force" || arg === "-f") {
      options.force = true;
    } else if (arg === "--no-gc") {
      options.gc = false;
    }
  }
  return options;
}

/** Rewrites keep author email, author time, committer time and message. */
function commitKeys(args) {
  const out = gitOrThrow(
    ["log", `--format=%H${SEP}%ae${SEP}%at${SEP}%ct${SEP}%B${END}`, ...args],
    "git log",
  );
  return out
    .split(END)
    .map((record) => record.replace(/^\n/, ""))
    .filter(Boolean)
    .map((record) => {
      const [hash, ...rest] = record.split(SEP);
      return { hash, key: rest.join(SEP).trimEnd(), subject: rest[3] };
    });
}

function trackedBranches(remote) {
  const out = gitOrThrow(
    [
      "for-each-ref",
      `--format=%(refname:short)${SEP}%(objectname)${SEP}%(upstream:short)${SEP}%(upstream:remotename)`,
      "refs/heads",
    ],
    "listing branches",
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, sha, upstream, upstreamRemote] = line.split(SEP);
      return { name, sha, upstream, upstreamRemote };
    })
    .filter(
      (branch) =>
        branch.upstreamRemote === remote && !branch.name.startsWith("backup/"),
    );
}

function resolve(ref) {
  const result = runGit([
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  return result.ok ? result.stdout.trim() : null;
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
}

export function main(argv = process.argv) {
  const options = parseArgs(argv);
  const log = (message) => console.log(`[git:reset] ${message}`);
  const fail = (message) => {
    console.error(`[git:reset] ${message}`);
    return 1;
  };

  if (!runGit(["rev-parse", "--git-dir"]).ok) {
    return fail("Not inside a git repository.");
  }
  const head = runGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!head.ok) {
    return fail("HEAD is detached. Check out a branch first.");
  }
  const current = head.stdout.trim();
  const dirty = gitOrThrow(
    ["status", "--porcelain", "--untracked-files=no"],
    "git status",
  ).trimEnd();
  if (dirty && !options.force) {
    return fail(
      `Uncommitted changes to tracked files would be lost:\n${dirty}\nCommit or stash them, or rerun with --force to stash them first.`,
    );
  }

  log(`Fetching ${options.remote} (branches and tags, forced).`);
  if (!options.dryRun) {
    const fetched = runGit([
      "fetch",
      "--force",
      "--prune",
      "--tags",
      options.remote,
    ]);
    if (!fetched.ok) {
      return fail(
        `git fetch failed; nothing was changed.\n${fetched.stderr.trim()}`,
      );
    }
  }

  const branches = trackedBranches(options.remote);
  const currentBranch = branches.find((branch) => branch.name === current);
  if (!currentBranch || !resolve(currentBranch.upstream)) {
    return fail(
      `Branch ${current} has no existing upstream on ${options.remote}. Set one with: git branch --set-upstream-to ${options.remote}/${current}`,
    );
  }

  const upstreamKeys = new Set(
    commitKeys([`--remotes=${options.remote}`, "--tags"]).map(
      (entry) => entry.key,
    ),
  );
  const refused = [];
  const moved = [];
  let stashed = false;

  for (const branch of branches) {
    const target = resolve(branch.upstream);
    if (!target) {
      log(`Skipping ${branch.name}: ${branch.upstream} no longer exists.`);
      continue;
    }
    if (target === branch.sha) {
      log(`${branch.name} is already in sync.`);
      continue;
    }
    const unique = commitKeys([`${target}..${branch.sha}`]).filter(
      (entry) => !upstreamKeys.has(entry.key),
    );
    if (unique.length > 0 && !options.force) {
      refused.push(branch.name);
      console.error(
        `[git:reset] ${branch.name} has local commits that are not on ${branch.upstream}:\n${unique
          .map(
            (entry) =>
              `  ${entry.hash.slice(0, 9)} ${entry.subject.split("\n")[0]}`,
          )
          .join(
            "\n",
          )}\nPush them first, or rerun with --force to keep them on a backup branch.`,
      );
      continue;
    }
    if (options.dryRun) {
      log(
        `Would move ${branch.name} to ${branch.upstream} (${target.slice(0, 9)}).`,
      );
      continue;
    }
    if (unique.length > 0) {
      const backup = `backup/git-reset-${branch.name.replace(/\//g, "-")}-${stamp()}`;
      gitOrThrow(["branch", backup, branch.sha], "creating backup branch");
      log(
        `Kept ${unique.length} local commit(s) of ${branch.name} on ${backup}.`,
      );
    }
    if (branch.name === current) {
      if (dirty && !stashed) {
        gitOrThrow(
          ["stash", "push", "--message", "git:reset uncommitted changes"],
          "git stash",
        );
        stashed = true;
        log("Stashed uncommitted changes (git stash list).");
      }
      gitOrThrow(["reset", "--hard", target], "git reset");
    } else {
      gitOrThrow(["branch", "--force", branch.name, target], "moving branch");
    }
    moved.push(branch.name);
    log(`Moved ${branch.name} to ${branch.upstream} (${target.slice(0, 9)}).`);
  }

  if (refused.length > 0) {
    return fail(
      `Refused: ${refused.join(", ")}. Garbage collection skipped so nothing local is lost.`,
    );
  }
  if (options.dryRun) {
    log("Dry run: nothing was changed.");
    return 0;
  }

  const otherRefs = gitOrThrow(
    ["for-each-ref", "--format=%(refname)"],
    "listing refs",
  )
    .split("\n")
    .filter(
      (ref) =>
        ref &&
        !ref.startsWith("refs/heads/") &&
        !ref.startsWith("refs/remotes/") &&
        !ref.startsWith("refs/tags/"),
    );
  if (otherRefs.length > 0) {
    log(
      `These refs may still keep old history (and its space) alive:\n  ${otherRefs.join("\n  ")}`,
    );
  }
  if (options.gc) {
    log("Expiring reflogs and running garbage collection to free space.");
    gitOrThrow(["reflog", "expire", "--expire=now", "--all"], "reflog expire");
    gitOrThrow(["gc", "--prune=now", "--quiet"], "git gc");
  }
  log(
    moved.length > 0
      ? `Done. Moved: ${moved.join(", ")}.`
      : "Done. Everything was already in sync.",
  );
  return 0;
}

export function isDirectExecution(
  moduleUrl = import.meta.url,
  executablePath = process.argv[1],
) {
  return (
    Boolean(executablePath) &&
    moduleUrl === pathToFileURL(path.resolve(executablePath)).href
  );
}

if (isDirectExecution()) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(
      `[git:reset] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
