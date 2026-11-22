// Stops an E2E child process together with everything it started. A timed-out
// runner that leaves its WebDriver app behind lets the next pass attach to that
// app on the fixed port, so a timeout must end the whole tree.
//
// spawnSync cannot see its child's descendants, so spawnSyncTree runs the
// command through this file as a wrapper. The wrapper spawns the command,
// stops its tree when the inner budget runs out, and exits with
// TREE_TIMEOUT_EXIT_CODE. The caller's own spawnSync timeout is the inner
// budget plus TREE_KILL_GRACE_MS, so the wrapper always acts first.

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Time the tree kill and the wrapper's exit get beyond the inner budget. */
export const TREE_KILL_GRACE_MS = 30_000;
/** Exit status the wrapper uses after it stopped a timed-out tree. */
export const TREE_TIMEOUT_EXIT_CODE = 124;

const SELF = fileURLToPath(import.meta.url);

function assertTimeout(timeout) {
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(
      `timeout must be a positive whole number of milliseconds, got ${timeout}`,
    );
  }
}

/**
 * Kills the process with this pid and its descendants. Windows uses taskkill
 * /T, which walks the tree while the root is alive. POSIX children are started
 * as process-group leaders, so the negative pid reaches the whole group.
 */
export function killProcessTree(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

/**
 * Runs a command and kills its tree when `timeout` ms pass. Resolves with the
 * exit status and whether the timeout fired. Only the wrapper calls this.
 */
export function runTreeWithTimeout(
  command,
  args,
  { timeout, shell = false, ...options } = {},
) {
  assertTimeout(timeout);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    const stop = () => killProcessTree(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    // If the wrapper itself is interrupted, the detached child must not outlive it.
    const onSignal = (signal) => {
      stop();
      process.exit(128 + (signal === "SIGINT" ? 2 : 15));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const finish = () => {
      clearTimeout(timer);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    };
    child.on("error", (error) => {
      finish();
      reject(error);
    });
    child.on("exit", (status, signal) => {
      finish();
      resolve({ status, signal, timedOut });
    });
  });
}

/**
 * Drop-in for spawnSync. Without `timeout` it is plain spawnSync. With one, the
 * command runs under this file's wrapper, and a timeout comes back as an error
 * with code ETIMEDOUT, as spawnSync reports it.
 */
export function spawnSyncTree(command, args = [], options = {}) {
  const { timeout, ...rest } = options;
  if (timeout === undefined) return spawnSync(command, args, rest);
  assertTimeout(timeout);
  const wrapperArgs = [
    SELF,
    "--timeout",
    String(timeout),
    ...(rest.shell === true ? ["--shell"] : []),
    "--",
    command,
    ...args,
  ];
  const result = spawnSync(process.execPath, wrapperArgs, {
    ...rest,
    shell: false,
    timeout: timeout + TREE_KILL_GRACE_MS,
  });
  if (result.status === TREE_TIMEOUT_EXIT_CODE) {
    result.error = Object.assign(
      new Error(`${command} timed out after ${timeout} ms`),
      { code: "ETIMEDOUT" },
    );
  }
  return result;
}

function parseWrapperArgs(argv) {
  const separator = argv.indexOf("--", 0);
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  const rest = separator === -1 ? [] : argv.slice(separator + 1);
  const timeoutIndex = flags.indexOf("--timeout");
  const timeout = Number(flags[timeoutIndex + 1]);
  if (timeoutIndex === -1 || rest.length === 0) {
    throw new Error(
      "usage: process-tree.js --timeout <ms> [--shell] -- <command> [args...]",
    );
  }
  return {
    timeout,
    shell: flags.includes("--shell"),
    command: rest[0],
    args: rest.slice(1),
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  let parsed;
  try {
    parsed = parseWrapperArgs(process.argv.slice(2));
    assertTimeout(parsed.timeout);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  runTreeWithTimeout(parsed.command, parsed.args, {
    timeout: parsed.timeout,
    shell: parsed.shell,
    stdio: "inherit",
  })
    .then(({ status, signal, timedOut }) => {
      if (timedOut) {
        console.error(
          `${parsed.command} exceeded ${parsed.timeout} ms; its process tree was stopped`,
        );
        process.exit(TREE_TIMEOUT_EXIT_CODE);
      }
      process.exit(status ?? (signal ? 1 : 0));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
