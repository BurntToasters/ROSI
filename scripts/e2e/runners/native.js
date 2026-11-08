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
  reportSelfHashMatches,
  run,
} from "../common.js";
import { companionFfprobe } from "../fixtures.js";
import { ROUND2_NATIVE_OBSERVATIONS } from "../manifest.js";

export function round2NativeReportProblems(report, expected) {
  const problems = [];
  if (!report || typeof report !== "object") {
    return ["native report is not an object"];
  }
  const suite = report.suite ?? report.scenario;
  if (report.app !== "ROSI")
    problems.push("native report app identity differs");
  if (report.schemaVersion !== undefined && report.schemaVersion !== 1) {
    problems.push("native report schema version is unsupported");
  }
  if (suite !== "round2-native") {
    problems.push("native report suite identity differs");
  }
  if (typeof report.runId !== "string" || report.runId.length === 0) {
    problems.push("native report run id is missing");
  }
  if (report.version !== expected.version) {
    problems.push("native report version differs");
  }
  if (report.platform !== expected.platform || report.arch !== expected.arch) {
    problems.push("native report host identity differs");
  }
  if (report.binary !== expected.binary) {
    problems.push("native report E2E binary path differs");
  }
  if (report.binarySha256 !== expected.binarySha256) {
    problems.push("native report E2E binary hash differs");
  }
  if (report.ffmpegSha256 !== expected.ffmpegSha256) {
    problems.push("native report FFmpeg hash differs");
  }
  const sourceHashes = report.probeSources ?? report.sourceHashes;
  for (const [file, hash] of Object.entries(expected.probeSources)) {
    if (sourceHashes?.[file] !== hash) {
      problems.push(`native report source hash differs for ${file}`);
    }
  }
  if (
    !/^[a-f0-9]{64}$/i.test(
      report.toneFixtureSha256 ?? report.fixtureHash ?? "",
    )
  ) {
    problems.push("native report tone fixture hash is missing or malformed");
  }
  if (typeof report.isolatedProfile !== "string" || !report.isolatedProfile) {
    problems.push("native report isolated profile is missing");
  }
  const startedAt = Date.parse(report.startedAt);
  const finishedAt = Date.parse(report.finishedAt);
  const suiteStartedAt = Date.parse(expected.suiteStartedAt);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    !Number.isFinite(suiteStartedAt) ||
    startedAt < suiteStartedAt ||
    finishedAt < startedAt
  ) {
    problems.push("native report timestamps are stale or invalid");
  }
  if (report.wdioExitCode !== 0 || report.wdioError) {
    problems.push("native WebdriverIO run did not pass");
  }
  if (report.passed !== true) problems.push("native report does not pass");
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
      const passed = matches[0].passed ?? matches[0].invariantPassed;
      if (passed !== true) {
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
  const { reportSha256, ...reportBody } = report;
  const actualReportSha256 = sha256(
    Buffer.from(JSON.stringify(reportBody, null, 2)),
  );
  if (reportSha256 !== actualReportSha256) {
    problems.push("native report self-hash differs");
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
      timeout: 900_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  console.log(result.stdout || "");
  if (result.stderr) console.error(result.stderr);
  try {
    const bytes = fs.readFileSync(path.join(directory, "report.json"));
    const report = JSON.parse(bytes);
    const { reportSha256, ...body } = report;
    if (
      result.status !== 0 ||
      report.suite !== "long-term-v5-audit" ||
      report.observations.length !== 15 ||
      report.observations.some(
        (item) => item.runnerExitCode !== 0 || item.invariantPassed !== true,
      ) ||
      report.binarySha256 !== sha256(fs.readFileSync(e2eBinaryPath())) ||
      reportSha256 !== sha256(Buffer.from(JSON.stringify(body, null, 2)))
    ) {
      throw new Error(
        "Native persistence acceptance or report identity failed.",
      );
    }
    for (const [file, expected] of Object.entries(report.sourceSha256)) {
      if (sha256(fs.readFileSync(path.join(REPO_ROOT, file))) !== expected) {
        throw new Error(`Persistence source changed: ${file}`);
      }
    }
    for (const file of report.artifacts) {
      const artifact = path.resolve(directory, file.path);
      if (!artifact.startsWith(`${directory}${path.sep}`))
        throw new Error("Invalid persistence artifact path.");
      const contents = fs.readFileSync(artifact);
      if (contents.length !== file.bytes || sha256(contents) !== file.sha256) {
        throw new Error(`Persistence artifact changed: ${file.path}`);
      }
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

export function runRound2NativeRepairs({ ffmpeg, binary, suiteStartedAt }) {
  const scenario = { name: "round2-native", status: "failed" };
  if (!ffmpeg) {
    return {
      ...scenario,
      reason: "The round-two native pass requires a real FFmpeg executable.",
    };
  }

  const runnerPath = path.join(REPO_ROOT, "e2e", "native-downloads-run.mjs");
  let result;
  try {
    result = spawnSync(process.execPath, [runnerPath], {
      cwd: REPO_ROOT,
      env: e2eChildEnv({ ROSI_ROUND2_NATIVE_FFMPEG: ffmpeg.binary }),
      encoding: "utf8",
      windowsHide: true,
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
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const reportedPath = output
    .match(/^Round 2 native evidence: (.+)$/m)?.[1]
    ?.trim();
  const artifactsDirectory = path.resolve(ARTIFACT_DIR, "round2-native");
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
      sourceHashes: report.probeSources ?? report.sourceHashes,
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
export function runDownloadProcessRepairs({
  ffmpeg,
  binary,
  suiteStartedAt,
  name = "download-process-repairs",
  spec = "./download-process.spec.js",
}) {
  const repairArtifactDir = path.join(
    ARTIFACT_DIR,
    `${name}-${Date.now()}-${process.pid}`,
  );
  const reportPath = path.join(repairArtifactDir, "repair-report.json");
  if (process.platform === "win32") {
    return {
      name,
      status: "skipped",
      reason:
        "The isolated signal and oversized-output wrapper probe currently supports macOS and Linux.",
      platform: process.platform,
    };
  }

  let runnerFailure = null;
  try {
    run(process.execPath, ["e2e/run-download-process.mjs"], {
      env: {
        ROSI_REPAIRS_FFMPEG: ffmpeg?.binary ?? "",
        ROSI_AUDIT3_ARTIFACT_DIR: repairArtifactDir,
        ROSI_REPAIRS_SPEC: spec,
      },
    });
  } catch (error) {
    runnerFailure = error instanceof Error ? error.message : String(error);
  }

  const scenario = {
    name,
    status: "failed",
    reportPath: path.relative(REPO_ROOT, reportPath).split(path.sep).join("/"),
  };
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const { reportSha256, ...reportBody } = report;
    const actualReportSha256 = sha256(
      Buffer.from(JSON.stringify(reportBody, null, 2)),
    );
    const startedAt = Date.parse(report.startedAt);
    const finishedAt = Date.parse(report.finishedAt);
    const suiteStart = Date.parse(suiteStartedAt);
    const binarySha256 = sha256(fs.readFileSync(binary));
    const selectedFfmpegSha256 = ffmpeg
      ? sha256(fs.readFileSync(fs.realpathSync(ffmpeg.binary)))
      : null;
    const mismatch =
      report.app !== "ROSI" ||
      report.version !==
        JSON.parse(
          fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
        ).version ||
      report.commit !== gitCommit() ||
      report.platform !== process.platform ||
      report.arch !== process.arch ||
      report.exitCode !== 0 ||
      report.binarySha256 !== binarySha256 ||
      report.probeSourceSha256?.runner !==
        sha256(
          fs.readFileSync(
            path.join(REPO_ROOT, "e2e", "run-download-process.mjs"),
          ),
        ) ||
      report.probeSourceSha256?.spec !==
        sha256(
          fs.readFileSync(
            path.join(REPO_ROOT, "e2e", spec.replace(/^\.\//, "")),
          ),
        ) ||
      report.probeSourceSha256?.failureModes !==
        sha256(
          fs.readFileSync(
            path.join(REPO_ROOT, "e2e", "download-process.failures.md"),
          ),
        ) ||
      report.probeSourceSha256?.audit3FailureModes !==
        sha256(
          fs.readFileSync(
            path.join(
              REPO_ROOT,
              "e2e",
              "download-process-targeted-failure-modes.md",
            ),
          ),
        ) ||
      (selectedFfmpegSha256 !== null &&
        report.realFfmpegSha256 !== selectedFfmpegSha256) ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(finishedAt) ||
      !Number.isFinite(suiteStart) ||
      startedAt < suiteStart ||
      finishedAt < startedAt ||
      reportSha256 !== actualReportSha256;
    if (mismatch) {
      throw new Error(
        "The process-repair report failed identity, freshness, result, or self-hash verification.",
      );
    }
    if (runnerFailure) throw new Error(runnerFailure);
    return {
      ...scenario,
      status: "passed",
      reportSha256,
      binarySha256,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      observations: report.observations?.length ?? 0,
    };
  } catch (error) {
    return {
      ...scenario,
      reason: error instanceof Error ? error.message : String(error),
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
      `audit four runner exited with ${result.status ?? result.signal ?? result.error?.message}`,
    );
  }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    if (!reportSelfHashMatches(report))
      problems.push("result self-hash differs");
    if (report.exitCode !== 0 || report.timedOut) {
      problems.push(
        `audit four spec exited ${report.exitCode}${report.timedOut ? " after timeout" : ""}`,
      );
    }
    if (!report.observationsPresent) {
      problems.push("audit four spec wrote no native observations");
    }
    if (report.binarySha256 !== sha256(fs.readFileSync(binary))) {
      problems.push("E2E binary changed during the audit four run");
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
    if (Date.parse(report.startedAt) < Date.parse(suiteStartedAt)) {
      problems.push("audit four result predates this gate run");
    }
  } catch (error) {
    problems.push(
      `audit four result unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (problems.length > 0) return { ...scenario, reason: problems.join("; ") };
  return { ...scenario, status: "passed" };
}
