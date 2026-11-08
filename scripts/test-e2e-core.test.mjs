// Failure modes: scripts/test-e2e-core.failure-modes.md
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCoreRunPlan,
  coreArtifactPaths,
  exactMochaTitlePattern,
  parseE2eProfile,
} from "./e2e/core.js";
import { E2E_SUITE_MANIFEST, scenarioOutcomeProblems } from "./e2e/manifest.js";
import { reportForRun } from "./e2e/stability.js";

const MAIN_SCENARIOS = [
  "launch",
  "settings-sidebar",
  "settings-persistence",
  "download-profiles",
  "url-safety",
  "manual-download",
  "unicode-download",
  "queue",
  "cancel",
  "conversion",
  "audio-extract",
  "preview",
  "formats",
  "merge-download",
  "queue-management",
  "queue-cancel",
  "dock-tabs",
  "small-window",
  "browser-choice",
  "ui-screenshots",
  "settings-controls",
  "queue-controls",
  "download-again-quickly",
  "activity-clear",
  "close-flow",
];

test("profile selector accepts only a single known profile", () => {
  assert.equal(parseE2eProfile([], {}), null);
  assert.equal(parseE2eProfile(["--profile", "core"], {}), "core");
  assert.equal(parseE2eProfile(["--profile=core"], {}), "core");
  for (const argv of [
    ["--profile"],
    ["--profile", "--group", "settings"],
    ["--profile="],
    ["--profile", "unknown"],
    ["--profile", "core", "--profile", "core"],
    ["--profile=core", "--profile", "core"],
  ]) {
    assert.throws(() => parseE2eProfile(argv, {}), /profile/i, argv.join(" "));
  }
});

test("core rejects group and ONLY selectors from arguments or environment", () => {
  for (const [argv, env] of [
    [["--profile", "core", "--group", "settings"], {}],
    [["--group=settings", "--profile=core"], {}],
    [["--profile", "core"], { ROSI_E2E_GROUPS: "settings" }],
    [["--profile", "core"], { ROSI_E2E_ONLY: "./specs/main.spec.js" }],
    [["--profile", "core"], { ROSI_E2E_ONLY: "  ./specs/main.spec.js  " }],
  ]) {
    assert.throws(() => parseE2eProfile(argv, env), /cannot be combined/i);
  }
  assert.equal(
    parseE2eProfile(["--profile", "core"], { ROSI_E2E_ONLY: "  " }),
    "core",
  );
});

test("core plan selects only the approved main scenarios and complete support owners", () => {
  const plan = buildCoreRunPlan(E2E_SUITE_MANIFEST);
  assert.equal(plan.fullSuite, false);
  assert.equal(plan.profile, "core");
  assert.equal(plan.mainSpecs, "./specs/main.spec.js");
  assert.deepEqual(plan.mainScenarioIds, MAIN_SCENARIOS);
  assert.deepEqual(plan.enabledOwners, [
    "main",
    "state-repairs",
    "round2-renderer",
    "offline-queue",
    "round3-renderer",
  ]);
  assert.deepEqual(
    plan.expectedScenarios,
    E2E_SUITE_MANIFEST.scenarios
      .filter(
        (scenario) =>
          MAIN_SCENARIOS.includes(scenario.name) ||
          (plan.enabledOwners.includes(scenario.owner) &&
            scenario.owner !== "main"),
      )
      .map((scenario) => scenario.name),
  );
  assert.equal(plan.expectedScenarios.length, 25 + 14 + 1 + 1 + 1);
  assert.equal(
    plan.expectedScenarios.includes("download-process-repairs"),
    false,
  );
  assert.equal(
    plan.expectedScenarios.some((name) => name.startsWith("v5-fixes/")),
    false,
  );
});

test("core main titles map one-to-one to selected scenario ids", () => {
  const plan = buildCoreRunPlan(E2E_SUITE_MANIFEST);
  assert.deepEqual(
    plan.mainMochaTitles.map((entry) => entry.scenario),
    MAIN_SCENARIOS,
  );
  assert.equal(
    new Set(plan.mainMochaTitles.map((entry) => entry.title)).size,
    25,
  );
  assert.ok(
    plan.mainMochaTitles.every((entry) =>
      entry.title.startsWith("ROSI main window "),
    ),
  );
});

test("Mocha title pattern anchors and escapes every title", () => {
  const pattern = new RegExp(
    exactMochaTitlePattern([
      "ROSI main window opens [settings] sidebar",
      "ROSI main window handles a+b",
    ]),
  );
  assert.equal(pattern.test("ROSI main window opens [settings] sidebar"), true);
  assert.equal(pattern.test("ROSI main window handles a+b"), true);
  assert.equal(pattern.test("ROSI main window opens settings sidebar"), false);
  assert.equal(pattern.test("prefix ROSI main window handles a+b"), false);
  assert.equal(pattern.test("ROSI main window handles aaab"), false);
  assert.throws(() => exactMochaTitlePattern([]), /at least one/i);
});

test("core scenario validation rejects missing, duplicate, failed, and skipped outcomes", () => {
  const expected = ["launch", "settings-sidebar"];
  const passing = expected.map((name) => ({ name, status: "passed" }));
  assert.deepEqual(scenarioOutcomeProblems(passing, "darwin", expected), []);
  assert.match(
    scenarioOutcomeProblems(passing.slice(0, 1), "darwin", expected).join("; "),
    /settings-sidebar reported 0 times/,
  );
  assert.match(
    scenarioOutcomeProblems(
      [...passing, { name: "launch", status: "passed" }],
      "darwin",
      expected,
    ).join("; "),
    /launch reported 2 times/,
  );
  assert.match(
    scenarioOutcomeProblems(
      [{ name: "launch", status: "failed" }, passing[1]],
      "darwin",
      expected,
    ).join("; "),
    /launch has unacceptable status failed/,
  );
  assert.match(
    scenarioOutcomeProblems(
      [{ name: "launch", status: "skipped" }, passing[1]],
      "darwin",
      expected,
    ).join("; "),
    /launch has unacceptable status skipped/,
  );
});

test("core artifact paths isolate timestamped run evidence and screenshots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-core-artifacts-"));
  try {
    const first = coreArtifactPaths({
      root,
      platform: "darwin",
      arch: "arm64",
      runId: "run-one",
    });
    const second = coreArtifactPaths({
      root,
      platform: "darwin",
      arch: "arm64",
      runId: "run-two",
    });
    assert.notEqual(first.runDir, second.runDir);
    assert.notEqual(first.screenshotDir, second.screenshotDir);
    assert.equal(first.latestReportPath, second.latestReportPath);
    assert.equal(path.basename(first.reportPath), "report.json");
    assert.ok(
      first.runDir.includes(path.join("core", "darwin-arm64", "run-one")),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repeat reads only the report written for its current run id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-core-repeat-"));
  const file = path.join(root, "report.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ runId: "previous", passed: true }));
    assert.equal(reportForRun(file, "current"), null);
    assert.deepEqual(reportForRun(file, "previous"), {
      runId: "previous",
      passed: true,
    });
    assert.equal(
      reportForRun(path.join(root, "missing.json"), "current"),
      null,
    );
    fs.writeFileSync(file, "not json");
    assert.equal(reportForRun(file, "current"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
