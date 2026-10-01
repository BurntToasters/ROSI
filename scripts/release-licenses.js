#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { npmInvocation } = require("./npm-cli.cjs");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_LICENSE_SCRIPTS = Object.freeze([
  "licenses:npm",
  "licenses:cargo:strict",
  "licenses:bundled",
]);

function runReleaseLicenses({
  spawn = spawnSync,
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  cwd = root,
} = {}) {
  const npm = npmInvocation({ env, platform, execPath });
  for (const script of RELEASE_LICENSE_SCRIPTS) {
    const result = spawn(npm.command, [...npm.prefixArgs, "run", script], {
      cwd,
      env,
      stdio: "inherit",
      shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

const isDirectExecution =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectExecution) {
  try {
    process.exitCode = runReleaseLicenses();
  } catch (error) {
    console.error(
      `release-licenses: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

export { RELEASE_LICENSE_SCRIPTS, runReleaseLicenses };
