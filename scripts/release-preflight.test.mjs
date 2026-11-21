import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  assertHostedCiPassed,
  expectedReleaseBranch,
  runPreflight,
} from "./release-preflight.js";

const require = createRequire(import.meta.url);
const { STABLE_FORBIDDEN_ENV } = require("./release-policy.cjs");

const OVERRIDE = "ROSI_RELEASE_ALLOW_UNVERIFIED_CI";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const GITHUB_ACTIONS_APP_ID = 15368;

function checkRun(overrides = {}) {
  return {
    id: 100,
    name: "ci-gate",
    head_sha: SHA,
    status: "completed",
    conclusion: "success",
    app: { id: GITHUB_ACTIONS_APP_ID },
    check_suite: { id: 5000 },
    ...overrides,
  };
}

// Stub for githubApi(method, endpoint): records calls, returns check runs and
// the workflow run for a check suite. events maps suite id to a run event.
function ciApi(runs, calls = [], { events = {}, workflowRuns } = {}) {
  return (method, endpoint) => {
    calls.push({ method, endpoint });
    const suite = endpoint.match(/actions\/runs\?check_suite_id=(\d+)/);
    if (suite) {
      const id = Number(suite[1]);
      const found = workflowRuns
        ? workflowRuns(id)
        : [
            {
              check_suite_id: id,
              event: events[id] ?? "push",
              path: ".github/workflows/ci.yml",
              head_sha: SHA,
            },
          ];
      return { total_count: found.length, workflow_runs: found };
    }
    return { total_count: runs.length, check_runs: runs };
  };
}

function silentLog() {
  const warnings = [];
  return {
    log: () => {},
    warn: (message) => warnings.push(message),
    warnings,
  };
}

function ciCheck({ runs, api, env = {}, log = silentLog() } = {}) {
  return assertHostedCiPassed({
    sha: SHA,
    owner: "BurntToasters",
    repo: "ROSI",
    api: api ?? ciApi(runs ?? [checkRun()]),
    env,
    log,
  });
}

test("beta and stable versions still map to their release branches", () => {
  assert.equal(expectedReleaseBranch("5.0.0-beta.4"), "beta");
  assert.equal(expectedReleaseBranch("5.0.0"), "main");
  assert.throws(() => expectedReleaseBranch("5.0.0-rc.1"));
});

test("a successful ci-gate on the exact HEAD commit passes and is queried by SHA", () => {
  const calls = [];
  const result = ciCheck({ api: ciApi([checkRun()], calls) });
  assert.equal(result.verified, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.match(
    calls[0].endpoint,
    new RegExp(`^/repos/BurntToasters/ROSI/commits/${SHA}/check-runs\\?`),
  );
  assert.match(calls[0].endpoint, /check_name=ci-gate/);
});

test("a missing, pending, failed or cancelled ci-gate blocks the release", () => {
  const cases = {
    "no ci-gate run": [],
    "run queued": [checkRun({ status: "queued", conclusion: null })],
    "run in progress": [checkRun({ status: "in_progress", conclusion: null })],
    "run failed": [checkRun({ conclusion: "failure" })],
    "run cancelled": [checkRun({ conclusion: "cancelled" })],
    "run skipped": [checkRun({ conclusion: "skipped" })],
    "run from another commit": [checkRun({ head_sha: OTHER_SHA })],
    "run from another app (spoofed name)": [checkRun({ app: { id: 999999 } })],
    "newest re-run failed after an earlier success": [
      checkRun({ id: 100 }),
      checkRun({ id: 200, conclusion: "failure" }),
    ],
  };
  for (const [label, runs] of Object.entries(cases)) {
    assert.throws(
      () => ciCheck({ runs }),
      (error) =>
        error.message.includes("ci-gate") && error.message.includes(OVERRIDE),
      label,
    );
  }
});

test("the newest ci-gate run decides, so a later re-run success passes", () => {
  const result = ciCheck({
    runs: [checkRun({ id: 100, conclusion: "failure" }), checkRun({ id: 200 })],
  });
  assert.equal(result.verified, true);
});

test("a scheduled ci-gate never counts, even when it is the newest and green", () => {
  const suite = (id) => ({ check_suite: { id } });
  const events = { 7000: "schedule", 7001: "push" };
  assert.throws(
    () =>
      ciCheck({
        api: ciApi(
          [
            checkRun({ id: 100, ...suite(7001), conclusion: "failure" }),
            checkRun({ id: 200, ...suite(7000) }),
          ],
          [],
          { events },
        ),
      }),
    /ci-gate concluded failure/,
  );
  assert.throws(
    () =>
      ciCheck({
        api: ciApi([checkRun({ id: 200, ...suite(7000) })], [], { events }),
      }),
    (error) =>
      error.message.includes("ci-gate") &&
      error.message.includes("scheduled") &&
      error.message.includes(OVERRIDE),
  );
});

test("a green ci-gate from a push run passes even with a newer scheduled run", () => {
  const suite = (id) => ({ check_suite: { id } });
  const result = ciCheck({
    api: ciApi(
      [
        checkRun({ id: 100, ...suite(7001) }),
        checkRun({ id: 200, ...suite(7000) }),
      ],
      [],
      { events: { 7000: "schedule", 7001: "push" } },
    ),
  });
  assert.equal(result.verified, true);
});

test("a newer green pull_request ci-gate cannot hide a failed push run", () => {
  const suite = (id) => ({ check_suite: { id } });
  assert.throws(
    () =>
      ciCheck({
        api: ciApi(
          [
            checkRun({ id: 100, ...suite(7001), conclusion: "failure" }),
            checkRun({ id: 200, ...suite(7002) }),
          ],
          [],
          { events: { 7001: "push", 7002: "pull_request" } },
        ),
      }),
    /ci-gate concluded failure/,
  );
  assert.throws(
    () =>
      ciCheck({
        api: ciApi([checkRun({ id: 200, ...suite(7002) })], [], {
          events: { 7002: "pull_request" },
        }),
      }),
    (error) =>
      error.message.includes("push or workflow_dispatch") &&
      error.message.includes(OVERRIDE),
  );
});

test("a manually dispatched ci-gate counts as release proof", () => {
  const result = ciCheck({
    api: ciApi([checkRun({ check_suite: { id: 7003 } })], [], {
      events: { 7003: "workflow_dispatch" },
    }),
  });
  assert.equal(result.verified, true);
});

test("a ci-gate from another workflow file or commit does not count", () => {
  const cases = {
    "another workflow file": (id) => [
      {
        check_suite_id: id,
        event: "push",
        path: ".github/workflows/other.yml",
        head_sha: SHA,
      },
    ],
    "workflow run for another commit": (id) => [
      {
        check_suite_id: id,
        event: "push",
        path: ".github/workflows/ci.yml",
        head_sha: OTHER_SHA,
      },
    ],
  };
  for (const [label, workflowRuns] of Object.entries(cases)) {
    assert.throws(
      () => ciCheck({ api: ciApi([checkRun()], [], { workflowRuns }) }),
      (error) =>
        error.message.includes("ci-gate") && error.message.includes(OVERRIDE),
      label,
    );
  }
});

test("check runs are listed with filter=all so older runs are visible", () => {
  const calls = [];
  ciCheck({ api: ciApi([checkRun()], calls) });
  assert.match(calls[0].endpoint, /filter=all/);
});

test("an unresolvable ci-gate workflow event fails closed", () => {
  const cases = {
    "no check suite on the run": {
      runs: [checkRun({ check_suite: undefined })],
    },
    "no workflow run for the suite": {
      runs: [checkRun()],
      workflowRuns: () => [],
    },
    "workflow run without an event": {
      runs: [checkRun()],
      workflowRuns: (id) => [{ check_suite_id: id }],
    },
    "workflow run for a different suite": {
      runs: [checkRun()],
      workflowRuns: () => [{ check_suite_id: 1, event: "push" }],
    },
  };
  for (const [label, { runs, workflowRuns }] of Object.entries(cases)) {
    assert.throws(
      () => ciCheck({ api: ciApi(runs, [], { workflowRuns }) }),
      (error) =>
        error.message.includes("ci-gate") && error.message.includes(OVERRIDE),
      label,
    );
  }
  assert.throws(
    () =>
      ciCheck({
        api: (method, endpoint) => {
          if (endpoint.includes("actions/runs")) throw new Error("HTTP 403");
          return { check_runs: [checkRun()] };
        },
      }),
    /403/,
  );
});

test("a GitHub API error fails closed without the override", () => {
  assert.throws(
    () =>
      ciCheck({
        api: () => {
          throw new Error("gh api failed with status 401");
        },
      }),
    /401/,
  );
});

test("the explicit override warns loudly and continues when ci-gate is not green", () => {
  const log = silentLog();
  const result = ciCheck({
    runs: [checkRun({ conclusion: "failure" })],
    env: { [OVERRIDE]: "1" },
    log,
  });
  assert.equal(result.verified, false);
  assert.equal(result.overridden, true);
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /UNVERIFIED/);
  assert.match(log.warnings[0], /ci-gate/);
});

test("the override also covers a GitHub API error, with a warning", () => {
  const log = silentLog();
  const result = ciCheck({
    api: () => {
      throw new Error("network down");
    },
    env: { [OVERRIDE]: "true" },
    log,
  });
  assert.equal(result.overridden, true);
  assert.match(log.warnings[0], /network down/);
});

test("the override ignores falsy and empty values", () => {
  for (const value of ["0", "false", "no", "off", ""]) {
    assert.throws(
      () => ciCheck({ runs: [], env: { [OVERRIDE]: value } }),
      /ci-gate/,
      `value ${JSON.stringify(value)}`,
    );
  }
});

test("stable releases forbid the unverified-CI override", () => {
  assert.ok(STABLE_FORBIDDEN_ENV.includes(OVERRIDE));
  assert.throws(
    () =>
      require("./release-policy.cjs").assertStableReleaseOverridesAllowed(
        { [OVERRIDE]: "1" },
        "5.1.0",
      ),
    /ROSI_RELEASE_ALLOW_UNVERIFIED_CI/,
  );
});

function gitStub({
  branch = "beta",
  head = SHA,
  upstream = "origin/beta",
  upstreamHead = SHA,
} = {}) {
  return (args) => {
    const key = args.join(" ");
    if (key === "branch --show-current") return branch;
    if (key === "status --porcelain=v1 --untracked-files=all") return "";
    if (key === "fetch --quiet origin") return "";
    if (key === "rev-parse --abbrev-ref @{upstream}") return upstream;
    if (key === "rev-parse HEAD") return head;
    if (key === "rev-parse @{upstream}") return upstreamHead;
    throw new Error(`unexpected git call: ${key}`);
  };
}

function preflightDeps({
  version = "5.1.0-beta.3",
  env = {},
  runs = [checkRun()],
  git = gitStub(),
  log = silentLog(),
} = {}) {
  const calls = [];
  return {
    calls,
    log,
    options: {
      version,
      env,
      platform: "linux",
      git,
      log,
      identity: () => ({ commit: SHA }),
      github: {
        githubApi: ciApi(runs, calls),
        assertGitHubCliAuthenticated: () => {},
      },
    },
  };
}

test("runPreflight queries ci-gate for HEAD before it reports ok", () => {
  const deps = preflightDeps();
  const messages = [];
  runPreflight({
    ...deps.options,
    log: { log: (m) => messages.push(m), warn: () => {} },
  });
  assert.equal(deps.calls.length, 2);
  assert.match(deps.calls[0].endpoint, new RegExp(SHA));
  assert.ok(messages.some((m) => m.includes("release-preflight: ok")));
});

test("runPreflight refuses a beta release whose HEAD has no green ci-gate", () => {
  const deps = preflightDeps({ runs: [] });
  assert.throws(
    () => runPreflight(deps.options),
    /ROSI_RELEASE_ALLOW_UNVERIFIED_CI/,
  );
});

test("runPreflight refuses a stable release that uses the override", () => {
  const deps = preflightDeps({
    version: "5.1.0",
    git: gitStub({ branch: "main", upstream: "origin/main" }),
    runs: [],
    env: { [OVERRIDE]: "1" },
  });
  assert.throws(
    () => runPreflight(deps.options),
    /Stable release 5\.1\.0 refuses .*ROSI_RELEASE_ALLOW_UNVERIFIED_CI/,
  );
});

test("runPreflight accepts a stable release with a green ci-gate", () => {
  const deps = preflightDeps({
    version: "5.1.0",
    git: gitStub({ branch: "main", upstream: "origin/main" }),
  });
  assert.doesNotThrow(() => runPreflight(deps.options));
});
