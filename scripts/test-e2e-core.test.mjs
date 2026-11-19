// Failure modes: scripts/test-e2e-core.failure-modes.md
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  buildCoreRunPlan,
  coreArtifactPaths,
  exactMochaTitlePattern,
  parseE2eProfile,
  partialRunKind,
  runArtifactPaths,
} from "./e2e/core.js";
import { gitWorktreeState, run } from "./e2e/common.js";
import {
  E2E_SUITE_MANIFEST,
  scenarioOutcomeProblems,
  validateSuiteManifest,
  verifyScreenshots,
} from "./e2e/manifest.js";
import * as stability from "./e2e/stability.js";
import { reportForRun } from "./e2e/stability.js";
import { writeEvidence } from "./test-e2e.js";

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

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

test("run() enforces an optional timeout and keeps no timeout by default", () => {
  assert.throws(
    () =>
      run(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        timeout: 300,
      }),
    /timed out after 300 ms/,
  );
  assert.doesNotThrow(() => run(process.execPath, ["-e", "process.exit(0)"]));
  assert.throws(
    () => run(process.execPath, ["-e", "process.exit(3)"]),
    /exited with 3/,
  );
  for (const timeout of [0, -1, 1.5, "1000"]) {
    assert.throws(
      () =>
        run(process.execPath, ["-e", "process.exit(0)"], {
          timeout,
        }),
      /timeout must be a positive whole number/,
      String(timeout),
    );
  }
});

test("worktree state records dirtiness and a hash of the porcelain status", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-worktree-state-"));
  try {
    const git = (args) =>
      spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(git(["init", "-q"]).status, 0);
    assert.deepEqual(gitWorktreeState(dir), {
      worktreeDirty: false,
      worktreeStatusSha256: sha256(""),
    });
    fs.writeFileSync(path.join(dir, "untracked.txt"), "pending work");
    const status = git(["status", "--porcelain=v1", "-uall"]).stdout;
    assert.match(status, /untracked\.txt/);
    assert.deepEqual(gitWorktreeState(dir), {
      worktreeDirty: true,
      worktreeStatusSha256: sha256(status),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree state fails closed outside a git checkout", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-worktree-none-"));
  try {
    assert.deepEqual(gitWorktreeState(dir), {
      worktreeDirty: true,
      worktreeStatusSha256: null,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ad-hoc and group runs get isolated evidence directories, never the canonical report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-adhoc-artifacts-"));
  try {
    const first = runArtifactPaths({
      kind: "adhoc",
      root,
      platform: "darwin",
      arch: "arm64",
      runId: "run-one",
    });
    const second = runArtifactPaths({
      kind: "adhoc",
      root,
      platform: "darwin",
      arch: "arm64",
      runId: "run-two",
    });
    assert.ok(
      first.runDir.includes(path.join("adhoc", "darwin-arm64", "run-one")),
    );
    assert.notEqual(first.runDir, second.runDir);
    assert.notEqual(first.screenshotDir, second.screenshotDir);
    assert.equal(first.latestReportPath, second.latestReportPath);
    assert.equal(
      first.latestReportPath,
      path.join(root, "adhoc", "darwin-arm64", "latest-report.json"),
    );
    assert.equal(path.basename(first.reportPath), "report.json");
    assert.notEqual(
      first.latestReportPath,
      path.join(root, "e2e-report-darwin-arm64.json"),
    );
    assert.equal(
      first.screenshotDir.startsWith(path.join(root, "screenshots")),
      false,
    );
    assert.throws(
      () =>
        runArtifactPaths({
          kind: "full",
          root,
          platform: "darwin",
          arch: "arm64",
          runId: "run-one",
        }),
      /kind/,
    );
    assert.equal(
      coreArtifactPaths({ root, platform: "darwin", arch: "arm64", runId: "a" })
        .hostDirectory,
      path.join(root, "core", "darwin-arm64"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only a full-suite run is allowed to use the canonical location", () => {
  assert.equal(partialRunKind({ profileName: null, fullSuite: true }), null);
  assert.equal(
    partialRunKind({ profileName: null, fullSuite: false }),
    "adhoc",
  );
  assert.equal(
    partialRunKind({ profileName: "core", fullSuite: false }),
    "core",
  );
});

function sampleReport(overrides = {}) {
  return {
    app: "ROSI",
    runId: "run-one",
    fullSuite: false,
    platform: process.platform,
    arch: process.arch,
    passed: false,
    worktreeDirty: true,
    worktreeStatusSha256: sha256(""),
    scenarios: [],
    ...overrides,
  };
}

test("partial evidence is written only inside its per-run directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-write-partial-"));
  const artifactDir = path.join(root, "artifacts");
  const canonical = path.join(
    artifactDir,
    `e2e-report-${process.platform}-${process.arch}.json`,
  );
  try {
    const runPaths = runArtifactPaths({
      kind: "adhoc",
      root: artifactDir,
      platform: process.platform,
      arch: process.arch,
      runId: "run-one",
    });
    const file = writeEvidence(sampleReport(), { runPaths, artifactDir });
    assert.equal(file, runPaths.reportPath);
    assert.ok(fs.existsSync(runPaths.reportPath));
    assert.ok(fs.existsSync(runPaths.latestReportPath));
    assert.equal(fs.existsSync(canonical), false);
    assert.throws(
      () => writeEvidence(sampleReport(), { artifactDir }),
      /per-run directory/,
    );
    assert.equal(fs.existsSync(canonical), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the full suite still writes the canonical report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-write-full-"));
  try {
    const file = writeEvidence(sampleReport({ fullSuite: true }), {
      artifactDir: root,
    });
    assert.equal(
      file,
      path.join(root, `e2e-report-${process.platform}-${process.arch}.json`),
    );
    assert.ok(fs.existsSync(file));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("suite manifest validation owns every profile check", () => {
  const manifest = () => structuredClone(E2E_SUITE_MANIFEST);
  assert.doesNotThrow(() => validateSuiteManifest(manifest()));
  const nonMainScenario = E2E_SUITE_MANIFEST.scenarios.find(
    (scenario) => scenario.owner !== "main",
  ).name;
  const mutations = {
    "duplicate main scenario": (m) =>
      m.profiles.core.mainScenarioIds.push(m.profiles.core.mainScenarioIds[0]),
    "unknown main scenario": (m) => {
      m.profiles.core.mainScenarioIds[0] = "no-such-scenario";
    },
    "non-main scenario in the core profile": (m) => {
      const [first] = m.profiles.core.mainScenarioIds;
      m.profiles.core.mainScenarioIds[0] = nonMainScenario;
      m.profiles.core.mainMochaTitles[nonMainScenario] =
        m.profiles.core.mainMochaTitles[first];
      delete m.profiles.core.mainMochaTitles[first];
    },
    "missing Mocha title": (m) => {
      delete m.profiles.core.mainMochaTitles[
        m.profiles.core.mainScenarioIds[0]
      ];
    },
    "duplicate Mocha title": (m) => {
      const [, second] = m.profiles.core.mainScenarioIds;
      m.profiles.core.mainMochaTitles[second] =
        m.profiles.core.mainMochaTitles[m.profiles.core.mainScenarioIds[0]];
    },
    "main as a complete owner": (m) =>
      m.profiles.core.completeOwners.push("main"),
    "unknown complete owner": (m) =>
      m.profiles.core.completeOwners.push("no-such-owner"),
    "core without FFprobe": (m) => {
      m.profiles.core.requiredTools = m.profiles.core.requiredTools.filter(
        (tool) => tool !== "ffprobe",
      );
    },
    "null profile body": (m) => {
      m.profiles.core = null;
    },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const invalid = manifest();
    mutate(invalid);
    assert.throws(
      () => validateSuiteManifest(invalid),
      /e2e\/suites\.json profile core/,
      label,
    );
  }
});

test("core plan reports only an unknown profile name, not profile contents", () => {
  const manifest = structuredClone(E2E_SUITE_MANIFEST);
  delete manifest.profiles.core;
  assert.throws(() => buildCoreRunPlan(manifest), /unknown E2E profile: core/);
});

test("stability reads the report the gate writes for each run kind", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-stability-kind-"));
  const base = {
    root,
    platform: "darwin",
    arch: "arm64",
    runId: "stability-x",
  };
  try {
    assert.equal(
      stability.gateReportFile({ ...base, fullSuite: true }),
      path.join(root, "e2e-report-darwin-arm64.json"),
    );
    assert.equal(
      stability.gateReportFile({ ...base, fullSuite: false }),
      path.join(root, "adhoc", "darwin-arm64", "latest-report.json"),
    );
    assert.equal(
      stability.gateReportFile({
        ...base,
        fullSuite: false,
        profile: "core",
      }),
      path.join(root, "core", "darwin-arm64", "latest-report.json"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setup-wizard screenshots are hashed with the other UI shots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-wizard-shots-"));
  try {
    const bytes = Buffer.from("wizard screenshot bytes");
    fs.writeFileSync(path.join(dir, "wizard-welcome.png"), bytes);
    const scenarios = [
      {
        name: "setup-wizard",
        status: "passed",
        shots: [
          {
            name: "wizard-welcome",
            file: "wizard-welcome.png",
            sha256: sha256(bytes),
            bytes: bytes.length,
          },
        ],
      },
    ];
    const verdict = verifyScreenshots(scenarios, dir);
    assert.deepEqual(verdict.problems, []);
    assert.deepEqual(
      verdict.screenshots.map((shot) => shot.name),
      ["wizard-welcome"],
    );
    fs.writeFileSync(path.join(dir, "wizard-welcome.png"), "changed");
    assert.deepEqual(verifyScreenshots(scenarios, dir).problems, [
      "wizard-welcome.png changed on disk",
    ]);
    const unnamed = structuredClone(scenarios);
    delete unnamed[0].shots[0].file;
    assert.match(
      verifyScreenshots(unnamed, dir).problems.join("; "),
      /lacks a file name/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
