// Shared checks for the reports that native E2E runners write. Runners call
// verifyRunnerReport with the identity they expect, so identity, freshness,
// verdict, and self-hash checks mean the same thing in every runner.

import crypto from "node:crypto";

const IDENTITY_KEYS = [
  "app",
  "suite",
  "version",
  "commit",
  "platform",
  "arch",
  "binarySha256",
];

/**
 * Hash of a report body the way the writers compute it: JSON with two-space
 * indentation, with the reportSha256 field itself left out.
 */
export function runnerReportSelfHash(report) {
  const body = Object.fromEntries(
    Object.entries(report).filter(([key]) => key !== "reportSha256"),
  );
  return crypto
    .createHash("sha256")
    .update(Buffer.from(JSON.stringify(body, null, 2)))
    .digest("hex");
}

/**
 * Reads the field names the runners write. Where two writers use different
 * names for one value, the first name present wins.
 */
export function normalizeRunnerReport(report) {
  return {
    app: report.app,
    suite: report.suite ?? report.scenario,
    version: report.version,
    commit: report.commit,
    platform: report.platform,
    arch: report.arch,
    binarySha256: report.binarySha256,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    verdict: report.passed ?? report.allPassed,
    probeSources: report.probeSources ?? report.sourceHashes,
    toneFixtureSha256: report.toneFixtureSha256 ?? report.fixtureHash,
  };
}

/**
 * Returns a list of problems; an empty list means the report passed every
 * check the caller asked for. Only expected keys are checked:
 *   app, suite, version, commit, platform, arch, binarySha256: exact match
 *   startedAfter: ISO string or epoch ms; startedAt and finishedAt must be
 *     valid, startedAt not before it, and finishedAt not before startedAt
 *   verdict: true requires passed or allPassed to be true
 *   selfHash: true requires reportSha256 to match runnerReportSelfHash
 *   label: prefix for messages
 */
export function verifyRunnerReport(report, expected = {}) {
  const label = expected.label ?? "runner";
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return [`${label} report is not an object`];
  }
  const fields = normalizeRunnerReport(report);
  const problems = [];
  for (const key of IDENTITY_KEYS) {
    if (expected[key] !== undefined && fields[key] !== expected[key]) {
      problems.push(`${label} report ${key} differs`);
    }
  }
  if (expected.startedAfter !== undefined) {
    const after =
      typeof expected.startedAfter === "number"
        ? expected.startedAfter
        : Date.parse(expected.startedAfter);
    const startedAt = Date.parse(fields.startedAt);
    const finishedAt = Date.parse(fields.finishedAt);
    if (
      !Number.isFinite(after) ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(finishedAt) ||
      startedAt < after ||
      finishedAt < startedAt
    ) {
      problems.push(`${label} report timestamps are stale or invalid`);
    }
  }
  if (expected.verdict === true && fields.verdict !== true) {
    problems.push(`${label} report does not pass`);
  }
  if (
    expected.selfHash === true &&
    report.reportSha256 !== runnerReportSelfHash(report)
  ) {
    problems.push(`${label} report self-hash differs`);
  }
  return problems;
}
