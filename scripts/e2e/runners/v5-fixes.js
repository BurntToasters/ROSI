// v5-fixes areas: discovery, runner-owned areas, and the WebdriverIO pass verdicts.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../../../e2e/helpers/profile.js";
import { ARTIFACT_DIR, e2eChildEnv, relativeToRepo } from "../common.js";

const V5_FIXES_ROOT = path.join(REPO_ROOT, "e2e", "v5-fixes");
// Record name a v5-fixes spec uses in its results file to hand the gate its
// screenshots (e2e/v5-fixes/ui-polish/ui-polish.spec.js).
const V5_SCREENSHOT_RECORD = "v5-screenshots";
const SKIP_OR_FOCUS_PATTERN =
  /\b(?:describe|it|context|test)\.(?:skip|only)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|\bthis\.skip\s*\(/;

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
  // place and are told apart by report mtime.
  const artifactDirectory = path.join(ARTIFACT_DIR, `v5-fixes-${area.area}`);
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const result = spawnSync(process.execPath, [area.runner], {
    cwd: REPO_ROOT,
    env: e2eChildEnv({
      ROSI_E2E_BINARY: binary,
      ROSI_E2E_ARTIFACT_DIR: artifactDirectory,
      ROSI_E2E_FFMPEG: ffmpeg?.binary ?? "",
    }),
    encoding: "utf8",
    windowsHide: true,
    timeout: 1_200_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

/**
 * Finds the newest report.json a runner wrote during this gate run under
 * e2e/artifacts/v5-fixes-<area>/<stamp>/. Returns { file, problem }.
 */
export function findRunnerReport(area, artifactDir, gateStartedMs) {
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
  const verdict = report.passed === true || report.allPassed === true;
  if (!verdict) return { file, problem: "runner report did not pass" };
  return { file, problem: null };
}

/**
 * Screenshot records a WebdriverIO v5-fixes pass wrote to its results file
 * (ROSI_E2E_RESULTS). Returns { shots, problem }; an unreadable file is a
 * problem, since its shots would otherwise drop out of the gate silently.
 */
function v5PassShots(pass) {
  if (!pass?.resultsPath || !fs.existsSync(pass.resultsPath)) {
    return { shots: [], problem: null };
  }
  let records;
  try {
    records = JSON.parse(fs.readFileSync(pass.resultsPath, "utf8"));
  } catch (error) {
    return {
      shots: [],
      problem: `screenshot results unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const shots = Array.isArray(records)
    ? records
        .filter((record) => record?.name === V5_SCREENSHOT_RECORD)
        .flatMap((record) => (Array.isArray(record.shots) ? record.shots : []))
    : [];
  return { shots, problem: null };
}

export function v5AreaScenario(area, pass, runnerResult, gateStartedMs) {
  const problems = [];
  if (area.skipFiles.length > 0) {
    problems.push(`skips or focuses tests in ${area.skipFiles.join(", ")}`);
  }
  let report = null;
  if (area.runner) {
    if (!runnerResult) {
      problems.push("runner did not run");
    } else if (runnerResult.error || runnerResult.status !== 0) {
      problems.push(
        `runner exited with ${runnerResult.status ?? runnerResult.signal ?? runnerResult.error?.message}`,
      );
    } else {
      const found = findRunnerReport(area, ARTIFACT_DIR, gateStartedMs);
      report = found.file ? relativeToRepo(found.file) : null;
      if (found.problem) problems.push(found.problem);
    }
  } else if (
    area.skipFiles.length === 0 &&
    area.specs.length > 0 &&
    pass?.status !== "passed"
  ) {
    problems.push(pass?.reason ? `specs: ${pass.reason}` : "specs did not run");
  }
  // Runner-owned areas report their own files; only WebdriverIO passes record shots.
  const { shots, problem: shotProblem } = area.runner
    ? { shots: [], problem: null }
    : v5PassShots(pass);
  if (shotProblem) problems.push(shotProblem);
  const scenario = {
    name: `v5-fixes/${area.area}`,
    status: problems.length > 0 ? "failed" : "passed",
    specs: area.specs.map((spec) => `${area.area}/${spec}`),
    runner: area.runner ? relativeToRepo(area.runner) : null,
    report,
  };
  // Only areas that record screenshots carry a shots list.
  if (shots.length > 0) scenario.shots = shots;
  if (problems.length > 0) scenario.reason = problems.join("; ");
  return scenario;
}
