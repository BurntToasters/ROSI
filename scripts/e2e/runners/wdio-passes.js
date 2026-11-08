// WebdriverIO passes: shared env, per-pass profiles, and the pass builders.
// Each pass is one app launch set; the gate records its outcome and continues.

import fs from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  createE2eProfile,
  e2eBinaryPath,
} from "../../../e2e/helpers/profile.js";
import { sha256 } from "../../../e2e/helpers/media-server.js";
import { seedLegacyV4Data } from "../../../e2e/helpers/legacy-v4.js";
import { ARTIFACT_DIR, npxCommand, runAsync } from "../common.js";
import { companionFfprobe } from "../fixtures.js";
import { round2RendererResultProblems } from "../manifest.js";

export function round2RendererScenario(pass, runnerFailure = null) {
  const scenario = {
    name: "round2-renderer",
    status: "failed",
    reportPath: path
      .relative(REPO_ROOT, pass.resultsPath)
      .split(path.sep)
      .join("/"),
  };
  try {
    const bytes = fs.readFileSync(pass.resultsPath);
    const results = JSON.parse(bytes.toString("utf8"));
    const problems = round2RendererResultProblems(results);
    if (runnerFailure) problems.unshift(runnerFailure);
    if (problems.length > 0) {
      return { ...scenario, reason: problems.join("; ") };
    }
    return {
      ...scenario,
      status: "passed",
      resultsSha256: sha256(bytes),
      observations: results.length,
    };
  } catch (error) {
    return {
      ...scenario,
      reason: runnerFailure
        ? `${runnerFailure}; ${error instanceof Error ? error.message : String(error)}`
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

/**
 * The environment every WebdriverIO pass shares: media server, fixture hashes,
 * TLS fixtures, and DNS maps for the security scenarios.
 */
export function buildSharedWdioEnv({ ffmpeg, server, fixtures }) {
  return {
    // Hardening check: point only the app at a temp dir such as a noexec
    // tmpfs, while the profile stays on an exec-capable filesystem.
    ...(process.env.ROSI_E2E_APP_TMPDIR
      ? { TMPDIR: process.env.ROSI_E2E_APP_TMPDIR }
      : {}),
    ROSI_E2E_BINARY: e2eBinaryPath(),
    ROSI_E2E_MEDIA_URL: server.baseUrl,
    ROSI_E2E_FIXTURES: JSON.stringify(fixtures),
    ROSI_E2E_HAS_FFMPEG: ffmpeg ? "1" : "0",
    ROSI_E2E_FFMPEG: ffmpeg?.binary ?? "",
    ROSI_E2E_TLS_CA: path.join(
      REPO_ROOT,
      "e2e",
      "fixtures",
      "security-test-ca.pem",
    ),
    ROSI_E2E_TLS_CERT: path.join(
      REPO_ROOT,
      "e2e",
      "fixtures",
      "security-test-server.pem",
    ),
    ROSI_E2E_TLS_KEY: path.join(
      REPO_ROOT,
      "e2e",
      "fixtures",
      "security-test-server-key.pem",
    ),
    ROSI_E2E_TLS_UNTRUSTED_CERT: path.join(
      REPO_ROOT,
      "e2e",
      "fixtures",
      "security-untrusted-server.pem",
    ),
    ROSI_E2E_TLS_UNTRUSTED_KEY: path.join(
      REPO_ROOT,
      "e2e",
      "fixtures",
      "security-untrusted-server-key.pem",
    ),
    ROSI_E2E_ALLOW_LOOPBACK: "1",
    ROSI_E2E_FFPROBE: ffmpeg ? (companionFfprobe(ffmpeg.binary) ?? "") : "",
    // Resolve this deterministic E2E-only alias to loopback. The Rust
    // override is compiled only with the `e2e` feature and is never present
    // in production builds.
    ROSI_E2E_DNS_MAP: "private.test=127.0.0.1,rebinding.test=93.184.216.34",
    ROSI_E2E_PROXY_DNS_MAP: "private.test=127.0.0.1,rebinding.test=127.0.0.1",
    ROSI_E2E_PROXY_TRACE: path.join(
      ARTIFACT_DIR,
      "security-release-checks",
      `${process.platform}-${process.arch}`,
      "proxy-decisions.jsonl",
    ),
    ROSI_SECURITY_REPAIR_DIRECTORY: path.join(
      ARTIFACT_DIR,
      "security-release-checks",
      `${process.platform}-${process.arch}`,
    ),
  };
}

async function runWdioPass(pass, env, sharedEnv) {
  return runAsync(npxCommand(), ["wdio", "run", "e2e/wdio.conf.js"], {
    env: {
      ...pass.profile.env,
      ...sharedEnv,
      ROSI_E2E_DOWNLOADS: pass.profile.downloads,
      ROSI_E2E_XDG_DOWNLOADS: pass.profile.xdgDownloads,
      ROSI_E2E_PROFILE: pass.profile.profileDir,
      ROSI_E2E_RESULTS: pass.resultsPath,
      ...env,
    },
  });
}

// Records the pass outcome on the pass object and never throws, so the gate
// runs every later pass and fails once at the end with all results.
export async function runRecordedWdioPass(pass, env, sharedEnv) {
  try {
    await runWdioPass(pass, env, sharedEnv);
    pass.status = "passed";
  } catch (error) {
    pass.status = "failed";
    pass.reason = error instanceof Error ? error.message : String(error);
  }
}

/**
 * Builds the WebdriverIO passes for this run. Ad-hoc and group runs include
 * only their selected owner passes. The main pass is built by the caller.
 */
export function buildWdioPasses({ onlySpec, ownerEnabled, ffmpeg, v5Areas }) {
  // Fresh ROSI 5 profiles with ROSI 4 data beside them, each a separate app
  // launch because the import only runs before the first settings file.
  // Ad-hoc and group runs include only their selected owner passes.
  const legacyPasses =
    onlySpec || !ownerEnabled("legacy-import")
      ? []
      : ["import", "corrupt-settings"].map((legacyCase) => {
          const legacyProfile = createE2eProfile({ seedSettings: false });
          return {
            name: `legacy-import/${legacyCase}`,
            legacyCase,
            profile: legacyProfile,
            status: "pending",
            reason: null,
            seed: seedLegacyV4Data(legacyProfile, {
              corruptSettings: legacyCase === "corrupt-settings",
            }),
            resultsPath: path.join(legacyProfile.profileDir, "results.json"),
          };
        });
  // Security downloads intentionally populate stats/activity and can exercise
  // renderer state that the main UI suite expects to start fresh. Keep the
  // security proof in its own profile while aggregating both result files.
  const securityPass =
    onlySpec || !ownerEnabled("security")
      ? null
      : (() => {
          const securityProfile = createE2eProfile({
            ffmpegPath: ffmpeg?.customPath ?? "",
          });
          return {
            name: "security",
            profile: securityProfile,
            resultsPath: path.join(
              securityProfile.profileDir,
              "security-repairs-results.json",
            ),
            status: "pending",
            reason: null,
          };
        })();
  // State-repair close-failure scenarios deliberately leave native warning
  // dialogs open. Run them in their own profile before the security and main
  // specs, whose final close-flow scenario closes this app window.
  const stateRepairPass =
    onlySpec || !ownerEnabled("state-repairs")
      ? null
      : (() => {
          const stateProfile = createE2eProfile({
            ffmpegPath: ffmpeg?.customPath ?? "",
          });
          return {
            name: "state-repairs",
            profile: stateProfile,
            resultsPath: path.join(
              stateProfile.profileDir,
              "state-repairs-results.json",
            ),
            status: "pending",
            reason: null,
          };
        })();
  const offlineQueuePass =
    onlySpec || !ownerEnabled("offline-queue")
      ? null
      : (() => {
          const offlineProfile = createE2eProfile({
            ffmpegPath: ffmpeg?.customPath ?? "",
          });
          fs.writeFileSync(
            path.join(offlineProfile.dataDir, "download-queue.json"),
            `${JSON.stringify(
              [
                {
                  id: "offline-dns-queue",
                  url: "http://offline-repair.invalid/video.mp4",
                  status: "pending",
                  addedAt: Date.now(),
                  request: null,
                },
              ],
              null,
              2,
            )}\n`,
          );
          return {
            name: "offline-queue",
            profile: offlineProfile,
            resultsPath: path.join(
              offlineProfile.profileDir,
              "offline-queue-results.json",
            ),
            status: "pending",
            reason: null,
          };
        })();
  const round2RendererPass =
    onlySpec || !ownerEnabled("round2-renderer")
      ? null
      : (() => {
          const rendererProfile = createE2eProfile({
            ffmpegPath: ffmpeg?.customPath ?? "",
          });
          const resultsDirectory = path.join(
            ARTIFACT_DIR,
            "round2-renderer",
            `${process.platform}-${process.arch}`,
          );
          fs.mkdirSync(resultsDirectory, { recursive: true });
          const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
          const resultsPath = path.join(resultsDirectory, `${runId}.json`);
          fs.rmSync(resultsPath, { force: true });
          return {
            name: "round2-renderer",
            profile: rendererProfile,
            resultsPath,
            status: "pending",
            reason: null,
          };
        })();
  // Each e2e/v5-fixes/<area>/ with *.spec.js and no run.mjs gets its own fresh
  // profile. Areas that skip or focus tests fail before WebdriverIO starts.
  // Runner-owned areas (run.mjs) get no generic wdio pass; the runner drives
  // their specs.
  const v5Passes = v5Areas
    .filter((area) => area.specs.length > 0 && !area.runner)
    .map((area) => {
      const profile = createE2eProfile({
        ffmpegPath: ffmpeg?.customPath ?? "",
      });
      return {
        name: `v5-fixes/${area.area}`,
        area,
        profile,
        resultsPath: path.join(profile.profileDir, "results.json"),
        status: "pending",
        reason: null,
      };
    });
  return {
    legacyPasses,
    offlineQueuePass,
    stateRepairPass,
    securityPass,
    round2RendererPass,
    v5Passes,
  };
}
