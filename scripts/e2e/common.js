// Process, environment, and git helpers shared by the E2E gate and its runners.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { REPO_ROOT } from "../../e2e/helpers/profile.js";
import { sha256 } from "../../e2e/helpers/media-server.js";
import { usesWindowsCmdShell } from "../npm-safe-update.mjs";
import { spawnSyncTree } from "./process-tree.js";

export const ARTIFACT_DIR = path.join(REPO_ROOT, "e2e", "artifacts");

/** The embedded WebDriver port ROSI app launches use; wdio.conf.js reads the same variable. */
export const EMBEDDED_WEBDRIVER_PORT =
  Number.parseInt(process.env.TAURI_WEBDRIVER_PORT ?? "", 10) || 4445;
const PORT_FREE_TIMEOUT_MS = 15_000;

/** One TCP probe of 127.0.0.1:port: "refused" means nothing is listening. */
function probeLoopbackPort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (state) => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(1_000, () => finish("timeout"));
    socket.once("connect", () => finish("listening"));
    socket.once("error", (error) =>
      finish(
        error.code === "ECONNREFUSED"
          ? "refused"
          : `error:${error.code ?? error.message}`,
      ),
    );
  });
}

/**
 * Resolves once nothing accepts connections on 127.0.0.1:port. A ROSI app left
 * running by an earlier timed-out pass would otherwise answer the next pass's
 * WebDriver session. Fails after `timeoutMs` (15 s by default) while the port
 * still answers.
 */
export async function waitForPortFree(
  port = EMBEDDED_WEBDRIVER_PORT,
  timeoutMs = PORT_FREE_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  let state = "listening";
  for (;;) {
    state = await probeLoopbackPort(port);
    if (state === "refused") return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `127.0.0.1:${port} still accepts connections after ${timeoutMs} ms (last probe: ${state}). ` +
      "An E2E app or runner from an earlier pass may be orphaned; stop it and rerun.",
  );
}

export function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

export function e2eChildEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // Cursor/CI helper envs must not redirect the e2e binary away from
  // src-tauri/target/debug, where the stamp and WDIO launcher look.
  delete env.CARGO_TARGET_DIR;
  return env;
}

/**
 * Run a child process to completion. `options.timeout` (ms) bounds it; without
 * one the child may run for as long as it needs, as before.
 */
export function run(command, args, options = {}) {
  const timeout = options.timeout;
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0)) {
    throw new Error(
      `run timeout must be a positive whole number of milliseconds, got ${timeout}`,
    );
  }
  const result = spawnSyncTree(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: e2eChildEnv(options.env),
    stdio: "inherit",
    windowsHide: true,
    encoding: "utf8",
    shell: usesWindowsCmdShell(command),
    ...(timeout === undefined ? {} : { timeout }),
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(
      `${command} ${args.join(" ")} timed out after ${timeout} ms`,
    );
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}`,
    );
  }
}

/**
 * Asynchronous variant for WebdriverIO: the in-process media server must keep
 * serving while the app downloads, so the event loop cannot be blocked.
 */
export function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: e2eChildEnv(options.env),
      stdio: "inherit",
      windowsHide: true,
      shell: usesWindowsCmdShell(command),
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${code ?? signal}`,
          ),
        );
    });
  });
}

export function which(bin) {
  const result = spawnSync(
    process.platform === "win32" ? "where" : "which",
    [bin],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null;
}

/** Platforms with an implemented background mode. Linux has none. */
const BACKGROUND_PLATFORMS = new Set(["darwin", "win32"]);

/**
 * `ROSI_E2E_BACKGROUND` for the app launches of this run. Local macOS and
 * Windows runs default to "1" so ROSI never takes focus or covers other apps.
 * CI and `ROSI_E2E_FOREGROUND=1` keep the foreground behavior; an explicit
 * value wins. Failure modes: scripts/test-e2e-background.failure-modes.md.
 */
export function e2eBackgroundValue({ env, platform }) {
  if (env.ROSI_E2E_BACKGROUND !== undefined) return env.ROSI_E2E_BACKGROUND;
  if (!BACKGROUND_PLATFORMS.has(platform)) return null;
  if (env.ROSI_E2E_FOREGROUND === "1") return null;
  const ci = (env.CI ?? "").trim().toLowerCase();
  if (ci !== "" && ci !== "false" && ci !== "0") return null;
  return "1";
}

// Paths the release gate allows to be dirty. The release scripts and the E2E
// gate share this one definition.
export const RELEASE_SESSION_RELATIVE_PATH = path.join(
  "release",
  ".build-session.json",
);
export const QUALITY_GATE_RELATIVE_PATH = path.join(
  "coverage",
  ".release-quality.json",
);
// Native Tauri builds rewrite these tracked outputs. Keep the allowlist exact:
// a new or unexpected file under gen/ must still invalidate release proof.
const GENERATED_TAURI_SCHEMA_PATHS = new Set(
  [
    "acl-manifests.json",
    "capabilities.json",
    "desktop-schema.json",
    "linux-schema.json",
    "macOS-schema.json",
    "windows-schema.json",
  ].map((name) => `src-tauri/gen/schemas/${name}`),
);

/** Paths from `git status --porcelain=v1` (keeps leading spaces in status text). */
export function porcelainPaths(statusText) {
  return statusText
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean)
    .map((line) => {
      // XY PATH  or  XY ORIG -> PATH  (XY is always two status columns)
      const pathPart = line.length >= 3 ? line.slice(3) : line;
      return pathPart.includes(" -> ")
        ? pathPart.split(" -> ").at(-1)
        : pathPart;
    });
}

export function isIgnorableReleaseDirtyPath(filePath) {
  // Git porcelain uses forward slashes on every platform, while the paths
  // used to read the generated proofs follow the host platform separator.
  const normalizedPath = filePath.replaceAll("\\", "/");
  const releaseSessionPath = RELEASE_SESSION_RELATIVE_PATH.replaceAll(
    "\\",
    "/",
  );
  const qualityGatePath = QUALITY_GATE_RELATIVE_PATH.replaceAll("\\", "/");
  return (
    GENERATED_TAURI_SCHEMA_PATHS.has(normalizedPath) ||
    normalizedPath === releaseSessionPath ||
    normalizedPath === qualityGatePath
  );
}

export function gitCommit(cwd = REPO_ROOT) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function gitSourceTree(cwd = REPO_ROOT) {
  const result = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

// Git-ignored Cargo configs change how the binary is built, so git status
// cannot vouch for them. Cargo reads config.toml and config from the directory
// it runs in, from every parent of that directory, and from CARGO_HOME. The
// E2E build runs from src-tauri, so src-tauri and all of its parents are read.
const CARGO_CONFIG_NAMES = ["config.toml", "config"];
// Cargo reads these variables as extra compiler flags. Only their hashes are
// recorded, because the values can hold credentials or paths.
const CARGO_RUSTFLAGS_VARIABLES = ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"];
// git's well-known empty tree, the diff base for a repository with no commits.
const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Every existing Cargo config that a build started in `cwd` may read. */
function cargoConfigFiles(cwd, env) {
  const directories = [env.CARGO_HOME || path.join(os.homedir(), ".cargo")];
  for (let dir = path.resolve(cwd, "src-tauri"); ;) {
    directories.push(path.join(dir, ".cargo"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const files = [];
  for (const directory of new Set(
    directories.map((item) => path.resolve(item)),
  )) {
    for (const name of CARGO_CONFIG_NAMES) {
      const file = path.join(directory, name);
      if (fs.existsSync(file)) files.push(file);
    }
  }
  return files;
}

/**
 * Hash of every Cargo config a build in `cwd` may read, or null when there is
 * none. A config that exists but cannot be read throws, so callers fail closed.
 */
export function localCargoConfigSha256(cwd = REPO_ROOT, env = process.env) {
  const files = cargoConfigFiles(cwd, env);
  if (files.length === 0) return null;
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(`${file}\0`);
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * For each Cargo rustflags variable: "unset", or the SHA-256 of its value. An
 * empty value that is set still gets a hash, so set and unset always differ.
 */
export function cargoRustflagsFingerprint(env = process.env) {
  return Object.fromEntries(
    CARGO_RUSTFLAGS_VARIABLES.map((name) => [
      name,
      env[name] === undefined ? "unset" : sha256(env[name]),
    ]),
  );
}

/**
 * Content hash of the worktree beyond the status listing: the diff against
 * HEAD and the bytes of each untracked file, minus the release allowlist.
 * Returns null when git or a file cannot be read, so callers fail closed.
 */
function worktreeContentSha256(cwd, statusText) {
  try {
    const hash = crypto.createHash("sha256");
    hash.update(statusText);
    const base = gitCommit(cwd) ? "HEAD" : EMPTY_TREE_SHA1;
    const excludes = [
      ...GENERATED_TAURI_SCHEMA_PATHS,
      RELEASE_SESSION_RELATIVE_PATH,
      QUALITY_GATE_RELATIVE_PATH,
    ].map((file) => `:(exclude,literal)${file.replaceAll("\\", "/")}`);
    const diff = spawnSync(
      "git",
      ["diff", "--binary", base, "--", ".", ...excludes],
      { cwd, maxBuffer: 256 * 1024 * 1024 },
    );
    if (diff.status !== 0 || !Buffer.isBuffer(diff.stdout)) return null;
    if (diff.stdout.length > 0) {
      hash.update("\0diff\0");
      hash.update(diff.stdout);
    }
    const listed = spawnSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        cwd,
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    if (listed.status !== 0 || !Buffer.isBuffer(listed.stdout)) return null;
    const names = listed.stdout
      .toString("utf8")
      .split("\0")
      .filter((name) => name && !isIgnorableReleaseDirtyPath(name))
      .sort();
    for (const name of names) {
      hash.update(`\0untracked\0${name}\0`);
      hash.update(fs.readFileSync(path.join(cwd, name)));
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/**
 * Whether the working tree differs from HEAD, plus a hash of the status
 * listing, of the diff, and of untracked file contents, and a hash of any local
 * Cargo config. Paths on the release allowlist (generated Tauri schemas, release
 * proofs) are left out, matching the release checks. An unreadable status or
 * config fails closed: it counts as dirty, with no hash.
 */
export function gitWorktreeState(cwd = REPO_ROOT, env = process.env) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-uall"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return {
      worktreeDirty: true,
      worktreeStatusSha256: null,
      localCargoConfigSha256: null,
    };
  }
  let cargoConfigSha256 = null;
  let cargoConfigReadable = true;
  try {
    cargoConfigSha256 = localCargoConfigSha256(cwd, env);
  } catch {
    cargoConfigReadable = false;
  }
  const kept = result.stdout
    .split("\n")
    .filter(
      (line) =>
        line.length > 0 &&
        !porcelainPaths(line).every((filePath) =>
          isIgnorableReleaseDirtyPath(filePath),
        ),
    )
    .map((line) => `${line}\n`)
    .join("");
  return {
    worktreeDirty: kept.length > 0 || !cargoConfigReadable,
    worktreeStatusSha256: worktreeContentSha256(cwd, kept),
    localCargoConfigSha256: cargoConfigSha256,
  };
}

/** Commit, source tree, worktree state and Cargo build settings read together. */
export function gitSourceSnapshot(cwd = REPO_ROOT, env = process.env) {
  return {
    commit: gitCommit(cwd),
    sourceTree: gitSourceTree(cwd),
    ...gitWorktreeState(cwd, env),
    cargoRustflags: cargoRustflagsFingerprint(env),
  };
}

/**
 * What differs between two snapshots. An unreadable value (null) never counts
 * as unchanged, so evidence cannot be trusted when git could not be read.
 */
export function sourceChangeProblems(before, after) {
  const checks = [
    ["commit", "commit"],
    ["source tree", "sourceTree"],
    ["worktree status", "worktreeStatusSha256"],
    ["local Cargo config", "localCargoConfigSha256"],
    ["Cargo rustflags", "cargoRustflags"],
  ];
  const problems = [];
  for (const [label, key] of checks) {
    const unreadable =
      key !== "localCargoConfigSha256" &&
      key !== "cargoRustflags" &&
      (before[key] === null || after[key] === null);
    const changed =
      JSON.stringify(before[key] ?? null) !==
      JSON.stringify(after[key] ?? null);
    if (unreadable || changed) problems.push(label);
  }
  return problems;
}

export function cleanupProfile(profileDir) {
  try {
    fs.rmSync(profileDir, {
      recursive: true,
      force: true,
      // WebView2 can retain file handles briefly after a clean application
      // exit. Its retries use linear backoff, giving Windows up to 21 seconds.
      maxRetries: process.platform === "win32" ? 20 : 8,
      retryDelay: 100,
    });
  } catch (error) {
    console.warn(
      `WARNING: Could not remove temporary E2E profile ${profileDir}; leaving it for OS cleanup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function relativeToRepo(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

/** True when `report.reportSha256` matches the hash of the rest of the report. */
export function reportSelfHashMatches(report) {
  const { reportSha256, ...body } = report;
  return reportSha256 === sha256(Buffer.from(JSON.stringify(body, null, 2)));
}
