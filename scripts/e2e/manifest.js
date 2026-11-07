// E2E suite manifest, feature groups, run plan, and scenario outcome checks.
// The gate (scripts/test-e2e.js) reads e2e/suites.json through this module.

import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../e2e/helpers/profile.js";
import { sha256 } from "../../e2e/helpers/media-server.js";

const SUITE_MANIFEST_PATH = path.join(REPO_ROOT, "e2e", "suites.json");
export const E2E_SUITE_MANIFEST = JSON.parse(
  fs.readFileSync(SUITE_MANIFEST_PATH, "utf8"),
);

function validateSuiteManifest(manifest) {
  if (manifest?.schemaVersion !== 1) {
    throw new Error("e2e/suites.json has an unsupported schemaVersion");
  }
  if (!Array.isArray(manifest.scenarios) || !Array.isArray(manifest.groups)) {
    throw new Error("e2e/suites.json must define scenarios and groups arrays");
  }
  const ownerIds = new Set(Object.keys(manifest.owners ?? {}));
  const groupIds = new Set();
  for (const group of manifest.groups) {
    if (!group?.id || groupIds.has(group.id)) {
      throw new Error(
        `e2e/suites.json has a missing or duplicate group id: ${group?.id}`,
      );
    }
    groupIds.add(group.id);
    if (!Array.isArray(group.owners) || !Array.isArray(group.v5FixAreas)) {
      throw new Error(
        `e2e/suites.json group ${group.id} has invalid owner or area lists`,
      );
    }
    for (const owner of group.owners) {
      if (!ownerIds.has(owner)) {
        throw new Error(
          `e2e/suites.json group ${group.id} has unknown owner ${owner}`,
        );
      }
    }
    if (group.v5FixAreas.some((area) => typeof area !== "string" || !area)) {
      throw new Error(
        `e2e/suites.json group ${group.id} has an invalid v5-fixes area`,
      );
    }
  }
  const names = new Set();
  for (const scenario of manifest.scenarios) {
    if (!scenario?.name || names.has(scenario.name)) {
      throw new Error(
        `e2e/suites.json has a missing or duplicate scenario: ${scenario?.name}`,
      );
    }
    names.add(scenario.name);
    if (!groupIds.has(scenario.feature) || !ownerIds.has(scenario.owner)) {
      throw new Error(
        `e2e/suites.json scenario ${scenario.name} has an unknown feature or owner`,
      );
    }
    if (!Array.isArray(scenario.allowedSkips)) {
      throw new Error(
        `e2e/suites.json scenario ${scenario.name} has invalid skip allowances`,
      );
    }
    if (
      scenario.allowedSkips.some(
        (platform) => !["darwin", "linux", "win32"].includes(platform),
      )
    ) {
      throw new Error(
        `e2e/suites.json scenario ${scenario.name} has an unknown platform allowance`,
      );
    }
  }
  const areaGroups = manifest.dynamicV5Fixes?.groupAreas ?? {};
  const mappedAreas = new Set();
  for (const [groupId, areas] of Object.entries(areaGroups)) {
    const group = manifest.groups.find((candidate) => candidate.id === groupId);
    if (!group || !Array.isArray(areas)) {
      throw new Error(
        `e2e/suites.json has invalid dynamic area mapping for ${groupId}`,
      );
    }
    for (const area of areas) {
      if (mappedAreas.has(area) || !group.v5FixAreas.includes(area)) {
        throw new Error(
          `e2e/suites.json has duplicate or inconsistent v5-fixes mapping: ${area}`,
        );
      }
      mappedAreas.add(area);
    }
  }
  for (const group of manifest.groups) {
    const scenarioOwners = new Set(
      manifest.scenarios
        .filter((scenario) => scenario.feature === group.id)
        .map((scenario) => scenario.owner),
    );
    if ([...scenarioOwners].some((owner) => !group.owners.includes(owner))) {
      throw new Error(
        `e2e/suites.json group ${group.id} omits a scenario owner`,
      );
    }
    for (const area of group.v5FixAreas) {
      if (!mappedAreas.has(area)) {
        throw new Error(
          `e2e/suites.json group ${group.id} has unmapped v5-fixes area ${area}`,
        );
      }
    }
  }
  if (!ownerIds.has(manifest.dynamicV5Fixes?.owner)) {
    throw new Error("e2e/suites.json has an unknown dynamic v5-fixes owner");
  }
  for (const group of manifest.groups) {
    if (
      group.v5FixAreas.length > 0 &&
      !group.owners.includes(manifest.dynamicV5Fixes.owner)
    ) {
      throw new Error(
        `e2e/suites.json group ${group.id} omits its dynamic v5-fixes owner`,
      );
    }
  }
}

validateSuiteManifest(E2E_SUITE_MANIFEST);

export const EXPECTED_SCENARIOS = E2E_SUITE_MANIFEST.scenarios.map(
  (scenario) => scenario.name,
);
export const ROUND2_RENDERER_OBSERVATIONS = Object.freeze([
  "renderer-startup-settings-ready",
  "updater-channel-and-singleflight",
  "activity-clear-commits-after-backend",
]);
export const ROUND2_NATIVE_OBSERVATIONS = Object.freeze([
  "download-staging-preserves-arrival",
  "source-identity-preserves-replacement",
  "deno-version-probe",
  "activity-clear-persist-failure-preserves-memory",
  "activity-clear-durable-retry",
  "activity-byte-budget-preserves-newest",
  "close-ack-survives-async-shutdown",
  "download-only-final-placement",
  "download-failure-cleans-staging",
  "download-cancel-cleans-staging",
  "download-retry-cleans-staging",
  "windows-job-object-leader-exit",
]);
export const ALLOWED_E2E_SKIPS = Object.freeze(
  Object.fromEntries(
    E2E_SUITE_MANIFEST.scenarios
      .filter((scenario) => scenario.allowedSkips.length > 0)
      .map((scenario) => [scenario.name, Object.freeze(scenario.allowedSkips)]),
  ),
);

export function groupedScenarioResults(scenarios, expectedScenarios) {
  const expected = new Set(expectedScenarios);
  const dynamicGroups = E2E_SUITE_MANIFEST.dynamicV5Fixes.groupAreas;
  return Object.fromEntries(
    E2E_SUITE_MANIFEST.groups.map((group) => {
      const groupNames = [
        ...E2E_SUITE_MANIFEST.scenarios
          .filter((scenario) => scenario.feature === group.id)
          .map((scenario) => scenario.name),
        ...(dynamicGroups[group.id] ?? []).map((area) => `v5-fixes/${area}`),
      ].filter((name) => expected.has(name));
      const reported = scenarios.filter((scenario) =>
        groupNames.includes(scenario?.name),
      );
      const reportedNames = new Set(reported.map((scenario) => scenario.name));
      return [
        group.id,
        {
          expectedScenarios: groupNames,
          reportedScenarios: reported,
          missingScenarios: groupNames.filter(
            (name) => !reportedNames.has(name),
          ),
        },
      ];
    }),
  );
}

export function scenarioOutcomeProblems(
  scenarios,
  platform,
  expected = EXPECTED_SCENARIOS,
) {
  const problems = [];
  const names = scenarios.map((scenario) => scenario?.name);
  for (const name of expected) {
    const count = names.filter((candidate) => candidate === name).length;
    if (count !== 1) {
      problems.push(`${name} reported ${count} times`);
      continue;
    }
    const scenario = scenarios.find((candidate) => candidate?.name === name);
    if (scenario.status === "passed") continue;
    const allowedPlatforms = ALLOWED_E2E_SKIPS[name] ?? [];
    if (scenario.status === "skipped" && allowedPlatforms.includes(platform)) {
      continue;
    }
    problems.push(`${name} has unacceptable status ${scenario.status}`);
  }
  for (const name of names) {
    if (!expected.includes(name)) {
      problems.push(`unexpected scenario ${name}`);
    }
  }
  return problems;
}

export function round2RendererResultProblems(results) {
  if (!Array.isArray(results))
    return ["renderer observations are not an array"];
  const problems = [];
  const names = results.map((result) => result?.name);
  for (const name of ROUND2_RENDERER_OBSERVATIONS) {
    const count = names.filter((candidate) => candidate === name).length;
    if (count !== 1) {
      problems.push(`${name} reported ${count} times`);
      continue;
    }
    const result = results.find((candidate) => candidate?.name === name);
    if (result.status !== "passed") {
      problems.push(`${name} has unacceptable status ${result.status}`);
    }
  }
  for (const name of names) {
    if (!ROUND2_RENDERER_OBSERVATIONS.includes(name)) {
      problems.push(`unexpected renderer observation ${name}`);
    }
  }
  return problems;
}

/** A blank ROSI_E2E_ONLY means the full gate, as if it were unset. */
export function e2eOnlySpec(value) {
  const spec = typeof value === "string" ? value.trim() : "";
  return spec === "" ? null : spec;
}

/** Read one or more manifest feature groups from CLI arguments or the env. */
export function parseE2eGroups(argv, env = process.env) {
  const fromArgs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--group") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--group needs a comma-separated feature group list");
      }
      fromArgs.push(value);
      index += 1;
    } else if (argument.startsWith("--group=")) {
      const value = argument.slice("--group=".length);
      if (value.trim() === "") {
        throw new Error("--group needs a comma-separated feature group list");
      }
      fromArgs.push(value);
    }
  }
  const rawGroups =
    fromArgs.length > 0 ? fromArgs : [env.ROSI_E2E_GROUPS ?? ""];
  const groups = rawGroups.flatMap((value) => value.split(","));
  const normalized = groups.map((group) => group.trim()).filter(Boolean);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("E2E feature groups must not be listed more than once");
  }
  return normalized;
}

/** True for specs under e2e/v5-fixes/, which report through their own files. */
export function isV5FixesSpec(spec) {
  return /^(\.\/)?v5-fixes\//.test((spec ?? "").replace(/\\/g, "/"));
}

/**
 * The full gate keeps the complete inventory. Ad-hoc specs and manifest group
 * selections are always partial, so neither report can pass as release proof.
 */
export function e2eRunPlan({
  onlySpec,
  v5AreaNames = [],
  selectedGroups = [],
}) {
  if (onlySpec !== null && selectedGroups.length > 0) {
    throw new Error(
      "ROSI_E2E_ONLY cannot be combined with --group or ROSI_E2E_GROUPS",
    );
  }
  const mappedV5Areas = new Set(
    Object.values(E2E_SUITE_MANIFEST.dynamicV5Fixes.groupAreas).flat(),
  );
  const ungroupedV5Areas = v5AreaNames.filter(
    (area) => !mappedV5Areas.has(area),
  );
  if (ungroupedV5Areas.length > 0) {
    throw new Error(
      `v5-fixes area(s) need a feature group in e2e/suites.json: ${ungroupedV5Areas.join(", ")}`,
    );
  }
  if (onlySpec === null && selectedGroups.length === 0) {
    return {
      fullSuite: true,
      mainSpecs: "./specs/main.spec.js",
      expectedScenarios: [
        ...EXPECTED_SCENARIOS,
        ...v5AreaNames.map((area) => `v5-fixes/${area}`),
      ],
      enabledOwners: Object.keys(E2E_SUITE_MANIFEST.owners),
      selectedGroups: [],
      v5AreaNames,
    };
  }
  if (onlySpec !== null) {
    return {
      fullSuite: false,
      mainSpecs: onlySpec,
      expectedScenarios: [],
      enabledOwners: [],
      selectedGroups: [],
      v5AreaNames: [],
    };
  }

  const groupsById = new Map(
    E2E_SUITE_MANIFEST.groups.map((group) => [group.id, group]),
  );
  const unknownGroups = selectedGroups.filter(
    (group) => !groupsById.has(group),
  );
  if (unknownGroups.length > 0) {
    throw new Error(
      `unknown E2E feature group(s): ${unknownGroups.join(", ")}`,
    );
  }
  const selected = selectedGroups.map((id) => groupsById.get(id));
  const enabledOwners = new Set(selected.flatMap((group) => group.owners));
  const requiredV5Areas = new Set(
    selected.flatMap((group) => group.v5FixAreas),
  );
  const selectedV5Areas = v5AreaNames.filter((area) =>
    requiredV5Areas.has(area),
  );
  const missingV5Areas = [...requiredV5Areas].filter(
    (area) => !v5AreaNames.includes(area),
  );
  if (missingV5Areas.length > 0) {
    throw new Error(
      `selected E2E feature group(s) require missing v5-fixes area(s): ${missingV5Areas.join(", ")}`,
    );
  }
  return {
    fullSuite: false,
    mainSpecs: "./specs/main.spec.js",
    expectedScenarios: [
      ...E2E_SUITE_MANIFEST.scenarios
        .filter((scenario) => enabledOwners.has(scenario.owner))
        .map((scenario) => scenario.name),
      ...selectedV5Areas.map((area) => `v5-fixes/${area}`),
    ],
    enabledOwners: [...enabledOwners],
    selectedGroups,
    v5AreaNames: selectedV5Areas,
  };
}

/**
 * Verdict for an ad-hoc run. A v5-fixes spec is judged by the WebdriverIO exit
 * code the caller already checks. Any other spec must report at least one
 * scenario, and each reported scenario must pass as it would in the full gate.
 */
export function onlyRunScenarioProblems({ onlySpec, scenarios, platform }) {
  if (isV5FixesSpec(onlySpec)) return [];
  if (scenarios.length === 0) return [`${onlySpec} reported no scenarios`];
  const names = [...new Set(scenarios.map((scenario) => scenario?.name))];
  return scenarioOutcomeProblems(scenarios, platform, names);
}

/**
 * Scenarios whose `shots` the gate verifies: the main UI pass, and the
 * v5-fixes/ui-polish area, whose shots come from its results file.
 */
export const SCREENSHOT_SCENARIO_NAMES = Object.freeze([
  "ui-screenshots",
  "v5-fixes/ui-polish",
]);

/**
 * Re-hash every screenshot the spec reported, so the evidence report vouches
 * for the PNGs actually on disk. Returns the list and any mismatch problems.
 */
export function verifyScreenshots(scenarios, directory) {
  const reported = scenarios
    .filter((scenario) => SCREENSHOT_SCENARIO_NAMES.includes(scenario?.name))
    .flatMap((scenario) =>
      Array.isArray(scenario.shots) ? scenario.shots : [],
    );
  const problems = [];
  const screenshots = reported.map((shot) => {
    const file = path.join(directory, shot.file);
    if (!fs.existsSync(file)) {
      problems.push(`${shot.file} is missing`);
      return { ...shot, path: path.relative(REPO_ROOT, file) };
    }
    const actual = sha256(fs.readFileSync(file));
    if (actual !== shot.sha256) problems.push(`${shot.file} changed on disk`);
    return {
      name: shot.name,
      path: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
      sha256: actual,
      bytes: fs.statSync(file).size,
    };
  });
  return { screenshots, problems };
}
