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

import { usesWindowsCmdShell } from "./npm-safe-update.mjs";

const ARTIFACT_DIR = path.join(REPO_ROOT, "e2e", "artifacts");
const EXPECTED_SCENARIOS = [
  "launch",
  "settings-sidebar",
  "settings-persistence",
  "url-safety",
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
  "webview-guard",
  "link-drop",
  "small-window",
  "browser-choice",
  "xdg-download-dir",
  "stats",
  "activity-clear",
  "close-flow",
];

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

function buildE2eBinary() {
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
  // Always rebuild (Cargo and Vite are incremental) so a stale binary can
  // never pass for current sources. ROSI_E2E_REUSE=1 skips it for fast local
  // spec iteration only.
  if (process.env.ROSI_E2E_REUSE !== "1" || !e2eBinaryIsFresh()) {
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
  const resultsPath = path.join(profile.profileDir, "results.json");
  const startedAt = new Date().toISOString();
  let failure = null;
  try {
    await runAsync(npxCommand(), ["wdio", "run", "e2e/wdio.conf.js"], {
      env: {
        ...profile.env,
        // Hardening check: point only the app at a temp dir such as a noexec
        // tmpfs, while the profile stays on an exec-capable filesystem.
        ...(process.env.ROSI_E2E_APP_TMPDIR
          ? { TMPDIR: process.env.ROSI_E2E_APP_TMPDIR }
          : {}),
        ROSI_E2E_BINARY: e2eBinaryPath(),
        // ROSI_E2E_ONLY runs a single ad-hoc spec while debugging; the full
        // gate always runs main.spec.js and requires every scenario.
        ROSI_E2E_SPECS: process.env.ROSI_E2E_ONLY ?? "./specs/main.spec.js",
        ROSI_E2E_DOWNLOADS: profile.downloads,
        ROSI_E2E_XDG_DOWNLOADS: profile.xdgDownloads,
        ROSI_E2E_PROFILE: profile.profileDir,
        ROSI_E2E_MEDIA_URL: server.baseUrl,
        ROSI_E2E_FIXTURES: JSON.stringify(fixtures),
        ROSI_E2E_HAS_FFMPEG: ffmpeg ? "1" : "0",
        ROSI_E2E_FFPROBE: ffmpeg ? (companionFfprobe(ffmpeg.binary) ?? "") : "",
        ROSI_E2E_RESULTS: resultsPath,
      },
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    await server.close();
  }

  const scenarios = fs.existsSync(resultsPath)
    ? JSON.parse(fs.readFileSync(resultsPath, "utf8"))
    : [];
  const seen = new Set(scenarios.map((scenario) => scenario.name));
  const missing = EXPECTED_SCENARIOS.filter((name) => !seen.has(name));
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  const logFile = path.join(profile.dataDir, "logs", "rosi.log");
  const evidence = writeEvidence({
    app: "ROSI",
    version: packageJson.version,
    commit: gitCommit(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    startedAt,
    finishedAt: new Date().toISOString(),
    ffmpeg: ffmpeg
      ? { source: ffmpeg.source, binary: path.basename(ffmpeg.binary) }
      : null,
    appTmpdir: process.env.ROSI_E2E_APP_TMPDIR || null,
    fixtures,
    scenarios,
    missingScenarios: missing,
    failure,
    passed: !failure && missing.length === 0,
    mediaRequests: server.requests.length,
    appLogTail: fs.existsSync(logFile)
      ? fs.readFileSync(logFile, "utf8").split(/\r?\n/).slice(-40)
      : [],
  });
  cleanupProfile(profile.profileDir);
  if (failure) throw new Error(`${failure} (evidence: ${evidence})`);
  if (missing.length > 0) {
    throw new Error(
      `E2E scenarios did not report: ${missing.join(", ")} (evidence: ${evidence})`,
    );
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
