import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  createE2eProfile,
  e2eBinaryPath,
  e2eStampPath,
  REPO_ROOT,
} from "./helpers/profile.js";

const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const binary = e2eBinaryPath();
const stamp = e2eStampPath();
if (
  !fs.existsSync(binary) ||
  !fs.existsSync(stamp) ||
  fs.statSync(stamp).mtimeMs < fs.statSync(binary).mtimeMs
) {
  throw new Error(
    "Build a fresh E2E binary with npm run test:e2e before running audit four repairs.",
  );
}
// scripts/test-e2e.js sets ROSI_AUDIT4_ARTIFACT_ROOT to a path under
// e2e/artifacts so the evidence survives the run.
const directory = path.resolve(
  process.env.ROSI_AUDIT4_ARTIFACT_ROOT ??
    path.join(
      REPO_ROOT,
      "e2e",
      "artifacts",
      "audit4-repairs",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
    ),
);
fs.mkdirSync(directory, { recursive: true });
const ffmpeg =
  process.env.ROSI_AUDIT4_FFMPEG ??
  spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout.trim();
if (!ffmpeg) throw new Error("Audit four repairs require a real FFmpeg.");
const ffprobe =
  process.env.ROSI_AUDIT4_FFPROBE ?? path.join(path.dirname(ffmpeg), "ffprobe");
const profile = createE2eProfile({ ffmpegPath: ffmpeg });
const cover = path.join(directory, "cover.jpg");
const media = path.join(directory, "covered.mp4");
function generate(args) {
  const result = spawnSync(ffmpeg, ["-y", "-v", "error", ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
}
generate([
  "-f",
  "lavfi",
  "-i",
  "color=c=yellow:s=32x32",
  "-frames:v",
  "1",
  cover,
]);
generate([
  "-f",
  "lavfi",
  "-i",
  "testsrc=size=32x32:rate=10",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:duration=0.3",
  "-i",
  cover,
  "-map",
  "0:v",
  "-map",
  "1:a",
  "-map",
  "2:v",
  "-c:v:0",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-c:v:1",
  "copy",
  "-disposition:v:1",
  "attached_pic",
  "-t",
  "0.3",
  media,
]);
const server = http.createServer((req, res) => {
  const bytes = fs.readFileSync(media);
  res.writeHead(200, {
    "content-type": "video/mp4",
    "content-length": bytes.length,
  });
  res.end(bytes);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const specPath = path.join(REPO_ROOT, "e2e", "audit4-repairs.spec.js");
const env = {
  ...process.env,
  ...profile.env,
  ROSI_E2E_BINARY: binary,
  ROSI_E2E_SPECS: "./audit4-repairs.spec.js",
  ROSI_AUDIT4_ARTIFACTS: directory,
  ROSI_AUDIT4_FFPROBE: ffprobe,
  ROSI_AUDIT4_MEDIA: "http://127.0.0.1:" + server.address().port,
};
const startedAt = new Date().toISOString();
const child = spawn(
  process.execPath,
  [
    path.join(REPO_ROOT, "node_modules/@wdio/cli/bin/wdio.js"),
    "run",
    path.join(REPO_ROOT, "e2e/wdio.conf.js"),
  ],
  { cwd: path.join(REPO_ROOT, "e2e"), env, stdio: ["ignore", "pipe", "pipe"] },
);
const log = fs.createWriteStream(path.join(directory, "wdio.log"));
child.stdout.pipe(log);
child.stderr.pipe(log);
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
}, 240_000);
const code = await new Promise((resolve) => child.once("exit", resolve));
clearTimeout(timer);
await new Promise((resolve) => log.end(resolve));
server.close();
const report = {
  app: "ROSI",
  directory: path.relative(REPO_ROOT, directory).split(path.sep).join("/"),
  profile: profile.profileDir,
  exitCode: code,
  timedOut,
  startedAt,
  binarySha256: sha256(fs.readFileSync(binary)),
  specSha256: sha256(fs.readFileSync(specPath)),
  runnerSha256: sha256(fs.readFileSync(new URL(import.meta.url))),
  observationsPresent: fs.existsSync(
    path.join(directory, "native-observations.json"),
  ),
  finishedAt: new Date().toISOString(),
};
report.reportSha256 = sha256(Buffer.from(JSON.stringify(report, null, 2)));
fs.writeFileSync(
  path.join(directory, "result.json"),
  JSON.stringify(report, null, 2) + "\n",
);
fs.rmSync(profile.profileDir, { recursive: true, force: true });
console.log(JSON.stringify(report));
process.exitCode =
  code === 0 && !timedOut && report.observationsPresent ? 0 : 1;
