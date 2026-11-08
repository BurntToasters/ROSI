// E2E gate orchestrator: builds the binary, runs the WebdriverIO passes and the
// runner-owned suites, verifies the evidence, and writes the gate report.
// Modules: scripts/e2e/ (manifest, common, build, fixtures, runners/*, stability).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  REPO_ROOT,
  createE2eProfile,
  e2eBinaryPath,
} from "../e2e/helpers/profile.js";
import { sha256, startMediaServer } from "../e2e/helpers/media-server.js";
import {
  LEGACY_IMPORT_FAILURE_MODES,
  seedLegacyV4Data,
} from "../e2e/helpers/legacy-v4.js";
import {
  ARTIFACT_DIR,
  cleanupProfile,
  e2eBackgroundValue,
  gitCommit,
  gitSourceTree,
  relativeToRepo,
  which,
} from "./e2e/common.js";
import {
  buildE2eBinary,
  e2eBinaryIsFresh,
  mayReuseE2eBinary,
} from "./e2e/build.js";
import {
  buildMediaRoutes,
  companionFfprobe,
  resolveTestFfmpeg,
} from "./e2e/fixtures.js";
import {
  buildCoreRunPlan,
  coreArtifactPaths,
  createE2eRunId,
  parseE2eProfile,
} from "./e2e/core.js";
import {
  e2eOnlySpec,
  e2eRunPlan,
  groupedScenarioResults,
  onlyRunScenarioProblems,
  parseE2eGroups,
  scenarioOutcomeProblems,
  verifyScreenshots,
} from "./e2e/manifest.js";
import {
  buildSharedWdioEnv,
  buildWdioPasses,
  round2RendererScenario,
  runRecordedWdioPass,
} from "./e2e/runners/wdio-passes.js";
import {
  runAudit4Repairs,
  runDownloadProcessRepairs,
  runLongTermPersistenceRepairs,
  runRound2NativeRepairs,
} from "./e2e/runners/native.js";
import { runAuditV5Probes } from "./e2e/runners/probes.js";
import { runRound3Renderer } from "./e2e/runners/renderer-dom-checks.js";
import {
  discoverV5Fixes,
  runV5FixesRunner,
  v5AreaScenario,
} from "./e2e/runners/v5-fixes.js";
import { parseRepeat, runStability } from "./e2e/stability.js";

// Public names other scripts and tests import from this module.
export {
  ALLOWED_E2E_SKIPS,
  E2E_SUITE_MANIFEST,
  EXPECTED_SCENARIOS,
  ROUND2_NATIVE_OBSERVATIONS,
  ROUND2_RENDERER_OBSERVATIONS,
  SCREENSHOT_SCENARIO_NAMES,
  e2eOnlySpec,
  e2eRunPlan,
  isV5FixesSpec,
  onlyRunScenarioProblems,
  parseE2eGroups,
  round2RendererResultProblems,
  scenarioOutcomeProblems,
} from "./e2e/manifest.js";
export { e2eBackgroundValue, reportSelfHashMatches } from "./e2e/common.js";
export { buildE2eBinary, mayReuseE2eBinary } from "./e2e/build.js";
export { round2NativeReportProblems } from "./e2e/runners/native.js";
export { discoverV5Fixes, findRunnerReport } from "./e2e/runners/v5-fixes.js";
export { parseRepeat, summarizeStability } from "./e2e/stability.js";

function needsXvfb() {
  return (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  );
}

function reexecUnderXvfb() {
  if (process.env.ROSI_E2E_XVFB === "1") return false;
  if (!needsXvfb()) return false;
  if (!which("xvfb-run")) {
    throw new Error(
      "Linux E2E needs a display. Install xvfb with `sudo apt install -y xvfb` (also in npm run setup:deb), or set DISPLAY.",
    );
  }
  const result = spawnSync(
    "xvfb-run",
    [
      "-a",
      process.execPath,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ROSI_E2E_XVFB: "1" },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

function writeEvidence(report, { corePaths = null } = {}) {
  fs.mkdirSync(corePaths?.hostDirectory ?? ARTIFACT_DIR, { recursive: true });
  const body = { ...report };
  const canonical = JSON.stringify(body, null, 2);
  body.reportSha256 = crypto
    .createHash("sha256")
    .update(canonical)
    .digest("hex");
  const file = corePaths
    ? corePaths.reportPath
    : path.join(
        ARTIFACT_DIR,
        `e2e-report-${process.platform}-${process.arch}.json`,
      );
  const contents = `${JSON.stringify(body, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  if (corePaths) {
    const temporaryLatest = `${corePaths.latestReportPath}.${body.runId}.tmp`;
    fs.writeFileSync(temporaryLatest, contents);
    fs.rmSync(corePaths.latestReportPath, { force: true });
    fs.renameSync(temporaryLatest, corePaths.latestReportPath);
    console.log(
      `Core E2E evidence written to ${path.relative(REPO_ROOT, file)} (latest: ${path.relative(REPO_ROOT, corePaths.latestReportPath)})`,
    );
  } else {
    console.log(`E2E evidence written to ${path.relative(REPO_ROOT, file)}`);
  }
  return file;
}

function createTimingState() {
  return { started: process.hrtime.bigint(), stages: [], printed: false };
}

function timingFailed(value) {
  if (Array.isArray(value)) return value.some(timingFailed);
  return value?.status === "failed";
}

async function timedStage(timing, name, action) {
  const started = process.hrtime.bigint();
  let status = "passed";
  try {
    const value = await action();
    if (timingFailed(value)) status = "failed";
    return value;
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    timing.stages.push({
      name,
      durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      status,
    });
  }
}

function timingReport(timing) {
  return {
    totalMs: Number(process.hrtime.bigint() - timing.started) / 1_000_000,
    stages: timing.stages.map((stage) => ({
      ...stage,
      durationMs: Math.round(stage.durationMs * 10) / 10,
    })),
  };
}

function printTimingSummary(timing, error = null) {
  if (timing.printed) return;
  const report = timingReport(timing);
  const slowest = [...report.stages]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 5)
    .map(
      ({ name, durationMs, status }) =>
        `${name}=${(durationMs / 1000).toFixed(1)}s${status === "failed" ? " (failed)" : ""}`,
    );
  console.log(
    `E2E timing: total ${(report.totalMs / 1000).toFixed(1)}s; slowest stages: ${slowest.join(", ") || "none completed"}${error ? "; invocation failed" : ""}`,
  );
  timing.printed = true;
}

async function main(options = {}) {
  const timing = createTimingState();
  try {
    return await runE2e(timing, options);
  } catch (error) {
    printTimingSummary(timing, error);
    throw error;
  }
}

async function runE2e(timing, options = {}) {
  const profileName = parseE2eProfile(process.argv.slice(2), process.env);
  if (process.env.SKIP_E2E === "1") {
    throw new Error(
      "SKIP_E2E=1 is not allowed. Unset it and run the unpackaged WebdriverIO suite.",
    );
  }
  const onlySpec = e2eOnlySpec(process.env.ROSI_E2E_ONLY);
  const selectedGroups = parseE2eGroups(process.argv.slice(2), process.env);
  const runId =
    options.runId ?? (process.env.ROSI_E2E_RUN_ID?.trim() || createE2eRunId());
  const corePaths = profileName ? coreArtifactPaths({ runId }) : null;
  const availableV5Areas = onlySpec || profileName ? [] : discoverV5Fixes();
  const runPlan = profileName
    ? buildCoreRunPlan()
    : e2eRunPlan({
        onlySpec,
        selectedGroups,
        v5AreaNames: availableV5Areas.map((area) => area.area),
      });
  const v5Areas = availableV5Areas.filter((area) =>
    runPlan.v5AreaNames.includes(area.area),
  );
  const ownerEnabled = (owner) =>
    runPlan.fullSuite || runPlan.enabledOwners.includes(owner);
  // Set before any launch so every pass, runner and probe inherits it.
  const background = e2eBackgroundValue({
    env: process.env,
    platform: process.platform,
  });
  if (background !== null) process.env.ROSI_E2E_BACKGROUND = background;
  reexecUnderXvfb();
  const startedAt = new Date().toISOString();
  // The full suite is release evidence and must always run against a freshly
  // compiled binary. Reuse is limited to an explicitly selected ad-hoc spec.
  const reuseRequested = process.env.ROSI_E2E_REUSE === "1";
  await timedStage(timing, "build", () => {
    const reuse = mayReuseE2eBinary({
      onlySpec: Boolean(onlySpec) && selectedGroups.length === 0,
      reuseRequested,
      binaryFresh: !reuseRequested || e2eBinaryIsFresh(),
    });
    if (!reuse) buildE2eBinary();
    return { reusedBinary: reuse };
  });

  let ffmpeg;
  let ffprobe;
  let fixtures;
  let profile;
  let server;
  let screenshotDir;
  let sharedEnv;
  try {
    await timedStage(timing, "fixtures", async () => {
      ffmpeg = resolveTestFfmpeg();
      if (!ffmpeg && runPlan.requiredTools?.includes("ffmpeg")) {
        throw new Error("Core E2E requires a working FFmpeg executable");
      }
      if (runPlan.requiredTools?.includes("ffprobe")) {
        ffprobe = companionFfprobe(ffmpeg.binary) ?? which("ffprobe");
        if (!ffprobe || !fs.existsSync(ffprobe)) {
          throw new Error("Core E2E requires a working FFprobe executable");
        }
        const probe = spawnSync(ffprobe, ["-version"], {
          encoding: "utf8",
          windowsHide: true,
        });
        if (probe.status !== 0) {
          throw new Error(
            `Core E2E could not run FFprobe: ${probe.stderr || probe.error?.message || "unknown error"}`,
          );
        }
      } else {
        ffprobe = ffmpeg
          ? (companionFfprobe(ffmpeg.binary) ?? undefined)
          : undefined;
      }
      if (!ffmpeg && process.env.ROSI_E2E_REQUIRE_FFMPEG === "1") {
        throw new Error(
          "ROSI_E2E_REQUIRE_FFMPEG=1 but no FFmpeg was found (bundled, ROSI_E2E_FFMPEG, or PATH).",
        );
      }
      screenshotDir = corePaths
        ? corePaths.screenshotDir
        : path.join(
            ARTIFACT_DIR,
            "screenshots",
            `${process.platform}-${process.arch}`,
          );
      // Full-run screenshots start empty; core paths are unique per invocation.
      if (!corePaths) {
        fs.rmSync(screenshotDir, { recursive: true, force: true });
      }
      fs.mkdirSync(screenshotDir, { recursive: true });
      profile = createE2eProfile({ ffmpegPath: ffmpeg?.customPath ?? "" });
      const fixtureDir = path.join(profile.profileDir, "fixtures");
      fs.mkdirSync(fixtureDir, { recursive: true });
      const builtFixtures = buildMediaRoutes({ ffmpeg, fixtureDir });
      fixtures = builtFixtures.fixtures;
      server = await startMediaServer(builtFixtures.routes);
      sharedEnv = buildSharedWdioEnv({ ffmpeg, ffprobe, server, fixtures });
      if (ownerEnabled("security")) {
        fs.rmSync(sharedEnv.ROSI_E2E_PROXY_TRACE, { force: true });
      }
      return { fixtureCount: Object.keys(fixtures).length };
    });
  } catch (error) {
    await server?.close();
    throw error;
  }
  const runRecordedPass = (pass, env) =>
    timedStage(timing, `wdio:${pass.name}`, async () => {
      await runRecordedWdioPass(pass, env, sharedEnv);
      return pass;
    });

  const mainPass = {
    name: "main",
    profile,
    // The main profile already has ROSI 5 settings, so this ROSI 4 folder
    // must be ignored.
    seed: seedLegacyV4Data(profile),
    resultsPath: path.join(profile.profileDir, "results.json"),
    stateRepairResultsPath: path.join(
      profile.profileDir,
      "state-repairs-results.json",
    ),
    status: "pending",
    reason: null,
  };

  const {
    legacyPasses,
    offlineQueuePass,
    stateRepairPass,
    securityPass,
    round2RendererPass,
    v5Passes,
  } = buildWdioPasses({ onlySpec, ownerEnabled, ffmpeg, v5Areas });

  let round2RendererFailure = null;
  let failure = null;
  try {
    for (const pass of legacyPasses) {
      await runRecordedPass(pass, {
        ROSI_E2E_SPECS: "./specs/legacy-import.spec.js",
        ROSI_E2E_LEGACY_CASE: pass.legacyCase,
        ROSI_E2E_LEGACY_V4: JSON.stringify(pass.seed),
      });
    }
    if (offlineQueuePass) {
      await runRecordedPass(offlineQueuePass, {
        ROSI_E2E_SPECS: "./specs/security-release-offline-queue.spec.js",
        ROSI_OFFLINE_QUEUE_RESULTS: path.join(
          offlineQueuePass.profile.profileDir,
          "offline-queue-results.json",
        ),
      });
    }
    if (stateRepairPass) {
      await runRecordedPass(stateRepairPass, {
        ROSI_E2E_SPECS: "./state-updater.spec.js",
        ROSI_STATE_REPAIR_RESULTS: stateRepairPass.resultsPath,
      });
    }
    if (securityPass) {
      await runRecordedPass(securityPass, {
        ROSI_E2E_SPECS: "./specs/security-release-checks.spec.js",
        ROSI_SECURITY_REPAIR_RESULTS: securityPass.resultsPath,
      });
    }
    if (round2RendererPass) {
      await runRecordedPass(round2RendererPass, {
        ROSI_E2E_SPECS: "./renderer-updates.spec.js",
        ROSI_ROUND2_RENDERER_RESULTS: round2RendererPass.resultsPath,
      });
      // round2-renderer reports this failure through its scenario below.
      if (round2RendererPass.status === "failed") {
        round2RendererFailure = round2RendererPass.reason;
      }
    }
    for (const pass of v5Passes) {
      // Skip-marker areas are reported as failed by v5AreaScenario.
      if (pass.area.skipFiles.length > 0) continue;
      await runRecordedPass(pass, {
        ROSI_E2E_SPECS: pass.area.specs
          .map((spec) => `./v5-fixes/${pass.area.area}/${spec}`)
          .join(","),
        // Specs that record screenshots write into the gate's folder, so the
        // gate can re-hash them with the rest of the report.
        ROSI_E2E_SCREENSHOTS: screenshotDir,
      });
    }
    if (onlySpec || ownerEnabled("main")) {
      await runRecordedPass(mainPass, {
        // ROSI_E2E_ONLY runs a single ad-hoc spec while debugging; the full
        // gate always runs main.spec.js and requires every scenario.
        ROSI_E2E_SPECS: runPlan.mainSpecs,
        // Preserve this path for ROSI_E2E_ONLY debugging when the selected spec
        // is the state-repair suite. The full gate uses the isolated pass above.
        ROSI_STATE_REPAIR_RESULTS: mainPass.stateRepairResultsPath,
        ROSI_E2E_LEGACY_V4: JSON.stringify(mainPass.seed),
        ROSI_E2E_SCREENSHOTS: screenshotDir,
        ...(runPlan.mainMochaTitles
          ? {
              ROSI_E2E_MOCHA_TITLES: JSON.stringify(
                runPlan.mainMochaTitles.map((entry) => entry.title),
              ),
            }
          : {}),
      });
    }
  } catch (error) {
    // Only an error outside the pass runs reaches here.
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    await server?.close();
  }
  // Every WebdriverIO pass that failed is part of the gate failure. Round2 and
  // v5-fixes passes are not listed here: their failed scenarios below carry
  // the same reason, so listing them twice would only repeat the message.
  const wdioPasses = [
    ...legacyPasses,
    offlineQueuePass,
    stateRepairPass,
    securityPass,
    round2RendererPass,
    ...v5Passes,
    mainPass,
  ].filter(Boolean);
  for (const pass of [
    ...legacyPasses,
    offlineQueuePass,
    stateRepairPass,
    securityPass,
    mainPass,
  ].filter(Boolean)) {
    if (pass.status !== "failed") continue;
    const detail = `${pass.name}: ${pass.reason}`;
    failure = failure ? `${failure}; ${detail}` : detail;
  }

  // Both specs share one isolated wrapper, which is the only code that starts
  // WebdriverIO with the process-level probe fixtures.
  const processRepairScenarios =
    onlySpec || !ownerEnabled("process-repairs")
      ? []
      : [
          await timedStage(timing, "runner:download-process-repairs", () =>
            runDownloadProcessRepairs({
              ffmpeg,
              binary: e2eBinaryPath(),
              suiteStartedAt: startedAt,
            }),
          ),
          await timedStage(timing, "runner:audit3-native-targeted", () =>
            runDownloadProcessRepairs({
              ffmpeg,
              binary: e2eBinaryPath(),
              suiteStartedAt: startedAt,
              name: "audit3-native-targeted",
              spec: "./download-process-targeted.spec.js",
            }),
          ),
        ];
  const round2NativeScenarios =
    onlySpec || !ownerEnabled("round2-native")
      ? []
      : [
          await timedStage(timing, "runner:round2-native", () =>
            runRound2NativeRepairs({
              ffmpeg,
              binary: e2eBinaryPath(),
              suiteStartedAt: startedAt,
            }),
          ),
        ];
  const round2RendererScenarios = round2RendererPass
    ? [round2RendererScenario(round2RendererPass, round2RendererFailure)]
    : [];
  const persistenceScenarios =
    onlySpec || !ownerEnabled("persistence")
      ? []
      : [
          await timedStage(timing, "runner:long-term-persistence", () =>
            runLongTermPersistenceRepairs(),
          ),
        ];
  const binary = e2eBinaryPath();
  const auditScenarios = [];
  if (!onlySpec && ownerEnabled("audit4-repairs")) {
    auditScenarios.push(
      await timedStage(timing, "runner:audit4-repairs", () =>
        runAudit4Repairs({ ffmpeg, binary, suiteStartedAt: startedAt }),
      ),
    );
  }
  if (!onlySpec && ownerEnabled("audit-v5-beta2")) {
    auditScenarios.push(
      await timedStage(timing, "runner:audit-v5-beta2", () =>
        runAuditV5Probes({ ffmpeg, binary, suiteStartedAt: startedAt }),
      ),
    );
  }
  if (!onlySpec && ownerEnabled("round3-renderer")) {
    auditScenarios.push(
      await timedStage(timing, "runner:round3-renderer", () =>
        runRound3Renderer({
          snapshotPath: corePaths
            ? path.join(corePaths.runDir, "renderer-dom-checks.json")
            : null,
        }),
      ),
    );
  }
  if (!onlySpec && ownerEnabled("v5-fixes")) {
    for (const area of v5Areas) {
      const pass = v5Passes.find((candidate) => candidate.area === area);
      const scenario = area.runner
        ? await timedStage(timing, `runner:v5-fixes/${area.area}`, () => {
            const runnerResult = runV5FixesRunner(area, binary, ffmpeg);
            return v5AreaScenario(
              area,
              pass,
              runnerResult,
              Date.parse(startedAt),
            );
          })
        : v5AreaScenario(area, pass, null, Date.parse(startedAt));
      auditScenarios.push(scenario);
    }
  }
  const gateScenarios = [
    ...round2RendererScenarios,
    ...processRepairScenarios,
    ...round2NativeScenarios,
    ...persistenceScenarios,
    ...auditScenarios,
  ];
  for (const scenario of gateScenarios) {
    if (scenario.status === "failed") {
      const detail = `${scenario.name}: ${scenario.reason}`;
      failure = failure ? `${failure}; ${detail}` : detail;
    }
  }
  // Full gate: every suite in EXPECTED_SCENARIOS, plus each discovered v5-fixes
  // area, must report exactly once. ROSI_E2E_ONLY expects none by name.
  const { expectedScenarios, fullSuite } = runPlan;

  const readResults = (file) =>
    fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  const readLogTail = (pass, lines) => {
    const file = path.join(pass.profile.dataDir, "logs", "rosi.log");
    return fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-lines)
      : [];
  };
  const scenarios = [
    ...legacyPasses,
    ...(offlineQueuePass ? [offlineQueuePass] : []),
    ...(stateRepairPass ? [stateRepairPass] : []),
    ...(securityPass ? [securityPass] : []),
    ...(onlySpec || ownerEnabled("main") ? [mainPass] : []),
  ].flatMap((pass) => [
    ...readResults(pass.resultsPath),
    ...(pass === mainPass && !stateRepairPass
      ? readResults(pass.stateRepairResultsPath)
      : []),
  ]);
  scenarios.push(...gateScenarios);
  const seen = new Set(scenarios.map((scenario) => scenario.name));
  const missing = expectedScenarios.filter((name) => !seen.has(name));
  const legacyImportCoverage = Object.fromEntries(
    Object.entries(LEGACY_IMPORT_FAILURE_MODES).map(([id, description]) => [
      id,
      {
        description,
        coveredBy: scenarios
          .filter((scenario) => scenario.covers?.includes(id))
          .map((scenario) => scenario.name),
      },
    ]),
  );
  const checksLegacyImportCoverage =
    fullSuite || runPlan.enabledOwners.includes("legacy-import");
  const uncovered = checksLegacyImportCoverage
    ? Object.entries(legacyImportCoverage)
        .filter(([, mode]) => mode.coveredBy.length === 0)
        .map(([id]) => id)
    : [];
  const { screenshots, problems: screenshotProblems } = verifyScreenshots(
    scenarios,
    screenshotDir,
  );
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  const scenarioProblems =
    fullSuite || selectedGroups.length > 0 || profileName !== null
      ? scenarioOutcomeProblems(scenarios, process.platform, expectedScenarios)
      : onlyRunScenarioProblems({
          onlySpec,
          scenarios,
          platform: process.platform,
        });
  const legacyPassLogTails = Object.fromEntries(
    legacyPasses.map((pass) => [pass.legacyCase, readLogTail(pass, 15)]),
  );
  const appLogTail = readLogTail(mainPass, 40);
  await timedStage(timing, "cleanup:profiles", () => {
    for (const pass of wdioPasses) {
      cleanupProfile(pass.profile.profileDir);
    }
    return {};
  });
  const evidence = writeEvidence(
    {
      app: "ROSI",
      fullSuite,
      runId,
      ...(profileName ? { profile: profileName } : {}),
      ...(corePaths
        ? {
            runDirectory: relativeToRepo(corePaths.runDir),
            reportPath: relativeToRepo(corePaths.reportPath),
          }
        : {}),
      // Present only on partial runs, so full-gate evidence keeps its shape.
      ...(onlySpec ? { onlySpec } : {}),
      ...(selectedGroups.length > 0
        ? {
            selectedGroups,
            selectedOwners: runPlan.enabledOwners,
          }
        : {}),
      expectedScenarios,
      version: packageJson.version,
      commit: gitCommit(),
      sourceTree: gitSourceTree(),
      packageLockSha256: sha256(
        fs.readFileSync(path.join(REPO_ROOT, "package-lock.json")),
      ),
      cargoLockSha256: sha256(
        fs.readFileSync(path.join(REPO_ROOT, "src-tauri", "Cargo.lock")),
      ),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      binarySha256: sha256(fs.readFileSync(e2eBinaryPath())),
      startedAt,
      ...(runPlan.requiredTools
        ? { requiredTools: runPlan.requiredTools }
        : {}),
      ffmpeg: ffmpeg
        ? { source: ffmpeg.source, binary: path.basename(ffmpeg.binary) }
        : null,
      ...(profileName === "core"
        ? { ffprobe: { binary: path.basename(ffprobe) } }
        : {}),
      appTmpdir: process.env.ROSI_E2E_APP_TMPDIR || null,
      fixtures,
      scenarios,
      // Each WebdriverIO pass that ran, with its own outcome. Scenario results
      // above come from the pass results files, so a failed pass still reports
      // whatever scenarios it wrote.
      wdioPasses: wdioPasses
        .filter((pass) => pass.status !== "pending")
        .map(({ name, status, reason }) => ({ name, status, reason })),
      scenarioGroups: groupedScenarioResults(scenarios, expectedScenarios),
      missingScenarios: missing,
      scenarioProblems,
      legacyImportCoverage,
      uncoveredLegacyImportFailureModes: uncovered,
      screenshots,
      screenshotProblems,
      failure,
      passed:
        !failure &&
        missing.length === 0 &&
        scenarioProblems.length === 0 &&
        uncovered.length === 0 &&
        screenshotProblems.length === 0,
      mediaRequests: server.requests.length,
      legacyPassLogTails,
      appLogTail,
      finishedAt: new Date().toISOString(),
      timings: timingReport(timing),
    },
    { corePaths },
  );
  printTimingSummary(
    timing,
    failure ||
      missing.length > 0 ||
      scenarioProblems.length > 0 ||
      uncovered.length > 0 ||
      screenshotProblems.length > 0
      ? new Error("E2E validation failed")
      : null,
  );
  if (failure) throw new Error(`${failure} (evidence: ${evidence})`);
  if (missing.length > 0) {
    throw new Error(
      `E2E scenarios did not report: ${missing.join(", ")} (evidence: ${evidence})`,
    );
  }
  if (scenarioProblems.length > 0) {
    throw new Error(
      `E2E scenario outcomes are incomplete or unsuccessful: ${scenarioProblems.join(", ")} (evidence: ${evidence})`,
    );
  }
  if (uncovered.length > 0) {
    throw new Error(
      `ROSI 4 import failure modes without a covering scenario: ${uncovered.join(", ")} (evidence: ${evidence})`,
    );
  }
  if (screenshotProblems.length > 0) {
    throw new Error(
      `Screenshot evidence is inconsistent: ${screenshotProblems.join(", ")} (evidence: ${evidence})`,
    );
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  Promise.resolve()
    .then(() => {
      const times = parseRepeat(process.argv.slice(2));
      const profile = parseE2eProfile(process.argv.slice(2), process.env);
      return times > 1 ? runStability(times, main, { profile }) : main();
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
