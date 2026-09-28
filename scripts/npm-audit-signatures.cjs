#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");

const MAX_ATTEMPTS = 5;
const RETRYABLE =
  /E503|503 Service Unavailable|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runAuditSignatures() {
  return spawnSync(npmCommand(), ["audit", "signatures"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
  });
}

function main() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = runAuditSignatures();
    if (result.error) {
      console.error(result.error.message);
    }
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status === 0) return;

    const output = `${result.stdout || ""}\n${result.stderr || ""}\n${result.error?.message || ""}`;
    const canRetry = RETRYABLE.test(output) && attempt < MAX_ATTEMPTS;
    if (!canRetry) {
      process.exit(result.status || 1);
    }
    const delayMs = attempt * 15_000;
    console.error(
      `[npm-audit-signatures] registry error; retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delayMs / 1000}s`,
    );
    sleepSync(delayMs);
  }
}

main();
