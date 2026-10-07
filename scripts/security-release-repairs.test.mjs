import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  validateQualityGate,
  validateReleaseSession,
  verifyFullE2eEvidence,
} from "./release-session.js";
import { REVIEWED_SOURCE_OMISSIONS } from "./generate-cargo-licenses.js";
import {
  EXPECTED_SCENARIOS,
  mayReuseE2eBinary,
  scenarioOutcomeProblems,
} from "./test-e2e.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = Date.parse("2026-10-03T12:00:00Z");
const expected = {
  version: "5.0.0-beta.2",
  commit: "a".repeat(40),
  sourceTree: "b".repeat(40),
  platform: "darwin",
  arch: "arm64",
  node: "v24.16.0",
  rustc: "rustc 1.98.1 (test)",
  packageLockSha256: "c".repeat(64),
  cargoLockSha256: "d".repeat(64),
};

function successfulScenarios(overrides = {}) {
  return EXPECTED_SCENARIOS.map((name) => ({
    name,
    status: overrides[name] ?? "passed",
  }));
}

test("canonical outcomes allow the Linux-only XDG skip only off Linux", () => {
  for (const platform of ["darwin", "win32"]) {
    assert.deepEqual(
      scenarioOutcomeProblems(
        successfulScenarios({ "xdg-download-dir": "skipped" }),
        platform,
      ),
      [],
    );
  }

  const linuxSkipProblems = scenarioOutcomeProblems(
    successfulScenarios({ "xdg-download-dir": "skipped" }),
    "linux",
  );
  assert.ok(
    linuxSkipProblems.some((problem) => problem.includes("xdg-download-dir")),
    JSON.stringify(linuxSkipProblems),
  );

  const failedProblems = scenarioOutcomeProblems(
    successfulScenarios({ "xdg-download-dir": "failed" }),
    "darwin",
  );
  assert.ok(
    failedProblems.some((problem) =>
      problem.includes("unacceptable status failed"),
    ),
    JSON.stringify(failedProblems),
  );

  const missingProblems = scenarioOutcomeProblems(
    successfulScenarios().filter(
      (scenario) => scenario.name !== "xdg-download-dir",
    ),
    "darwin",
  );
  assert.ok(
    missingProblems.some((problem) =>
      problem.includes("xdg-download-dir reported 0 times"),
    ),
    JSON.stringify(missingProblems),
  );

  const unexpectedProblems = scenarioOutcomeProblems(
    [
      ...successfulScenarios(),
      { name: "unexpected-scenario", status: "passed" },
    ],
    "darwin",
  );
  assert.ok(
    unexpectedProblems.some((problem) =>
      problem.includes("unexpected scenario"),
    ),
    JSON.stringify(unexpectedProblems),
  );
});

function fullGate(overrides = {}) {
  return {
    ...expected,
    scope: "full",
    e2e: {
      status: "passed",
      platform: expected.platform,
      arch: expected.arch,
      reportSha256: "e".repeat(64),
      binarySha256: "f".repeat(64),
      finishedAt: now - 60_000,
    },
    completedAt: now - 30_000,
    ...overrides,
  };
}

function hostedGate(overrides = {}) {
  return {
    ...expected,
    scope: "build-vm-partial",
    e2e: { status: "skipped" },
    hostedCi: {
      checkName: "ci-gate",
      status: "completed",
      conclusion: "success",
      event: "push",
      branch: "beta",
      headSha: expected.commit,
      checkRunId: 1234,
      url: "https://github.com/BurntToasters/ROSI/actions/runs/1234",
      completedAt: now - 120_000,
      artifactSha256: "1".repeat(64),
    },
    completedAt: now - 30_000,
    ...overrides,
  };
}

test("a full local gate must bind fresh same-platform E2E and binary artifacts", () => {
  assert.doesNotThrow(() => validateQualityGate(fullGate(), expected, { now }));
  for (const gate of [
    fullGate({ e2e: { status: "skipped" } }),
    fullGate({ e2e: { ...fullGate().e2e, platform: "linux" } }),
    fullGate({ e2e: { ...fullGate().e2e, reportSha256: "invalid" } }),
    fullGate({ e2e: { ...fullGate().e2e, binarySha256: null } }),
    fullGate({
      e2e: { ...fullGate().e2e, finishedAt: now - 26 * 60 * 60 * 1000 },
    }),
  ]) {
    assert.throws(() => validateQualityGate(gate, expected, { now }));
  }
});

test("a skipped-E2E build-VM proof requires fresh exact successful hosted ci-gate", () => {
  assert.doesNotThrow(() =>
    validateQualityGate(hostedGate(), expected, { now }),
  );
  const failures = [
    hostedGate({
      hostedCi: { ...hostedGate().hostedCi, conclusion: "failure" },
    }),
    hostedGate({
      hostedCi: { ...hostedGate().hostedCi, headSha: "9".repeat(40) },
    }),
    hostedGate({
      hostedCi: { ...hostedGate().hostedCi, checkName: "quality-gate" },
    }),
    hostedGate({
      hostedCi: { ...hostedGate().hostedCi, status: "in_progress" },
    }),
    hostedGate({
      hostedCi: { ...hostedGate().hostedCi, artifactSha256: null },
    }),
    hostedGate({
      hostedCi: {
        ...hostedGate().hostedCi,
        completedAt: now - 26 * 60 * 60 * 1000,
      },
    }),
    hostedGate({ hostedCi: null }),
  ];
  for (const gate of failures) {
    assert.throws(() => validateQualityGate(gate, expected, { now }));
  }
});

test("a gate proof is rejected for a different source tree, lock, or stale timestamp", () => {
  assert.throws(
    () =>
      validateQualityGate(
        fullGate(),
        { ...expected, sourceTree: "9".repeat(40) },
        { now },
      ),
    /sourceTree/,
  );
  assert.throws(
    () =>
      validateQualityGate(
        fullGate(),
        { ...expected, packageLockSha256: "9".repeat(64) },
        { now },
      ),
    /packageLockSha256/,
  );
  assert.throws(
    () =>
      validateQualityGate(
        fullGate({ completedAt: now - 26 * 60 * 60 * 1000 }),
        expected,
        { now },
      ),
    /expired/,
  );
});

test("only an ad-hoc E2E spec may reuse an existing native binary", () => {
  assert.equal(
    mayReuseE2eBinary({
      onlySpec: false,
      reuseRequested: true,
      binaryFresh: true,
    }),
    false,
  );
  assert.equal(
    mayReuseE2eBinary({
      onlySpec: true,
      reuseRequested: true,
      binaryFresh: true,
    }),
    true,
  );
  assert.equal(
    mayReuseE2eBinary({
      onlySpec: true,
      reuseRequested: true,
      binaryFresh: false,
    }),
    false,
  );
});

test("release sessions retain an accepted gate scope and evidence identity", () => {
  const session = {
    ...expected,
    qualityGateCompletedAt: now - 30_000,
    qualityGateScope: "build-vm-partial",
    qualityGateArtifactSha256: "2".repeat(64),
    startedAt: now - 10_000,
  };
  assert.doesNotThrow(() => validateReleaseSession(session, expected, { now }));
  assert.throws(() =>
    validateReleaseSession(
      { ...session, qualityGateScope: "skipped-e2e" },
      expected,
      { now },
    ),
  );
  assert.throws(() =>
    validateReleaseSession(
      { ...session, qualityGateArtifactSha256: null },
      expected,
      { now },
    ),
  );
});

test("selectors 0.38.0 omission is bound to its exact immutable source", () => {
  const review = REVIEWED_SOURCE_OMISSIONS.get("selectors@0.38.0");
  assert.ok(review, "selectors 0.38.0 source review is missing");
  assert.equal(review.repository, "https://github.com/servo/stylo");
  assert.equal(review.revision, "572ecba2d1600e7c3d490586692a209faf703baa");
  assert.equal(review.pathInRepository, "selectors");
  assert.match(
    review.reason,
    /no license text under selectors or at the repository root.*MPL-2\.0/i,
  );
  assert.equal(REVIEWED_SOURCE_OMISSIONS.has("selectors@0.38.1"), false);
});

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeFullE2eFixture(directory, mutate = () => {}) {
  const binaryPath = path.join(
    directory,
    "src-tauri",
    "target",
    "debug",
    "rosi",
  );
  const reportPath = path.join(
    directory,
    "e2e",
    "artifacts",
    "e2e-report-darwin-arm64.json",
  );
  const screenshotPath = path.join(
    directory,
    "e2e",
    "artifacts",
    "screenshots",
    "darwin-arm64",
    "proof.png",
  );
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(binaryPath, "fixture app binary");
  const screenshotBytes = Buffer.from("fixture screenshot bytes");
  fs.writeFileSync(screenshotPath, screenshotBytes);
  const startedAt = new Date(now - 120_000).toISOString();
  const finishedAt = new Date(now - 60_000).toISOString();
  const identity = {
    version: expected.version,
    commit: expected.commit,
    sourceTree: expected.sourceTree,
    platform: expected.platform,
    arch: expected.arch,
    node: expected.node,
    packageLockSha256: expected.packageLockSha256,
    cargoLockSha256: expected.cargoLockSha256,
  };
  const reportBody = {
    app: "ROSI",
    fullSuite: true,
    ...identity,
    startedAt,
    finishedAt,
    passed: true,
    expectedScenarios: [...EXPECTED_SCENARIOS],
    scenarios: EXPECTED_SCENARIOS.map((name) => ({
      name,
      status: "passed",
      ...(name === "ui-screenshots"
        ? {
            shots: [
              {
                name: "proof",
                file: "proof.png",
                sha256: hash(screenshotBytes),
              },
            ],
          }
        : {}),
    })),
    missingScenarios: [],
    scenarioProblems: [],
    uncoveredLegacyImportFailureModes: [],
    screenshots: [
      {
        name: "proof",
        path: "e2e/artifacts/screenshots/darwin-arm64/proof.png",
        sha256: hash(screenshotBytes),
        bytes: screenshotBytes.length,
      },
    ],
    screenshotProblems: [],
    binarySha256: hash(fs.readFileSync(binaryPath)),
  };
  mutate(reportBody);
  const reportSha256 = hash(JSON.stringify(reportBody, null, 2));
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify({ ...reportBody, reportSha256 }, null, 2)}\n`,
  );
  return {
    identity,
    binaryPath,
    reportPath,
    proof: {
      ...identity,
      gateStartedAt: now - 180_000,
      completedAt: now - 30_000,
      e2e: {
        status: "passed",
        platform: expected.platform,
        arch: expected.arch,
        reportPath: "e2e/artifacts/e2e-report-darwin-arm64.json",
        binaryPath: "src-tauri/target/debug/rosi",
        reportSha256: hash(fs.readFileSync(reportPath)),
        binarySha256: hash(fs.readFileSync(binaryPath)),
        finishedAt: Date.parse(finishedAt),
      },
    },
    root: directory,
  };
}

test("full E2E proof checks the canonical suite, successful outcomes, and exact binary", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "rosi-full-e2e-proof-"),
  );
  try {
    const fixture = writeFullE2eFixture(directory);
    assert.doesNotThrow(() =>
      verifyFullE2eEvidence(fixture.proof, fixture.root, fixture.identity),
    );
    for (const mutate of [
      (report) => {
        report.expectedScenarios = ["forged-suite"];
      },
      (report) => {
        report.scenarios[0].status = "failed";
      },
      (report) => {
        report.scenarios[0].status = "skipped";
      },
      (report) => {
        report.missingScenarios = ["launch"];
      },
      (report) => {
        report.uncoveredLegacyImportFailureModes = ["missing-case"];
      },
      (report) => {
        report.screenshotProblems = ["missing screenshot"];
      },
      (report) => {
        report.binarySha256 = "0".repeat(64);
      },
    ]) {
      fs.rmSync(directory, { recursive: true, force: true });
      fs.mkdirSync(directory, { recursive: true });
      const altered = writeFullE2eFixture(directory, mutate);
      assert.throws(() =>
        verifyFullE2eEvidence(altered.proof, altered.root, altered.identity),
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the two beta-2 unreviewed dev advisories no longer resolve to affected lock nodes", () => {
  const lock = JSON.parse(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  const basicFtp = lock.packages["node_modules/basic-ftp"];
  const braces = lock.packages["node_modules/braces"];
  assert.ok(basicFtp, "basic-ftp must remain in the reviewed test-tool graph");
  assert.ok(braces, "braces must remain in the reviewed test-tool graph");
  assert.equal(basicFtp.dev, true);
  assert.equal(braces.dev, true);
  assert.equal(basicFtp.version, "6.2.1");
  assert.equal(braces.version, "3.0.3");
  const audit = fs.readFileSync(
    path.join(root, "scripts", "npm-dev-audit.cjs"),
    "utf8",
  );
  assert.match(audit, /GHSA-C475-QRG2-PJ4R/);
  assert.match(audit, /GHSA-VFJ7-8CJW-P6XM/);
  assert.match(audit, /deeply nested brace|stack overflow/i);
  assert.match(audit, /2026-12-01/);
});
