// Runner for the V5 beta 2 deep audit probes. See failure-modes.md (written
// first) and README.md. Usage, after a fresh E2E build:
//   node e2e/audit-v5-beta2-deep/run.mjs [--only <mode>[,<mode>...]]
// Exit zero means every observation completed. Inspect each mode's
// `invariantPassed`; false is a reproduced product defect.
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  createE2eProfile,
  e2eBinaryPath,
  e2eStampPath,
  REPO_ROOT,
} from "../helpers/profile.js";

const ALL_MODES = [
  "close-newer-queue",
  "close-newer-settings",
  "close-invalid-folder",
  "queue-owner-race",
  "staging-sweep-leak",
  "proxy-pool-exhaustion",
];
const onlyIndex = process.argv.indexOf("--only");
const modes =
  onlyIndex >= 0
    ? String(process.argv[onlyIndex + 1] || "")
        .split(",")
        .filter(Boolean)
    : ALL_MODES;
for (const mode of modes) {
  if (!ALL_MODES.includes(mode)) throw new Error(`Unknown mode: ${mode}`);
}

const binary = e2eBinaryPath();
const stamp = e2eStampPath();
if (
  !fs.existsSync(binary) ||
  !fs.existsSync(stamp) ||
  fs.readFileSync(stamp, "utf8") !== "e2e-feature-1\n" ||
  fs.statSync(stamp).mtimeMs < fs.statSync(binary).mtimeMs
) {
  throw new Error(
    "Build a fresh E2E binary (npm run test:e2e) before running these probes.",
  );
}

const ownedRoot = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "audit-v5-beta2-deep",
);
const artifactRoot = path.join(
  ownedRoot,
  `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`,
);
fs.mkdirSync(artifactRoot, { recursive: true });

const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const fileHash = (file) =>
  fs.existsSync(file) && fs.statSync(file).isFile()
    ? sha256(fs.readFileSync(file))
    : null;
const ffmpeg = spawnSync("which", ["ffmpeg"], {
  encoding: "utf8",
}).stdout.trim();
if (!ffmpeg || path.basename(ffmpeg) !== "ffmpeg") {
  throw new Error("A real FFmpeg named `ffmpeg` must be on PATH.");
}
const caPath = path.join(REPO_ROOT, "e2e", "fixtures", "security-test-ca.pem");
const tlsKey = fs.readFileSync(
  path.join(REPO_ROOT, "e2e", "fixtures", "security-test-server-key.pem"),
);
const tlsCert = fs.readFileSync(
  path.join(REPO_ROOT, "e2e", "fixtures", "security-test-server.pem"),
);

function runWdio(env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(REPO_ROOT, "node_modules/@wdio/cli/bin/wdio.js"),
        "run",
        path.join(REPO_ROOT, "e2e/wdio.conf.js"),
      ],
      { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function setStale(target, days = 2) {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  fs.utimesSync(target, when, when);
}

function uuid() {
  return crypto.randomUUID();
}

/** Mode-specific seeding. Returns extra env and runner-side context. */
async function seed(mode, profile) {
  const settingsPath = path.join(profile.dataDir, "settings.json");
  if (mode === "close-newer-queue") {
    fs.writeFileSync(
      path.join(profile.dataDir, "download-queue.json"),
      JSON.stringify({
        schemaVersion: 2,
        items: [
          {
            id: "newer-a",
            url: "https://deep-audit.invalid/a.mp4",
            status: "pending",
            addedAt: 1,
          },
        ],
      }),
    );
    return { env: {} };
  }
  if (mode === "close-newer-settings") {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    settings.settingsVersion = 99;
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    return { env: {} };
  }
  if (mode === "close-invalid-folder") {
    const outside = path.join(profile.profileDir, "outside-home", "videos");
    fs.mkdirSync(outside, { recursive: true });
    return { env: { ROSI_DEEP_OUTSIDE_FOLDER: outside } };
  }
  if (mode === "staging-sweep-leak") {
    const stage = `.rosi-download-${uuid()}`;
    const nested = `.rosi-convert-${uuid()}`;
    const bookkeeping = `.rosi-path-7-${uuid()}.txt`;
    const stageDir = path.join(profile.downloads, stage);
    fs.mkdirSync(path.join(stageDir, nested), { recursive: true });
    const media = path.join(stageDir, "interrupted [abc123].mp4");
    fs.writeFileSync(media, crypto.randomBytes(4096));
    fs.writeFileSync(path.join(stageDir, bookkeeping), `${media}\n`);
    fs.writeFileSync(
      path.join(stageDir, nested, "output.mp4"),
      crypto.randomBytes(2048),
    );
    for (const target of [
      media,
      path.join(stageDir, bookkeeping),
      path.join(stageDir, nested, "output.mp4"),
      path.join(stageDir, nested),
      stageDir,
    ]) {
      setStale(target);
    }
    return {
      env: { ROSI_DEEP_SEEDED: JSON.stringify({ stage, nested, bookkeeping }) },
    };
  }
  if (mode === "proxy-pool-exhaustion") {
    return seedHls(profile);
  }
  return { env: {} };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function seedHls(profile) {
  const hlsDir = path.join(profile.profileDir, "hls");
  fs.mkdirSync(hlsDir, { recursive: true });
  const encode = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x90:rate=10:duration=12",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=12",
      "-c:v",
      "libx264",
      "-g",
      "10",
      "-keyint_min",
      "10",
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      "-shortest",
      "-f",
      "hls",
      "-hls_time",
      "1",
      "-hls_list_size",
      "0",
      "-hls_segment_filename",
      path.join(hlsDir, "seg%02d.ts"),
      path.join(hlsDir, "index.m3u8"),
    ],
    { encoding: "utf8" },
  );
  if (encode.status !== 0)
    throw new Error(`HLS fixture failed: ${encode.stderr}`);
  const segments = fs
    .readdirSync(hlsDir)
    .filter((name) => name.endsWith(".ts"))
    .sort();
  const events = [];
  const servers = [];
  const startOrigin = async (label, routes) => {
    const server = https.createServer(
      { key: tlsKey, cert: tlsCert },
      (request, response) => {
        const route =
          routes[new URL(request.url, "https://127.0.0.1").pathname];
        events.push({
          at: Date.now(),
          label,
          method: request.method,
          path: request.url,
          socket: request.socket.remotePort,
        });
        if (!route) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, {
          "Content-Type": route.type,
          "Content-Length": String(route.body.length),
          Connection: "keep-alive",
        });
        response.end(route.body);
      },
    );
    // CDN-like idle keep-alive, far longer than Node's 5 s default.
    server.keepAliveTimeout = 10 * 60 * 1000;
    server.headersTimeout = 10 * 60 * 1000 + 1000;
    server.requestTimeout = 0;
    server.on("secureConnection", (socket) =>
      events.push({ at: Date.now(), label, tlsConnection: socket.remotePort }),
    );
    const port = await listen(server);
    servers.push(server);
    return port;
  };
  const segmentPorts = [];
  for (const segment of segments) {
    segmentPorts.push(
      await startOrigin(segment, {
        [`/${segment}`]: {
          type: "video/mp2t",
          body: fs.readFileSync(path.join(hlsDir, segment)),
        },
      }),
    );
  }
  const playlist = fs
    .readFileSync(path.join(hlsDir, "index.m3u8"), "utf8")
    .split("\n")
    .map((line) => {
      const index = segments.indexOf(line.trim());
      return index >= 0
        ? `https://127.0.0.1:${segmentPorts[index]}/${segments[index]}`
        : line;
    })
    .join("\n");
  const manifestPort = await startOrigin("manifest", {
    "/index.m3u8": {
      type: "application/vnd.apple.mpegurl",
      body: Buffer.from(playlist),
    },
  });
  return {
    env: {
      ROSI_E2E_TLS_CA: caPath,
      ROSI_DEEP_HLS_URL: `https://127.0.0.1:${manifestPort}/index.m3u8`,
      ROSI_DEEP_WINDOW_MS: "120000",
    },
    context: {
      segments,
      segmentPorts,
      manifestPort,
      events,
      servers,
      playlist,
    },
  };
}

function judgeHls(observation, context) {
  const firstRequest = context.segments.map((segment) => {
    const hit = context.events.find(
      (event) => event.label === segment && event.method === "GET",
    );
    return hit ? hit.at : null;
  });
  const tlsConnections = Object.fromEntries(
    ["manifest", ...context.segments].map((label) => [
      label,
      context.events.filter(
        (event) => event.label === label && event.tlsConnection,
      ).length,
    ]),
  );
  const requested = firstRequest.filter((at) => at !== null).length;
  const gaps = [];
  for (let index = 1; index < firstRequest.length; index += 1) {
    if (firstRequest[index] && firstRequest[index - 1]) {
      gaps.push(firstRequest[index] - firstRequest[index - 1]);
    }
  }
  observation.origins = {
    segmentCount: context.segments.length,
    segmentsRequested: requested,
    firstRequestOffsetsMs: firstRequest.map((at) =>
      at === null ? null : at - (firstRequest[0] ?? at),
    ),
    maxGapMs: gaps.length ? Math.max(...gaps) : null,
    tlsConnections,
    keepAliveTimeoutMs: 10 * 60 * 1000,
    requestLog: context.events,
  };
  observation.judgeable = (tlsConnections[context.segments[0]] ?? 0) > 0;
  observation.invariantPassed =
    requested === context.segments.length &&
    (observation.origins.maxGapMs ?? Infinity) < 10_000 &&
    observation.outcome === "success";
}

const observations = [];
for (const mode of modes) {
  const directory = path.join(artifactRoot, mode);
  fs.mkdirSync(directory, { recursive: true });
  const profile = createE2eProfile({
    ffmpegPath: mode === "proxy-pool-exhaustion" ? ffmpeg : "",
  });
  const seeded = await seed(mode, profile);
  const dataBefore = Object.fromEntries(
    fs
      .readdirSync(profile.dataDir)
      .map((name) => [name, fileHash(path.join(profile.dataDir, name))]),
  );
  const result = await runWdio(
    {
      ...process.env,
      ...profile.env,
      ...seeded.env,
      ROSI_E2E_BINARY: binary,
      ROSI_E2E_SPECS: "./audit-v5-beta2-deep/deep-audit.spec.js",
      ROSI_DEEP_MODE: mode,
      ROSI_DEEP_ARTIFACTS: directory,
      ROSI_DEEP_DOWNLOADS: profile.downloads,
    },
    mode === "proxy-pool-exhaustion" || mode === "queue-owner-race"
      ? 600_000
      : 240_000,
  );
  fs.writeFileSync(path.join(directory, "wdio.log"), result.output);
  const logFile = path.join(profile.dataDir, "logs", "rosi.log");
  if (fs.existsSync(logFile))
    fs.copyFileSync(logFile, path.join(directory, "rosi.log"));
  const observationPath = path.join(directory, "observation.json");
  const observation = fs.existsSync(observationPath)
    ? JSON.parse(fs.readFileSync(observationPath, "utf8"))
    : { mode, invariantPassed: false, probeError: "No observation produced" };
  if (mode === "proxy-pool-exhaustion" && seeded.context) {
    judgeHls(observation, seeded.context);
    await Promise.all(
      seeded.context.servers.map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(resolve);
          }),
      ),
    );
  }
  observation.runnerExitCode = result.code;
  observation.dataBefore = dataBefore;
  observations.push(observation);
  fs.writeFileSync(
    observationPath,
    `${JSON.stringify(observation, null, 2)}\n`,
  );
  fs.rmSync(profile.profileDir, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      mode,
      invariantPassed: observation.invariantPassed,
      probeError: observation.probeError ?? null,
      wdioExit: result.code,
    }),
  );
}

const commit = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).stdout.trim();
const report = {
  suite: "audit-v5-beta2-deep",
  commit,
  workingTreeDirty:
    spawnSync("git", ["status", "--porcelain", "--", "src", "src-tauri"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).stdout.trim() !== "",
  binarySha256: sha256(fs.readFileSync(binary)),
  ffmpeg,
  probeSourceSha256: {
    "deep-audit.spec.js": fileHash(
      path.join(REPO_ROOT, "e2e/audit-v5-beta2-deep/deep-audit.spec.js"),
    ),
    "run.mjs": fileHash(
      path.join(REPO_ROOT, "e2e/audit-v5-beta2-deep/run.mjs"),
    ),
    "failure-modes.md": fileHash(
      path.join(REPO_ROOT, "e2e/audit-v5-beta2-deep/failure-modes.md"),
    ),
  },
  platform: `${process.platform}-${process.arch}`,
  finishedAt: new Date().toISOString(),
  observations,
};
const reportText = `${JSON.stringify(report, null, 2)}\n`;
fs.writeFileSync(path.join(artifactRoot, "report.json"), reportText);
fs.writeFileSync(
  path.join(artifactRoot, "report.sha256"),
  `${sha256(reportText)}  report.json\n`,
);
console.log(
  `Report: ${path.relative(REPO_ROOT, path.join(artifactRoot, "report.json"))}`,
);
