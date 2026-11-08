// Stability runs: `--repeat N` reruns the whole gate and summarizes flakiness.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../e2e/helpers/profile.js";
import { ARTIFACT_DIR, gitCommit } from "./common.js";
import { EXPECTED_SCENARIOS } from "./manifest.js";

/** `--repeat N` (or ROSI_E2E_REPEAT=N) reruns the whole suite N times. */
export function parseRepeat(argv, env = process.env) {
  const index = argv.indexOf("--repeat");
  const raw = index >= 0 ? argv[index + 1] : env.ROSI_E2E_REPEAT;
  if (raw === undefined) return 1;
  const times = Number(raw);
  if (!Number.isInteger(times) || times < 1 || times > 100) {
    throw new Error(`--repeat needs a whole number from 1 to 100, got ${raw}`);
  }
  return times;
}

/**
 * Per-scenario outcome across repeated runs. A scenario that passed in some
 * runs and failed or never reported in others is flaky.
 */
export function summarizeStability(runs) {
  const names = new Set([
    ...runs.flatMap((run) => run.expected ?? EXPECTED_SCENARIOS),
    ...runs.flatMap((run) => run.passed),
    ...runs.flatMap((run) => run.skipped),
    ...runs.flatMap((run) => run.failed ?? []),
  ]);
  const scenarios = [...names].sort().map((name) => {
    const eligible = runs.filter(
      (run) =>
        (run.expected ?? EXPECTED_SCENARIOS).includes(name) ||
        run.passed.includes(name) ||
        run.skipped.includes(name) ||
        (run.failed ?? []).includes(name),
    );
    const passed = eligible.filter((run) => run.passed.includes(name)).length;
    const skipped = eligible.filter((run) => run.skipped.includes(name)).length;
    const failed = eligible.filter(
      (run) => !run.passed.includes(name) && !run.skipped.includes(name),
    ).length;
    return { name, passed, skipped, failed };
  });
  return {
    runs: runs.length,
    failedRuns: runs.filter((run) => run.error).map((run) => run.run),
    flaky: scenarios
      .filter((scenario) => scenario.passed > 0 && scenario.failed > 0)
      .map((scenario) => scenario.name),
    alwaysFailing: scenarios
      .filter((scenario) => scenario.passed === 0 && scenario.failed > 0)
      .map((scenario) => scenario.name),
    scenarios,
  };
}

export async function runStability(times, runGate) {
  const reportFile = path.join(
    ARTIFACT_DIR,
    `e2e-report-${process.platform}-${process.arch}.json`,
  );
  const runDir = path.join(
    ARTIFACT_DIR,
    "stability",
    `${process.platform}-${process.arch}`,
  );
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  const runs = [];
  for (let run = 1; run <= times; run += 1) {
    console.log(`\n=== E2E stability run ${run}/${times} ===`);
    // The first run builds; later runs reuse that binary.
    if (run > 1) process.env.ROSI_E2E_REUSE = "1";
    let error = null;
    try {
      await runGate();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const report = fs.existsSync(reportFile)
      ? JSON.parse(fs.readFileSync(reportFile, "utf8"))
      : { scenarios: [] };
    fs.copyFileSync(reportFile, path.join(runDir, `run-${run}.json`));
    runs.push({
      run,
      error,
      passed: report.scenarios
        .filter((scenario) => scenario.status === "passed")
        .map((scenario) => scenario.name),
      skipped: report.scenarios
        .filter((scenario) => scenario.status === "skipped")
        .map((scenario) => scenario.name),
      failed: report.scenarios
        .filter((scenario) => scenario.status === "failed")
        .map((scenario) => scenario.name),
      expected: report.expectedScenarios ?? EXPECTED_SCENARIOS,
    });
  }
  const summary = {
    app: "ROSI",
    platform: process.platform,
    arch: process.arch,
    commit: gitCommit(),
    finishedAt: new Date().toISOString(),
    ...summarizeStability(runs),
  };
  summary.reportSha256 = crypto
    .createHash("sha256")
    .update(JSON.stringify(summary, null, 2))
    .digest("hex");
  const file = path.join(
    ARTIFACT_DIR,
    `e2e-stability-${process.platform}-${process.arch}.json`,
  );
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `\nStability: ${times - summary.failedRuns.length}/${times} runs passed; ` +
      `flaky: ${summary.flaky.join(", ") || "none"}; ` +
      `always failing: ${summary.alwaysFailing.join(", ") || "none"}`,
  );
  console.log(
    `Stability evidence written to ${path.relative(REPO_ROOT, file)}`,
  );
  if (summary.failedRuns.length > 0) {
    throw new Error(`E2E failed in run(s) ${summary.failedRuns.join(", ")}`);
  }
}
