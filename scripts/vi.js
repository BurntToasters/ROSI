#!/usr/bin/env node
import { spawnSync, execSync } from "child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { npmInvocation } = require("./npm-cli.cjs");

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const invocation =
    cmd === "npm" ? npmInvocation() : { command: cmd, prefixArgs: [] };
  const res = spawnSync(
    invocation.command,
    [...invocation.prefixArgs, ...args],
    {
      stdio: "inherit",
      shell: false,
    },
  );
  if (res.status !== 0) {
    console.error(`Command failed: ${cmd} ${args.join(" ")}`);
    process.exit(res.status || 1);
  }
}

try {
  run("git", ["fetch", "origin"]);
  run("git", ["reset", "--hard", "@{u}"]);
  run("git", ["clean", "-fd"]);
  run("git", ["pull"]);
  run("npm", ["ci", "--ignore-scripts"]);

  const branch = execSync("git rev-parse --abbrev-ref HEAD", {
    encoding: "utf8",
  }).trim();
  const green = "\x1b[32m";
  const reset = "\x1b[0m";
  console.log(
    `\n${green}VM Setup Complete. You are on Branch ${branch}.${reset}\n`,
  );
} catch (err) {
  console.error("vi script failed:", err);
  process.exit(1);
}
