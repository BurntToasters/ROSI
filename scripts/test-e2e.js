import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  REPO_ROOT,
  createE2eProfile,
  e2eBinaryPath,
  e2eStampPath,
} from "../e2e/helpers/profile.js";
import {
  deterministicBytes,
  sha256,
  startMediaServer,
} from "../e2e/helpers/media-server.js";
import {
  LEGACY_IMPORT_FAILURE_MODES,
  seedLegacyV4Data,
} from "../e2e/helpers/legacy-v4.js";

import { usesWindowsCmdShell } from "./npm-safe-update.mjs";

const ARTIFACT_DIR = path.join(REPO_ROOT, "e2e", "artifacts");
export const EXPECTED_SCENARIOS = [
  "legacy-v4-import",
  "legacy-v4-corrupt-settings",
  "launch",
  "legacy-v4-preserve",
  "settings-sidebar",
  "settings-persistence",
  "download-profiles",
  "settings-layout",
  "flat-ui-tokens",
  "window-theme",
  "no-overscroll",
  "sidebar-glass",
  "url-safety",
  "loopback-exception-and-thumbnail-data",
  "loopback-download",
  "proxy-delayed-http-response",
  "proxy-cancels-streamed-response",
  "private-dns-alias",
  "dns-rebinding-connection-time",
  "redirect-and-extractor-handoffs",
  "verified-https-connect-proxy",
  "untrusted-https-certificate-rejected",
  "credential-bearing-urls",
  "guarded-hls-fragments",
  "bracketed-ipv6-classification",
  "proxy-cancellation-closes-active-sockets",
  "thumbnail-fetch-cancellation",
  "dns-cancellation-reserved-ipc",
  "proxy-rejects-unreviewed-pipelined-destination",
  "bounded-dns-cancellation",
  "persisted-offline-queue",
  "manual-download",
  "unicode-download",
  "queue",
  "cancel",
  "conversion",
  "audio-extract",
  "gpu-detect",
  "licenses",
  "navigation-guard",
  "preview",
  "formats",
  "merge-download",
  "queue-management",
  "queue-cancel",
  "dock-tabs",
  "webview-guard",
  "link-drop",
  "small-window",
  "dock-empty",
  "save-path",
  "lucide-icons",
  "status-icons",
  "console-log",
  "activity-actions",
  "activity-action-clicks",
  "theme-contrast",
  "setup-wizard",
  "setup-wizard-skip",
  "setup-wizard-escape",
  "setup-wizard-small",
  "setup-wizard-deno",
  "browser-choice",
  "xdg-download-dir",
  "ui-screenshots",
  "stats",
  "settings-search-reset",
  "settings-controls",
  "settings-reset-all",
  "settings-response-revision",
  "settings-lifecycle-latest-revision",
  "settings-captured-wizard-deno",
  "compatible-profile-wording",
  "guarded-preview-thumbnail",
  "queue-latest-snapshot",
  "updater-generation-retry",
  "queue-flush-backup-failure",
  "close-pending-timeout",
  "download-session-isolation",
  "external-links",
  "menu-actions",
  "update-check",
  "dialogs",
  "download-card-input",
  "presets",
  "custom-formats",
  "playlist-range",
  "embed-extras",
  "queue-controls",
  "save-location",
  "notifications",
  "download-again-quickly",
  "download-process-repairs",
  "activity-clear",
  "close-flow",
  "round2-renderer",
  "round2-native",
  "long-term-persistence",
];
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
export const ALLOWED_E2E_SKIPS = Object.freeze({
  "download-process-repairs": Object.freeze(["win32"]),
  "xdg-download-dir": Object.freeze(["darwin", "win32"]),
});

export function scenarioOutcomeProblems(scenarios, platform) {
  const problems = [];
  const names = scenarios.map((scenario) => scenario?.name);
  for (const name of EXPECTED_SCENARIOS) {
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
    if (!EXPECTED_SCENARIOS.includes(name)) {
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

export function round2NativeReportProblems(report, expected) {
  const problems = [];
  if (!report || typeof report !== "object") {
    return ["native report is not an object"];
  }
  const suite = report.suite ?? report.scenario;
  if (report.app !== "ROSI")
    problems.push("native report app identity differs");
  if (report.schemaVersion !== undefined && report.schemaVersion !== 1) {
    problems.push("native report schema version is unsupported");
  }
  if (suite !== "round2-native") {
    problems.push("native report suite identity differs");
  }
  if (typeof report.runId !== "string" || report.runId.length === 0) {
    problems.push("native report run id is missing");
  }
  if (report.version !== expected.version) {
    problems.push("native report version differs");
  }
  if (report.platform !== expected.platform || report.arch !== expected.arch) {
    problems.push("native report host identity differs");
  }
  if (report.binary !== expected.binary) {
    problems.push("native report E2E binary path differs");
  }
  if (report.binarySha256 !== expected.binarySha256) {
    problems.push("native report E2E binary hash differs");
  }
  if (report.ffmpegSha256 !== expected.ffmpegSha256) {
    problems.push("native report FFmpeg hash differs");
  }
  const sourceHashes = report.probeSources ?? report.sourceHashes;
  for (const [file, hash] of Object.entries(expected.probeSources)) {
    if (sourceHashes?.[file] !== hash) {
      problems.push(`native report source hash differs for ${file}`);
    }
  }
  if (
    !/^[a-f0-9]{64}$/i.test(
      report.toneFixtureSha256 ?? report.fixtureHash ?? "",
    )
  ) {
    problems.push("native report tone fixture hash is missing or malformed");
  }
  if (typeof report.isolatedProfile !== "string" || !report.isolatedProfile) {
    problems.push("native report isolated profile is missing");
  }
  const startedAt = Date.parse(report.startedAt);
  const finishedAt = Date.parse(report.finishedAt);
  const suiteStartedAt = Date.parse(expected.suiteStartedAt);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    !Number.isFinite(suiteStartedAt) ||
    startedAt < suiteStartedAt ||
    finishedAt < startedAt
  ) {
    problems.push("native report timestamps are stale or invalid");
  }
  if (report.wdioExitCode !== 0 || report.wdioError) {
    problems.push("native WebdriverIO run did not pass");
  }
  if (report.passed !== true) problems.push("native report does not pass");
  if (!Array.isArray(report.failures) || report.failures.length > 0) {
    problems.push("native report lists failed observations");
  }
  if (!Array.isArray(report.observations)) {
    problems.push("native observations are not an array");
  } else {
    const names = report.observations.map((observation) => observation?.name);
    for (const name of ROUND2_NATIVE_OBSERVATIONS) {
      const matches = report.observations.filter(
        (observation) => observation?.name === name,
      );
      if (matches.length !== 1) {
        problems.push(`${name} reported ${matches.length} times`);
        continue;
      }
      const passed = matches[0].passed ?? matches[0].invariantPassed;
      if (passed !== true) {
        problems.push(`${name} did not pass`);
      }
      if (
        name === "windows-job-object-leader-exit" &&
        matches[0].skipped !== true
      ) {
        problems.push(`${name} must remain explicitly unproven`);
      }
      if (matches[0].skipped === true) {
        const supportedWindowsSkip =
          expected.platform === "win32" &&
          [
            "source-identity-preserves-replacement",
            "deno-version-probe",
          ].includes(name) &&
          typeof matches[0].skipReason === "string" &&
          matches[0].skipReason.length > 0;
        const documentedLeaderExitGap =
          name === "windows-job-object-leader-exit" &&
          typeof matches[0].skipReason === "string" &&
          matches[0].skipReason.length > 0;
        if (!supportedWindowsSkip && !documentedLeaderExitGap) {
          problems.push(`${name} has an unsupported platform skip`);
        }
      }
    }
    for (const name of names) {
      if (!ROUND2_NATIVE_OBSERVATIONS.includes(name)) {
        problems.push(`unexpected native observation ${name}`);
      }
    }
  }
  const { reportSha256, ...reportBody } = report;
  const actualReportSha256 = sha256(
    Buffer.from(JSON.stringify(reportBody, null, 2)),
  );
  if (reportSha256 !== actualReportSha256) {
    problems.push("native report self-hash differs");
  }
  return problems;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function e2eChildEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // Cursor/CI helper envs must not redirect the e2e binary away from
  // src-tauri/target/debug, where the stamp and WDIO launcher look.
  delete env.CARGO_TARGET_DIR;
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: e2eChildEnv(options.env),
    stdio: "inherit",
    windowsHide: true,
    encoding: "utf8",
    shell: usesWindowsCmdShell(command),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}`,
    );
  }
}

/**
 * Asynchronous variant for WebdriverIO: the in-process media server must keep
 * serving while the app downloads, so the event loop cannot be blocked.
 */
function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: e2eChildEnv(options.env),
      stdio: "inherit",
      windowsHide: true,
      shell: usesWindowsCmdShell(command),
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${code ?? signal}`,
          ),
        );
    });
  });
}

function which(bin) {
  const result = spawnSync(
    process.platform === "win32" ? "where" : "which",
    [bin],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null;
}

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

const STAMP = "e2e-feature-1\n";

function e2eBinaryIsFresh() {
  const binary = e2eBinaryPath();
  const stamp = e2eStampPath();
  if (!fs.existsSync(binary) || !fs.existsSync(stamp)) return false;
  if (fs.readFileSync(stamp, "utf8") !== STAMP) return false;
  // cargo test / clippy rebuild target/debug/rosi without --features e2e.
  return fs.statSync(stamp).mtimeMs >= fs.statSync(binary).mtimeMs;
}

export function mayReuseE2eBinary({ onlySpec, reuseRequested, binaryFresh }) {
  return onlySpec === true && reuseRequested === true && binaryFresh === true;
}

function snapshotGeneratedSchemas() {
  const schemaDir = path.join(REPO_ROOT, "src-tauri", "gen", "schemas");
  if (!fs.existsSync(schemaDir)) return [];
  return fs
    .readdirSync(schemaDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(schemaDir, entry.name);
      return [file, fs.readFileSync(file)];
    });
}

function restoreGeneratedSchemas(snapshots) {
  for (const [file, contents] of snapshots) {
    fs.writeFileSync(file, contents);
  }
}

export function buildE2eBinary() {
  // Development stubs are acceptable: E2E uses a debug build and supplies a
  // real FFmpeg through the custom-path setting when one is available.
  run(npmCommand(), ["run", "prepare:rust-tests"]);
  // The licenses scenario renders these git-ignored notices; release builds
  // generate them in build:*, so a fresh checkout or CI runner has none yet.
  run(npmCommand(), ["run", "licenses"]);
  const schemaSnapshots = snapshotGeneratedSchemas();
  try {
    run(npxCommand(), [
      "tauri",
      "build",
      "--debug",
      "--no-bundle",
      "--config",
      path.join(REPO_ROOT, "src-tauri", "tauri.e2e.conf.json"),
      "--",
      "--features",
      "e2e",
    ]);
  } finally {
    // Tauri writes feature-dependent ACL schemas into this tracked directory.
    // An E2E build must not dirty a clean release checkout with test-only ACLs.
    restoreGeneratedSchemas(schemaSnapshots);
  }
  const binary = e2eBinaryPath();
  if (!fs.existsSync(binary)) {
    throw new Error(`E2E binary missing after build: ${binary}`);
  }
  fs.mkdirSync(path.dirname(e2eStampPath()), { recursive: true });
  fs.writeFileSync(e2eStampPath(), STAMP);
}

function hostTriple() {
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  const triple = result.stdout?.match(/^host: (\S+)$/m)?.[1];
  if (!triple) throw new Error("Could not determine the Rust host triple.");
  return triple;
}

/**
 * The bundled FFmpeg sidecar for this host when it is real (not a dev stub).
 * The E2E build copies it next to the debug binary, so the app uses it with
 * no custom FFmpeg path.
 */
function resolveBundledFfmpeg() {
  const manifestPath = path.join(
    REPO_ROOT,
    "src-tauri",
    "binaries",
    ".sidecar-manifest.json",
  );
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const ext = process.platform === "win32" ? ".exe" : "";
  const name = `rosi-ffmpeg-${hostTriple()}${ext}`;
  if (manifest[name]?.stub !== false) return null;
  const candidate = path.join(REPO_ROOT, "src-tauri", "binaries", name);
  return fs.existsSync(candidate) ? candidate : null;
}

/** A real FFmpeg for the conversion scenarios (never the dev stub). */
function resolveTestFfmpeg() {
  const bundled = resolveBundledFfmpeg();
  if (bundled) return { binary: bundled, source: "bundled", customPath: "" };
  const candidate = process.env.ROSI_E2E_FFMPEG || which("ffmpeg");
  if (!candidate || !fs.existsSync(candidate)) return null;
  const probe = spawnSync(candidate, ["-hide_banner", "-version"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) return null;
  const base = path.basename(candidate).toLowerCase();
  if (base !== "ffmpeg" && base !== "ffmpeg.exe") return null;
  return { binary: candidate, source: "system", customPath: candidate };
}

function buildToneFixture(ffmpeg, destination) {
  const result = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x120:d=2",
      "-shortest",
      "-c:v",
      "mpeg4",
      "-c:a",
      "aac",
      "-y",
      destination,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `Could not build the FFmpeg tone fixture: ${result.stderr}`,
    );
  }
}

/**
 * HTML5 pages for yt-dlp's generic extractor: one video with a poster and a
 * subtitle track (thumbnail, subtitle, and metadata embedding), and one page
 * of three videos that yt-dlp reads as a playlist.
 */
function buildPageFixtures(ffmpeg, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const thumb = path.join(directory, "thumb.jpg");
  const result = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=160x120",
      "-frames:v",
      "1",
      "-y",
      thumb,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Could not build the thumbnail fixture: ${result.stderr}`);
  }
  const page = (title, body) =>
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>\n`;
  return {
    "/thumb.jpg": { file: thumb, contentType: "image/jpeg" },
    "/subs.en.vtt": {
      body: Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.500\nHello from ROSI\n"),
      contentType: "text/vtt",
    },
    "/page.html": {
      body: Buffer.from(
        page(
          "ROSI Extras",
          '<video src="tone.mp4" poster="thumb.jpg"><track kind="subtitles" src="subs.en.vtt" srclang="en" label="English"></video>',
        ),
      ),
      contentType: "text/html; charset=utf-8",
    },
    "/list.html": {
      body: Buffer.from(
        page(
          "ROSI List",
          '<video src="tone.mp4?item=1"></video><video src="tone.mp4?item=2"></video><video src="tone.mp4?item=3"></video>',
        ),
      ),
      contentType: "text/html; charset=utf-8",
    },
  };
}

/** Separate DASH video + audio renditions: exercises yt-dlp's merge path. */
function buildDashFixture(ffmpeg, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const result = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=25:duration=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:duration=3",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-f",
      "dash",
      "-seg_duration",
      "1",
      "manifest.mpd",
    ],
    { cwd: directory, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Could not build the DASH fixture: ${result.stderr}`);
  }
  return fs.readdirSync(directory);
}

/** ffprobe that pairs with the FFmpeg used for fixtures. */
function companionFfprobe(ffmpegBinary) {
  const directory = path.dirname(ffmpegBinary);
  const name = path.basename(ffmpegBinary).replace("ffmpeg", "ffprobe");
  const candidate = path.join(directory, name);
  return fs.existsSync(candidate) ? candidate : null;
}

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitSourceTree() {
  const result = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function cleanupProfile(profileDir) {
  try {
    fs.rmSync(profileDir, {
      recursive: true,
      force: true,
      // WebView2 can retain file handles briefly after a clean application
      // exit. Its retries use linear backoff, giving Windows up to 21 seconds.
      maxRetries: process.platform === "win32" ? 20 : 8,
      retryDelay: 100,
    });
  } catch (error) {
    console.warn(
      `WARNING: Could not remove temporary E2E profile ${profileDir}; leaving it for OS cleanup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Re-hash every screenshot the spec reported, so the evidence report vouches
 * for the PNGs actually on disk. Returns the list and any mismatch problems.
 */
function verifyScreenshots(scenarios, directory) {
  const reported =
    scenarios.find((scenario) => scenario.name === "ui-screenshots")?.shots ??
    [];
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

function round2RendererScenario(pass, runnerFailure = null) {
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

function runLongTermPersistenceRepairs() {
  const relative = path.join(
    "e2e",
    "artifacts",
    "long-term-v5-repairs",
    `gate-${Date.now()}-${process.pid}`,
  );
  const directory = path.join(REPO_ROOT, relative);
  const scenario = {
    name: "long-term-persistence",
    status: "failed",
    reportPath: `${relative}/report.json`,
  };
  const result = spawnSync(
    process.execPath,
    ["e2e/long-term-v5-audit-run.mjs"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ROSI_LONG_TERM_ARTIFACT_ROOT: relative },
      encoding: "utf8",
      timeout: 240_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  console.log(result.stdout || "");
  if (result.stderr) console.error(result.stderr);
  try {
    const bytes = fs.readFileSync(path.join(directory, "report.json"));
    const report = JSON.parse(bytes);
    const { reportSha256, ...body } = report;
    if (
      result.status !== 0 ||
      report.suite !== "long-term-v5-audit" ||
      report.observations.length !== 15 ||
      report.observations.some(
        (item) => item.runnerExitCode !== 0 || item.invariantPassed !== true,
      ) ||
      report.binarySha256 !== sha256(fs.readFileSync(e2eBinaryPath())) ||
      reportSha256 !== sha256(Buffer.from(JSON.stringify(body, null, 2)))
    ) {
      throw new Error(
        "Native persistence acceptance or report identity failed.",
      );
    }
    for (const [file, expected] of Object.entries(report.sourceSha256)) {
      if (sha256(fs.readFileSync(path.join(REPO_ROOT, file))) !== expected) {
        throw new Error(`Persistence source changed: ${file}`);
      }
    }
    for (const file of report.artifacts) {
      const artifact = path.resolve(directory, file.path);
      if (!artifact.startsWith(`${directory}${path.sep}`))
        throw new Error("Invalid persistence artifact path.");
      const contents = fs.readFileSync(artifact);
      if (contents.length !== file.bytes || sha256(contents) !== file.sha256) {
        throw new Error(`Persistence artifact changed: ${file.path}`);
      }
    }
    return {
      ...scenario,
      status: "passed",
      observations: 15,
      reportSha256: sha256(bytes),
    };
  } catch (error) {
    return {
      ...scenario,
      reason: error instanceof Error ? error.message : String(error),
      runnerExitCode: result.status,
    };
  }
}

function runRound2NativeRepairs({ ffmpeg, binary, suiteStartedAt }) {
  const scenario = { name: "round2-native", status: "failed" };
  if (!ffmpeg) {
    return {
      ...scenario,
      reason: "The round-two native pass requires a real FFmpeg executable.",
    };
  }

  const runnerPath = path.join(REPO_ROOT, "e2e", "round2-native-run.mjs");
  let result;
  try {
    result = spawnSync(process.execPath, [runnerPath], {
      cwd: REPO_ROOT,
      env: e2eChildEnv({ ROSI_ROUND2_NATIVE_FFMPEG: ffmpeg.binary }),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    return {
      ...scenario,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const reportedPath = output
    .match(/^Round 2 native evidence: (.+)$/m)?.[1]
    ?.trim();
  const artifactsDirectory = path.resolve(ARTIFACT_DIR, "round2-native");
  if (!reportedPath) {
    return {
      ...scenario,
      reason:
        result.error?.message ??
        `Native runner did not report its artifact (exit ${result.status ?? result.signal}).`,
      runnerExitCode: result.status,
    };
  }
  const reportPath = path.resolve(reportedPath);
  if (!reportPath.startsWith(`${artifactsDirectory}${path.sep}`)) {
    return {
      ...scenario,
      reason:
        "Native runner reported an artifact outside its evidence directory.",
      reportPath: path
        .relative(REPO_ROOT, reportPath)
        .split(path.sep)
        .join("/"),
    };
  }
  scenario.reportPath = path
    .relative(REPO_ROOT, reportPath)
    .split(path.sep)
    .join("/");
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    );
    const expected = {
      version: packageJson.version,
      platform: process.platform,
      arch: process.arch,
      binary: path.relative(REPO_ROOT, binary).split(path.sep).join("/"),
      binarySha256: sha256(fs.readFileSync(binary)),
      ffmpegSha256: sha256(fs.readFileSync(fs.realpathSync(ffmpeg.binary))),
      probeSources: Object.fromEntries(
        ["e2e/round2-native.spec.js", "e2e/round2-native-failure-modes.md"].map(
          (file) => [file, sha256(fs.readFileSync(path.join(REPO_ROOT, file)))],
        ),
      ),
      suiteStartedAt,
    };
    const problems = round2NativeReportProblems(report, expected);
    const observationsPath = path.join(
      path.dirname(reportPath),
      "observations.json",
    );
    const observations = JSON.parse(fs.readFileSync(observationsPath, "utf8"));
    if (JSON.stringify(observations) !== JSON.stringify(report.observations)) {
      problems.push(
        "native observation artifact differs from the hashed report",
      );
    }
    if (result.status !== 0 || result.error) {
      problems.push(
        result.error?.message ?? `native runner exited with ${result.status}`,
      );
    }
    if (problems.length > 0) {
      return {
        ...scenario,
        reason: problems.join("; "),
        runnerExitCode: result.status,
      };
    }
    return {
      ...scenario,
      status: "passed",
      reportSha256: report.reportSha256,
      binarySha256: report.binarySha256,
      sourceHashes: report.probeSources ?? report.sourceHashes,
      observations: report.observations.length,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
    };
  } catch (error) {
    return {
      ...scenario,
      reason: error instanceof Error ? error.message : String(error),
      runnerExitCode: result.status,
    };
  }
}

function runDownloadProcessRepairs({ ffmpeg, binary, suiteStartedAt }) {
  const repairArtifactDir = path.join(
    ARTIFACT_DIR,
    `download-process-repairs-${Date.now()}-${process.pid}`,
  );
  const reportPath = path.join(repairArtifactDir, "repair-report.json");
  if (process.platform === "win32") {
    return {
      name: "download-process-repairs",
      status: "skipped",
      reason:
        "The isolated signal and oversized-output wrapper probe currently supports macOS and Linux.",
      platform: process.platform,
    };
  }

  let runnerFailure = null;
  try {
    run(process.execPath, ["e2e/run-download-process-repairs.mjs"], {
      env: {
        ROSI_REPAIRS_FFMPEG: ffmpeg?.binary ?? "",
        ROSI_AUDIT3_ARTIFACT_DIR: repairArtifactDir,
        ROSI_REPAIRS_SPEC: "./download-process-repairs.spec.js",
      },
    });
  } catch (error) {
    runnerFailure = error instanceof Error ? error.message : String(error);
  }

  const scenario = {
    name: "download-process-repairs",
    status: "failed",
    reportPath: path.relative(REPO_ROOT, reportPath).split(path.sep).join("/"),
  };
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const { reportSha256, ...reportBody } = report;
    const actualReportSha256 = sha256(
      Buffer.from(JSON.stringify(reportBody, null, 2)),
    );
    const startedAt = Date.parse(report.startedAt);
    const finishedAt = Date.parse(report.finishedAt);
    const suiteStart = Date.parse(suiteStartedAt);
    const binarySha256 = sha256(fs.readFileSync(binary));
    const selectedFfmpegSha256 = ffmpeg
      ? sha256(fs.readFileSync(fs.realpathSync(ffmpeg.binary)))
      : null;
    const mismatch =
      report.app !== "ROSI" ||
      report.version !==
        JSON.parse(
          fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
        ).version ||
      report.commit !== gitCommit() ||
      report.platform !== process.platform ||
      report.arch !== process.arch ||
      report.exitCode !== 0 ||
      report.binarySha256 !== binarySha256 ||
      report.probeSourceSha256?.runner !==
        sha256(
          fs.readFileSync(
            path.join(REPO_ROOT, "e2e", "run-download-process-repairs.mjs"),
          ),
        ) ||
      report.probeSourceSha256?.spec !==
        sha256(
          fs.readFileSync(
            path.join(REPO_ROOT, "e2e", "download-process-repairs.spec.js"),
          ),
        ) ||
      report.probeSourceSha256?.failureModes !==
        sha256(
          fs.readFileSync(
            path.join(REPO_ROOT, "e2e", "download-process-repairs.failures.md"),
          ),
        ) ||
      report.probeSourceSha256?.audit3FailureModes !==
        sha256(
          fs.readFileSync(
            path.join(REPO_ROOT, "e2e", "audit3-native-failure-modes.md"),
          ),
        ) ||
      (selectedFfmpegSha256 !== null &&
        report.realFfmpegSha256 !== selectedFfmpegSha256) ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(finishedAt) ||
      !Number.isFinite(suiteStart) ||
      startedAt < suiteStart ||
      finishedAt < startedAt ||
      reportSha256 !== actualReportSha256;
    if (mismatch) {
      throw new Error(
        "The process-repair report failed identity, freshness, result, or self-hash verification.",
      );
    }
    if (runnerFailure) throw new Error(runnerFailure);
    return {
      ...scenario,
      status: "passed",
      reportSha256,
      binarySha256,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      observations: report.observations?.length ?? 0,
    };
  } catch (error) {
    return {
      ...scenario,
      reason: error instanceof Error ? error.message : String(error),
      runnerFailure,
    };
  }
}

function writeEvidence(report) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const body = { ...report };
  const canonical = JSON.stringify(body, null, 2);
  body.reportSha256 = crypto
    .createHash("sha256")
    .update(canonical)
    .digest("hex");
  const file = path.join(
    ARTIFACT_DIR,
    `e2e-report-${process.platform}-${process.arch}.json`,
  );
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`E2E evidence written to ${path.relative(REPO_ROOT, file)}`);
  return file;
}

async function main() {
  if (process.env.SKIP_E2E === "1") {
    throw new Error(
      "SKIP_E2E=1 is not allowed. Unset it and run the unpackaged WebdriverIO suite.",
    );
  }
  reexecUnderXvfb();
  // The full suite is release evidence and must always run against a freshly
  // compiled binary. Reuse is limited to an explicitly selected ad-hoc spec.
  const reuseRequested = process.env.ROSI_E2E_REUSE === "1";
  if (
    !mayReuseE2eBinary({
      onlySpec: Boolean(process.env.ROSI_E2E_ONLY),
      reuseRequested,
      binaryFresh: !reuseRequested || e2eBinaryIsFresh(),
    })
  ) {
    buildE2eBinary();
  }

  const ffmpeg = resolveTestFfmpeg();
  if (!ffmpeg && process.env.ROSI_E2E_REQUIRE_FFMPEG === "1") {
    // CI sets this so conversion/merge scenarios cannot silently turn into
    // skips on a platform whose runner lacks FFmpeg.
    console.error(
      "ROSI_E2E_REQUIRE_FFMPEG=1 but no FFmpeg was found (bundled, ROSI_E2E_FFMPEG, or PATH).",
    );
    process.exit(1);
  }
  const screenshotDir = path.join(
    ARTIFACT_DIR,
    "screenshots",
    `${process.platform}-${process.arch}`,
  );
  // Start empty so the report never lists a PNG left over from an older run.
  fs.rmSync(screenshotDir, { recursive: true, force: true });
  const profile = createE2eProfile({ ffmpegPath: ffmpeg?.customPath ?? "" });
  const fixtureDir = path.join(profile.profileDir, "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixtures = {};
  const routes = {};
  for (const [name, size] of [
    ["clip-one.mp4", 256 * 1024],
    ["clip-two.mp4", 384 * 1024],
    ["clip-three.mp4", 512 * 1024],
  ]) {
    const bytes = deterministicBytes(size, `rosi-e2e:${name}`);
    fixtures[name] = sha256(bytes);
    routes[`/${name}`] = { body: bytes };
  }
  // Non-ASCII name: the spec checks UTF-8 survives yt-dlp on every OS.
  const unicodeName = "日本語-Привет-café.mp4";
  const unicodeBytes = deterministicBytes(128 * 1024, "rosi-e2e:unicode");
  fixtures[unicodeName] = sha256(unicodeBytes);
  routes[`/${encodeURIComponent(unicodeName)}`] = { body: unicodeBytes };
  routes["/slow.mp4"] = {
    body: deterministicBytes(32 * 1024 * 1024, "rosi-e2e:slow"),
    slow: true,
  };
  if (ffmpeg) {
    const tone = path.join(fixtureDir, "tone.mp4");
    buildToneFixture(ffmpeg.binary, tone);
    routes["/tone.mp4"] = { file: tone };
    fixtures["tone.mp4"] = sha256(fs.readFileSync(tone));
    Object.assign(
      routes,
      buildPageFixtures(ffmpeg.binary, path.join(fixtureDir, "pages")),
    );
    const dashDir = path.join(fixtureDir, "dash");
    for (const name of buildDashFixture(ffmpeg.binary, dashDir)) {
      routes[`/dash/${name}`] = {
        file: path.join(dashDir, name),
        contentType: name.endsWith(".mpd")
          ? "application/dash+xml"
          : "application/octet-stream",
      };
    }
  }
  const server = await startMediaServer(routes);
  const startedAt = new Date().toISOString();
  const sharedEnv = {
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
      "security-release-repairs",
      `${process.platform}-${process.arch}`,
      "proxy-decisions.jsonl",
    ),
    ROSI_SECURITY_REPAIR_DIRECTORY: path.join(
      ARTIFACT_DIR,
      "security-release-repairs",
      `${process.platform}-${process.arch}`,
    ),
  };
  fs.rmSync(sharedEnv.ROSI_E2E_PROXY_TRACE, { force: true });
  const runPass = (pass, env) =>
    runAsync(npxCommand(), ["wdio", "run", "e2e/wdio.conf.js"], {
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

  // Fresh ROSI 5 profiles with ROSI 4 data beside them, each a separate app
  // launch because the import only runs before the first settings file.
  // ROSI_E2E_ONLY runs one ad-hoc spec, so it skips these passes.
  const legacyPasses = process.env.ROSI_E2E_ONLY
    ? []
    : ["import", "corrupt-settings"].map((legacyCase) => {
        const legacyProfile = createE2eProfile({ seedSettings: false });
        return {
          legacyCase,
          profile: legacyProfile,
          seed: seedLegacyV4Data(legacyProfile, {
            corruptSettings: legacyCase === "corrupt-settings",
          }),
          resultsPath: path.join(legacyProfile.profileDir, "results.json"),
        };
      });
  const mainPass = {
    profile,
    // The main profile already has ROSI 5 settings, so this ROSI 4 folder
    // must be ignored.
    seed: seedLegacyV4Data(profile),
    resultsPath: path.join(profile.profileDir, "results.json"),
    stateRepairResultsPath: path.join(
      profile.profileDir,
      "state-repairs-results.json",
    ),
  };
  // Security downloads intentionally populate stats/activity and can exercise
  // renderer state that the main UI suite expects to start fresh. Keep the
  // security proof in its own profile while aggregating both result files.
  const securityPass = process.env.ROSI_E2E_ONLY
    ? null
    : (() => {
        const securityProfile = createE2eProfile({
          ffmpegPath: ffmpeg?.customPath ?? "",
        });
        return {
          profile: securityProfile,
          resultsPath: path.join(
            securityProfile.profileDir,
            "security-repairs-results.json",
          ),
        };
      })();
  // State-repair close-failure scenarios deliberately leave native warning
  // dialogs open. Run them in their own profile before the security and main
  // specs, whose final close-flow scenario closes this app window.
  const stateRepairPass = process.env.ROSI_E2E_ONLY
    ? null
    : (() => {
        const stateProfile = createE2eProfile({
          ffmpegPath: ffmpeg?.customPath ?? "",
        });
        return {
          profile: stateProfile,
          resultsPath: path.join(
            stateProfile.profileDir,
            "state-repairs-results.json",
          ),
        };
      })();
  const offlineQueuePass = process.env.ROSI_E2E_ONLY
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
          profile: offlineProfile,
          resultsPath: path.join(
            offlineProfile.profileDir,
            "offline-queue-results.json",
          ),
        };
      })();
  const round2RendererPass = process.env.ROSI_E2E_ONLY
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
        return { profile: rendererProfile, resultsPath };
      })();
  let round2RendererFailure = null;
  let failure = null;
  try {
    for (const pass of legacyPasses) {
      await runPass(pass, {
        ROSI_E2E_SPECS: "./specs/legacy-import.spec.js",
        ROSI_E2E_LEGACY_CASE: pass.legacyCase,
        ROSI_E2E_LEGACY_V4: JSON.stringify(pass.seed),
      });
    }
    if (offlineQueuePass) {
      await runPass(offlineQueuePass, {
        ROSI_E2E_SPECS: "./specs/security-release-offline-queue.spec.js",
        ROSI_OFFLINE_QUEUE_RESULTS: path.join(
          offlineQueuePass.profile.profileDir,
          "offline-queue-results.json",
        ),
      });
    }
    if (stateRepairPass) {
      await runPass(stateRepairPass, {
        ROSI_E2E_SPECS: "./state-updater-repairs.spec.js",
        ROSI_STATE_REPAIR_RESULTS: stateRepairPass.resultsPath,
      });
    }
    if (securityPass) {
      await runPass(securityPass, {
        ROSI_E2E_SPECS: "./specs/security-release-repairs.spec.js",
        ROSI_SECURITY_REPAIR_RESULTS: securityPass.resultsPath,
      });
    }
    if (round2RendererPass) {
      try {
        await runPass(round2RendererPass, {
          ROSI_E2E_SPECS: "./round2-renderer-repairs.spec.js",
          ROSI_ROUND2_RENDERER_RESULTS: round2RendererPass.resultsPath,
        });
      } catch (error) {
        round2RendererFailure =
          error instanceof Error ? error.message : String(error);
        throw error;
      }
    }
    await runPass(mainPass, {
      // ROSI_E2E_ONLY runs a single ad-hoc spec while debugging; the full
      // gate always runs main.spec.js and requires every scenario.
      ROSI_E2E_SPECS: process.env.ROSI_E2E_ONLY ?? "./specs/main.spec.js",
      // Preserve this path for ROSI_E2E_ONLY debugging when the selected spec
      // is the state-repair suite. The full gate uses the isolated pass above.
      ROSI_STATE_REPAIR_RESULTS: mainPass.stateRepairResultsPath,
      ROSI_E2E_LEGACY_V4: JSON.stringify(mainPass.seed),
      ROSI_E2E_SCREENSHOTS: screenshotDir,
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    await server.close();
  }

  const processRepairScenarios = process.env.ROSI_E2E_ONLY
    ? []
    : [
        runDownloadProcessRepairs({
          ffmpeg,
          binary: e2eBinaryPath(),
          suiteStartedAt: startedAt,
        }),
      ];
  const round2NativeScenarios = process.env.ROSI_E2E_ONLY
    ? []
    : [
        runRound2NativeRepairs({
          ffmpeg,
          binary: e2eBinaryPath(),
          suiteStartedAt: startedAt,
        }),
      ];
  const round2RendererScenarios = round2RendererPass
    ? [round2RendererScenario(round2RendererPass, round2RendererFailure)]
    : [];
  const persistenceScenarios = process.env.ROSI_E2E_ONLY
    ? []
    : [runLongTermPersistenceRepairs()];
  if (
    round2RendererScenarios.some((scenario) => scenario.status === "failed")
  ) {
    const detail = `${round2RendererScenarios[0].name}: ${round2RendererScenarios[0].reason}`;
    failure = failure ? `${failure}; ${detail}` : detail;
  }
  for (const scenario of processRepairScenarios) {
    if (scenario.status === "failed") {
      const detail = `${scenario.name}: ${scenario.reason}`;
      failure = failure ? `${failure}; ${detail}` : detail;
    }
  }
  for (const scenario of round2NativeScenarios) {
    if (scenario.status === "failed") {
      const detail = `${scenario.name}: ${scenario.reason}`;
      failure = failure ? `${failure}; ${detail}` : detail;
    }
  }
  for (const scenario of persistenceScenarios) {
    if (scenario.status === "failed") {
      const detail = `${scenario.name}: ${scenario.reason}`;
      failure = failure ? `${failure}; ${detail}` : detail;
    }
  }

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
    mainPass,
  ].flatMap((pass) => [
    ...readResults(pass.resultsPath),
    ...(pass === mainPass && !stateRepairPass
      ? readResults(pass.stateRepairResultsPath)
      : []),
  ]);
  scenarios.push(...round2RendererScenarios);
  scenarios.push(...processRepairScenarios);
  scenarios.push(...round2NativeScenarios);
  scenarios.push(...persistenceScenarios);
  const seen = new Set(scenarios.map((scenario) => scenario.name));
  const missing = EXPECTED_SCENARIOS.filter((name) => !seen.has(name));
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
  const uncovered = process.env.ROSI_E2E_ONLY
    ? []
    : Object.entries(legacyImportCoverage)
        .filter(([, mode]) => mode.coveredBy.length === 0)
        .map(([id]) => id);
  const { screenshots, problems: screenshotProblems } = verifyScreenshots(
    scenarios,
    screenshotDir,
  );
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  const scenarioProblems = scenarioOutcomeProblems(scenarios, process.platform);
  const evidence = writeEvidence({
    app: "ROSI",
    fullSuite: !process.env.ROSI_E2E_ONLY,
    expectedScenarios: [...EXPECTED_SCENARIOS],
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
    finishedAt: new Date().toISOString(),
    ffmpeg: ffmpeg
      ? { source: ffmpeg.source, binary: path.basename(ffmpeg.binary) }
      : null,
    appTmpdir: process.env.ROSI_E2E_APP_TMPDIR || null,
    fixtures,
    scenarios,
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
    legacyPassLogTails: Object.fromEntries(
      legacyPasses.map((pass) => [pass.legacyCase, readLogTail(pass, 15)]),
    ),
    appLogTail: readLogTail(mainPass, 40),
  });
  for (const pass of [
    ...legacyPasses,
    ...(offlineQueuePass ? [offlineQueuePass] : []),
    ...(stateRepairPass ? [stateRepairPass] : []),
    ...(securityPass ? [securityPass] : []),
    ...(round2RendererPass ? [round2RendererPass] : []),
    mainPass,
  ]) {
    cleanupProfile(pass.profile.profileDir);
  }
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

/** `--repeat N` (or ROSI_E2E_REPEAT=N) reruns the whole suite N times. */
export function parseRepeat(argv, env = process.env) {
  const index = argv.indexOf("--repeat");
  const raw = index >= 0 ? argv[index + 1] : env.ROSI_E2E_REPEAT;
  if (raw === undefined) return 1;
  const times = Number(raw);
  if (!Number.isInteger(times) || times < 1 || times > 100) {
    throw new Error(`--repeat needs a whole number from 1 to 100, got ${raw}`);
  }
  return times;
}

/**
 * Per-scenario outcome across repeated runs. A scenario that passed in some
 * runs and failed or never reported in others is flaky.
 */
export function summarizeStability(runs) {
  const names = new Set([
    ...EXPECTED_SCENARIOS,
    ...runs.flatMap((run) => run.passed),
  ]);
  const scenarios = [...names].sort().map((name) => {
    const passed = runs.filter((run) => run.passed.includes(name)).length;
    const skipped = runs.filter((run) => run.skipped.includes(name)).length;
    return { name, passed, skipped, failed: runs.length - passed - skipped };
  });
  return {
    runs: runs.length,
    failedRuns: runs.filter((run) => run.error).map((run) => run.run),
    flaky: scenarios
      .filter((scenario) => scenario.passed > 0 && scenario.failed > 0)
      .map((scenario) => scenario.name),
    alwaysFailing: scenarios
      .filter((scenario) => scenario.passed === 0 && scenario.failed > 0)
      .map((scenario) => scenario.name),
    scenarios,
  };
}

async function runStability(times) {
  const reportFile = path.join(
    ARTIFACT_DIR,
    `e2e-report-${process.platform}-${process.arch}.json`,
  );
  const runDir = path.join(
    ARTIFACT_DIR,
    "stability",
    `${process.platform}-${process.arch}`,
  );
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  const runs = [];
  for (let run = 1; run <= times; run += 1) {
    console.log(`\n=== E2E stability run ${run}/${times} ===`);
    // The first run builds; later runs reuse that binary.
    if (run > 1) process.env.ROSI_E2E_REUSE = "1";
    let error = null;
    try {
      await main();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const report = fs.existsSync(reportFile)
      ? JSON.parse(fs.readFileSync(reportFile, "utf8"))
      : { scenarios: [] };
    fs.copyFileSync(reportFile, path.join(runDir, `run-${run}.json`));
    runs.push({
      run,
      error,
      passed: report.scenarios
        .filter((scenario) => scenario.status === "passed")
        .map((scenario) => scenario.name),
      skipped: report.scenarios
        .filter((scenario) => scenario.status === "skipped")
        .map((scenario) => scenario.name),
    });
  }
  const summary = {
    app: "ROSI",
    platform: process.platform,
    arch: process.arch,
    commit: gitCommit(),
    finishedAt: new Date().toISOString(),
    ...summarizeStability(runs),
  };
  summary.reportSha256 = crypto
    .createHash("sha256")
    .update(JSON.stringify(summary, null, 2))
    .digest("hex");
  const file = path.join(
    ARTIFACT_DIR,
    `e2e-stability-${process.platform}-${process.arch}.json`,
  );
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `\nStability: ${times - summary.failedRuns.length}/${times} runs passed; ` +
      `flaky: ${summary.flaky.join(", ") || "none"}; ` +
      `always failing: ${summary.alwaysFailing.join(", ") || "none"}`,
  );
  console.log(
    `Stability evidence written to ${path.relative(REPO_ROOT, file)}`,
  );
  if (summary.failedRuns.length > 0) {
    throw new Error(`E2E failed in run(s) ${summary.failedRuns.join(", ")}`);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  Promise.resolve()
    .then(() => {
      const times = parseRepeat(process.argv.slice(2));
      return times > 1 ? runStability(times) : main();
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
