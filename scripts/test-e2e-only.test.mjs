import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_SCENARIOS,
  e2eOnlySpec,
  e2eRunPlan,
  isV5FixesSpec,
  onlyRunScenarioProblems,
  scenarioOutcomeProblems,
} from "./test-e2e.js";

test("blank ROSI_E2E_ONLY values mean the full gate", () => {
  for (const value of [undefined, "", "   ", "\n\t"]) {
    assert.equal(e2eOnlySpec(value), null, JSON.stringify(value));
  }
});

test("ROSI_E2E_ONLY spec is trimmed and kept otherwise", () => {
  assert.equal(e2eOnlySpec(" ./specs/main.spec.js "), "./specs/main.spec.js");
  assert.equal(
    e2eOnlySpec("./v5-fixes/network/a.spec.js"),
    "./v5-fixes/network/a.spec.js",
  );
});

test("only a v5-fixes directory prefix counts as a v5-fixes spec", () => {
  for (const spec of [
    "./v5-fixes/network/a.spec.js",
    "v5-fixes/network/a.spec.js",
    "./v5-fixes\\network\\a.spec.js",
  ]) {
    assert.equal(isV5FixesSpec(spec), true, spec);
  }
  for (const spec of [
    "./specs/main.spec.js",
    "./specs/v5-fixes-notes.spec.js",
    "./v5-fixesX/a.spec.js",
    "./specs/main.spec.js ./v5-fixes/a.spec.js",
  ]) {
    assert.equal(isV5FixesSpec(spec), false, spec);
  }
});

test("full mode keeps the complete inventory and full-suite flag", () => {
  const plan = e2eRunPlan({
    onlySpec: null,
    v5AreaNames: ["network", "persistence"],
  });
  assert.equal(plan.fullSuite, true);
  assert.equal(plan.mainSpecs, "./specs/main.spec.js");
  assert.deepEqual(plan.expectedScenarios, [
    ...EXPECTED_SCENARIOS,
    "v5-fixes/network",
    "v5-fixes/persistence",
  ]);
});

test("full mode with no v5-fixes areas expects only the inventory", () => {
  const plan = e2eRunPlan({ onlySpec: null, v5AreaNames: [] });
  assert.equal(plan.fullSuite, true);
  assert.deepEqual(plan.expectedScenarios, EXPECTED_SCENARIOS);
});

test("full mode still rejects a run that reports only one suite", () => {
  const plan = e2eRunPlan({ onlySpec: null, v5AreaNames: [] });
  const problems = scenarioOutcomeProblems(
    [{ name: "launch", status: "passed" }],
    "linux",
    plan.expectedScenarios,
  );
  assert.ok(problems.includes("legacy-v4-import reported 0 times"));
});

test("ONLY mode with main.spec expects no suites and is partial", () => {
  const plan = e2eRunPlan({
    onlySpec: "./specs/main.spec.js",
    v5AreaNames: ["network"],
  });
  assert.equal(plan.fullSuite, false);
  assert.equal(plan.mainSpecs, "./specs/main.spec.js");
  assert.deepEqual(plan.expectedScenarios, []);
});

test("ONLY mode with a v5-fixes spec runs that spec and is partial", () => {
  const spec = "./v5-fixes/network/a.spec.js";
  const plan = e2eRunPlan({ onlySpec: spec, v5AreaNames: ["network"] });
  assert.equal(plan.fullSuite, false);
  assert.equal(plan.mainSpecs, spec);
  assert.deepEqual(plan.expectedScenarios, []);
});

test("ONLY main.spec with no reported scenarios fails", () => {
  const problems = onlyRunScenarioProblems({
    onlySpec: "./specs/main.spec.js",
    scenarios: [],
    platform: "linux",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /reported no scenarios/);
});

test("ONLY main.spec passes when every reported scenario passed", () => {
  const problems = onlyRunScenarioProblems({
    onlySpec: "./specs/main.spec.js",
    scenarios: [
      { name: "launch", status: "passed" },
      { name: "settings-persistence", status: "passed" },
    ],
    platform: "linux",
  });
  assert.deepEqual(problems, []);
});

test("ONLY main.spec fails on a failed or unallowed skipped scenario", () => {
  const failed = onlyRunScenarioProblems({
    onlySpec: "./specs/main.spec.js",
    scenarios: [{ name: "launch", status: "failed" }],
    platform: "linux",
  });
  assert.deepEqual(failed, ["launch has unacceptable status failed"]);

  const skipped = onlyRunScenarioProblems({
    onlySpec: "./specs/main.spec.js",
    scenarios: [{ name: "download-process-repairs", status: "skipped" }],
    platform: "linux",
  });
  assert.deepEqual(skipped, [
    "download-process-repairs has unacceptable status skipped",
  ]);
});

test("ONLY main.spec accepts a platform allowance only on that platform", () => {
  const scenarios = [{ name: "download-process-repairs", status: "skipped" }];
  assert.deepEqual(
    onlyRunScenarioProblems({
      onlySpec: "./specs/main.spec.js",
      scenarios,
      platform: "win32",
    }),
    [],
  );
});

test("ONLY main.spec rejects a scenario reported twice", () => {
  const problems = onlyRunScenarioProblems({
    onlySpec: "./specs/main.spec.js",
    scenarios: [
      { name: "launch", status: "passed" },
      { name: "launch", status: "passed" },
    ],
    platform: "linux",
  });
  assert.deepEqual(problems, ["launch reported 2 times"]);
});

test("ONLY v5-fixes spec is judged by wdio exit, not reported scenarios", () => {
  const spec = "./v5-fixes/network/a.spec.js";
  assert.deepEqual(
    onlyRunScenarioProblems({
      onlySpec: spec,
      scenarios: [],
      platform: "linux",
    }),
    [],
  );
  assert.deepEqual(
    onlyRunScenarioProblems({
      onlySpec: spec,
      scenarios: [{ name: "launch", status: "failed" }],
      platform: "linux",
    }),
    [],
  );
});
