// Platform probes: one app launch per mode, each report checked for identity
// and for every invariant (see e2e/platform-probes/README.md).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../../../e2e/helpers/profile.js";
import { sha256 } from "../../../e2e/helpers/media-server.js";
import {
  ARTIFACT_DIR,
  e2eChildEnv,
  gitCommit,
  relativeToRepo,
} from "../common.js";
import { verifyRunnerReport } from "../runner-report.js";

// Each mode is a separate launch of the same binary, as documented in
// e2e/platform-probes/README.md. The spec enables one describe block per mode.
const AUDIT_V5_MODES = Object.freeze([
  { label: "default", args: [], directory: ["audit-v5-beta2"] },
  {
    label: "security",
    args: ["--security"],
    directory: ["audit-v5-beta2", "security-probe"],
  },
  { label: "ui", args: ["--ui"], directory: ["audit-v5-beta2", "ui-probe"] },
  {
    label: "termination",
    args: ["--termination"],
    directory: ["audit-v5-beta2", "termination-probe"],
  },
]);

/**
 * Problems with one probe report, given the identity the gate expects. The
 * probes exit zero once their observations complete, so a false invariant
 * here is a reproduced product defect and fails the gate.
 */
export function probeReportProblems(report, expected) {
  const label = expected.label;
  const problems = verifyRunnerReport(report, {
    label,
    version: expected.version,
    commit: expected.commit,
    binarySha256: expected.binarySha256,
    startedAfter: expected.suiteStartedAt,
    selfHash: true,
  });
  const observations = Array.isArray(report?.observations)
    ? report.observations
    : [];
  if (observations.length === 0) {
    problems.push(`${label} recorded no observations`);
  }
  for (const item of observations) {
    if (item?.invariantPassed === false) {
      problems.push(
        `${label}: ${item.name ?? item.id ?? "observation"} invariant failed`,
      );
    }
  }
  return problems;
}

export function runAuditV5Probes({ ffmpeg, binary, suiteStartedAt }) {
  const scenario = { name: "audit-v5-beta2", status: "failed" };
  if (process.platform !== "darwin") {
    return {
      ...scenario,
      status: "skipped",
      reason:
        "The V5 beta 2 probes need macOS ps and /usr/bin/python3 for the termination probe.",
      platform: process.platform,
    };
  }
  if (!ffmpeg) {
    return {
      ...scenario,
      reason: "The V5 beta 2 probes require a real FFmpeg executable.",
    };
  }
  const binarySha256 = sha256(fs.readFileSync(binary));
  const version = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  ).version;
  const commit = gitCommit();
  const problems = [];
  const reports = [];
  for (const mode of AUDIT_V5_MODES) {
    const reportFile = path.join(
      ARTIFACT_DIR,
      ...mode.directory,
      "probe-report.json",
    );
    fs.rmSync(reportFile, { force: true });
    const result = spawnSync(
      process.execPath,
      ["e2e/platform-probes/run-probes.mjs", ...mode.args],
      {
        cwd: REPO_ROOT,
        env: e2eChildEnv({
          PATH: `${path.dirname(ffmpeg.binary)}${path.delimiter}${process.env.PATH ?? ""}`,
        }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 600_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) {
      problems.push(
        `${mode.label} probes exited with ${result.status ?? result.signal ?? result.error?.message}`,
      );
    }
    try {
      const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
      problems.push(
        ...probeReportProblems(report, {
          label: mode.label,
          version,
          commit,
          binarySha256,
          suiteStartedAt,
        }),
      );
      const observations = Array.isArray(report.observations)
        ? report.observations
        : [];
      reports.push({
        mode: mode.label,
        reportPath: relativeToRepo(reportFile),
        reportSha256: report.reportSha256,
        observations: observations.length,
      });
    } catch (error) {
      problems.push(
        `${mode.label} report unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const outcome = { ...scenario, reports };
  if (problems.length > 0) return { ...outcome, reason: problems.join("; ") };
  return { ...outcome, status: "passed" };
}
