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
  relativeToRepo,
  reportSelfHashMatches,
} from "../common.js";

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
      if (!reportSelfHashMatches(report)) {
        problems.push(`${mode.label} report self-hash differs`);
      }
      if (report.binarySha256 !== binarySha256) {
        problems.push(`${mode.label} binary changed during probes`);
      }
      if (Date.parse(report.startedAt) < Date.parse(suiteStartedAt)) {
        problems.push(`${mode.label} report predates this gate run`);
      }
      const observations = Array.isArray(report.observations)
        ? report.observations
        : [];
      if (observations.length === 0) {
        problems.push(`${mode.label} recorded no observations`);
      }
      // The probes exit zero once observations complete. A false invariant is
      // a reproduced product defect, so it fails the gate.
      for (const item of observations) {
        if (item.invariantPassed === false) {
          problems.push(
            `${mode.label}: ${item.name ?? item.id ?? "observation"} invariant failed`,
          );
        }
      }
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
