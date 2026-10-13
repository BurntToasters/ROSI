// Acceptance for `npm run git:reset` (failure modes in
// scripts/git-reset.failure-modes.md). Uses throwaway repositories only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "git-reset.js",
);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: os.tmpdir(),
};

function git(cwd, args, extraEnv = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...ENV, ...extraEnv },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(cwd, files, message, time) {
  for (const [name, text] of Object.entries(files)) {
    if (text === null) fs.rmSync(path.join(cwd, name), { force: true });
    else fs.writeFileSync(path.join(cwd, name), text);
  }
  git(cwd, ["add", "-A"]);
  const date = `${time} +0000`;
  git(cwd, ["commit", "-q", "-m", message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
}

// Remote history: A adds src and a big binary, B edits src, C edits src.
// The rewrite drops the binary from every commit, keeping messages and times.
function writeHistory(cwd, withBinary) {
  commit(
    cwd,
    { "src.txt": "one\n", ...(withBinary ? { "big.bin": "BINARY" } : {}) },
    "A",
    1_700_000_000,
  );
  commit(cwd, { "src.txt": "two\n" }, "B", 1_700_000_100);
  git(cwd, ["tag", "v1"]);
  commit(cwd, { "src.txt": "three\n" }, "C", 1_700_000_200);
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-git-reset-"));
  const remote = path.join(root, "remote.git");
  git(root, ["init", "-q", "--bare", "-b", "main", remote]);
  const seed = path.join(root, "seed");
  git(root, ["init", "-q", "-b", "main", seed]);
  writeHistory(seed, true);
  git(seed, ["branch", "beta"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-q", "origin", "main", "beta", "--tags"]);
  const clone = path.join(root, "clone");
  git(root, ["clone", "-q", remote, clone]);
  git(clone, ["branch", "-q", "--track", "beta", "origin/beta"]);
  fs.writeFileSync(path.join(clone, "untracked.bin"), "KEEP");

  const rewrite = () => {
    const fresh = path.join(root, "rewrite");
    git(root, ["init", "-q", "-b", "main", fresh]);
    writeHistory(fresh, false);
    git(fresh, ["branch", "beta"]);
    git(fresh, ["push", "-q", "--force", remote, "main", "beta"]);
    git(fresh, ["push", "-q", "--force", remote, "--tags"]);
  };
  return { root, remote, clone, rewrite };
}

function run(cwd, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: ENV,
  });
}

const reachable = (cwd, file) =>
  git(cwd, ["log", "--all", "--format=%H", "--", file]).length > 0;

test("rewritten history: clean clone syncs, frees old objects, keeps untracked", () => {
  const { clone, remote, rewrite } = setup();
  rewrite();
  assert.ok(reachable(clone, "big.bin"));
  const result = run(clone);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(
    git(clone, ["rev-parse", "HEAD"]),
    git(remote, ["rev-parse", "main"]),
  );
  assert.equal(
    git(clone, ["rev-parse", "beta"]),
    git(remote, ["rev-parse", "beta"]),
  );
  assert.equal(
    git(clone, ["rev-parse", "v1^{commit}"]),
    git(remote, ["rev-parse", "v1^{commit}"]),
  );
  assert.equal(reachable(clone, "big.bin"), false);
  assert.equal(
    fs.readFileSync(path.join(clone, "untracked.bin"), "utf8"),
    "KEEP",
  );
  assert.match(result.stdout, /garbage/i);
});

test("uncommitted tracked change: refuses and changes nothing", () => {
  const { clone, rewrite } = setup();
  rewrite();
  const before = git(clone, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(clone, "src.txt"), "local edit\n");
  const result = run(clone);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /uncommitted/i);
  assert.equal(git(clone, ["rev-parse", "HEAD"]), before);
  assert.equal(
    fs.readFileSync(path.join(clone, "src.txt"), "utf8"),
    "local edit\n",
  );
});

test("real local commit: refused without --force, no gc", () => {
  const { clone, rewrite } = setup();
  commit(clone, { "mine.txt": "work\n" }, "local work", 1_700_000_300);
  rewrite();
  const before = git(clone, ["rev-parse", "HEAD"]);
  const result = run(clone);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /local work/);
  assert.equal(git(clone, ["rev-parse", "HEAD"]), before);
  assert.ok(reachable(clone, "big.bin"), "gc must not run after a refusal");
});

test("real local commit with --force: backup branch keeps it", () => {
  const { clone, remote, rewrite } = setup();
  commit(clone, { "mine.txt": "work\n" }, "local work", 1_700_000_300);
  const work = git(clone, ["rev-parse", "HEAD"]);
  rewrite();
  const result = run(clone, ["--force"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(
    git(clone, ["rev-parse", "HEAD"]),
    git(remote, ["rev-parse", "main"]),
  );
  const backups = git(clone, [
    "for-each-ref",
    "--format=%(objectname)",
    "refs/heads/backup/",
  ]);
  assert.ok(backups.split("\n").includes(work), backups);
});

test("--dry-run changes nothing", () => {
  const { clone, rewrite } = setup();
  rewrite();
  const before = git(clone, ["for-each-ref"]);
  const result = run(clone, ["--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(clone, ["for-each-ref"]), before);
  assert.ok(reachable(clone, "big.bin"));
});

test("detached HEAD fails clearly", () => {
  const { clone, rewrite } = setup();
  rewrite();
  git(clone, ["checkout", "-q", "--detach"]);
  const result = run(clone);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /detached/i);
});

test("fetch failure stops before any reset", () => {
  const { clone, rewrite } = setup();
  rewrite();
  git(clone, ["remote", "set-url", "origin", "/nonexistent/remote.git"]);
  const before = git(clone, ["for-each-ref"]);
  const result = run(clone);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fetch/i);
  assert.equal(git(clone, ["for-each-ref"]), before);
});

test("already in sync: no-op success", () => {
  const { clone } = setup();
  const result = run(clone);
  assert.equal(result.status, 0, result.stderr);
});
