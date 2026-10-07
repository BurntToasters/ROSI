import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  createE2eProfile,
  e2eBinaryPath,
  e2eStampPath,
  REPO_ROOT,
} from "../helpers/profile.js";
import {
  startMediaServer,
  deterministicBytes,
} from "../helpers/media-server.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const securityOnly = process.argv.includes("--security");
const uiOnly = process.argv.includes("--ui");
const terminationOnly = process.argv.includes("--termination");
if ([securityOnly, uiOnly, terminationOnly].filter(Boolean).length > 1) {
  throw new Error("Choose at most one of --security, --ui, or --termination.");
}
const resolvedAddresses = securityOnly
  ? await dnsLookup("localtest.me", { all: true })
  : [];
if (
  securityOnly &&
  (resolvedAddresses.length === 0 ||
    resolvedAddresses.some(
      ({ address }) => !["127.0.0.1", "::1"].includes(address),
    ))
) {
  throw new Error(
    "The security probe requires localtest.me to resolve exclusively to loopback.",
  );
}
const artifactDirectory = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "audit-v5-beta2",
);
const directory = securityOnly
  ? path.join(artifactDirectory, "security-probe")
  : uiOnly
    ? path.join(artifactDirectory, "ui-probe")
    : terminationOnly
      ? path.join(artifactDirectory, "termination-probe")
      : artifactDirectory;
fs.mkdirSync(directory, { recursive: true });
fs.rmSync(path.join(directory, "observations.json"), { force: true });
const binary = e2eBinaryPath();
const stamp = e2eStampPath();
if (
  !fs.existsSync(binary) ||
  !fs.existsSync(stamp) ||
  fs.readFileSync(stamp, "utf8") !== "e2e-feature-1\n" ||
  fs.statSync(stamp).mtimeMs < fs.statSync(binary).mtimeMs
) {
  throw new Error(
    "Build a fresh E2E binary with npm run test:e2e before running the audit probes.",
  );
}
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const lookup = spawnSync("which", ["ffmpeg"], { encoding: "utf8" });
const ffmpeg = lookup.stdout.trim();
if (!ffmpeg || !fs.existsSync(ffmpeg))
  throw new Error("Real FFmpeg is required.");
const profile = createE2eProfile({ ffmpegPath: ffmpeg });
const fixtures = path.join(profile.profileDir, "fixtures");
fs.mkdirSync(fixtures, { recursive: true });
let terminationHelper = "";
let terminationReady = "";
if (terminationOnly) {
  terminationHelper = path.join(fixtures, "ffmpeg");
  terminationReady = path.join(fixtures, "termination-ready.json");
  fs.writeFileSync(
    terminationHelper,
    `#!/usr/bin/python3
import json, os, signal, subprocess, sys, time
ready = ${JSON.stringify(terminationReady)}
if "--audit-descendant" in sys.argv:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    with open(ready, "w") as file:
        json.dump({"pid": os.getpid(), "parentPid": os.getppid(), "pgid": os.getpgid(0)}, file)
    while True:
        time.sleep(1)
elif len(sys.argv) > 1 and sys.argv[1] == "-progress":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    subprocess.Popen([sys.executable, __file__, "--audit-descendant"])
    while True:
        time.sleep(1)
else:
    os.execv(${JSON.stringify(ffmpeg)}, [${JSON.stringify(ffmpeg)}] + sys.argv[1:])
`,
    { mode: 0o700 },
  );
}
function encode(file, codec) {
  const args = [
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
    file,
  ];
  const result = spawnSync(ffmpeg, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}
const tone = path.join(fixtures, "tone.mp4");
const vp8 = path.join(fixtures, "vp8.webm");
encode(tone, "mpeg4");
encode(vp8, "libvpx");
const server = await startMediaServer({
  "/broken.mp4": { body: deterministicBytes(8192, "audit-broken") },
  "/vp8.webm": { file: vp8, contentType: "video/webm" },
  "/a.mp4": { file: tone },
  "/b.mp4": { file: tone },
  "/audit-private.mp4": { file: tone },
  "/list.html": {
    body: Buffer.from(
      '<!doctype html><title>Audit Playlist</title><video src="a.mp4"></video><video src="b.mp4"></video>',
    ),
    contentType: "text/html",
  },
  "/slow.mp4": {
    body: deterministicBytes(8 * 1024 * 1024, "audit-slow"),
    slow: true,
  },
  "/slow.html": {
    body: Buffer.from(
      '<!doctype html><title>Slow audit preview</title><video src="a.mp4"></video>' +
        " ".repeat(8 * 1024 * 1024),
    ),
    contentType: "text/html",
    slow: true,
  },
});
const startedAt = new Date().toISOString();
let exitCode = null;
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
          ROSI_E2E_ALLOW_LOOPBACK: securityOnly ? "0" : "1",
          ROSI_E2E_BINARY: e2eBinaryPath(),
          ROSI_E2E_SPECS: "./audit-v5-beta2/audit.spec.js",
          ROSI_AUDIT_SECURITY_ONLY: securityOnly ? "1" : "0",
          ROSI_AUDIT_UI_ONLY: uiOnly ? "1" : "0",
          ROSI_AUDIT_TERMINATION_ONLY: terminationOnly ? "1" : "0",
          ROSI_AUDIT_TERMINATION_HELPER: terminationHelper,
          ROSI_AUDIT_TERMINATION_READY: terminationReady,
          ROSI_AUDIT_DIRECTORY: directory,
          ROSI_AUDIT_DOWNLOADS: profile.downloads,
          ROSI_AUDIT_MEDIA: server.baseUrl,
        },
      },
    );
    child.on("error", reject);
    child.on("exit", resolve);
  });
} finally {
  await server.close();
  const snapshots = path.join(directory, "profile-evidence");
  fs.mkdirSync(snapshots, { recursive: true });
  for (const name of [
    "settings.json",
    "download-activity.json",
    "download-queue.json",
    "download-stats.json",
    "logs/rosi.log",
  ]) {
    const source = path.join(profile.dataDir, name);
    if (!fs.existsSync(source)) continue;
    const target = path.join(snapshots, path.basename(name));
    fs.copyFileSync(source, target);
  }
  const observationsPath = path.join(directory, "observations.json");
  const observations = fs.existsSync(observationsPath)
    ? JSON.parse(fs.readFileSync(observationsPath, "utf8"))
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
    loopbackOverride: securityOnly ? "0" : "1",
    resolvedAddresses,
    customFfmpeg: { path: ffmpeg, sha256: hash(fs.readFileSync(ffmpeg)) },
    binarySha256: hash(fs.readFileSync(e2eBinaryPath())),
    probeSourceSha256: {
      runner: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
      spec: hash(fs.readFileSync(path.join(scriptDirectory, "audit.spec.js"))),
    },
    fixtureSha256: {
      tone: hash(fs.readFileSync(tone)),
      vp8: hash(fs.readFileSync(vp8)),
    },
    exitCode,
    observations,
    requests: server.requests,
  };
  report.reportSha256 = hash(JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(directory, "probe-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  fs.rmSync(profile.profileDir, { recursive: true, force: true });
}
process.exitCode = exitCode === 0 ? 0 : 1;
