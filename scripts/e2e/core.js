// Local core profile selection and artifact paths.

import path from "node:path";
import crypto from "node:crypto";
import { REPO_ROOT } from "../../e2e/helpers/profile.js";
import { E2E_SUITE_MANIFEST } from "./manifest.js";

export function createE2eRunId() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${process.pid}-${crypto.randomUUID()}`;
}

export function parseE2eProfile(
  argv,
  env = process.env,
  manifest = E2E_SUITE_MANIFEST,
) {
  const requested = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--profile needs a profile name");
      }
      requested.push(value);
      index += 1;
    } else if (argument.startsWith("--profile=")) {
      const value = argument.slice("--profile=".length).trim();
      if (!value) throw new Error("--profile needs a profile name");
      requested.push(value);
    }
  }
  if (requested.length > 1) {
    throw new Error("--profile can be provided only once");
  }
  if (requested.length === 0) return null;

  const profile = requested[0];
  if (!Object.hasOwn(manifest.profiles ?? {}, profile)) {
    throw new Error(
      `unknown E2E profile ${profile}; available profile(s): ${Object.keys(manifest.profiles ?? {}).join(", ") || "none"}`,
    );
  }
  const hasGroupArgument = argv.some(
    (argument) => argument === "--group" || argument.startsWith("--group="),
  );
  const hasGroupEnvironment = (env.ROSI_E2E_GROUPS ?? "").trim() !== "";
  const hasOnlySpec = (env.ROSI_E2E_ONLY ?? "").trim() !== "";
  if (hasGroupArgument || hasGroupEnvironment || hasOnlySpec) {
    throw new Error(
      `E2E profile ${profile} cannot be combined with --group, ROSI_E2E_GROUPS, or ROSI_E2E_ONLY`,
    );
  }
  return profile;
}

function profileDefinition(manifest, profileName) {
  const profile = manifest.profiles?.[profileName];
  if (!profile) throw new Error(`unknown E2E profile: ${profileName}`);
  const scenarios = new Map(
    manifest.scenarios.map((item) => [item.name, item]),
  );
  const mainIds = profile.mainScenarioIds;
  if (!Array.isArray(mainIds) || mainIds.length === 0) {
    throw new Error(`E2E profile ${profileName} has no main scenarios`);
  }
  if (new Set(mainIds).size !== mainIds.length) {
    throw new Error(`E2E profile ${profileName} has duplicate main scenarios`);
  }
  for (const id of mainIds) {
    if (scenarios.get(id)?.owner !== "main") {
      throw new Error(
        `E2E profile ${profileName} references missing or non-main scenario ${id}`,
      );
    }
  }
  const titles = profile.mainMochaTitles;
  if (!titles || typeof titles !== "object" || Array.isArray(titles)) {
    throw new Error(`E2E profile ${profileName} has no main Mocha title map`);
  }
  const titleIds = Object.keys(titles);
  if (
    titleIds.length !== mainIds.length ||
    mainIds.some((id) => typeof titles[id] !== "string" || !titles[id].trim())
  ) {
    throw new Error(
      `E2E profile ${profileName} must map every main scenario to one title`,
    );
  }
  const titleValues = mainIds.map((id) => titles[id]);
  if (new Set(titleValues).size !== titleValues.length) {
    throw new Error(
      `E2E profile ${profileName} has duplicate main Mocha titles`,
    );
  }
  const owners = profile.completeOwners;
  const ownerIds = new Set(Object.keys(manifest.owners ?? {}));
  if (
    !Array.isArray(owners) ||
    owners.length === 0 ||
    new Set(owners).size !== owners.length ||
    owners.some((owner) => owner === "main" || !ownerIds.has(owner))
  ) {
    throw new Error(`E2E profile ${profileName} has invalid complete owners`);
  }
  if (
    !Array.isArray(profile.requiredTools) ||
    profile.requiredTools.some((tool) => typeof tool !== "string" || !tool) ||
    (profileName === "core" &&
      !["ffmpeg", "ffprobe"].every((tool) =>
        profile.requiredTools.includes(tool),
      ))
  ) {
    throw new Error(
      `E2E profile ${profileName} must require FFmpeg and FFprobe`,
    );
  }
  return profile;
}

export function buildCoreRunPlan(manifest = E2E_SUITE_MANIFEST) {
  const profileName = "core";
  const profile = profileDefinition(manifest, profileName);
  const mainScenarioIds = [...profile.mainScenarioIds];
  const selectedMain = new Set(mainScenarioIds);
  const enabledOwners = ["main", ...profile.completeOwners];
  const expectedScenarios = manifest.scenarios
    .filter(
      (scenario) =>
        selectedMain.has(scenario.name) ||
        (scenario.owner !== "main" && enabledOwners.includes(scenario.owner)),
    )
    .map((scenario) => scenario.name);
  return {
    profile: profileName,
    fullSuite: false,
    mainSpecs: "./specs/main.spec.js",
    mainScenarioIds,
    mainMochaTitles: mainScenarioIds.map((scenario) => ({
      scenario,
      title: `ROSI main window ${profile.mainMochaTitles[scenario]}`,
    })),
    expectedScenarios,
    enabledOwners,
    requiredTools: [...profile.requiredTools],
    selectedGroups: [],
    v5AreaNames: [],
  };
}

export function exactMochaTitlePattern(titles) {
  if (!Array.isArray(titles) || titles.length === 0) {
    throw new Error("Mocha title selection needs at least one full title");
  }
  if (titles.some((title) => typeof title !== "string" || title.length === 0)) {
    throw new Error("Mocha title selection contains an empty title");
  }
  const escaped = titles.map((title) =>
    title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return `^(?:${escaped.join("|")})$`;
}

export function coreArtifactPaths({
  root = path.join(REPO_ROOT, "e2e", "artifacts"),
  platform = process.platform,
  arch = process.arch,
  runId,
}) {
  if (typeof runId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error(
      "core E2E run id must contain only letters, numbers, _ or -",
    );
  }
  const hostDirectory = path.join(root, "core", `${platform}-${arch}`);
  const runDir = path.join(hostDirectory, runId);
  return {
    hostDirectory,
    runDir,
    reportPath: path.join(runDir, "report.json"),
    latestReportPath: path.join(hostDirectory, "latest-report.json"),
    screenshotDir: path.join(runDir, "screenshots"),
  };
}
