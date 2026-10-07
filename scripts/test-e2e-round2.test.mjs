import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  EXPECTED_SCENARIOS,
  ROUND2_NATIVE_OBSERVATIONS,
  ROUND2_RENDERER_OBSERVATIONS,
  round2NativeReportProblems,
  round2RendererResultProblems,
  scenarioOutcomeProblems,
} from "./test-e2e.js";

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

function createNativeReport() {
  const body = {
    app: "ROSI",
    suite: "round2-native",
    runId: "2030-01-01T00-00-00-000Z-1234",
    version: "5.0.0-beta.2",
    platform: process.platform,
    arch: process.arch,
    startedAt: "2030-01-01T00:00:01.000Z",
    finishedAt: "2030-01-01T00:01:00.000Z",
    binary: "src-tauri/target/debug/rosi",
    binarySha256: "a".repeat(64),
    ffmpegSha256: "b".repeat(64),
    probeSources: {
      "e2e/round2-native.spec.js": "c".repeat(64),
      "e2e/round2-native-failure-modes.md": "d".repeat(64),
    },
    isolatedProfile: "/tmp/rosi-round2-native-profile",
    toneFixtureSha256: "e".repeat(64),
    windowsSourceReplacementWrapper: process.platform !== "win32",
    wdioExitCode: 0,
    wdioError: null,
    observations: ROUND2_NATIVE_OBSERVATIONS.map((name) => ({
      name,
      invariantPassed: true,
      ...(name === "windows-job-object-leader-exit"
        ? {
            skipped: true,
            skipReason:
              "No owned descendant-pipe fixture exercises leader exit yet.",
          }
        : {}),
    })),
    failures: [],
    passed: true,
  };
  return {
    ...body,
    reportSha256: sha256(Buffer.from(JSON.stringify(body, null, 2))),
  };
}

const nativeExpectations = {
  version: "5.0.0-beta.2",
  platform: process.platform,
  arch: process.arch,
  binary: "src-tauri/target/debug/rosi",
  binarySha256: "a".repeat(64),
  ffmpegSha256: "b".repeat(64),
  probeSources: {
    "e2e/round2-native.spec.js": "c".repeat(64),
    "e2e/round2-native-failure-modes.md": "d".repeat(64),
  },
  suiteStartedAt: "2030-01-01T00:00:00.000Z",
};

test("round-two renderer observations are complete, unique, and successful", () => {
  const valid = ROUND2_RENDERER_OBSERVATIONS.map((name) => ({
    name,
    status: "passed",
  }));
  assert.deepEqual(round2RendererResultProblems(valid), []);
  assert.ok(round2RendererResultProblems(valid.slice(1)).length > 0);
  assert.ok(round2RendererResultProblems([...valid, valid[0]]).length > 0);
  assert.ok(
    round2RendererResultProblems([
      ...valid.slice(0, -1),
      { ...valid.at(-1), status: "failed" },
    ]).length > 0,
  );
  assert.ok(
    round2RendererResultProblems([
      ...valid,
      { name: "unexpected", status: "passed" },
    ]).length > 0,
  );
});

test("canonical E2E inventory includes renderer and native round-two passes", () => {
  assert.ok(EXPECTED_SCENARIOS.includes("round2-renderer"));
  assert.ok(EXPECTED_SCENARIOS.includes("round2-native"));
  const fullInventory = EXPECTED_SCENARIOS.map((name) => ({
    name,
    status: "passed",
  }));
  assert.deepEqual(
    scenarioOutcomeProblems(fullInventory, process.platform),
    [],
  );
  const adHoc = [{ name: "focused-debug-spec", status: "passed" }];
  const adHocProblems = scenarioOutcomeProblems(adHoc, process.platform);
  assert.ok(
    adHocProblems.some((problem) => problem.startsWith("round2-renderer ")),
  );
  assert.ok(
    adHocProblems.some((problem) => problem.startsWith("round2-native ")),
  );
});

test("native report validation binds identity, source, observations, freshness, and self-hash", () => {
  const report = createNativeReport();
  assert.deepEqual(round2NativeReportProblems(report, nativeExpectations), []);

  const invalidReports = [
    (value) => (value.app = "other app"),
    (value) => (value.suite = "other suite"),
    (value) => (value.version = "9.9.9"),
    (value) => (value.platform = "other-platform"),
    (value) => (value.arch = "other-arch"),
    (value) => (value.binarySha256 = "f".repeat(64)),
    (value) => (value.ffmpegSha256 = "f".repeat(64)),
    (value) =>
      (value.probeSources["e2e/round2-native.spec.js"] = "f".repeat(64)),
    (value) => value.observations.pop(),
    (value) => (value.observations[0].invariantPassed = false),
    (value) => {
      const observation = value.observations.find(
        (candidate) => candidate.name === "windows-job-object-leader-exit",
      );
      observation.skipped = false;
    },
    (value) => {
      const observation = value.observations.find(
        (candidate) => candidate.name === "windows-job-object-leader-exit",
      );
      delete observation.skipReason;
    },
    (value) => value.failures.push("failed-observation"),
    (value) => (value.wdioExitCode = 1),
    (value) => (value.passed = false),
    (value) => (value.startedAt = "2029-12-31T23:59:59.000Z"),
  ];
  for (const mutate of invalidReports) {
    const invalid = structuredClone(report);
    mutate(invalid);
    invalid.reportSha256 = sha256(
      Buffer.from(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(invalid).filter(([key]) => key !== "reportSha256"),
          ),
          null,
          2,
        ),
      ),
    );
    assert.ok(
      round2NativeReportProblems(invalid, nativeExpectations).length > 0,
    );
  }
  const tamperedHash = { ...report, reportSha256: "0".repeat(64) };
  assert.ok(
    round2NativeReportProblems(tamperedHash, nativeExpectations).length > 0,
  );
});
