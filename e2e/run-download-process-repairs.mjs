import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  createE2eProfile,
  e2eBinaryPath,
  e2eStampPath,
  REPO_ROOT,
} from "./helpers/profile.js";
import {
  deterministicBytes,
  sha256,
  startMediaServer,
} from "./helpers/media-server.js";

if (process.platform === "win32") {
  throw new Error(
    "This isolated process probe currently requires a Unix host for its owned helper wrappers.",
  );
}

const scriptPath = fileURLToPath(import.meta.url);
const e2eSpec =
  process.env.ROSI_REPAIRS_SPEC || "./download-process-repairs.spec.js";
const artifactToken = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const artifactDir = path.resolve(
  process.env.ROSI_AUDIT3_ARTIFACT_DIR ||
    path.join(REPO_ROOT, "e2e", "artifacts", `audit3-native-${artifactToken}`),
);
const proxyTracePath = path.join(artifactDir, "proxy-decisions.jsonl");
const binary = e2eBinaryPath();
const stamp = e2eStampPath();
if (
  !fs.existsSync(binary) ||
  !fs.existsSync(stamp) ||
  fs.readFileSync(stamp, "utf8") !== "e2e-feature-1\n" ||
  fs.statSync(stamp).mtimeMs < fs.statSync(binary).mtimeMs
) {
  throw new Error(
    "Build a fresh E2E binary with npm run test:e2e before running this probe.",
  );
}

const selectedFfmpeg =
  process.env.ROSI_REPAIRS_FFMPEG || process.env.ROSI_E2E_FFMPEG;
const lookup = selectedFfmpeg
  ? { status: 0, stdout: selectedFfmpeg }
  : spawnSync("which", ["ffmpeg"], { encoding: "utf8" });
const realFfmpeg = lookup.status === 0 ? lookup.stdout.trim() : "";
if (!realFfmpeg || !fs.existsSync(realFfmpeg)) {
  throw new Error(
    "A real FFmpeg executable is required; set ROSI_REPAIRS_FFMPEG to the binary selected for E2E or install ffmpeg on PATH.",
  );
}
const ffmpeg = fs.realpathSync(realFfmpeg);
const ffprobe = spawnSync(ffmpeg, ["-hide_banner", "-version"], {
  encoding: "utf8",
});
if (ffprobe.status !== 0) throw new Error(ffprobe.stderr);
const pairedFfprobe = path.join(
  path.dirname(ffmpeg),
  path.basename(ffmpeg).replace(/ffmpeg/i, "ffprobe"),
);
const ffprobeLookup = fs.existsSync(pairedFfprobe)
  ? { status: 0, stdout: pairedFfprobe }
  : spawnSync("which", ["ffprobe"], { encoding: "utf8" });
const ffprobeBinary =
  ffprobeLookup.status === 0 ? ffprobeLookup.stdout.trim() : "";
if (!ffprobeBinary || !fs.existsSync(ffprobeBinary)) {
  throw new Error(
    "A real ffprobe executable is required for the PATH-only ffprobe repair case.",
  );
}
let repairPath = [path.dirname(ffprobeBinary), process.env.PATH ?? ""]
  .filter(Boolean)
  .join(path.delimiter);

if (fs.existsSync(artifactDir)) {
  throw new Error(
    `Refusing to overwrite existing audit artifacts: ${artifactDir}`,
  );
}
fs.mkdirSync(artifactDir, { recursive: true });

const profile = createE2eProfile();
const malformedLauncherPath = path.join(artifactDir, "malformed-launch.json");
const malformedConfigDirectory = path.join(
  profile.profileDir,
  "malformed-launcher",
);
fs.mkdirSync(malformedConfigDirectory, { mode: 0o700 });
const missingConfigPath = path.join(malformedConfigDirectory, "missing.json");
const invalidConfigPath = path.join(malformedConfigDirectory, "invalid.json");
fs.writeFileSync(invalidConfigPath, "{\n", { mode: 0o600 });
function killTimedOutProcessGroup(result) {
  if (result.error?.code === "ETIMEDOUT" && result.pid) {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch {}
  }
}
const malformedLauncherCases = [
  {
    name: "missing-config-and-role",
    args: ["--rosi-private-media-tool"],
    expected: "ROSI private media-tool invocation is incomplete.",
  },
  {
    name: "missing-role",
    args: ["--rosi-private-media-tool", missingConfigPath],
    expected: "ROSI private media-tool invocation is incomplete.",
  },
  {
    name: "invalid-config",
    args: ["--rosi-private-media-tool", invalidConfigPath, "ffmpeg"],
    expected:
      "ROSI media-tool launcher refused to start: Private launcher config is invalid:",
  },
];
const malformedLauncher = malformedLauncherCases.map((testCase) => {
  const result = spawnSync(binary, testCase.args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...profile.env },
    encoding: "utf8",
    timeout: 3000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    detached: true,
  });
  killTimedOutProcessGroup(result);
  return {
    name: testCase.name,
    status: result.status,
    signal: result.signal,
    error: result.error?.code ?? null,
    expected: testCase.expected,
    stderrTail: (result.stderr ?? "").slice(-4000),
  };
});
const nonUtf8Role = spawnSync(
  "python3",
  [
    "-c",
    'import os,sys; os.execve(sys.argv[1], [os.fsencode(sys.argv[1]), b"--rosi-private-media-tool", os.fsencode(sys.argv[2]), b"\\xff"], os.environ)',
    binary,
    missingConfigPath,
  ],
  {
    cwd: REPO_ROOT,
    env: { ...process.env, ...profile.env },
    encoding: "utf8",
    timeout: 3000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    detached: true,
  },
);
killTimedOutProcessGroup(nonUtf8Role);
malformedLauncher.push({
  name: "non-utf8-role",
  status: nonUtf8Role.status,
  signal: nonUtf8Role.signal,
  error: nonUtf8Role.error?.code ?? null,
  expected: "ROSI private media-tool invocation is incomplete.",
  stderrTail: (nonUtf8Role.stderr ?? "").slice(-4000),
});
fs.writeFileSync(
  malformedLauncherPath,
  `${JSON.stringify(malformedLauncher, null, 2)}\n`,
);
const fixtureDir = path.join(profile.profileDir, "fixtures");
fs.mkdirSync(fixtureDir, { recursive: true });
const helper = path.join(fixtureDir, "ffmpeg");
const terminationReady = path.join(fixtureDir, "tree-ready.json");
const cancelBetweenReady = path.join(fixtureDir, "cancel-between-ready");
const codecProbeReady = path.join(fixtureDir, "codec-probe-ready");
const captionEnumerationReady = path.join(
  fixtureDir,
  "caption-enumeration-ready",
);
const captionEnumerationRelease = path.join(
  fixtureDir,
  "caption-enumeration-release",
);
const captionRaceReady = path.join(fixtureDir, "caption-race-ready");
const captionRaceRelease = path.join(fixtureDir, "caption-race-release");
const gpuFailureMarker = path.join(fixtureDir, "gpu-init-failure");
const gpuProbeAReady = path.join(fixtureDir, "gpu-probe-a-ready");
const gpuProbeARelease = path.join(fixtureDir, "gpu-probe-a-release");
const gpuProbeBTrace = path.join(fixtureDir, "gpu-probe-b.jsonl");
const gpuProbeADirectory = path.join(fixtureDir, "gpu-probe-a");
const gpuProbeBDirectory = path.join(fixtureDir, "gpu-probe-b");
const gpuProbeA = path.join(gpuProbeADirectory, "ffmpeg");
const gpuProbeB = path.join(gpuProbeBDirectory, "ffmpeg");
const authRequestsFile = path.join(fixtureDir, "auth-requests.json");
const tone = path.join(fixtureDir, "tone.mp4");
const vp8 = path.join(fixtureDir, "vp8.webm");
const audioOnly = path.join(fixtureDir, "audio-only.m4a");
const plainMatroska = path.join(fixtureDir, "plain-source.mkv");
const subtitledMatroska = path.join(fixtureDir, "subtitled-source.mkv");
const mixedTracksMatroska = path.join(fixtureDir, "mixed-video-tracks.mkv");
const coverArtJpeg = path.join(fixtureDir, "cover-art.jpg");
const coverArtMp4 = path.join(fixtureDir, "cover-art-source.mp4");
const sidecarSrt = path.join(fixtureDir, "sidecar-source.en.srt");
const audioSidecarSrt = path.join(fixtureDir, "audio-sidecar-source.en.srt");
const embeddedSubtitleSrt = path.join(fixtureDir, "embedded-caption.srt");
const fallbackLocalSegment = path.join(fixtureDir, "fallback-local-segment.ts");
const toolTracePath = path.join(fixtureDir, "tool-invocations.jsonl");
repairPath = [fixtureDir, path.dirname(ffprobeBinary), process.env.PATH ?? ""]
  .filter(Boolean)
  .join(path.delimiter);

function encode(destination, codec) {
  const result = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x120:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-shortest",
      "-c:v",
      codec,
      "-c:a",
      codec === "libvpx" ? "libvorbis" : "aac",
      "-y",
      destination,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
}

encode(tone, "mpeg4");
encode(vp8, "libvpx");
const audioResult = spawnSync(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    tone,
    "-vn",
    "-c:a",
    "copy",
    "-y",
    audioOnly,
  ],
  { encoding: "utf8" },
);
if (audioResult.status !== 0) throw new Error(audioResult.stderr);
fs.writeFileSync(
  embeddedSubtitleSrt,
  "1\n00:00:00,000 --> 00:00:04,000\nROSI audit caption\n\n",
);
for (const sidecar of [sidecarSrt, audioSidecarSrt]) {
  fs.copyFileSync(embeddedSubtitleSrt, sidecar);
}
const matroskaResult = spawnSync(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x240:d=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=4",
    "-t",
    "4",
    "-c:v",
    "mpeg4",
    "-b:v",
    "250k",
    "-c:a",
    "aac",
    "-y",
    plainMatroska,
  ],
  { encoding: "utf8" },
);
if (matroskaResult.status !== 0) throw new Error(matroskaResult.stderr);
const subtitledResult = spawnSync(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x240:d=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=4",
    "-i",
    embeddedSubtitleSrt,
    "-t",
    "4",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-map",
    "2:s:0",
    "-c:v",
    "mpeg4",
    "-b:v",
    "250k",
    "-c:a",
    "aac",
    "-c:s",
    "srt",
    "-y",
    subtitledMatroska,
  ],
  { encoding: "utf8" },
);
if (subtitledResult.status !== 0) throw new Error(subtitledResult.stderr);
const coverArtResult = spawnSync(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=48x48:d=1",
    "-frames:v",
    "1",
    "-y",
    coverArtJpeg,
  ],
  { encoding: "utf8" },
);
if (coverArtResult.status !== 0) throw new Error(coverArtResult.stderr);
const mixedTracksResult = spawnSync(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    tone,
    "-i",
    vp8,
    "-i",
    coverArtJpeg,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-map",
    "1:v:0",
    "-map",
    "2:v:0",
    "-c:v:0",
    "copy",
    "-c:v:1",
    "copy",
    "-c:v:2",
    "mjpeg",
    "-disposition:v:2",
    "attached_pic",
    "-c:a",
    "copy",
    "-y",
    mixedTracksMatroska,
  ],
  { encoding: "utf8" },
);
if (mixedTracksResult.status !== 0) throw new Error(mixedTracksResult.stderr);
const coverArtMp4Result = spawnSync(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    tone,
    "-i",
    coverArtJpeg,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-map",
    "1:v:0",
    "-c:v:0",
    "copy",
    "-c:v:1",
    "mjpeg",
    "-disposition:v:1",
    "attached_pic",
    "-c:a",
    "copy",
    "-y",
    coverArtMp4,
  ],
  { encoding: "utf8" },
);
if (coverArtMp4Result.status !== 0) throw new Error(coverArtMp4Result.stderr);
const segmentResult = spawnSync(
  ffmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    tone,
    "-c:v",
    "mpeg2video",
    "-c:a",
    "mp2",
    "-f",
    "mpegts",
    "-y",
    fallbackLocalSegment,
  ],
  { encoding: "utf8" },
);
if (segmentResult.status !== 0) throw new Error(segmentResult.stderr);
const fallbackRequestsFile = path.join(
  fixtureDir,
  "fallback-segment-requests.json",
);
fs.writeFileSync(fallbackRequestsFile, "[]\n");
fs.writeFileSync(toolTracePath, "", { mode: 0o600 });
const wrapper = (realTool, toolKind) => `#!/usr/bin/env python3
import json, os, re, signal, subprocess, sys, time
REAL_TOOL = ${JSON.stringify(realTool)}
TOOL_KIND = ${JSON.stringify(toolKind)}
TOOL_TRACE = ${JSON.stringify(toolTracePath)}
READY = ${JSON.stringify(terminationReady)}
CANCEL_BETWEEN_READY = ${JSON.stringify(cancelBetweenReady)}
CODEC_PROBE_READY = ${JSON.stringify(codecProbeReady)}
GPU_FAILURE = ${JSON.stringify(gpuFailureMarker)}
if "--audit-descendant" in sys.argv:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    with open(READY, "w", encoding="utf-8") as file:
        json.dump({"pid": os.getpid(), "parentPid": os.getppid(), "pgid": os.getpgid(0)}, file)
    while True:
        time.sleep(1)
args = sys.argv[1:]
if TOOL_KIND == "ffprobe":
    input_path = next((arg for arg in reversed(args) if not arg.startswith("-")), "")
else:
    try:
        input_path = args[args.index("-i") + 1]
    except (ValueError, IndexError):
        input_path = ""
input_name = os.path.basename(input_path)
if TOOL_KIND == "ffmpeg" and "-progress" not in args and "probe-unknown-caption" in input_name:
    sys.stderr.write("ROSI_FORCED_INCOMPLETE_CODEC_PROBE\\n")
    sys.exit(1)
if TOOL_KIND == "ffmpeg" and "-progress" not in args and "cancel-between-2" in input_name:
    with open(CANCEL_BETWEEN_READY, "w", encoding="utf-8") as file:
        file.write(input_name)
    while True:
        time.sleep(1)
if TOOL_KIND == "ffmpeg" and "-progress" not in args and (
    "cancel-probe" in input_name or "cancel-same-extension-list-2" in input_name
):
    with open(CODEC_PROBE_READY, "w", encoding="utf-8") as file:
        file.write(input_name)
    while True:
        time.sleep(1)
if TOOL_KIND == "ffmpeg" and "-c:v" in args and args[args.index("-c:v") + 1] == "h264_nvenc":
    with open(GPU_FAILURE, "w", encoding="utf-8") as file:
        file.write(input_name)
    sys.stderr.write("ROSI_FORCED_GPU_INIT_FAILURE\\n")
    sys.exit(1)
if TOOL_KIND == "ffmpeg" and "-progress" in args and (
    "caption-enumeration-failure" in input_name or "caption-identity-race" in input_name
):
    result = subprocess.run([REAL_TOOL] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode == 0 and "caption-enumeration-failure" in input_name:
        with open(${JSON.stringify(captionEnumerationReady)}, "w", encoding="utf-8") as file:
            file.write(input_name)
        while not os.path.exists(${JSON.stringify(captionEnumerationRelease)}):
            time.sleep(0.025)
    if result.returncode == 0 and "caption-identity-race" in input_name:
        with open(${JSON.stringify(captionRaceReady)}, "w", encoding="utf-8") as file:
            file.write(input_name)
        while not os.path.exists(${JSON.stringify(captionRaceRelease)}):
            time.sleep(0.025)
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    sys.exit(result.returncode)
if TOOL_KIND == "ffmpeg" and "-progress" in args:
    if os.path.basename(input_path).startswith("trigger-cancel-tree"):
        subprocess.Popen([sys.executable, __file__, "--audit-descendant"])
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        while True:
            time.sleep(1)
    if os.path.basename(input_path).startswith("large-output"):
        line = b"AUDIT_LARGE_LINE_HEAD:" + ("é" * 524288).encode("utf-8") + b":AUDIT_LARGE_LINE_TAIL\\n"
        for descriptor in (1, 2):
            view = memoryview(line)
            while view:
                view = view[os.write(descriptor, view):]
trace_needed = any(marker in input_path for marker in ("fallback-escape", "ffprobe-escape", "audio-ok"))
if trace_needed:
    safe_args = []
    redact_next = False
    for argument in args:
        if redact_next:
            safe_args.append("<redacted>")
            redact_next = False
        elif argument in ("-cookies", "-headers"):
            safe_args.append(argument)
            redact_next = True
        else:
            safe_args.append(re.sub(
                r"([A-Za-z][A-Za-z0-9+.-]*://)[^/@\\s]+@",
                r"\\1<redacted>@",
                argument,
                flags=re.IGNORECASE,
            ))
    protocol_whitelists = [args[index + 1] for index, argument in enumerate(args[:-1]) if argument == "-protocol_whitelist"]
    input_arguments = [args[index + 1] for index, argument in enumerate(args[:-1]) if argument == "-i"]
    executed_args = list(args)
    diagnostic_override = None
    # yt-dlp deliberately uses quiet logging for this fallback. Keep the
    # production argv in the trace, but make the test-owned launcher request
    # the protocol error text so the native rejection is independently
    # auditable. This never changes the app command or the enforced whitelist.
    if TOOL_KIND == "ffmpeg" and "fallback-escape" in input_path and "-loglevel" in executed_args:
        executed_args[executed_args.index("-loglevel") + 1] = "error"
        diagnostic_override = "loglevel:error"
    result = subprocess.run([REAL_TOOL] + executed_args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    event = {
        "toolKind": TOOL_KIND,
        "pid": os.getpid(),
        "input": input_path,
        "inputArguments": input_arguments,
        "protocolWhitelists": protocol_whitelists,
        "arguments": safe_args,
        "executedArguments": [
            re.sub(r"([A-Za-z][A-Za-z0-9+.-]*://)[^/@\\s]+@", r"\\1<redacted>@", argument)
            for argument in executed_args
        ],
        "diagnosticOverride": diagnostic_override,
        "exitCode": result.returncode,
        "stderrTail": result.stderr.decode("utf-8", errors="replace")[-4096:],
    }
    with open(TOOL_TRACE, "a", encoding="utf-8") as file:
        file.write(json.dumps(event, ensure_ascii=False) + "\\n")
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    sys.exit(result.returncode)
os.execv(REAL_TOOL, [REAL_TOOL] + args)
`;
const helperProbe = path.join(fixtureDir, "ffprobe");
fs.writeFileSync(helper, wrapper(ffmpeg, "ffmpeg"), { mode: 0o700 });
fs.writeFileSync(helperProbe, wrapper(ffprobeBinary, "ffprobe"), {
  mode: 0o700,
});
fs.mkdirSync(gpuProbeADirectory, { recursive: true });
fs.mkdirSync(gpuProbeBDirectory, { recursive: true });
const gpuProbeWrapper = (
  readyPath,
  releasePath,
  tracePath,
  vendor,
) => `#!/usr/bin/env python3
import json, os, sys, time
READY = ${JSON.stringify(readyPath)}
RELEASE = ${JSON.stringify(releasePath)}
TRACE = ${JSON.stringify(tracePath)}
VENDOR = ${JSON.stringify(vendor)}
args = sys.argv[1:]
try:
    encoder = args[args.index("-c:v") + 1]
except (ValueError, IndexError):
    encoder = ""
if encoder == "h264_nvenc":
    if VENDOR == "a":
        with open(READY, "w", encoding="utf-8") as file:
            file.write("started\\n")
        while not os.path.exists(RELEASE):
            time.sleep(0.02)
        sys.exit(0)
    with open(TRACE, "a", encoding="utf-8") as file:
        file.write(json.dumps({"encoder": encoder, "arguments": args}) + "\\n")
sys.exit(1)
`;
fs.writeFileSync(
  gpuProbeA,
  gpuProbeWrapper(gpuProbeAReady, gpuProbeARelease, gpuProbeBTrace, "a"),
  { mode: 0o700 },
);
fs.writeFileSync(
  gpuProbeB,
  gpuProbeWrapper(gpuProbeAReady, gpuProbeARelease, gpuProbeBTrace, "b"),
  { mode: 0o700 },
);

const settingsPath = path.join(profile.dataDir, "settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
settings.ffmpegPath = helper;
settings.hookBrowser = true;
settings.browserChoice = "firefox";
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

function createFirefoxCookieProfile(home) {
  const root =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Firefox")
      : path.join(home, ".mozilla", "firefox");
  const profileRoot =
    process.platform === "darwin" ? path.join(root, "Profiles") : root;
  const profileName = "rosi-audit.default-release";
  const relativeProfilePath =
    process.platform === "darwin"
      ? path.join("Profiles", profileName)
      : profileName;
  const directory = path.join(profileRoot, profileName);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(root, "profiles.ini"),
    `[Profile0]\nName=ROSI isolated audit\nIsRelative=1\nPath=${relativeProfilePath}\nDefault=1\n[General]\nStartWithLastProfile=1\nVersion=2\n`,
  );
  const database = path.join(directory, "cookies.sqlite");
  const sql = `
import sqlite3, sys, time
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0, sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0, partitionKey TEXT DEFAULT '')")
now = int(time.time())
db.execute("INSERT INTO moz_cookies (originAttributes,name,value,host,path,expiry,lastAccessed,creationTime,isSecure,isHttpOnly,inBrowserElement,sameSite,rawSameSite,schemeMap,partitionKey) VALUES ('','rosi_audit_cookie','browser-session-secret','127.0.0.1','/',?, ?, ?,0,0,0,0,0,0,'')", (now + 86400, now * 1000000, now * 1000000))
db.commit()
db.close()
`;
  const created = spawnSync("python3", ["-c", sql, database], {
    encoding: "utf8",
  });
  if (created.status !== 0) {
    throw new Error(
      `Could not seed isolated Firefox cookies: ${created.stderr}`,
    );
  }
  return database;
}

const cookieDatabase = createFirefoxCookieProfile(profile.home);
const mediaRoutes = {
  "/broken.mp4": { body: deterministicBytes(8192, "repair-broken") },
  "/collision.mp4": { file: tone },
  "/same-title.mp4": { file: tone },
  "/same-title.webm": { file: vp8, contentType: "video/webm" },
  "/a.mp4": { file: tone },
  "/b.mp4": { file: tone },
  "/cancel-between-first.mp4": { file: tone },
  "/cancel-between-second.mp4": { file: tone },
  "/cancel-ytdlp-first.mp4": { file: tone },
  "/cancel-ytdlp-second.mp4": {
    body: deterministicBytes(8 * 1024 * 1024, "audit3-cancel-ytdlp"),
    slow: true,
  },
  "/already-target.mp4": { file: tone },
  "/cancel-probe.webm": { file: vp8, contentType: "video/webm" },
  "/subtitled-source.mkv": {
    file: subtitledMatroska,
    contentType: "video/x-matroska",
  },
  "/mixed-video-tracks.mkv": {
    file: mixedTracksMatroska,
    contentType: "video/x-matroska",
  },
  "/cover-art-source.mp4": {
    file: coverArtMp4,
    contentType: "video/mp4",
  },
  "/probe-unknown-caption.mkv": {
    file: subtitledMatroska,
    contentType: "video/x-matroska",
  },
  "/caption-enumeration-failure.mkv": {
    file: plainMatroska,
    contentType: "video/x-matroska",
    slow: true,
  },
  "/caption-identity-race.mkv": {
    file: plainMatroska,
    contentType: "video/x-matroska",
    slow: true,
  },
  "/sidecar-source.mkv": {
    file: plainMatroska,
    contentType: "video/x-matroska",
    slow: true,
  },
  "/audio-sidecar-source.mkv": {
    file: plainMatroska,
    contentType: "video/x-matroska",
    slow: true,
  },
  "/trigger-cancel-tree.mp4": { file: tone },
  "/large-output.mp4": { file: tone },
  "/force-gpu-fail.webm": { file: vp8, contentType: "video/webm" },
  "/cancel-probe.webm": { file: vp8, contentType: "video/webm" },
  "/vp8.webm": { file: vp8, contentType: "video/webm" },
  "/list.html": {
    body: Buffer.from(
      '<!doctype html><title>Audit Playlist</title><video src="a.mp4"></video><video src="b.mp4"></video>',
    ),
    contentType: "text/html",
  },
  "/partial-list.html": {
    body: Buffer.from(
      '<!doctype html><title>Partial repair list</title><video src="/a.mp4"></video><video src="/broken.mp4"></video>',
    ),
    contentType: "text/html",
  },
  "/cancel-between.html": {
    body: Buffer.from(
      '<!doctype html><title>Cancel between entries</title><video src="/cancel-between-first.mp4"></video><video src="/cancel-between-second.mp4"></video>',
    ),
    contentType: "text/html",
  },
  "/partial-download-list.html": {
    body: Buffer.from(
      '<!doctype html><title>Audit 3 partial download failure</title><video src="/cancel-ytdlp-first.mp4"></video><video src="/missing-audit3-entry.mp4"></video>',
    ),
    contentType: "text/html",
  },
  "/cancel-download-list.html": {
    body: Buffer.from(
      '<!doctype html><title>Audit 3 cancellation during playlist download</title><video src="/cancel-ytdlp-first.mp4"></video><video src="/cancel-ytdlp-second.mp4"></video>',
    ),
    contentType: "text/html",
  },
  "/cancel-same-extension-list.html": {
    body: Buffer.from(
      '<!doctype html><title>Audit 3 same extension cancellation</title><video src="/already-target.mp4"></video><video src="/cancel-probe.webm"></video>',
    ),
    contentType: "text/html",
  },
  "/slow.mp4": {
    body: deterministicBytes(8 * 1024 * 1024, "repair-slow"),
    slow: true,
  },
  "/plain-source.mkv": {
    file: plainMatroska,
    contentType: "video/x-matroska",
  },
  "/slow.html": {
    body: Buffer.from(
      '<!doctype html><title>Slow repair preview</title><video src="a.mp4"></video>' +
        " ".repeat(8 * 1024 * 1024),
    ),
    contentType: "text/html",
    slow: true,
  },
};
const mediaServer = await startMediaServer(mediaRoutes);
const fallbackSegmentServer = http.createServer((request, response) => {
  const requests = JSON.parse(fs.readFileSync(fallbackRequestsFile, "utf8"));
  requests.push({ method: request.method, path: request.url });
  fs.writeFileSync(
    fallbackRequestsFile,
    `${JSON.stringify(requests, null, 2)}\n`,
  );
  const bytes = fs.readFileSync(fallbackLocalSegment);
  response.writeHead(200, {
    "Content-Type": "video/mp2t",
    "Content-Length": String(bytes.length),
  });
  response.end(bytes);
});
await new Promise((resolve) =>
  fallbackSegmentServer.listen(0, "127.0.0.1", resolve),
);
const fallbackSegmentUrl = `http://127.0.0.1:${fallbackSegmentServer.address().port}/nested.ts`;
mediaRoutes["/fallback-escape.m3u8"] = {
  body: Buffer.from(
    `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n` +
      `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="${pathToFileURL(fallbackLocalSegment).href}"\n` +
      `#EXTINF:1,\n${fallbackSegmentUrl}\n#EXT-X-ENDLIST\n`,
  ),
  contentType: "application/vnd.apple.mpegurl",
};
const nestedProbePlaylist = path.join(profile.downloads, "nested-probe.m3u8");
fs.writeFileSync(
  nestedProbePlaylist,
  `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n` +
    `#EXTINF:1,\n${fallbackSegmentUrl}\n#EXT-X-ENDLIST\n`,
);
const ffconcatHeader = Buffer.from(
  "ffconcat version 1.0\nfile nested-probe.m3u8\n",
);
const ffconcatComments = Buffer.from(`${"#" + "x".repeat(4094)}\n`.repeat(64));
mediaRoutes["/ffprobe-escape.m4a"] = {
  body: Buffer.concat([ffconcatHeader, ffconcatComments]),
  contentType: "audio/mp4",
  slow: true,
};
mediaRoutes["/audio-ok.m4a"] = { file: audioOnly, contentType: "audio/mp4" };

const authRequests = [];
const authServer = http.createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  const authorized =
    request.headers.cookie?.includes(
      "rosi_audit_cookie=browser-session-secret",
    ) ?? false;
  authRequests.push({ path: url.pathname, authorized });
  fs.writeFileSync(
    authRequestsFile,
    `${JSON.stringify(authRequests, null, 2)}\n`,
  );
  if (!authorized) {
    response.writeHead(403, { "Content-Type": "text/plain" });
    response.end("authentication required");
    return;
  }
  if (url.pathname === "/auth.html") {
    const page = Buffer.from(
      '<!doctype html><html><head><title>ROSI Authenticated Fixture</title></head><body><video src="/auth.mp4"></video></body></html>',
    );
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(page.length),
    });
    response.end(page);
    return;
  }
  if (url.pathname === "/auth.mp4") {
    const bytes = fs.readFileSync(tone);
    response.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": String(bytes.length),
      "Accept-Ranges": "bytes",
    });
    response.end(bytes);
    return;
  }
  response.writeHead(404);
  response.end("not found");
});
await new Promise((resolve) => authServer.listen(0, "127.0.0.1", resolve));
const authenticatedMedia = `http://127.0.0.1:${authServer.address().port}`;

const startedAt = new Date().toISOString();
let exitCode = 1;
try {
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["wdio", "run", "e2e/wdio.conf.js"],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          ...profile.env,
          ROSI_E2E_BINARY: binary,
          ROSI_E2E_SPECS: e2eSpec,
          ROSI_E2E_PROCESS_REPAIRS: "1",
          ROSI_E2E_DOWNLOADS: profile.downloads,
          ROSI_REPAIRS_DIRECTORY: artifactDir,
          ROSI_REPAIRS_MEDIA: mediaServer.baseUrl,
          ROSI_REPAIRS_AUTH_MEDIA: authenticatedMedia,
          ROSI_REPAIRS_AUTH_REQUESTS_FILE: authRequestsFile,
          ROSI_REPAIRS_TERMINATION_READY: terminationReady,
          ROSI_REPAIRS_CANCEL_BETWEEN_READY: cancelBetweenReady,
          ROSI_REPAIRS_CODEC_PROBE_READY: codecProbeReady,
          ROSI_AUDIT3_CAPTION_ENUMERATION_READY: captionEnumerationReady,
          ROSI_AUDIT3_CAPTION_ENUMERATION_RELEASE: captionEnumerationRelease,
          ROSI_AUDIT3_CAPTION_RACE_READY: captionRaceReady,
          ROSI_AUDIT3_CAPTION_RACE_RELEASE: captionRaceRelease,
          ROSI_REPAIRS_GPU_FAILURE_MARKER: gpuFailureMarker,
          ROSI_AUDIT3_GPU_PROBE_A: gpuProbeA,
          ROSI_AUDIT3_GPU_PROBE_B: gpuProbeB,
          ROSI_AUDIT3_GPU_PROBE_A_READY: gpuProbeAReady,
          ROSI_AUDIT3_GPU_PROBE_A_RELEASE: gpuProbeARelease,
          ROSI_AUDIT3_GPU_PROBE_B_TRACE: gpuProbeBTrace,
          ROSI_AUDIT3_FAILURE_MODES: path.join(
            REPO_ROOT,
            "e2e",
            "audit3-native-failure-modes.md",
          ),
          ROSI_AUDIT3_REAL_FFPROBE: ffprobeBinary,
          ROSI_AUDIT3_SIDECAR_FIXTURE: sidecarSrt,
          ROSI_AUDIT3_AUDIO_SIDECAR_FIXTURE: audioSidecarSrt,
          ROSI_REPAIRS_FFMPEG: helper,
          ROSI_REPAIRS_FALLBACK_LOCAL_SEGMENT: fallbackLocalSegment,
          ROSI_REPAIRS_FALLBACK_REQUESTS_FILE: fallbackRequestsFile,
          ROSI_REPAIRS_TOOL_TRACE: toolTracePath,
          ROSI_REPAIRS_MALFORMED_LAUNCHER: malformedLauncherPath,
          ROSI_E2E_PROXY_TRACE: proxyTracePath,
          PATH: repairPath,
          ROSI_E2E_ALLOW_LOOPBACK: "1",
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await mediaServer.close();
  await new Promise((resolve) => {
    fallbackSegmentServer.closeAllConnections?.();
    fallbackSegmentServer.close(resolve);
  });
  await new Promise((resolve) => {
    authServer.closeAllConnections?.();
    authServer.close(resolve);
  });
  const evidence = path.join(artifactDir, "profile-evidence");
  fs.mkdirSync(evidence, { recursive: true });
  for (const relative of [
    "settings.json",
    "download-activity.json",
    "download-queue.json",
    "download-stats.json",
    "logs/rosi.log",
  ]) {
    const source = path.join(profile.dataDir, relative);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(evidence, path.basename(relative)));
    }
  }

  // Keep enough synthetic input and output bytes to audit the process and
  // no-overwrite claims after the disposable profile is removed. The manifest
  // contains only relative paths, byte counts, and SHA-256 digests.
  const retainedRoot = path.join(artifactDir, "retained-artifacts");
  const retainedEntries = [];
  function retainTree(sourceRoot, label) {
    if (!fs.existsSync(sourceRoot)) return;
    const visit = (sourceDirectory, relativeDirectory = "") => {
      for (const entry of fs
        .readdirSync(sourceDirectory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))) {
        const sourcePath = path.join(sourceDirectory, entry.name);
        const relativePath = path.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
          visit(sourcePath, relativePath);
        } else if (entry.isFile()) {
          const artifactRelativePath = path.join(label, relativePath);
          const artifactPath = path.join(retainedRoot, artifactRelativePath);
          fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
          fs.copyFileSync(sourcePath, artifactPath);
          const bytes = fs.readFileSync(artifactPath);
          retainedEntries.push({
            source: `${label}/${relativePath.split(path.sep).join("/")}`,
            path: artifactRelativePath.split(path.sep).join("/"),
            sizeBytes: bytes.length,
            sha256: sha256(bytes),
          });
        }
      }
    };
    visit(sourceRoot);
  }
  retainTree(fixtureDir, "fixtures");
  retainTree(profile.downloads, "downloads");
  const retainedCookieDatabase = path.join(
    retainedRoot,
    "synthetic-firefox-profile",
    "cookies.sqlite",
  );
  fs.mkdirSync(path.dirname(retainedCookieDatabase), { recursive: true });
  fs.copyFileSync(cookieDatabase, retainedCookieDatabase);
  const cookieBytes = fs.readFileSync(retainedCookieDatabase);
  retainedEntries.push({
    source: "synthetic-firefox-profile/cookies.sqlite",
    path: "synthetic-firefox-profile/cookies.sqlite",
    sizeBytes: cookieBytes.length,
    sha256: sha256(cookieBytes),
  });
  retainedEntries.sort((left, right) => left.path.localeCompare(right.path));
  const retainedManifest = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    entries: retainedEntries,
  };
  const retainedManifestBytes = Buffer.from(
    `${JSON.stringify(retainedManifest, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(retainedRoot, "manifest.json"),
    retainedManifestBytes,
  );

  const observationsPath = path.join(artifactDir, "observations.json");
  const observations = fs.existsSync(observationsPath)
    ? JSON.parse(fs.readFileSync(observationsPath, "utf8"))
    : [];
  const authTrace = fs.existsSync(authRequestsFile)
    ? JSON.parse(fs.readFileSync(authRequestsFile, "utf8"))
    : authRequests;
  const proxyDecisions = fs.existsSync(proxyTracePath)
    ? fs
        .readFileSync(proxyTracePath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const report = {
    app: "ROSI",
    version: JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ).version,
    commit: spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).stdout.trim(),
    startedAt,
    finishedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    exitCode,
    binarySha256: sha256(fs.readFileSync(binary)),
    realFfmpegSha256: sha256(fs.readFileSync(ffmpeg)),
    realFfprobeSha256: sha256(fs.readFileSync(ffprobeBinary)),
    helperFfmpegSha256: sha256(fs.readFileSync(helper)),
    helperFfprobeSha256: sha256(fs.readFileSync(helperProbe)),
    firefoxCookieDatabaseSha256: sha256(fs.readFileSync(cookieDatabase)),
    probeSourceSha256: {
      runner: sha256(fs.readFileSync(scriptPath)),
      spec: sha256(
        fs.readFileSync(
          path.resolve(REPO_ROOT, "e2e", e2eSpec.replace(/^\.\//, "")),
        ),
      ),
      failureModes: sha256(
        fs.readFileSync(
          path.join(REPO_ROOT, "e2e", "download-process-repairs.failures.md"),
        ),
      ),
      audit3FailureModes: sha256(
        fs.readFileSync(
          path.join(REPO_ROOT, "e2e", "audit3-native-failure-modes.md"),
        ),
      ),
    },
    fixtureSha256: {
      tone: sha256(fs.readFileSync(tone)),
      vp8: sha256(fs.readFileSync(vp8)),
      audioOnly: sha256(fs.readFileSync(audioOnly)),
      plainMatroska: sha256(fs.readFileSync(plainMatroska)),
      subtitledMatroska: sha256(fs.readFileSync(subtitledMatroska)),
      mixedTracksMatroska: sha256(fs.readFileSync(mixedTracksMatroska)),
      coverArtJpeg: sha256(fs.readFileSync(coverArtJpeg)),
      coverArtMp4: sha256(fs.readFileSync(coverArtMp4)),
      embeddedSubtitleSrt: sha256(fs.readFileSync(embeddedSubtitleSrt)),
      fallbackLocalSegment: sha256(fs.readFileSync(fallbackLocalSegment)),
    },
    toolInvocations: fs
      .readFileSync(toolTracePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    retainedArtifacts: {
      manifestPath: "retained-artifacts/manifest.json",
      manifestSha256: sha256(retainedManifestBytes),
      entryCount: retainedEntries.length,
    },
    observations,
    mediaRequests: mediaServer.requests,
    authenticatedRequests: authTrace,
    proxyDecisions,
    fallbackSegmentRequests: JSON.parse(
      fs.readFileSync(fallbackRequestsFile, "utf8"),
    ),
  };
  report.reportSha256 = sha256(Buffer.from(JSON.stringify(report, null, 2)));
  fs.writeFileSync(
    path.join(artifactDir, "repair-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  fs.rmSync(profile.profileDir, { recursive: true, force: true });
}
process.exitCode = exitCode === 0 ? 0 : 1;
