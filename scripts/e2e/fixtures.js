// Fixture media for the E2E gate: FFmpeg resolution, tone, page, DASH, and media routes.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "../../e2e/helpers/profile.js";
import { deterministicBytes, sha256 } from "../../e2e/helpers/media-server.js";
import { which } from "./common.js";

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
export function resolveTestFfmpeg() {
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
export function companionFfprobe(ffmpegBinary) {
  const directory = path.dirname(ffmpegBinary);
  const name = path.basename(ffmpegBinary).replace("ffmpeg", "ffprobe");
  const candidate = path.join(directory, name);
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Every route the media server serves for the gate: deterministic clips, a
 * non-ASCII name, a slow download, and (with FFmpeg) the generated fixtures.
 * Returns the hash of each fixture for the report, and the routes.
 */
export function buildMediaRoutes({ ffmpeg, fixtureDir }) {
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
  return { fixtures, routes };
}
