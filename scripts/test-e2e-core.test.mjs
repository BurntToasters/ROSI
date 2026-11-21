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
import {
  gitSourceSnapshot,
  gitWorktreeState,
  isIgnorableReleaseDirtyPath,
  localCargoConfigSha256,
  run,
  sourceChangeProblems,
} from "./e2e/common.js";
import * as releaseSession from "./release-session.js";
import {
  E2E_SUITE_MANIFEST,
  scenarioOutcomeProblems,
  validateSuiteManifest,
  verifyScreenshots,
} from "./e2e/manifest.js";
import * as stability from "./e2e/stability.js";
import { reportForRun } from "./e2e/stability.js";
import { writeEvidence } from "./test-e2e.js";
import * as testE2eModule from "./test-e2e.js";
import * as buildModule from "./e2e/build.js";

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
      localCargoConfigSha256: null,
    });
    fs.writeFileSync(path.join(dir, "untracked.txt"), "pending work");
    const status = git(["status", "--porcelain=v1", "-uall"]).stdout;
    assert.match(status, /untracked\.txt/);
    assert.deepEqual(gitWorktreeState(dir), {
      worktreeDirty: true,
      worktreeStatusSha256: sha256(status),
      localCargoConfigSha256: null,
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
      localCargoConfigSha256: null,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function initCommittedRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (args) =>
    spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { cwd: dir, encoding: "utf8" },
    );
  assert.equal(git(["init", "-q"]).status, 0);
  const schemas = path.join(dir, "src-tauri", "gen", "schemas");
  fs.mkdirSync(schemas, { recursive: true });
  fs.writeFileSync(path.join(schemas, "acl-manifests.json"), "{}");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "one");
  assert.equal(git(["add", "-A"]).status, 0);
  assert.equal(git(["commit", "-q", "-m", "init"]).status, 0);
  return { dir, git, schemas };
}

test("worktree state ignores the release allowlist but not other paths", () => {
  const { dir, git, schemas } = initCommittedRepo("rosi-worktree-allow-");
  try {
    fs.writeFileSync(path.join(schemas, "acl-manifests.json"), '{"a":1}');
    assert.deepEqual(gitWorktreeState(dir), {
      worktreeDirty: false,
      worktreeStatusSha256: sha256(""),
      localCargoConfigSha256: null,
    });
    fs.writeFileSync(path.join(schemas, "unexpected.json"), "{}");
    fs.writeFileSync(path.join(dir, "tracked.txt"), "two");
    const state = gitWorktreeState(dir);
    const raw = git(["status", "--porcelain=v1", "-uall"]).stdout;
    const kept = raw
      .split("\n")
      .filter((line) => line && !line.includes("acl-manifests.json"))
      .map((line) => `${line}\n`)
      .join("");
    assert.match(kept, /unexpected\.json/);
    assert.equal(state.worktreeDirty, true);
    assert.equal(state.worktreeStatusSha256, sha256(kept));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the release allowlist has one definition shared by both scripts", () => {
  assert.equal(
    releaseSession.isIgnorableReleaseDirtyPath,
    isIgnorableReleaseDirtyPath,
  );
  assert.equal(
    isIgnorableReleaseDirtyPath("src-tauri/gen/schemas/acl-manifests.json"),
    true,
  );
  assert.equal(isIgnorableReleaseDirtyPath("src-tauri/gen/other.json"), false);
});

test("a local Cargo config is hashed into the worktree state", () => {
  const { dir } = initCommittedRepo("rosi-worktree-cargo-");
  try {
    assert.equal(localCargoConfigSha256(dir), null);
    const cargoDir = path.join(dir, "src-tauri", ".cargo");
    fs.mkdirSync(cargoDir, { recursive: true });
    fs.writeFileSync(path.join(cargoDir, "config.toml"), "jobs-one");
    const first = localCargoConfigSha256(dir);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(gitWorktreeState(dir).localCargoConfigSha256, first);
    fs.writeFileSync(path.join(cargoDir, "config.toml"), "jobs-two");
    assert.notEqual(localCargoConfigSha256(dir), first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("release proof refuses a report whose Cargo config differs from the current one", () => {
  const { dir } = initCommittedRepo("rosi-cargo-proof-");
  try {
    const mismatch = releaseSession.localCargoConfigProblem;
    assert.equal(mismatch({ localCargoConfigSha256: null }, dir), null);
    assert.equal(mismatch({}, dir), null);
    const cargoDir = path.join(dir, "src-tauri", ".cargo");
    fs.mkdirSync(cargoDir, { recursive: true });
    fs.writeFileSync(path.join(cargoDir, "config.toml"), "[build]");
    assert.match(mismatch({}, dir), /Cargo config/);
    assert.match(
      mismatch({ localCargoConfigSha256: null }, dir),
      /Cargo config/,
    );
    assert.match(
      mismatch({ localCargoConfigSha256: "a".repeat(64) }, dir),
      /Cargo config/,
    );
    assert.equal(
      mismatch({ localCargoConfigSha256: localCargoConfigSha256(dir) }, dir),
      null,
    );
    fs.rmSync(path.join(cargoDir, "config.toml"));
    assert.match(
      mismatch({ localCargoConfigSha256: "a".repeat(64) }, dir),
      /Cargo config/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a commit, tree or worktree change during a run is reported", () => {
  const { dir, git } = initCommittedRepo("rosi-source-change-");
  try {
    const start = gitSourceSnapshot(dir);
    assert.match(start.commit, /^[a-f0-9]{40}$/);
    assert.match(start.sourceTree, /^[a-f0-9]{40}$/);
    assert.deepEqual(sourceChangeProblems(start, gitSourceSnapshot(dir)), []);
    fs.writeFileSync(path.join(dir, "late.txt"), "edit during run");
    const edited = gitSourceSnapshot(dir);
    assert.match(sourceChangeProblems(start, edited).join(), /worktree/);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "late"]);
    const committed = gitSourceSnapshot(dir);
    const problems = sourceChangeProblems(start, committed).join();
    assert.match(problems, /commit/);
    assert.match(problems, /source tree/);
    assert.match(
      sourceChangeProblems(start, {
        ...start,
        localCargoConfigSha256: "b".repeat(64),
      }).join(),
      /Cargo config/,
    );
    // An unreadable snapshot never matches a readable one.
    assert.notDeepEqual(
      sourceChangeProblems(start, { ...start, commit: null }),
      [],
    );
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

// The E2E binary is hashed after the build and again at the end. A binary that
// changed in between no longer matches the evidence, so the gate must fail.
test("binaryChangeProblems fails when the E2E binary is replaced during the run", () => {
  const { binaryChangeProblems } = testE2eModule;
  assert.equal(typeof binaryChangeProblems, "function");
  const hash = "c".repeat(64);
  assert.deepEqual(binaryChangeProblems(hash, hash), []);
  assert.match(
    binaryChangeProblems(hash, "d".repeat(64)).join(),
    /E2E binary changed during the run/,
  );
  assert.notDeepEqual(binaryChangeProblems(null, hash), []);
  assert.notDeepEqual(binaryChangeProblems(hash, null), []);
});

// The E2E cargo build must use the committed lockfile, like the release builds.
test("the E2E tauri build passes --locked through to cargo", () => {
  const { e2eTauriBuildArgs } = buildModule;
  assert.equal(typeof e2eTauriBuildArgs, "function");
  const args = e2eTauriBuildArgs("/repo/src-tauri/tauri.e2e.conf.json");
  const separator = args.indexOf("--");
  assert.notEqual(separator, -1);
  assert.ok(args.slice(separator + 1).includes("--locked"));
  assert.ok(args.slice(separator + 1).includes("--features"));
});
