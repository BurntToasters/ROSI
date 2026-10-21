#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { usesWindowsCmdShell } from "./npm-safe-update.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONTINUE_SCRIPTS = {
  win: "release:win:continue",
  mac: "release:mac:continue",
  linux: "release:linux:continue",
  "linux:x64": "release:linux:x64:continue",
  "linux:arm64": "release:linux:arm64:continue",
};

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function parseReleaseArgs(argv) {
  const flags = argv.filter((arg) => arg.startsWith("-"));
  // Keep the former opt-in flag as a no-op so old operator commands still work.
  const knownFlags = new Set(["--skip-e2e", "--skip-check"]);
  const unknown = flags.filter((flag) => !knownFlags.has(flag));
  if (unknown.length > 0) {
    throw new Error(`Unknown release flag: ${unknown.join(", ")}`);
  }
  const platforms = argv.filter((arg) => !arg.startsWith("-"));
  if (platforms.length !== 1 || !CONTINUE_SCRIPTS[platforms[0]]) {
    throw new Error(
      `Usage: node scripts/run-release.js <${Object.keys(CONTINUE_SCRIPTS).join("|")}> [--skip-check]`,
    );
  }
  return {
    platform: platforms[0],
    skipCheck: flags.includes("--skip-check"),
    continueScript: CONTINUE_SCRIPTS[platforms[0]],
  };
}

function runNpm(script, extraArgs = [], envOverrides = {}) {
  const npm = npmCommand();
  const result = spawnSync(npm, ["run", script, ...extraArgs], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    shell: usesWindowsCmdShell(npm),
    env: { ...process.env, ...envOverrides },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function main(argv = process.argv.slice(2), runner = runNpm) {
  const { skipCheck, continueScript } = parseReleaseArgs(argv);
  runner("prerelease:prepare");
  runner("workspace:bootstrap");
  runner("test:all", ["--", "--require-clean-proof", "--skip-e2e"]);
  runner("dist:clean-release-artifacts");
  runner(continueScript, [], skipCheck ? { FORCE_UPLOAD: "1" } : {});
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isDirectExecution()) {
  main();
}
