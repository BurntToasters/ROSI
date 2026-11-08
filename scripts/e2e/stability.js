// Stability runs: `--repeat N` reruns the whole gate and summarizes flakiness.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../e2e/helpers/profile.js";
import { ARTIFACT_DIR, gitCommit } from "./common.js";
import { buildCoreRunPlan, coreArtifactPaths, createE2eRunId } from "./core.js";
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

/** Return only a parseable gate report written by this exact invocation. */
export function reportForRun(file, runId) {
  if (!fs.existsSync(file)) return null;
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    return report?.runId === runId ? report : null;
  } catch {
    return null;
  }
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

export async function runStability(times, runGate, { profile = null } = {}) {
  const corePaths =
    profile === "core"
      ? coreArtifactPaths({
          runId: `stability-${createE2eRunId()}`,
        })
      : null;
  const reportFile = corePaths
    ? corePaths.latestReportPath
    : path.join(
        ARTIFACT_DIR,
        `e2e-report-${process.platform}-${process.arch}.json`,
      );
  const runDir = corePaths
    ? path.join(corePaths.runDir, "runs")
    : path.join(
        ARTIFACT_DIR,
        "stability",
        `${process.platform}-${process.arch}`,
      );
  if (!corePaths) fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  const runs = [];
  const previousRunId = process.env.ROSI_E2E_RUN_ID;
  const previousReuse = process.env.ROSI_E2E_REUSE;
  for (let run = 1; run <= times; run += 1) {
    console.log(`\n=== E2E stability run ${run}/${times} ===`);
    // Later runs request reuse, but the build policy honors it only for an
    // explicit fresh ROSI_E2E_ONLY spec; full and core runs rebuild incrementally.
    if (run > 1) process.env.ROSI_E2E_REUSE = "1";
    const runId = createE2eRunId();
    process.env.ROSI_E2E_RUN_ID = runId;
    let error = null;
    try {
      await runGate();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const report = reportForRun(reportFile, runId);
    if (!report) {
      const reason = `E2E report for run ${runId} was not written; refusing stale evidence`;
      error = error ? `${error}; ${reason}` : reason;
    }
    const snapshot = report ?? {
      run,
      runId,
      reportUnavailable: true,
      error,
      scenarios: [],
    };
    fs.writeFileSync(
      path.join(runDir, `run-${run}.json`),
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
    runs.push({
      run,
      error,
      passed: (report?.scenarios ?? [])
        .filter((scenario) => scenario.status === "passed")
        .map((scenario) => scenario.name),
      skipped: (report?.scenarios ?? [])
        .filter((scenario) => scenario.status === "skipped")
        .map((scenario) => scenario.name),
      failed: (report?.scenarios ?? [])
        .filter((scenario) => scenario.status === "failed")
        .map((scenario) => scenario.name),
      expected:
        report?.expectedScenarios ??
        (profile === "core"
          ? buildCoreRunPlan().expectedScenarios
          : EXPECTED_SCENARIOS),
    });
  }
  if (previousRunId === undefined) delete process.env.ROSI_E2E_RUN_ID;
  else process.env.ROSI_E2E_RUN_ID = previousRunId;
  if (previousReuse === undefined) delete process.env.ROSI_E2E_REUSE;
  else process.env.ROSI_E2E_REUSE = previousReuse;
  const summary = {
    app: "ROSI",
    ...(profile ? { profile } : {}),
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
  const file = corePaths
    ? path.join(runDir, "stability-report.json")
    : path.join(
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
