import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";
import { deterministicBytes, sha256 } from "../../helpers/media-server.js";

// Acceptance for the optional upstream HTTP proxy. The spec starts its own
// upstream proxy (CONNECT tunnel plus absolute-form HTTP forwarding), points
// ROSI at it through the saveSettings API, and records every request the
// upstream receives. Evidence goes to
// e2e/artifacts/v5-fixes-upstream-proxy/<timestamp>-<pid>/ (report.json,
// upstream-log.json, proxy-decisions.jsonl). Failure modes are listed in
// failure-modes.md beside this file.

const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SPEC_DIR, "..", "..", "..");
const runStamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-upstream-proxy",
  runStamp,
);
const startedAt = new Date().toISOString();
const downloads = process.env.ROSI_E2E_DOWNLOADS;
const mediaUrl = process.env.ROSI_E2E_MEDIA_URL;
const fixtures = JSON.parse(process.env.ROSI_E2E_FIXTURES || "{}");
const proxyTracePath = process.env.ROSI_E2E_PROXY_TRACE;
const tlsCertificate = process.env.ROSI_E2E_TLS_CERT;
const tlsPrivateKey = process.env.ROSI_E2E_TLS_KEY;
const binaryPath = process.env.ROSI_E2E_BINARY;

const TLS_VIDEO_SEED = "rosi-upstream-proxy-tls-video";
const TLS_VIDEO_SIZE = 128 * 1024;
const PAGE_VIDEO_SEED = "rosi-upstream-proxy-page-video";
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nXcAAAAASUVORK5CYII=",
  "base64",
);
const SOURCE_FILES = [
  "e2e/v5-fixes/upstream-proxy/upstream-proxy.spec.js",
  "e2e/v5-fixes/upstream-proxy/failure-modes.md",
  "src-tauri/src/network_security.rs",
  "src-tauri/src/settings.rs",
  "src-tauri/src/validation.rs",
  "src-tauri/src/types.rs",
  "src-tauri/src/downloader.rs",
  "src-tauri/src/media_info.rs",
  "docs/NETWORK-POLICY.md",
];

const checks = [];
let upstream;
let tlsServer;
let pageServer;
let tlsUrl;
let tlsPort;
let pageUrl;
let pageThumbnailUrl;
let binarySha256 = null;
let workingTreeDiffSha256 = null;

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function writeReport() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const sources = SOURCE_FILES.flatMap((source) => {
    const file = path.join(REPO_ROOT, source);
    return fs.existsSync(file)
      ? [{ path: source, sha256: hash(fs.readFileSync(file)) }]
      : [];
  });
  const body = {
    suite: "v5-fixes-upstream-proxy",
    startedAt,
    binarySha256,
    workingTreeDiffSha256,
    sources,
    checks,
    upstreamLogEntries: upstream?.state.log.length ?? 0,
    passed:
      checks.length > 0 &&
      checks.every((check) => check.invariantPassed === true),
  };
  fs.writeFileSync(
    path.join(artifactDir, "report.json"),
    `${JSON.stringify({ ...body, reportSha256: hash(JSON.stringify(body)) }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(artifactDir, "upstream-log.json"),
    `${JSON.stringify(upstream?.state.log ?? [], null, 2)}\n`,
  );
  if (proxyTracePath && fs.existsSync(proxyTracePath)) {
    fs.copyFileSync(
      proxyTracePath,
      path.join(artifactDir, "proxy-decisions.jsonl"),
    );
  }
}

function record(name, details) {
  checks.push({ name, ...details });
  writeReport();
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function closedPort() {
  const probe = net.createServer();
  await listen(probe);
  const port = probe.address().port;
  await closeServer(probe);
  return port;
}

function splitAuthority(authority) {
  const separator = authority.lastIndexOf(":");
  return {
    host: authority.slice(0, separator),
    port: Number(authority.slice(separator + 1)),
  };
}

const HOP_HEADERS = ["proxy-authorization", "proxy-connection"];

/**
 * Upstream proxy the spec controls. `mode` changes how it answers:
 * relay (tunnel and forward), refuse (407), oversized (header over 16 KiB),
 * malformed (not HTTP), close (drop before answering), stall (never answer).
 */
async function startUpstreamProxy() {
  const state = {
    mode: "relay",
    log: [],
    closedByClient: 0,
  };
  const sockets = new Set();
  const logEntry = (entry) => {
    state.log.push({ index: state.log.length, at: Date.now(), ...entry });
  };
  const server = http.createServer((request, response) => {
    let target;
    try {
      target = new URL(request.url);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    logEntry({
      kind: "GET",
      method: request.method,
      target: request.url,
      host: request.headers.host ?? null,
      proxyAuthorization: request.headers["proxy-authorization"] ?? null,
    });
    if (state.mode === "refuse") {
      response.writeHead(407, { "Content-Length": "0" });
      response.end();
      return;
    }
    if (state.mode === "stall") return;
    const headers = { ...request.headers };
    for (const name of HOP_HEADERS) delete headers[name];
    const outbound = http.request(
      {
        host: target.hostname,
        port: Number(target.port || 80),
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
      },
    );
    outbound.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(outbound);
  });
  server.on("connect", (request, socket, head) => {
    logEntry({
      kind: "CONNECT",
      method: "CONNECT",
      target: request.url,
      host: request.headers.host ?? null,
      proxyAuthorization: request.headers["proxy-authorization"] ?? null,
    });
    if (state.mode === "refuse") {
      socket.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    if (state.mode === "oversized") {
      socket.end(
        `HTTP/1.1 200 Connection Established\r\nX-Padding: ${"a".repeat(64 * 1024)}\r\n\r\n`,
      );
      return;
    }
    if (state.mode === "malformed") {
      socket.end("not an http response\r\n\r\n");
      return;
    }
    if (state.mode === "close") {
      socket.destroy();
      return;
    }
    if (state.mode === "stall") {
      // The http server keeps a half-closed CONNECT socket open (allowHalfOpen),
      // so a FIN from ROSI emits only "end". That FIN is the closure to count.
      socket.on("end", () => {
        state.closedByClient += 1;
        socket.end();
      });
      return;
    }
    const { host, port } = splitAuthority(request.url);
    const remote = net.connect({ host, port });
    socket.on("error", () => remote.destroy());
    socket.on("close", () => remote.destroy());
    remote.on("error", () => socket.destroy());
    remote.on("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) remote.write(head);
      remote.pipe(socket);
      socket.pipe(remote);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    // ROSI may close before reading a full oversized answer, which resets the
    // socket. That reset is expected, so it must not reach mocha as uncaught.
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await listen(server);
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    state,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

/** Plain HTTP and TLS origins for the metadata and HTTPS checks. */
async function startPageServer() {
  const server = http.createServer((request, response) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (request.url === "/page.html") {
      const body = Buffer.from(
        `<!doctype html><html><head><title>Upstream proxy fixture</title><meta property="og:title" content="Upstream proxy fixture"><meta property="og:image" content="${base}/thumb.png"></head><body><video src="${base}/video.mp4"></video></body></html>`,
      );
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(body.length),
      });
      response.end(body);
      return;
    }
    if (request.url === "/thumb.png") {
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": String(ONE_PIXEL_PNG.length),
      });
      response.end(ONE_PIXEL_PNG);
      return;
    }
    if (request.url === "/video.mp4") {
      const body = deterministicBytes(64 * 1024, PAGE_VIDEO_SEED);
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(body.length),
      });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await listen(server);
  return server;
}

function startTlsServer() {
  const server = https.createServer(
    {
      cert: fs.readFileSync(tlsCertificate),
      key: fs.readFileSync(tlsPrivateKey),
    },
    (request, response) => {
      if (request.url !== "/video.mp4") {
        response.writeHead(404);
        response.end("not found");
        return;
      }
      const body = deterministicBytes(TLS_VIDEO_SIZE, TLS_VIDEO_SEED);
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(body.length),
      });
      response.end(body);
    },
  );
  return listen(server).then(() => server);
}

function readTrace() {
  if (!proxyTracePath || !fs.existsSync(proxyTracePath)) return [];
  return fs
    .readFileSync(proxyTracePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// The renderer's progress stream carries yt-dlp stderr, which is where a
// proxy's 502 shows up. Activity only records "yt-dlp process exited".
async function readProgress() {
  const encoded = await browser.execute(() =>
    JSON.stringify(window.__upstreamProxyProgress ?? []).replace(
      /[\u0080-￿]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ),
  );
  return JSON.parse(encoded);
}

async function activityIds() {
  const response = await api("getDownloadActivity");
  return new Set((response.data ?? []).map((item) => item.id));
}

async function setUpstream(value) {
  const response = await api("saveSettings", { upstreamProxy: value });
  assert.equal(response.ok, true, JSON.stringify(response));
}

async function startDownload(url) {
  const before = await activityIds();
  const progressBefore = (await readProgress()).length;
  const started = await api("downloadVideo", {
    url,
    outputPath: downloads,
    convertEnabled: false,
    hookBrowser: false,
    gpuAcceleration: false,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  return { url, before, progressBefore };
}

async function waitForItem(run, { completed = true, timeout = 90_000 } = {}) {
  let item;
  await browser.waitUntil(
    async () => {
      const response = await api("getDownloadActivity");
      item = (response.data ?? []).find(
        (candidate) =>
          candidate.url === run.url && !run.before.has(candidate.id),
      );
      return Boolean(item && (!completed || item.completedAt));
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `download did not ${completed ? "finish" : "start"}: ${run.url}`,
    },
  );
  const progress = (await readProgress()).slice(run.progressBefore);
  return { item, progress };
}

async function download(url, options) {
  return waitForItem(await startDownload(url), options);
}

function downloadedBytes(item) {
  const file = item.outputPaths?.[0] ?? item.outputPath;
  assert.ok(file, `no output path on ${JSON.stringify(item)}`);
  return fs.readFileSync(file);
}

describe("V5 optional upstream HTTP proxy", () => {
  before(async () => {
    await waitForAppReady();
    assert.ok(downloads, "ROSI_E2E_DOWNLOADS is required");
    assert.ok(mediaUrl, "ROSI_E2E_MEDIA_URL is required");
    assert.ok(
      tlsCertificate && tlsPrivateKey,
      "ROSI_E2E_TLS_CERT/KEY required",
    );
    if (binaryPath && fs.existsSync(binaryPath)) {
      binarySha256 = hash(fs.readFileSync(binaryPath));
    }
    const diff = spawnSync("git", ["diff", "--binary", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "buffer",
    });
    if (diff.status === 0) {
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(
        path.join(artifactDir, "working-tree.patch"),
        diff.stdout,
      );
      workingTreeDiffSha256 = hash(diff.stdout);
    }
    upstream = await startUpstreamProxy();
    pageServer = await startPageServer();
    tlsServer = await startTlsServer();
    tlsPort = tlsServer.address().port;
    tlsUrl = `https://127.0.0.1:${tlsPort}/video.mp4`;
    pageUrl = `http://127.0.0.1:${pageServer.address().port}/page.html`;
    pageThumbnailUrl = `http://127.0.0.1:${pageServer.address().port}/thumb.png`;
    await browser.execute(() => {
      window.__upstreamProxyProgress = [];
      window.api.onProgress((message) => {
        window.__upstreamProxyProgress.push(String(message));
      });
    });
    await setUpstream("");
    writeReport();
  });

  after(async () => {
    await setUpstream("").catch(() => {});
    await upstream?.close();
    if (pageServer) await closeServer(pageServer);
    if (tlsServer) await closeServer(tlsServer);
    writeReport();
  });

  it("keeps the default empty and accepts only the documented upstream shape", async () => {
    const initial = await api("getSettings");
    const valid = [
      upstream.url,
      "http://proxy.example:8080",
      "http://[::1]:3128/",
      "http://localhost:65535",
    ];
    const invalid = [
      "https://proxy.example:8080",
      "socks5://proxy.example:1080",
      "ftp://proxy.example:21",
      "http://user:pass@proxy.example:8080",
      "http://proxy.example:8080/path",
      "http://proxy.example:8080?x=1",
      "http://proxy.example:8080#frag",
      " http://proxy.example:8080",
      "http://proxy.example:8080 ",
      "http://proxy example:8080",
      "http://proxy.example",
      "http://proxy.example:0",
      "http://proxy.example:65536",
      "http://proxy.example:+8080",
      "http://proxy.example:-1",
      "http://::1:8080",
      "http://proxy_1.example:8080",
      "http://-bad.example:8080",
      "http://999.1.1.1:8080",
      "http://proxy.example:8080//",
      `http://${"a".repeat(2040)}.example:8080`,
      12345,
    ];
    const validResults = [];
    for (const value of valid) {
      const response = await api("saveSettings", { upstreamProxy: value });
      const stored = await api("getSettings");
      validResults.push({
        value,
        ok: response.ok === true,
        stored: stored.upstreamProxy === value,
      });
    }
    await setUpstream("");
    const invalidResults = [];
    for (const value of invalid) {
      const response = await api("saveSettings", { upstreamProxy: value });
      const details = response.error?.details
        ? JSON.parse(response.error.details)
        : [];
      const stored = await api("getSettings");
      invalidResults.push({
        value: typeof value === "string" ? value.slice(0, 80) : value,
        refused: response.ok === false,
        keyNamed: details.includes("upstreamProxy"),
        unchanged: stored.upstreamProxy === "",
      });
    }
    const passed =
      initial.upstreamProxy === "" &&
      validResults.every((row) => row.ok && row.stored) &&
      invalidResults.every(
        (row) => row.refused && row.keyNamed && row.unchanged,
      );
    record("setting-validation", {
      initialUpstreamProxy: initial.upstreamProxy,
      validResults,
      invalidResults,
      invariantPassed: passed,
    });
    assert.equal(initial.upstreamProxy, "", "default must stay empty");
    assert.ok(
      validResults.every((row) => row.ok && row.stored),
      JSON.stringify(validResults),
    );
    assert.ok(
      invalidResults.every(
        (row) => row.refused && row.keyNamed && row.unchanged,
      ),
      JSON.stringify(invalidResults),
    );
  });

  it("sends plain HTTP downloads to the upstream in absolute form", async () => {
    await setUpstream(upstream.url);
    upstream.state.mode = "relay";
    const priorEntries = upstream.state.log.length;
    const url = `${mediaUrl}/clip-one.mp4`;
    const { item } = await download(url);
    const entries = upstream.state.log.slice(priorEntries);
    const request = entries.find(
      (entry) => entry.kind === "GET" && entry.target === url,
    );
    const actualSha =
      item.outcome === "success" ? sha256(downloadedBytes(item)) : null;
    const passed =
      item.outcome === "success" &&
      Boolean(request) &&
      request.proxyAuthorization === null &&
      actualSha === fixtures["clip-one.mp4"];
    record("plain-http-through-upstream", {
      outcome: item.outcome,
      upstreamEntries: entries,
      sha256Matches: actualSha === fixtures["clip-one.mp4"],
      invariantPassed: passed,
    });
    assert.equal(item.outcome, "success", JSON.stringify(item));
    assert.ok(
      request,
      `upstream did not receive ${url}: ${JSON.stringify(entries)}`,
    );
    assert.equal(
      request.proxyAuthorization,
      null,
      "ROSI credential leaked upstream",
    );
    assert.equal(actualSha, fixtures["clip-one.mp4"]);
  });

  it("tunnels HTTPS downloads through CONNECT to the upstream", async () => {
    await setUpstream(upstream.url);
    upstream.state.mode = "relay";
    const priorEntries = upstream.state.log.length;
    const { item } = await download(tlsUrl);
    const entries = upstream.state.log.slice(priorEntries);
    const tunnel = entries.find(
      (entry) =>
        entry.kind === "CONNECT" && entry.target === `127.0.0.1:${tlsPort}`,
    );
    const expected = sha256(deterministicBytes(TLS_VIDEO_SIZE, TLS_VIDEO_SEED));
    const actualSha =
      item.outcome === "success" ? sha256(downloadedBytes(item)) : null;
    const passed =
      item.outcome === "success" &&
      Boolean(tunnel) &&
      tunnel.proxyAuthorization === null &&
      actualSha === expected;
    record("https-connect-through-upstream", {
      outcome: item.outcome,
      upstreamEntries: entries,
      sha256Matches: actualSha === expected,
      invariantPassed: passed,
    });
    assert.equal(item.outcome, "success", JSON.stringify(item));
    assert.ok(
      tunnel,
      `no CONNECT reached the upstream: ${JSON.stringify(entries)}`,
    );
    assert.equal(actualSha, expected);
  });

  it("refuses private destinations before the upstream sees them", async () => {
    await setUpstream(upstream.url);
    upstream.state.mode = "relay";
    const priorEntries = upstream.state.log.length;
    const priorTrace = readTrace().length;
    const plain = await download(
      `http://private.test:${new URL(mediaUrl).port}/clip-one.mp4`,
    );
    const tunnel = await download(`https://private.test:${tlsPort}/video.mp4`);
    const entries = upstream.state.log.slice(priorEntries);
    const decisions = readTrace()
      .slice(priorTrace)
      .filter((entry) => entry.stage === "connection");
    const privateDecisions = decisions.filter(
      (entry) => entry.host === "private.test",
    );
    const passed =
      plain.item.outcome === "failed" &&
      tunnel.item.outcome === "failed" &&
      entries.length === 0 &&
      privateDecisions.length >= 2 &&
      privateDecisions.every((entry) => entry.allowed === false);
    record("private-destination-refused-before-upstream", {
      plainOutcome: plain.item.outcome,
      tunnelOutcome: tunnel.item.outcome,
      upstreamEntries: entries,
      privateDecisions,
      invariantPassed: passed,
    });
    assert.equal(plain.item.outcome, "failed", JSON.stringify(plain.item));
    assert.equal(tunnel.item.outcome, "failed", JSON.stringify(tunnel.item));
    assert.deepEqual(entries, [], "the upstream saw a blocked destination");
    assert.ok(privateDecisions.length >= 2, JSON.stringify(decisions));
    assert.ok(privateDecisions.every((entry) => entry.allowed === false));
  });

  it("reports a refused or unreachable upstream as a 502 to yt-dlp", async () => {
    const deadPort = await closedPort();
    await setUpstream(`http://127.0.0.1:${deadPort}`);
    const plain = await download(`${mediaUrl}/clip-one.mp4`);
    const tunnel = await download(tlsUrl);
    const plainLines = plain.progress.filter((line) => /502/.test(line));
    const tunnelLines = tunnel.progress.filter((line) => /502/.test(line));
    const passed =
      plain.item.outcome === "failed" &&
      tunnel.item.outcome === "failed" &&
      plainLines.length > 0 &&
      tunnelLines.length > 0;
    record("unreachable-upstream", {
      plainOutcome: plain.item.outcome,
      tunnelOutcome: tunnel.item.outcome,
      plainErrorLines: plainLines.slice(0, 3),
      tunnelErrorLines: tunnelLines.slice(0, 3),
      invariantPassed: passed,
    });
    assert.equal(plain.item.outcome, "failed", JSON.stringify(plain.item));
    assert.equal(tunnel.item.outcome, "failed", JSON.stringify(tunnel.item));
    assert.ok(plainLines.length > 0, JSON.stringify(plain.progress));
    assert.ok(tunnelLines.length > 0, JSON.stringify(tunnel.progress));
  });

  it("maps every bad CONNECT answer to a 502 and fails the download", async () => {
    await setUpstream(upstream.url);
    const outcomes = [];
    try {
      for (const mode of ["refuse", "oversized", "malformed", "close"]) {
        upstream.state.mode = mode;
        const priorEntries = upstream.state.log.length;
        const { item, progress } = await download(tlsUrl);
        const sawConnect = upstream.state.log
          .slice(priorEntries)
          .some((entry) => entry.kind === "CONNECT");
        outcomes.push({
          mode,
          outcome: item.outcome,
          sawConnect,
          mentions502: progress.some((line) => /502/.test(line)),
        });
      }
    } finally {
      upstream.state.mode = "relay";
    }
    const passed = outcomes.every(
      (row) => row.outcome === "failed" && row.sawConnect && row.mentions502,
    );
    record("bad-connect-answers", { outcomes, invariantPassed: passed });
    assert.ok(passed, JSON.stringify(outcomes));
  });

  it("closes the upstream socket when a download is cancelled mid-CONNECT", async () => {
    await setUpstream(upstream.url);
    upstream.state.mode = "stall";
    const priorClosed = upstream.state.closedByClient;
    const priorEntries = upstream.state.log.length;
    const run = await startDownload(tlsUrl);
    await browser.waitUntil(
      () =>
        upstream.state.log
          .slice(priorEntries)
          .some((entry) => entry.kind === "CONNECT"),
      {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: "ROSI never sent CONNECT to the upstream",
      },
    );
    await api("cancelDownload");
    const { item } = await waitForItem(run, { timeout: 60_000 });
    await browser.waitUntil(() => upstream.state.closedByClient > priorClosed, {
      timeout: 15_000,
      interval: 100,
      timeoutMsg: "the upstream socket stayed open after cancel",
    });
    const closed = upstream.state.closedByClient - priorClosed;
    upstream.state.mode = "relay";
    record("cancel-mid-connect", {
      outcome: item.outcome,
      upstreamSocketsClosed: closed,
      invariantPassed: item.outcome === "cancelled" && closed >= 1,
    });
    assert.equal(item.outcome, "cancelled", JSON.stringify(item));
    assert.ok(closed >= 1);
  });

  it("routes thumbnails and format listings through the upstream", async () => {
    await setUpstream(upstream.url);
    upstream.state.mode = "relay";
    const priorEntries = upstream.state.log.length;
    const info = await api("getVideoInfo", pageUrl);
    const formats = await api("getFormats", pageUrl);
    const entries = upstream.state.log.slice(priorEntries);
    const sawPage = entries.some(
      (entry) => entry.kind === "GET" && entry.target === pageUrl,
    );
    const sawThumbnail = entries.some(
      (entry) => entry.kind === "GET" && entry.target === pageThumbnailUrl,
    );
    const thumbnail = info.data?.thumbnail ?? "";
    const passed =
      info.ok === true &&
      thumbnail.startsWith("data:image/png;base64,") &&
      formats.ok === true &&
      sawPage &&
      sawThumbnail;
    record("metadata-through-upstream", {
      infoOk: info.ok,
      thumbnailIsPng: thumbnail.startsWith("data:image/png;base64,"),
      formatsOk: formats.ok,
      upstreamEntries: entries,
      invariantPassed: passed,
    });
    assert.equal(info.ok, true, JSON.stringify(info));
    assert.ok(thumbnail.startsWith("data:image/png;base64,"), "no thumbnail");
    assert.equal(formats.ok, true, JSON.stringify(formats));
    assert.ok(sawPage && sawThumbnail, JSON.stringify(entries));
  });

  it("returns to direct connections when the setting is cleared", async () => {
    await setUpstream("");
    upstream.state.mode = "relay";
    const priorEntries = upstream.state.log.length;
    const url = `${mediaUrl}/clip-two.mp4`;
    const { item } = await download(url);
    const entries = upstream.state.log.slice(priorEntries);
    const actualSha =
      item.outcome === "success" ? sha256(downloadedBytes(item)) : null;
    const passed =
      item.outcome === "success" &&
      entries.length === 0 &&
      actualSha === fixtures["clip-two.mp4"];
    record("cleared-setting-goes-direct", {
      outcome: item.outcome,
      upstreamEntries: entries,
      sha256Matches: actualSha === fixtures["clip-two.mp4"],
      invariantPassed: passed,
    });
    assert.equal(item.outcome, "success", JSON.stringify(item));
    assert.deepEqual(entries, [], "a cleared setting still used the upstream");
    assert.equal(actualSha, fixtures["clip-two.mp4"]);
  });
});
