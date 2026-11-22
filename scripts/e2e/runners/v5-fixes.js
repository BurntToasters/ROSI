// v5-fixes areas: discovery, runner-owned areas, and the WebdriverIO pass verdicts.

import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../../e2e/helpers/profile.js";
import { sha256 } from "../../../e2e/helpers/media-server.js";
import { ARTIFACT_DIR, e2eChildEnv, relativeToRepo } from "../common.js";
import { caseSkipProblems } from "../manifest.js";
import { verifyRunnerReport } from "../runner-report.js";
import { pruneRunnerArtifacts } from "../prune-artifacts.js";
import { spawnSyncTree } from "../process-tree.js";

const V5_FIXES_ROOT = path.join(REPO_ROOT, "e2e", "v5-fixes");
// Record name a v5-fixes spec uses in its results file to hand the gate its
// screenshots (e2e/v5-fixes/ui-polish/ui-polish.spec.js).
const V5_SCREENSHOT_RECORD = "v5-screenshots";
// `.skip`/`.only` need no following "(": `(cond ? describe : describe.skip)(` is a skip.
const SKIP_OR_FOCUS_PATTERN =
  /\b(?:describe|it|context|test)\.(?:skip|only)\b|\b(?:xit|xdescribe|xtest)\s*\(|\bthis\.skip\s*\(/;
// Run folders the v5 runners create: <ISO time>-<pid>. The runners write
// either "HH-MM-SS-mmmZ" or "HH-MM-SS.mmmZ" for the time part.
export const V5_RUN_DIR_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}[.-]\d{3}Z-\d+$/;
const V5_RETAINED_RUN_FOLDERS = 20;
// Outer budget for an area runner. Its own WebdriverIO launches each get 300 s
// (async-proxy, deno-installer, downloader, network), so one launch fits well
// inside it.
export const V5_RUNNER_TIMEOUT_MS = 1_200_000;
// The persistence runner launches WebdriverIO once per seed mode (13 modes in
// e2e/v5-fixes/persistence/run.mjs), each with a 180 s budget, plus 120 s of setup.
export const PERSISTENCE_RUNNER_TIMEOUT_MS = 13 * 180_000 + 120_000;

/**
 * Lists each e2e/v5-fixes/<area>/ with a *.spec.js file or a run.mjs runner.
 * An area with run.mjs is runner-owned: its specs are driven by the runner and
 * never get a generic wdio pass. Spec files that skip or focus tests are
 * reported in skipFiles, which fails the area.
 */
export function discoverV5Fixes(root = V5_FIXES_ROOT) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = path.join(root, entry.name);
      const specs = fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((file) => file.isFile() && file.name.endsWith(".spec.js"))
        .map((file) => file.name)
        .sort();
      const runnerPath = path.join(directory, "run.mjs");
      const skipFiles = specs.filter((spec) =>
        SKIP_OR_FOCUS_PATTERN.test(
          fs.readFileSync(path.join(directory, spec), "utf8"),
        ),
      );
      return {
        area: entry.name,
        directory,
        specs,
        skipFiles,
        runner: fs.existsSync(runnerPath) ? runnerPath : null,
      };
    })
    .filter((area) => area.specs.length > 0 || area.runner)
    .sort((a, b) => a.area.localeCompare(b.area));
}

export function runV5FixesRunner(area, binary, ffmpeg) {
  // Runners timestamp their own report directories, so earlier runs stay in
  // place and are told apart by report mtime. Only the newest are kept.
  const artifactDirectory = path.join(ARTIFACT_DIR, `v5-fixes-${area.area}`);
  fs.mkdirSync(artifactDirectory, { recursive: true });
  pruneRunnerArtifacts({
    artifactsDir: artifactDirectory,
    pattern: V5_RUN_DIR_PATTERN,
    keep: V5_RETAINED_RUN_FOLDERS,
  });
  // The gate checks each report against the hash of the binary it launched.
  const binarySha256 = sha256(fs.readFileSync(binary));
  const result = spawnSyncTree(process.execPath, [area.runner], {
    cwd: REPO_ROOT,
    env: e2eChildEnv({
      ROSI_E2E_BINARY: binary,
      ROSI_E2E_ARTIFACT_DIR: artifactDirectory,
      ROSI_E2E_FFMPEG: ffmpeg?.binary ?? "",
    }),
    encoding: "utf8",
    windowsHide: true,
    timeout:
      area.area === "persistence"
        ? PERSISTENCE_RUNNER_TIMEOUT_MS
        : V5_RUNNER_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return { ...result, binarySha256 };
}

/**
 * Skips a runner report records: cases or checks marked skipped, plus skipped
 * records in the top-level checks and observations lists. Returns
 * [{ case, reason }]; a check is named "<case>/<check>".
 */
export function reportedSkips(report) {
  const isSkip = (item) => item?.skipped === true || item?.status === "skipped";
  const reasonOf = (item) => {
    const reason = item.reason ?? item.skipReason;
    return typeof reason === "string" ? reason : "";
  };
  const nameOf = (item) => item.name ?? item.mode ?? "unnamed";
  const skips = [];
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  for (const entry of cases) {
    if (isSkip(entry)) {
      skips.push({ case: nameOf(entry), reason: reasonOf(entry) });
    }
    const checks = Array.isArray(entry?.checks) ? entry.checks : [];
    for (const check of checks.filter(isSkip)) {
      skips.push({
        case: `${nameOf(entry ?? {})}/${nameOf(check)}`,
        reason: reasonOf(check),
      });
    }
  }
  for (const key of ["checks", "observations", "previewCookieObservations"]) {
    const records = Array.isArray(report?.[key]) ? report[key] : [];
    for (const record of records.filter(isSkip)) {
      skips.push({ case: nameOf(record), reason: reasonOf(record) });
    }
  }
  return skips;
}

/**
 * Finds the newest report.json a runner wrote during this gate run under
 * e2e/artifacts/v5-fixes-<area>/<stamp>/. Returns { file, problem, skipped }.
 * `expected.binarySha256` is the gate's binary hash; the report must carry the
 * same one and a startedAt inside this invocation. Skipped cases need an
 * allowance in e2e/suites.json for `expected.platform`.
 */
export function findRunnerReport(
  area,
  artifactDir,
  gateStartedMs,
  expected = {},
) {
  const root = path.join(artifactDir, `v5-fixes-${area.area}`);
  if (!fs.existsSync(root)) {
    return { file: null, problem: "no runner report directory was written" };
  }
  // One second of slack covers filesystems with coarse mtimes.
  const since = gateStartedMs - 1000;
  const candidates = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "report.json"))
    .filter((file) => fs.existsSync(file) && fs.statSync(file).mtimeMs >= since)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (candidates.length === 0) {
    return { file: null, problem: "no report written during this run" };
  }
  const file = candidates[0];
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return {
      file,
      problem: `report unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // Network and persistence runners use different verdict keys; both count.
  // Their embedded self-hash is not checked here: network and async-proxy
  // hash their body before adding `passed`, and persistence writes a sidecar.
  const problems = [];
  if (typeof expected.binarySha256 !== "string" || !expected.binarySha256) {
    problems.push(`${area.area} has no gate binary hash to verify against`);
  }
  problems.push(
    ...verifyRunnerReport(report, {
      label: area.area,
      verdict: true,
      binarySha256: expected.binarySha256 || undefined,
      startedAfter: gateStartedMs,
    }),
  );
  const skipped = reportedSkips(report);
  problems.push(
    ...caseSkipProblems(
      `v5-fixes/${area.area}`,
      skipped,
      expected.platform ?? process.platform,
    ),
  );
  if (problems.length > 0) {
    return { file, problem: problems.join("; "), skipped };
  }
  return { file, problem: null, skipped };
}

/**
 * Screenshot and skip records a WebdriverIO v5-fixes pass wrote to its results
 * file (ROSI_E2E_RESULTS). Returns { shots, skipped, problem }; an unreadable
 * file is a problem, since its records would otherwise drop out of the gate
 * silently.
 */
function v5PassRecords(pass) {
  if (!pass?.resultsPath || !fs.existsSync(pass.resultsPath)) {
    return { shots: [], skipped: [], problem: null };
  }
  let records;
  try {
    records = JSON.parse(fs.readFileSync(pass.resultsPath, "utf8"));
  } catch (error) {
    return {
      shots: [],
      skipped: [],
      problem: `pass results unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const shots = Array.isArray(records)
    ? records
        .filter((record) => record?.name === V5_SCREENSHOT_RECORD)
        .flatMap((record) => (Array.isArray(record.shots) ? record.shots : []))
    : [];
  const skipped = Array.isArray(records)
    ? reportedSkips({ checks: records })
    : [];
  return { shots, skipped, problem: null };
}

export function v5AreaScenario(
  area,
  pass,
  runnerResult,
  gateStartedMs,
  platform = process.platform,
) {
  const problems = [];
  if (area.skipFiles.length > 0) {
    problems.push(`skips or focuses tests in ${area.skipFiles.join(", ")}`);
  }
  let report = null;
  let skippedCases = [];
  if (area.runner) {
    if (!runnerResult) {
      problems.push("runner did not run");
    } else if (runnerResult.error || runnerResult.status !== 0) {
      problems.push(
        `runner exited with ${runnerResult.status ?? runnerResult.signal ?? runnerResult.error?.message}`,
      );
    } else {
      const found = findRunnerReport(area, ARTIFACT_DIR, gateStartedMs, {
        binarySha256: runnerResult.binarySha256,
        platform,
      });
      report = found.file ? relativeToRepo(found.file) : null;
      skippedCases = found.skipped ?? [];
      if (found.problem) problems.push(found.problem);
    }
  } else if (
    area.skipFiles.length === 0 &&
    area.specs.length > 0 &&
    pass?.status !== "passed"
  ) {
    problems.push(pass?.reason ? `specs: ${pass.reason}` : "specs did not run");
  }
  // Runner-owned areas report their own files; only WebdriverIO passes write
  // shots and skip records to the pass results file. A spec that does not
  // apply on this platform records a skip, which needs a case allowance.
  const passRecords = area.runner
    ? { shots: [], skipped: [], problem: null }
    : v5PassRecords(pass);
  const shots = passRecords.shots;
  if (passRecords.problem) problems.push(passRecords.problem);
  if (!area.runner && passRecords.skipped.length > 0) {
    skippedCases = passRecords.skipped;
    problems.push(
      ...caseSkipProblems(`v5-fixes/${area.area}`, skippedCases, platform),
    );
  }
  const scenario = {
    name: `v5-fixes/${area.area}`,
    status: problems.length > 0 ? "failed" : "passed",
    specs: area.specs.map((spec) => `${area.area}/${spec}`),
    runner: area.runner ? relativeToRepo(area.runner) : null,
    report,
  };
  // Only areas that record screenshots carry a shots list.
  if (shots.length > 0) scenario.shots = shots;
  // Allowed skips stay visible in the evidence report.
  if (skippedCases.length > 0) scenario.skippedCases = skippedCases;
  if (problems.length > 0) scenario.reason = problems.join("; ");
  return scenario;
}
