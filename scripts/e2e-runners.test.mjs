import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  verifyRunnerReport,
  normalizeRunnerReport,
  runnerReportSelfHash,
} from "./e2e/runner-report.js";
import { pruneRunnerArtifacts } from "./e2e/prune-artifacts.js";
import {
  runDownloadProcessRepairs,
  runRound2NativeRepairs,
  round2NativeReportProblems,
} from "./e2e/runners/native.js";
import { probeReportProblems } from "./e2e/runners/probes.js";
import {
  V5_RUN_DIR_PATTERN,
  findRunnerReport,
  reportedSkips,
} from "./e2e/runners/v5-fixes.js";
import {
  ALLOWED_CASE_SKIPS,
  ALLOWED_E2E_SKIPS,
  E2E_SUITE_MANIFEST,
  caseSkipProblems,
  scenarioOutcomeProblems,
  validateSuiteManifest,
} from "./e2e/manifest.js";

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const TIMEOUT_MS = 900000;

// Mirrors the writers: the hash covers the body serialized with two-space indent.
function writerReport(body) {
  return {
    ...body,
    reportSha256: sha256(Buffer.from(JSON.stringify(body, null, 2))),
  };
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-runners-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function setMtime(file, secondsAgo, now = Date.now()) {
  const time = new Date(now - secondsAgo * 1000);
  fs.utimesSync(file, time, time);
}

const identity = {
  app: "ROSI",
  version: "5.1.0",
  commit: "c".repeat(40),
  platform: "darwin",
  arch: "arm64",
  binarySha256: HASH_A,
  startedAt: "2030-01-01T00:00:01.000Z",
  finishedAt: "2030-01-01T00:01:00.000Z",
  suite: "round2-native",
  passed: true,
};
const expected = {
  app: "ROSI",
  version: "5.1.0",
  commit: "c".repeat(40),
  platform: "darwin",
  arch: "arm64",
  binarySha256: HASH_A,
  startedAfter: "2030-01-01T00:00:00.000Z",
  suite: "round2-native",
  verdict: true,
  selfHash: true,
};

test("verifyRunnerReport accepts a writer-shaped report that matches every expectation", () => {
  assert.deepEqual(verifyRunnerReport(writerReport(identity), expected), []);
});

test("verifyRunnerReport rejects each identity field that differs", () => {
  const cases = [
    ["app", "other"],
    ["version", "9.9.9"],
    ["commit", "d".repeat(40)],
    ["platform", "win32"],
    ["arch", "x64"],
    ["binarySha256", HASH_B],
    ["suite", "other-suite"],
  ];
  for (const [field, value] of cases) {
    const body = { ...identity, [field]: value };
    const problems = verifyRunnerReport(writerReport(body), expected);
    assert.equal(problems.length, 1, `${field} should produce one problem`);
    assert.match(problems[0], /differs/);
  }
});

test("verifyRunnerReport checks only the expectations the caller supplies", () => {
  const body = { ...identity, commit: "anything", extra: true };
  assert.deepEqual(
    verifyRunnerReport(writerReport(body), {
      binarySha256: HASH_A,
      selfHash: true,
    }),
    [],
  );
});

test("verifyRunnerReport rejects a report that started before startedAfter", () => {
  const body = { ...identity, startedAt: "2029-12-31T23:59:59.000Z" };
  const problems = verifyRunnerReport(writerReport(body), expected);
  assert.ok(
    problems.some((problem) => /timestamps are stale or invalid/.test(problem)),
  );
});

test("verifyRunnerReport accepts epoch milliseconds for startedAfter", () => {
  const startedAfter = Date.parse(identity.startedAt) - 1000;
  assert.deepEqual(
    verifyRunnerReport(writerReport(identity), { startedAfter }),
    [],
  );
  assert.ok(
    verifyRunnerReport(writerReport(identity), {
      startedAfter: Date.parse(identity.startedAt) + 1,
    }).length > 0,
  );
});

test("verifyRunnerReport rejects invalid or reversed timestamps", () => {
  const invalid = [
    { ...identity, startedAt: "not a date" },
    { ...identity, finishedAt: undefined },
    { ...identity, finishedAt: "2030-01-01T00:00:00.000Z" },
  ];
  for (const body of invalid) {
    const problems = verifyRunnerReport(writerReport(body), expected);
    assert.ok(
      problems.some((problem) =>
        /timestamps are stale or invalid/.test(problem),
      ),
    );
  }
  assert.ok(
    verifyRunnerReport(writerReport(identity), { startedAfter: "not a date" })
      .length > 0,
  );
});

test("verifyRunnerReport rejects a tampered or missing self-hash only when requested", () => {
  const report = writerReport(identity);
  const tampered = { ...report, version: "5.1.1" };
  assert.ok(
    verifyRunnerReport(tampered, { selfHash: true }).some((p) =>
      /self-hash differs/.test(p),
    ),
  );
  assert.ok(verifyRunnerReport({ ...identity }, { selfHash: true }).length > 0);
  assert.deepEqual(verifyRunnerReport(tampered, { version: "5.1.1" }), []);
  assert.deepEqual(verifyRunnerReport({ ...identity }, {}), []);
});

test("verifyRunnerReport enforces the verdict from passed or allPassed", () => {
  assert.deepEqual(
    verifyRunnerReport({ allPassed: true }, { verdict: true }),
    [],
  );
  assert.deepEqual(verifyRunnerReport({ passed: true }, { verdict: true }), []);
  assert.ok(
    verifyRunnerReport({ passed: false }, { verdict: true }).length > 0,
  );
  assert.ok(
    verifyRunnerReport({ allPassed: false }, { verdict: true }).length > 0,
  );
  assert.ok(
    verifyRunnerReport({ passed: false, allPassed: true }, { verdict: true })
      .length > 0,
  );
  assert.ok(verifyRunnerReport({}, { verdict: true }).length > 0);
});

test("verifyRunnerReport returns a problem for non-object reports without throwing", () => {
  for (const value of [null, undefined, "report", 7, []]) {
    const problems = verifyRunnerReport(value, expected);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not an object/);
  }
});

test("verifyRunnerReport uses the caller label in messages", () => {
  const problems = verifyRunnerReport(
    { ...identity, version: "0.0.0" },
    { label: "probe", version: "5.1.0" },
  );
  assert.equal(problems[0], "probe report version differs");
});

test("normalizeRunnerReport reads each writer alias", () => {
  const normalized = normalizeRunnerReport({
    scenario: "round2-native",
    allPassed: true,
    sourceHashes: { "a.js": HASH_A },
    fixtureHash: HASH_B,
  });
  assert.equal(normalized.suite, "round2-native");
  assert.equal(normalized.verdict, true);
  assert.deepEqual(normalized.probeSources, { "a.js": HASH_A });
  assert.equal(normalized.toneFixtureSha256, HASH_B);
  const preferred = normalizeRunnerReport({
    suite: "x",
    scenario: "y",
    probeSources: {},
    sourceHashes: {},
  });
  assert.equal(preferred.suite, "x");
});

test("runnerReportSelfHash matches the writer serialization without reportSha256", () => {
  const report = writerReport(identity);
  assert.equal(runnerReportSelfHash(report), report.reportSha256);
});

function makeRuns(
  root,
  count,
  pattern = (index) => `run-${String(index).padStart(3, "0")}`,
) {
  const names = [];
  for (let index = 1; index <= count; index += 1) {
    const name = pattern(index);
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "report.json"), "{}");
    setMtime(dir, (count - index + 1) * 60);
    names.push(name);
  }
  return names;
}

const runPattern = /^run-\d{3}$/;

test("pruneRunnerArtifacts removes the oldest matching directories beyond keep", () => {
  withTempDir((root) => {
    makeRuns(root, 25);
    const result = pruneRunnerArtifacts({
      artifactsDir: root,
      pattern: runPattern,
      keep: 20,
    });
    assert.deepEqual(result.deleted.sort(), [
      "run-001",
      "run-002",
      "run-003",
      "run-004",
      "run-005",
    ]);
    assert.equal(fs.readdirSync(root).length, 20);
  });
});

test("pruneRunnerArtifacts keeps 20 folders by default", () => {
  withTempDir((root) => {
    makeRuns(root, 21);
    const result = pruneRunnerArtifacts({
      artifactsDir: root,
      pattern: runPattern,
    });
    assert.deepEqual(result.deleted, ["run-001"]);
  });
});

test("pruneRunnerArtifacts never removes the current run and counts it as retained", () => {
  withTempDir((root) => {
    makeRuns(root, 4);
    const result = pruneRunnerArtifacts({
      artifactsDir: root,
      pattern: runPattern,
      keep: 2,
      currentRunDir: path.join(root, "run-001"),
    });
    assert.deepEqual(result.deleted, ["run-002"]);
    assert.ok(fs.existsSync(path.join(root, "run-001")));
    assert.ok(fs.existsSync(path.join(root, "run-003")));
    assert.ok(fs.existsSync(path.join(root, "run-004")));
  });
});

test("pruneRunnerArtifacts leaves files, other folders, reserved names, and report files alone", () => {
  withTempDir((root) => {
    makeRuns(root, 1);
    fs.writeFileSync(path.join(root, "run-099"), "a file with a matching name");
    fs.mkdirSync(path.join(root, "other-runner-001"));
    fs.mkdirSync(path.join(root, "core"));
    fs.mkdirSync(path.join(root, "adhoc"));
    fs.writeFileSync(path.join(root, "e2e-report-darwin-arm64.json"), "{}");
    fs.writeFileSync(path.join(root, "latest-report.json"), "{}");
    // The pattern matches the reserved names but not the other runner's folder.
    const result = pruneRunnerArtifacts({
      artifactsDir: root,
      pattern: /^(?:run-|core$|adhoc$)/,
      keep: 0,
    });
    assert.deepEqual(result.deleted, ["run-001"]);
    for (const name of [
      "run-099",
      "other-runner-001",
      "core",
      "adhoc",
      "e2e-report-darwin-arm64.json",
      "latest-report.json",
    ]) {
      assert.ok(fs.existsSync(path.join(root, name)), `${name} must survive`);
    }
  });
});

test("pruneRunnerArtifacts never follows or removes symlinks, or the directories they point at", () => {
  withTempDir((root) => {
    withTempDir((outside) => {
      fs.mkdirSync(path.join(outside, "target"));
      fs.writeFileSync(path.join(outside, "target", "keep.txt"), "outside");
      fs.symlinkSync(
        path.join(outside, "target"),
        path.join(root, "run-link-out"),
      );
      makeRuns(root, 1);
      fs.symlinkSync(
        path.join(root, "run-001"),
        path.join(root, "run-link-in"),
      );
      const result = pruneRunnerArtifacts({
        artifactsDir: root,
        pattern: /^run-/,
        keep: 0,
      });
      assert.deepEqual(result.deleted, []);
      assert.ok(fs.lstatSync(path.join(root, "run-link-out")).isSymbolicLink());
      assert.ok(fs.lstatSync(path.join(root, "run-link-in")).isSymbolicLink());
      assert.ok(fs.existsSync(path.join(root, "run-001")));
      assert.equal(
        fs.readFileSync(path.join(outside, "target", "keep.txt"), "utf8"),
        "outside",
      );
    });
  });
});

test("pruneRunnerArtifacts does nothing when artifactsDir does not exist", () => {
  withTempDir((root) => {
    const missing = path.join(root, "missing");
    const result = pruneRunnerArtifacts({
      artifactsDir: missing,
      pattern: runPattern,
    });
    assert.deepEqual(result.deleted, []);
    assert.equal(fs.existsSync(missing), false);
  });
});

test("pruneRunnerArtifacts rejects unsafe arguments before deleting", () => {
  withTempDir((root) => {
    makeRuns(root, 3);
    const bad = [
      { artifactsDir: "relative/dir", pattern: runPattern },
      { artifactsDir: root, pattern: "run-" },
      { artifactsDir: root, pattern: /run/g },
      { artifactsDir: root, pattern: /run/y },
      { artifactsDir: root, pattern: runPattern, keep: -1 },
      { artifactsDir: root, pattern: runPattern, keep: 1.5 },
    ];
    for (const args of bad) {
      assert.throws(() => pruneRunnerArtifacts(args), TypeError);
    }
    assert.equal(fs.readdirSync(root).length, 3);
  });
});

test("pruneRunnerArtifacts reports a removal that fails and still processes the rest", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root ignores directory permissions");
    return;
  }
  if (process.platform === "win32") {
    t.skip("chmod cannot make a folder undeletable on Windows");
    return;
  }
  withTempDir((root) => {
    makeRuns(root, 3);
    const locked = path.join(root, "run-001");
    fs.writeFileSync(path.join(locked, "inside.txt"), "x");
    // Writing into the folder moved its mtime; restore it so it is the oldest.
    setMtime(locked, 3 * 60);
    fs.chmodSync(locked, 0o555);
    try {
      const result = pruneRunnerArtifacts({
        artifactsDir: root,
        pattern: runPattern,
        keep: 1,
      });
      assert.deepEqual(result.deleted, ["run-002"]);
      assert.deepEqual(
        result.failed.map((entry) => entry.name),
        ["run-001"],
      );
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

test("V5_RUN_DIR_PATTERN matches the timestamped folders the v5 runners write", () => {
  assert.ok(V5_RUN_DIR_PATTERN.test("2026-11-18T10-00-00-000Z-4242"));
  assert.ok(V5_RUN_DIR_PATTERN.test("2026-11-18T10-00-00.000Z-4242"));
  for (const name of [
    "core",
    "sources",
    "report.json",
    "2026-11-18T10-00-00-000Z",
  ]) {
    assert.equal(V5_RUN_DIR_PATTERN.test(name), false, name);
  }
});

test("runRound2NativeRepairs stops a timed-out child with a clear message", () => {
  withTempDir((root) => {
    const calls = [];
    const spawnCommand = (command, args, options) => {
      calls.push(options);
      return {
        status: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawnSync node ETIMEDOUT"), {
          code: "ETIMEDOUT",
        }),
      };
    };
    const outcome = runRound2NativeRepairs(
      {
        ffmpeg: { binary: path.join(root, "ffmpeg") },
        binary: path.join(root, "rosi"),
        suiteStartedAt: identity.startedAt,
      },
      { spawnCommand, artifactsDir: root },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].timeout, TIMEOUT_MS);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.reason, /timed out after 900000 ms/);
  });
});

test("runRound2NativeRepairs prunes its own folders under the given artifacts directory", () => {
  withTempDir((root) => {
    const evidence = path.join(root, "round2-native");
    fs.mkdirSync(evidence);
    makeRuns(
      evidence,
      22,
      (index) =>
        `2026-11-18T10-00-${String(index).padStart(2, "0")}-000Z-${index}`,
    );
    runRound2NativeRepairs(
      {
        ffmpeg: { binary: path.join(root, "ffmpeg") },
        binary: path.join(root, "rosi"),
        suiteStartedAt: identity.startedAt,
      },
      {
        spawnCommand: () => ({ status: 1, stdout: "", stderr: "" }),
        artifactsDir: root,
      },
    );
    assert.equal(fs.readdirSync(evidence).length, 20);
    assert.equal(
      fs.existsSync(path.join(evidence, "2026-11-18T10-00-01-000Z-1")),
      false,
    );
  });
});

test("runDownloadProcessRepairs passes the timeout and reports a timeout", (t) => {
  if (process.platform === "win32") {
    t.skip("process-repair runner is skipped on Windows");
    return;
  }
  withTempDir((root) => {
    const calls = [];
    const runCommand = (command, args, options) => {
      calls.push(options);
      throw Object.assign(new Error("spawnSync node ETIMEDOUT"), {
        code: "ETIMEDOUT",
      });
    };
    const outcome = runDownloadProcessRepairs(
      {
        ffmpeg: null,
        binary: path.join(root, "rosi"),
        suiteStartedAt: identity.startedAt,
      },
      { run: runCommand, artifactsDir: root },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].timeout, TIMEOUT_MS);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.reason, /timed out after 900000 ms/);
  });
});

test("probeReportProblems accepts a valid probe report and rejects each defect", () => {
  const probeExpected = {
    label: "default",
    version: "5.1.0",
    commit: "c".repeat(40),
    binarySha256: HASH_A,
    suiteStartedAt: identity.startedAt,
  };
  const body = {
    version: "5.1.0",
    commit: "c".repeat(40),
    startedAt: "2030-01-01T00:00:02.000Z",
    finishedAt: "2030-01-01T00:00:30.000Z",
    platform: "darwin",
    arch: "arm64",
    binarySha256: HASH_A,
    observations: [{ name: "one", invariantPassed: true }],
  };
  assert.deepEqual(probeReportProblems(writerReport(body), probeExpected), []);
  const defects = [
    { observations: [{ name: "one", invariantPassed: false }] },
    { observations: [{ name: "one" }] },
    { observations: [{ name: "one", invariantPassed: null }] },
    { observations: [{ name: "one", invariantPassed: "true" }] },
    { observations: [{ name: "one", invariantPassed: true }, { name: "two" }] },
    { observations: [] },
    { commit: "d".repeat(40) },
    { version: "9.9.9" },
    { binarySha256: HASH_B },
    { startedAt: "2029-12-31T23:59:59.000Z" },
  ];
  for (const change of defects) {
    const problems = probeReportProblems(
      writerReport({ ...body, ...change }),
      probeExpected,
    );
    assert.ok(problems.length > 0, JSON.stringify(change));
  }
  const tampered = { ...writerReport(body), observations: [] };
  assert.ok(probeReportProblems(tampered, probeExpected).length > 0);
  assert.ok(probeReportProblems(null, probeExpected).length > 0);
});

test("round2NativeReportProblems still rejects a report that did not pass", () => {
  const body = {
    app: "ROSI",
    suite: "round2-native",
    passed: false,
    observations: [],
    failures: [],
    wdioExitCode: 0,
  };
  const problems = round2NativeReportProblems(writerReport(body), {
    version: "5.1.0",
    platform: "darwin",
    arch: "arm64",
    binary: "x",
    binarySha256: HASH_A,
    ffmpegSha256: HASH_B,
    probeSources: {},
    suiteStartedAt: identity.startedAt,
  });
  assert.ok(problems.some((problem) => /does not pass/.test(problem)));
});

// Writes one runner report under <root>/v5-fixes-<area>/stamp/report.json.
function runnerReportFixture(
  root,
  areaName,
  body,
  { secondsAgo = 0, now } = {},
) {
  const areaDir = path.join(root, `v5-fixes-${areaName}`);
  fs.rmSync(areaDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(areaDir, "stamp"), { recursive: true });
  const file = path.join(areaDir, "stamp", "report.json");
  fs.writeFileSync(
    file,
    typeof body === "string" ? body : JSON.stringify(body),
  );
  setMtime(file, secondsAgo, now);
  return file;
}

const GATE_BINARY = { binarySha256: HASH_A, platform: "linux" };

function freshBody(now, extra = {}) {
  return {
    passed: true,
    binarySha256: HASH_A,
    startedAt: new Date(now - 30_000).toISOString(),
    finishedAt: new Date(now - 10_000).toISOString(),
    ...extra,
  };
}

test("findRunnerReport accepts passed or allPassed and rejects failures, stale reports, and bad JSON", () => {
  withTempDir((root) => {
    const area = { area: "demo" };
    const now = Date.now();
    const gateStartedMs = now - 60_000;
    const check = (body, options) => {
      runnerReportFixture(root, "demo", body, { now, ...options });
      return findRunnerReport(area, root, gateStartedMs, GATE_BINARY);
    };
    assert.equal(check(freshBody(now)).problem, null);
    assert.equal(
      check(freshBody(now, { passed: undefined, allPassed: true })).problem,
      null,
    );
    assert.match(
      check(freshBody(now, { passed: false })).problem,
      /does not pass/,
    );
    assert.match(check("{not json")?.problem ?? "", /unreadable/);
    assert.match(
      check(freshBody(now), { secondsAgo: 3600 }).problem,
      /no report written during this run/,
    );
    fs.rmSync(path.join(root, "v5-fixes-demo"), {
      recursive: true,
      force: true,
    });
    assert.match(
      findRunnerReport(area, root, gateStartedMs, GATE_BINARY).problem,
      /no runner report directory/,
    );
  });
});

test("findRunnerReport requires binarySha256 and a startedAt inside this invocation", () => {
  withTempDir((root) => {
    const area = { area: "demo" };
    const now = Date.now();
    const gateStartedMs = now - 60_000;
    const problemFor = (change, expectedIdentity = GATE_BINARY) => {
      runnerReportFixture(root, "demo", freshBody(now, change), { now });
      return findRunnerReport(area, root, gateStartedMs, expectedIdentity)
        .problem;
    };
    assert.equal(problemFor({}), null);
    assert.match(
      problemFor({ binarySha256: undefined }),
      /binarySha256 differs/,
    );
    assert.match(problemFor({ binarySha256: HASH_B }), /binarySha256 differs/);
    assert.match(problemFor({ binarySha256: "" }), /binarySha256 differs/);
    assert.match(problemFor({ startedAt: undefined }), /timestamps/);
    assert.match(problemFor({ startedAt: "not a date" }), /timestamps/);
    assert.match(
      problemFor({ startedAt: new Date(gateStartedMs - 1000).toISOString() }),
      /timestamps/,
    );
    assert.match(problemFor({ finishedAt: undefined }), /timestamps/);
    assert.match(
      problemFor({ finishedAt: new Date(now - 40_000).toISOString() }),
      /timestamps/,
    );
    // Without the gate's binary hash there is nothing to compare against.
    assert.match(problemFor({}, {}), /binary hash/);
    assert.match(problemFor({}, { binarySha256: "" }), /binary hash/);
  });
});

test("findRunnerReport fails a skipped case unless it has an allowance for this platform", () => {
  withTempDir((root) => {
    const now = Date.now();
    const gateStartedMs = now - 60_000;
    const run = (areaName, extra, platform) => {
      runnerReportFixture(root, areaName, freshBody(now, extra), { now });
      return findRunnerReport({ area: areaName }, root, gateStartedMs, {
        binarySha256: HASH_A,
        platform,
      });
    };
    const installSkip = {
      cases: [
        { name: "orphan-sweep", status: "passed" },
        {
          name: "install-fallback",
          status: "skipped",
          reason: "needs an exFAT mount",
        },
      ],
    };
    const allowed = run("downloader", installSkip, "linux");
    assert.equal(allowed.problem, null);
    assert.deepEqual(
      allowed.skipped.map((entry) => entry.case),
      ["install-fallback"],
    );
    assert.equal(run("downloader", installSkip, "win32").problem, null);
    assert.match(
      run("downloader", installSkip, "darwin").problem,
      /install-fallback skipped without an allowance on darwin/,
    );
    const otherCase = {
      cases: [{ name: "long-path", status: "skipped", reason: "because" }],
    };
    assert.match(
      run("downloader", otherCase, "linux").problem,
      /long-path skipped without an allowance/,
    );
    const noReason = {
      cases: [{ name: "install-fallback", status: "skipped", reason: " " }],
    };
    assert.match(run("downloader", noReason, "linux").problem, /no reason/);
    assert.match(
      run("network", installSkip, "linux").problem,
      /skipped without an allowance/,
    );
    const denoSkip = {
      cases: [
        {
          name: "deno-installer",
          status: "passed",
          checks: [
            {
              name: "reminder-failure-offers-instructions",
              skipped: true,
              invariantPassed: null,
              reason: "Linux shows only instructions",
            },
          ],
        },
      ],
    };
    assert.equal(run("deno-installer", denoSkip, "linux").problem, null);
    assert.match(
      run("deno-installer", denoSkip, "win32").problem,
      /reminder-failure-offers-instructions skipped without an allowance/,
    );
    const observationSkip = {
      observations: [{ name: "probe", skipped: true, reason: "x" }],
    };
    assert.match(
      run("persistence", observationSkip, "linux").problem,
      /probe skipped without an allowance/,
    );
  });
});

test("reportedSkips finds skipped cases, case checks, and top-level records", () => {
  assert.deepEqual(reportedSkips(null), []);
  assert.deepEqual(
    reportedSkips({ cases: [{ name: "a", status: "passed" }] }),
    [],
  );
  const skips = reportedSkips({
    cases: [
      { name: "a", status: "skipped", reason: "r1" },
      {
        name: "b",
        status: "passed",
        checks: [
          { name: "ok", invariantPassed: true },
          { name: "x", skipped: true, reason: "r2" },
          { name: "y", status: "skipped" },
        ],
      },
    ],
    checks: [{ skipped: true }],
    observations: [{ mode: "m", skipped: true, reason: "r3" }],
  });
  assert.deepEqual(
    skips.map((entry) => [entry.case, entry.reason]),
    [
      ["a", "r1"],
      ["b/x", "r2"],
      ["b/y", ""],
      ["unnamed", ""],
      ["m", "r3"],
    ],
  );
});

test("caseSkipProblems accepts only a listed scenario, case, and platform with a reason", () => {
  const skip = { case: "install-fallback", reason: "needs a mount" };
  assert.deepEqual(
    caseSkipProblems("v5-fixes/downloader", [skip], "linux"),
    [],
  );
  assert.equal(
    caseSkipProblems("v5-fixes/downloader", [skip], "darwin").length,
    1,
  );
  assert.equal(caseSkipProblems("v5-fixes/network", [skip], "linux").length, 1);
  assert.equal(
    caseSkipProblems(
      "v5-fixes/downloader",
      [{ case: "install-fallback", reason: "" }],
      "linux",
    ).length,
    1,
  );
});

test("every skip allowance in the manifest carries a platform and a reason", () => {
  assert.ok(Object.keys(ALLOWED_E2E_SKIPS).length > 0);
  for (const [name, allowances] of Object.entries(ALLOWED_E2E_SKIPS)) {
    assert.ok(allowances.length > 0, name);
    for (const allowance of allowances) {
      assert.ok(["darwin", "linux", "win32"].includes(allowance.platform));
      assert.ok(allowance.reason.trim().length > 0, name);
    }
  }
  assert.ok(ALLOWED_CASE_SKIPS.length > 0);
  for (const allowance of ALLOWED_CASE_SKIPS) {
    assert.ok(allowance.reason.trim().length > 0, allowance.case);
  }
});

test("validateSuiteManifest rejects an allowance with no reason or an unknown platform", () => {
  const clone = () => structuredClone(E2E_SUITE_MANIFEST);
  assert.doesNotThrow(() => validateSuiteManifest(clone()));
  const skipScenario = (manifest) =>
    manifest.scenarios.find((scenario) => scenario.allowedSkips.length > 0);
  const breakers = [
    (m) => {
      skipScenario(m).allowedSkips[0].reason = "";
    },
    (m) => {
      skipScenario(m).allowedSkips[0].reason = "   ";
    },
    (m) => {
      delete skipScenario(m).allowedSkips[0].reason;
    },
    (m) => {
      skipScenario(m).allowedSkips[0] = "win32";
    },
    (m) => {
      skipScenario(m).allowedSkips[0].platform = "freebsd";
    },
    (m) => {
      m.allowedCaseSkips[0].reason = "";
    },
    (m) => {
      delete m.allowedCaseSkips[0].reason;
    },
    (m) => {
      m.allowedCaseSkips[0].platform = "freebsd";
    },
    (m) => {
      m.allowedCaseSkips[0].case = "";
    },
    (m) => {
      m.allowedCaseSkips[0].scenario = "v5-fixes/no-such-area";
    },
    (m) => {
      m.allowedCaseSkips.push({ ...m.allowedCaseSkips[0] });
    },
    (m) => {
      m.allowedCaseSkips = "none";
    },
  ];
  for (const [index, mutate] of breakers.entries()) {
    const manifest = clone();
    mutate(manifest);
    assert.throws(
      () => validateSuiteManifest(manifest),
      Error,
      `breaker ${index}`,
    );
  }
});

test("scenarioOutcomeProblems allows a skipped scenario only on a platform with an allowance", () => {
  const name = "download-process-repairs";
  const skipped = [{ name, status: "skipped" }];
  assert.deepEqual(scenarioOutcomeProblems(skipped, "win32", [name]), []);
  assert.equal(scenarioOutcomeProblems(skipped, "linux", [name]).length, 1);
});
