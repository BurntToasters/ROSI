// Renderer DOM checks: a Node runner in e2e/renderer-dom-checks that needs no app.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../../../e2e/helpers/profile.js";
import { ARTIFACT_DIR, e2eChildEnv, relativeToRepo } from "../common.js";

const ROUND3_CHECK_COUNT = 15;

export function runRound3Renderer() {
  const scenario = { name: "round3-renderer-repairs", status: "failed" };
  const artifact = path.join(
    ARTIFACT_DIR,
    "round3-renderer",
    "renderer-dom-checks.json",
  );
  // Remove the previous record so a crashed run cannot be read as passing.
  fs.rmSync(artifact, { force: true });
  const result = spawnSync(
    process.execPath,
    ["e2e/renderer-dom-checks/run.cjs"],
    {
      cwd: REPO_ROOT,
      env: e2eChildEnv(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.stderr) process.stderr.write(result.stderr);
  scenario.reportPath = relativeToRepo(artifact);
  const problems = [];
  if (result.error || result.status !== 0) {
    problems.push(
      `renderer runner exited with ${result.status ?? result.signal ?? result.error?.message}`,
    );
  }
  try {
    const report = JSON.parse(fs.readFileSync(artifact, "utf8"));
    const checks = Array.isArray(report.checks) ? report.checks : [];
    if (checks.length !== ROUND3_CHECK_COUNT) {
      problems.push(
        `expected ${ROUND3_CHECK_COUNT} renderer checks, found ${checks.length}`,
      );
    }
    for (const check of checks) {
      if (check.status !== "passed") problems.push(`${check.name} failed`);
    }
  } catch (error) {
    problems.push(
      `renderer record unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (problems.length > 0) return { ...scenario, reason: problems.join("; ") };
  return { ...scenario, status: "passed" };
}
