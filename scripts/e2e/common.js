// Process, environment, and git helpers shared by the E2E gate and its runners.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { REPO_ROOT } from "../../e2e/helpers/profile.js";
import { sha256 } from "../../e2e/helpers/media-server.js";
import { usesWindowsCmdShell } from "../npm-safe-update.mjs";

export const ARTIFACT_DIR = path.join(REPO_ROOT, "e2e", "artifacts");

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

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: e2eChildEnv(options.env),
    stdio: "inherit",
    windowsHide: true,
    encoding: "utf8",
    shell: usesWindowsCmdShell(command),
  });
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

/**
 * `ROSI_E2E_BACKGROUND` for the app launches of this run. Local macOS runs
 * default to "1" so ROSI never takes focus or covers other apps. CI and
 * `ROSI_E2E_FOREGROUND=1` keep the foreground behavior; an explicit value wins.
 * Failure modes: scripts/test-e2e-background.failure-modes.md.
 */
export function e2eBackgroundValue({ env, platform }) {
  if (env.ROSI_E2E_BACKGROUND !== undefined) return env.ROSI_E2E_BACKGROUND;
  if (platform !== "darwin") return null;
  if (env.ROSI_E2E_FOREGROUND === "1") return null;
  const ci = (env.CI ?? "").trim().toLowerCase();
  if (ci !== "" && ci !== "false" && ci !== "0") return null;
  return "1";
}

export function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function gitSourceTree() {
  const result = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
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
