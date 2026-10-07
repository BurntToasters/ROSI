import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createE2eProfile,
  e2eBinaryPath,
  e2eStampPath,
  REPO_ROOT,
} from "./helpers/profile.js";

const stampContents = "e2e-feature-1\n";
const binary = e2eBinaryPath();
const stamp = e2eStampPath();
const expectedObservations = [
  "download-only-final-placement",
  "download-failure-cleans-staging",
  "download-cancel-cleans-staging",
  "download-retry-cleans-staging",
  "download-staging-preserves-arrival",
  "source-identity-preserves-replacement",
  "deno-version-probe",
  "activity-clear-persist-failure-preserves-memory",
  "activity-clear-durable-retry",
  "activity-byte-budget-preserves-newest",
  "close-ack-survives-async-shutdown",
  "windows-job-object-leader-exit",
];
if (
  !fs.existsSync(binary) ||
  !fs.existsSync(stamp) ||
  fs.readFileSync(stamp, "utf8") !== stampContents ||
  fs.statSync(stamp).mtimeMs < fs.statSync(binary).mtimeMs
) {
  throw new Error(
    "Build a fresh E2E binary before this probe; use the round 2 native spec in the E2E gate.",
  );
}

const override = process.env.ROSI_ROUND2_NATIVE_FFMPEG;
const lookup = override
  ? null
  : spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], {
      encoding: "utf8",
      windowsHide: true,
    });
const realFfmpeg = override
  ? path.resolve(override)
  : lookup?.status === 0
    ? lookup.stdout.split(/\r?\n/).find(Boolean)?.trim()
    : null;
if (!realFfmpeg || !fs.existsSync(realFfmpeg)) {
  throw new Error(
    "A real FFmpeg executable is required for the native conversion path.",
  );
}

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const artifactDirectory = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "round2-native",
  runId,
);
fs.mkdirSync(artifactDirectory, { recursive: true });
const profile = createE2eProfile();
const fixtureDirectory = path.join(profile.profileDir, "round2-native");
fs.mkdirSync(fixtureDirectory, { recursive: true });
const tone = path.join(fixtureDirectory, "round2-tone.mp4");
const toneResult = spawnSync(
  realFfmpeg,
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
    "mpeg4",
    "-c:a",
    "aac",
    "-y",
    tone,
  ],
  { encoding: "utf8", windowsHide: true },
);
if (toneResult.status !== 0) throw new Error(toneResult.stderr);

const replacementReady = path.join(fixtureDirectory, "replacement-ready.json");
const replacementRelease = path.join(fixtureDirectory, "replacement-release");
const realFfmpegPath = fs.realpathSync(realFfmpeg);
const wrapper = path.join(
  fixtureDirectory,
  process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
);
if (process.platform !== "win32") {
  const python = spawnSync("which", ["python3"], { encoding: "utf8" });
  const pythonPath =
    python.status === 0 ? python.stdout.trim() : "/usr/bin/python3";
  const script = `#!${pythonPath}
import json, os, subprocess, sys, time
REAL = ${JSON.stringify(realFfmpegPath)}
READY = ${JSON.stringify(replacementReady)}
RELEASE = ${JSON.stringify(replacementRelease)}
args = sys.argv[1:]
try:
    input_path = args[args.index("-i") + 1]
except (ValueError, IndexError):
    input_path = ""
if "-progress" in args and "replace-source" in os.path.basename(input_path):
    result = subprocess.run([REAL] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    temporary = READY + ".tmp"
    with open(temporary, "w", encoding="utf-8") as marker:
        json.dump({"input": input_path, "exitCode": result.returncode}, marker)
    os.replace(temporary, READY)
    deadline = time.monotonic() + 45
    while not os.path.exists(RELEASE) and time.monotonic() < deadline:
        time.sleep(0.02)
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    sys.exit(result.returncode if os.path.exists(RELEASE) else 91)
os.execv(REAL, [REAL] + args)
`;
  fs.writeFileSync(wrapper, script, { mode: 0o700 });
  fs.chmodSync(wrapper, 0o700);
} else {
  // The standard Windows helper is an executable, and this probe deliberately
  // avoids compiling a test wrapper. Conversion still exercises the native
  // application path; the report marks source-replacement coverage unavailable.
  fs.copyFileSync(realFfmpegPath, wrapper);
}

const denoPath = path.join(
  profile.home,
  ".deno",
  "bin",
  process.platform === "win32" ? "deno.exe" : "deno",
);
fs.mkdirSync(path.dirname(denoPath), { recursive: true });
if (process.platform === "win32") {
  fs.writeFileSync(denoPath, "", { mode: 0o600 });
} else {
  fs.writeFileSync(denoPath, "#!/bin/sh\necho unrelated-tool 1.0\n", {
    mode: 0o700,
  });
  fs.chmodSync(denoPath, 0o700);
}

const settingsPath = path.join(profile.dataDir, "settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
settings.ffmpegPath = wrapper;
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

const activitySeedPath = path.join(profile.dataDir, "download-activity.json");
const activitySeed = createActivitySeed(profile);
fs.writeFileSync(
  activitySeedPath,
  `${JSON.stringify(activitySeed, null, 2)}\n`,
);
const activitySeedBytes = fs.statSync(activitySeedPath).size;
const activitySeedSha256 = sha256(fs.readFileSync(activitySeedPath));
if (activitySeedBytes >= 16 * 1024 * 1024) {
  throw new Error("The native activity seed must fit below the reader limit.");
}

const observationsPath = path.join(artifactDirectory, "observations.json");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const startedAt = new Date().toISOString();
const wdio = spawnSync(npx, ["wdio", "run", "e2e/wdio.conf.js"], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    ...profile.env,
    ROSI_E2E_BINARY: binary,
    ROSI_E2E_SPECS: "./round2-native.spec.js",
    ROSI_E2E_DOWNLOADS: profile.downloads,
    ROSI_E2E_DATA_DIR: profile.dataDir,
    ROSI_ROUND2_NATIVE_ARTIFACTS: artifactDirectory,
    ROSI_ROUND2_NATIVE_TONE: tone,
    ROSI_ROUND2_NATIVE_FFMPEG_WRAPPER: wrapper,
    ROSI_ROUND2_NATIVE_REPLACEMENT_READY: replacementReady,
    ROSI_ROUND2_NATIVE_REPLACEMENT_RELEASE: replacementRelease,
    ROSI_ROUND2_NATIVE_DENO: denoPath,
    ROSI_ROUND2_NATIVE_ACTIVITY_SEED_BYTES: String(activitySeedBytes),
    ROSI_E2E_DENO_PROBE_DIR: path.dirname(denoPath),
    ROSI_E2E_CLOSE_SHUTDOWN_DELAY_MS: "2200",
  },
  stdio: "inherit",
  windowsHide: true,
  shell: process.platform === "win32",
  encoding: "utf8",
});

const observed = fs.existsSync(observationsPath)
  ? JSON.parse(fs.readFileSync(observationsPath, "utf8"))
  : [];
const reportBody = {
  app: "ROSI",
  suite: "round2-native",
  schemaVersion: 1,
  scenario: "round2-native",
  runId,
  version: JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  ).version,
  platform: process.platform,
  arch: process.arch,
  startedAt,
  finishedAt: new Date().toISOString(),
  binary: path.relative(REPO_ROOT, binary).split(path.sep).join("/"),
  binarySha256: sha256(fs.readFileSync(binary)),
  ffmpegSha256: sha256(fs.readFileSync(realFfmpegPath)),
  probeSources: Object.fromEntries(
    ["e2e/round2-native.spec.js", "e2e/round2-native-failure-modes.md"].map(
      (relativePath) => [
        relativePath,
        sha256(fs.readFileSync(path.join(REPO_ROOT, relativePath))),
      ],
    ),
  ),
  isolatedProfile: profile.profileDir,
  toneFixtureSha256: sha256(fs.readFileSync(tone)),
  activitySeed: path.basename(activitySeedPath),
  activitySeedBytes,
  activitySeedSha256,
  windowsSourceReplacementWrapper: process.platform !== "win32",
  windowsJobObjectLeaderExit: {
    status: "unproven",
    reason:
      "This suite does not force a real app helper leader to exit while a descendant keeps an inherited pipe open.",
  },
  wdioExitCode: wdio.status,
  wdioError: wdio.error?.message ?? null,
  observations: observed,
  failures: observed
    .filter((item) => item.invariantPassed === false)
    .map((item) => item.name),
  passed:
    wdio.status === 0 &&
    expectedObservations.every((name) => {
      const item = observed.find((observation) => observation.name === name);
      if (!item || item.invariantPassed !== true) return false;
      if (item.skipped !== true) return true;
      const windowsOnly = [
        "source-identity-preserves-replacement",
        "deno-version-probe",
      ].includes(name);
      const alwaysUnproven = name === "windows-job-object-leader-exit";
      return (
        (alwaysUnproven || (process.platform === "win32" && windowsOnly)) &&
        typeof item.skipReason === "string" &&
        item.skipReason.trim().length > 0
      );
    }) &&
    observed.every((item) => item.invariantPassed !== false),
};
const report = {
  ...reportBody,
  reportSha256: sha256(Buffer.from(JSON.stringify(reportBody, null, 2))),
};
const reportPath = path.join(artifactDirectory, "repair-report.json");
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
console.log(`Round 2 native evidence: ${reportPath}`);
console.log(`Isolated profile retained at: ${profile.profileDir}`);
if (!report.passed) process.exitCode = 1;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function createActivitySeed(profile) {
  const byteLimit = 16 * 1024 * 1024;
  const entryCount = 99;
  const pathCount = 41;
  const pathPrefix = `${profile.home}${path.sep}activity-budget`;
  let pathLength = 4080;
  let longPath;
  const setLongPath = () => {
    longPath =
      pathPrefix + "x".repeat(pathLength - Buffer.byteLength(pathPrefix));
    for (const record of records)
      record.outputPaths = Array(pathCount).fill(longPath);
  };
  const records = Array.from({ length: entryCount }, (_, index) => {
    const url = `https://activity.invalid/seed/${index}`;
    return {
      id: `round2-seed-${index.toString().padStart(3, "0")}`,
      owner: "manual",
      outcome: "success",
      statusMessage: `Seeded activity detail ${index}`,
      url,
      profile: "compatible",
      request: { url, outputPath: profile.downloads, profile: "compatible" },
      filename: `seed-${index}.mp4`,
      outputPaths: [],
      startedAt: 1,
      completedAt: 2,
    };
  });

  const serializedSize = () =>
    Buffer.byteLength(`${JSON.stringify(records, null, 2)}\n`);
  setLongPath();
  let size = serializedSize();
  const targetSize = byteLimit - 256;
  if (size > targetSize) {
    pathLength -= Math.ceil((size - targetSize) / (entryCount * pathCount)) + 1;
    setLongPath();
    size = serializedSize();
  }
  if (size > targetSize) {
    throw new Error(`Initial activity seed is too large (${size} bytes).`);
  }
  // Fill the remaining budget with ordinary status detail. The later real
  // app completions must push the exact writer snapshot over its read limit.
  let remaining = targetSize - size;
  for (const record of records) {
    const available = 2000 - record.statusMessage.length;
    const addition = Math.min(available, remaining);
    record.statusMessage += "x".repeat(addition);
    remaining -= addition;
    if (remaining === 0) break;
  }
  if (remaining > 0) {
    throw new Error(
      "Could not fill the activity seed close to its read limit.",
    );
  }
  return records;
}
