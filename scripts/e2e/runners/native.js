// Runner-owned native suites: each drives its own app launches and writes a
// report the gate verifies (identity, freshness, self-hash, and outcome).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, e2eBinaryPath } from "../../../e2e/helpers/profile.js";
import { sha256 } from "../../../e2e/helpers/media-server.js";
import {
  ARTIFACT_DIR,
  e2eChildEnv,
  gitCommit,
  relativeToRepo,
  run,
} from "../common.js";
import { companionFfprobe } from "../fixtures.js";
import { ROUND2_NATIVE_OBSERVATIONS } from "../manifest.js";
import { normalizeRunnerReport, verifyRunnerReport } from "../runner-report.js";
import { pruneRunnerArtifacts } from "../prune-artifacts.js";

// Upper bound for one native child. The round-two and process-repair runners
// had none, so a hung child used to block the gate until the CI job timed out.
export const NATIVE_RUNNER_TIMEOUT_MS = 900_000;
const RETAINED_RUN_FOLDERS = 20;
// Folder names these runners write: <ISO time, with - for : and .>-<pid>.
const ROUND2_RUN_FOLDER = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+$/;
const LONG_TERM_GATE_FOLDER = /^gate-\d+-\d+$/;
const AUDIT4_RUN_FOLDER = /^\d+-\d+$/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A message when a child was stopped by its timeout, otherwise null. */
function timeoutReason(error, label) {
  if (error?.code !== "ETIMEDOUT") return null;
  return `${label} timed out after ${NATIVE_RUNNER_TIMEOUT_MS} ms and was stopped`;
}

export function round2NativeReportProblems(report, expected) {
  if (!report || typeof report !== "object") {
    return ["native report is not an object"];
  }
  const problems = verifyRunnerReport(report, {
    label: "native",
    app: "ROSI",
    suite: "round2-native",
    version: expected.version,
    platform: expected.platform,
    arch: expected.arch,
    binarySha256: expected.binarySha256,
    startedAfter: expected.suiteStartedAt,
    verdict: true,
    selfHash: true,
  });
  const fields = normalizeRunnerReport(report);
  if (report.schemaVersion !== undefined && report.schemaVersion !== 1) {
    problems.push("native report schema version is unsupported");
  }
  if (typeof report.runId !== "string" || report.runId.length === 0) {
    problems.push("native report run id is missing");
  }
  if (report.binary !== expected.binary) {
    problems.push("native report E2E binary path differs");
  }
  if (report.ffmpegSha256 !== expected.ffmpegSha256) {
    problems.push("native report FFmpeg hash differs");
  }
  for (const [file, hash] of Object.entries(expected.probeSources)) {
    if (fields.probeSources?.[file] !== hash) {
      problems.push(`native report source hash differs for ${file}`);
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(fields.toneFixtureSha256 ?? "")) {
    problems.push("native report tone fixture hash is missing or malformed");
  }
  if (typeof report.isolatedProfile !== "string" || !report.isolatedProfile) {
    problems.push("native report isolated profile is missing");
  }
  if (report.wdioExitCode !== 0 || report.wdioError) {
    problems.push("native WebdriverIO run did not pass");
  }
  if (!Array.isArray(report.failures) || report.failures.length > 0) {
    problems.push("native report lists failed observations");
  }
  if (!Array.isArray(report.observations)) {
    problems.push("native observations are not an array");
  } else {
    const names = report.observations.map((observation) => observation?.name);
    for (const name of ROUND2_NATIVE_OBSERVATIONS) {
      const matches = report.observations.filter(
        (observation) => observation?.name === name,
      );
      if (matches.length !== 1) {
        problems.push(`${name} reported ${matches.length} times`);
        continue;
      }
      if (matches[0].skipped === true) {
        // A skipped record proves nothing, so it must report null, not a pass.
        if (matches[0].invariantPassed !== null) {
          problems.push(
            `${name} skipped record must report invariantPassed null`,
          );
        }
      } else if ((matches[0].passed ?? matches[0].invariantPassed) !== true) {
        problems.push(`${name} did not pass`);
      }
      if (
        name === "windows-job-object-leader-exit" &&
        matches[0].skipped !== true
      ) {
        problems.push(`${name} must remain explicitly unproven`);
      }
      if (matches[0].skipped === true) {
        const supportedWindowsSkip =
          expected.platform === "win32" &&
          [
            "source-identity-preserves-replacement",
            "deno-version-probe",
          ].includes(name) &&
          typeof matches[0].skipReason === "string" &&
          matches[0].skipReason.length > 0;
        const documentedLeaderExitGap =
          name === "windows-job-object-leader-exit" &&
          typeof matches[0].skipReason === "string" &&
          matches[0].skipReason.length > 0;
        if (!supportedWindowsSkip && !documentedLeaderExitGap) {
          problems.push(`${name} has an unsupported platform skip`);
        }
      }
    }
    for (const name of names) {
      if (!ROUND2_NATIVE_OBSERVATIONS.includes(name)) {
        problems.push(`unexpected native observation ${name}`);
      }
    }
  }
  return problems;
}

export function runLongTermPersistenceRepairs() {
  const relative = path.join(
    "e2e",
    "artifacts",
    "long-term-persistence",
    `gate-${Date.now()}-${process.pid}`,
  );
  const directory = path.join(REPO_ROOT, relative);
  pruneRunnerArtifacts({
    artifactsDir: path.join(ARTIFACT_DIR, "long-term-persistence"),
    pattern: LONG_TERM_GATE_FOLDER,
    keep: RETAINED_RUN_FOLDERS,
    currentRunDir: directory,
  });
  const scenario = {
    name: "long-term-persistence",
    status: "failed",
    reportPath: `${relative}/report.json`,
  };
  const result = spawnSync(
    process.execPath,
    ["e2e/long-term-persistence-run.mjs"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ROSI_LONG_TERM_ARTIFACT_ROOT: relative },
      encoding: "utf8",
      // This runner performs 15 isolated app launches. WebKitGTK startup on
      // hosted Linux takes roughly 30 seconds per launch, so four minutes
      // kills the runner mid-suite and leaves its WebDriver child behind.
      timeout: NATIVE_RUNNER_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  console.log(result.stdout || "");
  if (result.stderr) console.error(result.stderr);
  try {
    const bytes = fs.readFileSync(path.join(directory, "report.json"));
    const report = JSON.parse(bytes);
    const problems = verifyRunnerReport(report, {
      label: "persistence",
      suite: "long-term-v5-audit",
      commit: gitCommit(),
      binarySha256: sha256(fs.readFileSync(e2eBinaryPath())),
      selfHash: true,
    });
    const timedOut = timeoutReason(
      result.error,
      "The long-term persistence runner",
    );
    if (timedOut) problems.push(timedOut);
    else if (result.status !== 0) {
      problems.push(`long-term runner exited with ${result.status}`);
    }
    const observations = Array.isArray(report.observations)
      ? report.observations
      : [];
    if (observations.length !== 15) {
      problems.push("persistence report must record 15 observations");
    }
    if (
      observations.some(
        (item) => item?.runnerExitCode !== 0 || item?.invariantPassed !== true,
      )
    ) {
      problems.push("persistence observation failed");
    }
    for (const [file, expected] of Object.entries(report.sourceSha256 ?? {})) {
      if (sha256(fs.readFileSync(path.join(REPO_ROOT, file))) !== expected) {
        problems.push(`Persistence source changed: ${file}`);
      }
    }
    for (const file of Array.isArray(report.artifacts)
      ? report.artifacts
      : []) {
      const artifact = path.resolve(directory, file.path);
      if (!artifact.startsWith(`${directory}${path.sep}`)) {
        problems.push("Invalid persistence artifact path.");
        continue;
      }
      const contents = fs.readFileSync(artifact);
      if (contents.length !== file.bytes || sha256(contents) !== file.sha256) {
        problems.push(`Persistence artifact changed: ${file.path}`);
      }
    }
    if (problems.length > 0) {
      return {
        ...scenario,
        reason: problems.join("; "),
        runnerExitCode: result.status,
      };
    }
    return {
      ...scenario,
      status: "passed",
      observations: 15,
      reportSha256: sha256(bytes),
    };
  } catch (error) {
    return {
      ...scenario,
      reason: error instanceof Error ? error.message : String(error),
      runnerExitCode: result.status,
    };
  }
}

export function runRound2NativeRepairs(
  { ffmpeg, binary, suiteStartedAt },
  { spawnCommand = spawnSync, artifactsDir = ARTIFACT_DIR } = {},
) {
  const scenario = { name: "round2-native", status: "failed" };
  if (!ffmpeg) {
    return {
      ...scenario,
      reason: "The round-two native pass requires a real FFmpeg executable.",
    };
  }

  const artifactsDirectory = path.resolve(artifactsDir, "round2-native");
  pruneRunnerArtifacts({
    artifactsDir: artifactsDirectory,
    pattern: ROUND2_RUN_FOLDER,
    keep: RETAINED_RUN_FOLDERS,
  });
  const runnerPath = path.join(REPO_ROOT, "e2e", "native-downloads-run.mjs");
  let result;
  try {
    result = spawnCommand(process.execPath, [runnerPath], {
      cwd: REPO_ROOT,
      env: e2eChildEnv({ ROSI_ROUND2_NATIVE_FFMPEG: ffmpeg.binary }),
      encoding: "utf8",
      windowsHide: true,
      timeout: NATIVE_RUNNER_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    return {
      ...scenario,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const timedOut = timeoutReason(result.error, "The round-two native runner");
  if (timedOut) {
    return {
      ...scenario,
      reason: timedOut,
      runnerExitCode: result.status,
    };
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const reportedPath = output
    .match(/^Round 2 native evidence: (.+)$/m)?.[1]
    ?.trim();
  if (!reportedPath) {
    return {
      ...scenario,
      reason:
        result.error?.message ??
        `Native runner did not report its artifact (exit ${result.status ?? result.signal}).`,
      runnerExitCode: result.status,
    };
  }
  const reportPath = path.resolve(reportedPath);
  if (!reportPath.startsWith(`${artifactsDirectory}${path.sep}`)) {
    return {
      ...scenario,
      reason:
        "Native runner reported an artifact outside its evidence directory.",
      reportPath: path
        .relative(REPO_ROOT, reportPath)
        .split(path.sep)
        .join("/"),
    };
  }
  scenario.reportPath = path
    .relative(REPO_ROOT, reportPath)
    .split(path.sep)
    .join("/");
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    );
    const expected = {
      version: packageJson.version,
      platform: process.platform,
      arch: process.arch,
      binary: path.relative(REPO_ROOT, binary).split(path.sep).join("/"),
      binarySha256: sha256(fs.readFileSync(binary)),
      ffmpegSha256: sha256(fs.readFileSync(fs.realpathSync(ffmpeg.binary))),
      probeSources: Object.fromEntries(
        [
          "e2e/native-downloads.spec.js",
          "e2e/native-downloads-failure-modes.md",
        ].map((file) => [
          file,
          sha256(fs.readFileSync(path.join(REPO_ROOT, file))),
        ]),
      ),
      suiteStartedAt,
    };
    const problems = round2NativeReportProblems(report, expected);
    const observationsPath = path.join(
      path.dirname(reportPath),
      "observations.json",
    );
    const observations = JSON.parse(fs.readFileSync(observationsPath, "utf8"));
    if (JSON.stringify(observations) !== JSON.stringify(report.observations)) {
      problems.push(
        "native observation artifact differs from the hashed report",
      );
    }
    if (result.status !== 0 || result.error) {
      problems.push(
        result.error?.message ?? `native runner exited with ${result.status}`,
      );
    }
    if (problems.length > 0) {
      return {
        ...scenario,
        reason: problems.join("; "),
        runnerExitCode: result.status,
      };
    }
    return {
      ...scenario,
      status: "passed",
      reportSha256: report.reportSha256,
      binarySha256: report.binarySha256,
      sourceHashes: normalizeRunnerReport(report).probeSources,
      observations: report.observations.length,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
    };
  } catch (error) {
    return {
      ...scenario,
      reason: error instanceof Error ? error.message : String(error),
      runnerExitCode: result.status,
    };
  }
}

/**
 * Runs one spec through the isolated process-repair wrapper. The wrapper
 * writes repair-report.json; the gate verifies its identity and result.
 */
export function runDownloadProcessRepairs(
  {
    ffmpeg,
    binary,
    suiteStartedAt,
    name = "download-process-repairs",
    spec = "./download-process.spec.js",
  },
  { run: runCommand = run, artifactsDir = ARTIFACT_DIR } = {},
) {
  if (process.platform === "win32") {
    return {
      name,
      status: "skipped",
      reason:
        "The isolated signal and oversized-output wrapper probe currently supports macOS and Linux.",
      platform: process.platform,
    };
  }
  pruneRunnerArtifacts({
    artifactsDir,
    pattern: new RegExp(`^${escapeRegExp(name)}-\\d+-\\d+$`),
    keep: RETAINED_RUN_FOLDERS,
  });
  const repairArtifactDir = path.join(
    artifactsDir,
    `${name}-${Date.now()}-${process.pid}`,
  );
  const reportPath = path.join(repairArtifactDir, "repair-report.json");

  let runnerFailure = null;
  try {
    runCommand(process.execPath, ["e2e/run-download-process.mjs"], {
      env: {
        ROSI_REPAIRS_FFMPEG: ffmpeg?.binary ?? "",
        ROSI_AUDIT3_ARTIFACT_DIR: repairArtifactDir,
        ROSI_REPAIRS_SPEC: spec,
      },
      timeout: NATIVE_RUNNER_TIMEOUT_MS,
    });
  } catch (error) {
    runnerFailure =
      timeoutReason(error, `The ${name} runner`) ??
      (error instanceof Error ? error.message : String(error));
  }

  const scenario = {
    name,
    status: "failed",
    reportPath: path.relative(REPO_ROOT, reportPath).split(path.sep).join("/"),
  };
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const binarySha256 = sha256(fs.readFileSync(binary));
    const selectedFfmpegSha256 = ffmpeg
      ? sha256(fs.readFileSync(fs.realpathSync(ffmpeg.binary)))
      : null;
    const problems = verifyRunnerReport(report, {
      label: "process-repair",
      app: "ROSI",
      version: JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
      ).version,
      commit: gitCommit(),
      platform: process.platform,
      arch: process.arch,
      binarySha256,
      startedAfter: suiteStartedAt,
      selfHash: true,
    });
    if (report.exitCode !== 0) {
      problems.push("process-repair spec reported a nonzero exit code");
    }
    const expectedSources = {
      runner: sha256(
        fs.readFileSync(
          path.join(REPO_ROOT, "e2e", "run-download-process.mjs"),
        ),
      ),
      spec: sha256(
        fs.readFileSync(path.join(REPO_ROOT, "e2e", spec.replace(/^\.\//, ""))),
      ),
      failureModes: sha256(
        fs.readFileSync(
          path.join(REPO_ROOT, "e2e", "download-process.failures.md"),
        ),
      ),
      audit3FailureModes: sha256(
        fs.readFileSync(
          path.join(
            REPO_ROOT,
            "e2e",
            "download-process-targeted-failure-modes.md",
          ),
        ),
      ),
    };
    for (const [key, hash] of Object.entries(expectedSources)) {
      if (report.probeSourceSha256?.[key] !== hash) {
        problems.push(`process-repair source hash differs: ${key}`);
      }
    }
    if (
      selectedFfmpegSha256 !== null &&
      report.realFfmpegSha256 !== selectedFfmpegSha256
    ) {
      problems.push("process-repair FFmpeg hash differs");
    }
    if (runnerFailure) problems.push(runnerFailure);
    if (problems.length > 0) {
      return { ...scenario, reason: problems.join("; "), runnerFailure };
    }
    return {
      ...scenario,
      status: "passed",
      reportSha256: report.reportSha256,
      binarySha256,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      observations: report.observations?.length ?? 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...scenario,
      reason: [runnerFailure, message].filter(Boolean).join("; "),
      runnerFailure,
    };
  }
}

export function runAudit4Repairs({ ffmpeg, binary, suiteStartedAt }) {
  const scenario = { name: "audit4-repairs", status: "failed" };
  if (!ffmpeg) {
    return {
      ...scenario,
      reason: "The audit four repair pass requires a real FFmpeg executable.",
    };
  }
  pruneRunnerArtifacts({
    artifactsDir: path.join(ARTIFACT_DIR, "audit4-repairs"),
    pattern: AUDIT4_RUN_FOLDER,
    keep: RETAINED_RUN_FOLDERS,
  });
  const artifactRoot = path.join(
    ARTIFACT_DIR,
    "audit4-repairs",
    `${Date.now()}-${process.pid}`,
  );
  const reportPath = path.join(artifactRoot, "result.json");
  const env = {
    ROSI_AUDIT4_FFMPEG: ffmpeg.binary,
    ROSI_AUDIT4_ARTIFACT_ROOT: artifactRoot,
  };
  const ffprobe = companionFfprobe(ffmpeg.binary);
  if (ffprobe) env.ROSI_AUDIT4_FFPROBE = ffprobe;
  const result = spawnSync(process.execPath, ["e2e/download-session-run.mjs"], {
    cwd: REPO_ROOT,
    env: e2eChildEnv(env),
    encoding: "utf8",
    windowsHide: true,
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  scenario.reportPath = relativeToRepo(reportPath);
  const problems = [];
  if (result.error || result.status !== 0) {
    problems.push(
      timeoutReason(result.error, "The audit four runner") ??
        `audit four runner exited with ${result.status ?? result.signal ?? result.error?.message}`,
    );
  }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    problems.push(
      ...verifyRunnerReport(report, {
        label: "audit four",
        binarySha256: sha256(fs.readFileSync(binary)),
        startedAfter: suiteStartedAt,
        selfHash: true,
      }),
    );
    if (report.exitCode !== 0 || report.timedOut) {
      problems.push(
        `audit four spec exited ${report.exitCode}${report.timedOut ? " after timeout" : ""}`,
      );
    }
    if (!report.observationsPresent) {
      problems.push("audit four spec wrote no native observations");
    }
    if (
      report.specSha256 !==
      sha256(
        fs.readFileSync(
          path.join(REPO_ROOT, "e2e", "download-session.spec.js"),
        ),
      )
    ) {
      problems.push("audit four spec changed during the run");
    }
  } catch (error) {
    problems.push(
      `audit four result unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (problems.length > 0) return { ...scenario, reason: problems.join("; ") };
  return { ...scenario, status: "passed" };
}
