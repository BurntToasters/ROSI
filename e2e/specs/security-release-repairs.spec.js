import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../helpers/app-bridge.js";
import { deterministicBytes, sha256 } from "../helpers/media-server.js";

const directory = process.env.ROSI_SECURITY_REPAIR_DIRECTORY;
const resultsPath = process.env.ROSI_SECURITY_REPAIR_RESULTS;
const downloads = process.env.ROSI_E2E_DOWNLOADS;
const observations = [];
const privateHits = [];
const rebindingHits = [];
const requests = [];
const tlsRequests = [];
const untrustedTlsRequests = [];
const stalledConnections = { hits: 0, closed: 0 };
const stalledThumbnails = { hits: 0, closed: 0 };
function createStreamState(size, seed) {
  return {
    body: deterministicBytes(size, seed),
    requests: 0,
    headRequests: 0,
    getRequests: 0,
    completedGetRequests: 0,
    closedGetRequests: 0,
    activeGetRequests: 0,
    bytesWritten: 0,
  };
}

const completedStream = createStreamState(
  512 * 1024,
  "rosi-security-delayed-response-complete",
);
const cancelledStream = createStreamState(
  4 * 1024 * 1024,
  "rosi-security-delayed-response-cancel",
);
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nXcAAAAASUVORK5CYII=",
  "base64",
);

let server;
let tlsServer;
let untrustedTlsServer;
let baseUrl;
let tlsBaseUrl;
let untrustedTlsBaseUrl;
let hlsDirectory;
let hlsManifest;

function record(name, details) {
  observations.push({ name, ...details });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
}

function aliasUrl(pathname) {
  return `http://private.test:${new URL(baseUrl).port}${pathname}`;
}

function rebindingUrl(pathname) {
  return `http://rebinding.test:${new URL(baseUrl).port}${pathname}`;
}

function page(imageUrl) {
  return Buffer.from(
    `<!doctype html><html><head><title>Security fixture</title><meta property="og:title" content="Security fixture"><meta property="og:image" content="${imageUrl}"></head><body><video src="${baseUrl}/video.mp4"></video></body></html>`,
  );
}

function serveDelayedStream(request, response, state) {
  state.requests += 1;
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range
    ? range[2]
      ? Math.min(Number(range[2]), state.body.length - 1)
      : state.body.length - 1
    : state.body.length - 1;
  if (start >= state.body.length || end < start) {
    response.writeHead(416, {
      "Content-Range": `bytes */${state.body.length}`,
    });
    response.end();
    return;
  }
  const slice = state.body.subarray(start, end + 1);
  const headers = {
    "Content-Type": "video/mp4",
    "Content-Length": String(slice.length),
    "Accept-Ranges": "bytes",
  };
  if (range)
    headers["Content-Range"] = `bytes ${start}-${end}/${state.body.length}`;
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") {
    state.headRequests += 1;
    response.end();
    return;
  }

  state.getRequests += 1;
  state.activeGetRequests += 1;
  request.socket.once("close", () => {
    state.closedGetRequests += 1;
    state.activeGetRequests = Math.max(0, state.activeGetRequests - 1);
  });
  response.on("finish", () => {
    state.completedGetRequests += 1;
  });
  let offset = 0;
  const timer = setInterval(() => {
    if (response.destroyed) {
      clearInterval(timer);
      return;
    }
    const chunk = slice.subarray(offset, offset + 64 * 1024);
    offset += chunk.length;
    state.bytesWritten += chunk.length;
    response.write(chunk);
    if (offset >= slice.length) {
      clearInterval(timer);
      response.end();
    }
  }, 250);
  response.on("close", () => clearInterval(timer));
  response.flushHeaders();
}

describe("ROSI URL boundary and release proof repairs", () => {
  before(async () => {
    assert.ok(directory, "ROSI_SECURITY_REPAIR_DIRECTORY is required");
    assert.ok(resultsPath, "ROSI_SECURITY_REPAIR_RESULTS is required");
    assert.ok(downloads, "ROSI_E2E_DOWNLOADS is required");
    const tlsCertificate = process.env.ROSI_E2E_TLS_CERT;
    const tlsPrivateKey = process.env.ROSI_E2E_TLS_KEY;
    const untrustedTlsCertificate = process.env.ROSI_E2E_TLS_UNTRUSTED_CERT;
    const untrustedTlsPrivateKey = process.env.ROSI_E2E_TLS_UNTRUSTED_KEY;
    assert.ok(
      tlsCertificate && tlsPrivateKey,
      "ROSI E2E TLS fixture paths are required",
    );
    assert.ok(
      untrustedTlsCertificate && untrustedTlsPrivateKey,
      "ROSI E2E untrusted TLS fixture paths are required",
    );
    const ffmpeg = process.env.ROSI_E2E_FFMPEG;
    assert.ok(ffmpeg, "ROSI_E2E_FFMPEG is required for real HLS fragments");
    hlsDirectory = path.join(directory, "hls-fixture");
    fs.mkdirSync(hlsDirectory, { recursive: true });
    const hlsPlaylistPath = path.join(hlsDirectory, "index.m3u8");
    const generatedHls = spawnSync(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=160x120:d=1",
        "-an",
        "-c:v",
        "mpeg2video",
        "-f",
        "hls",
        "-hls_time",
        "0.5",
        "-hls_list_size",
        "0",
        "-hls_segment_filename",
        path.join(hlsDirectory, "segment%03d.ts"),
        hlsPlaylistPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      generatedHls.status,
      0,
      `could not generate HLS fragments: ${generatedHls.stderr}`,
    );
    hlsManifest = fs.readFileSync(hlsPlaylistPath, "utf8");
    server = http.createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      requests.push({
        host: request.headers.host,
        path: url.pathname,
        requestTarget: request.url,
        connectionHeaders: request.rawHeaders.filter(
          (header, index) =>
            index % 2 === 0 && header.toLowerCase() === "connection",
        ).length,
      });
      if (request.headers.host?.startsWith("private.test:")) {
        privateHits.push(url.pathname);
      }
      if (request.headers.host?.startsWith("rebinding.test:")) {
        rebindingHits.push(url.pathname);
      }
      if (url.pathname === "/delayed-stream.mp4") {
        serveDelayedStream(request, response, completedStream);
        return;
      }
      if (url.pathname === "/cancel-stream.mp4") {
        serveDelayedStream(request, response, cancelledStream);
        return;
      }
      if (url.pathname === "/video.mp4") {
        const body = deterministicBytes(
          256 * 1024,
          "rosi-security-repair-video",
        );
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": String(body.length),
          "Accept-Ranges": "bytes",
        });
        response.end(body);
        return;
      }
      if (url.pathname === "/hold-info") {
        stalledConnections.hits += 1;
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          Connection: "keep-alive",
        });
        response.flushHeaders();
        request.socket.once("close", () => {
          stalledConnections.closed += 1;
        });
        return;
      }
      if (url.pathname.startsWith("/hls/")) {
        const name = path.basename(url.pathname);
        if (name.endsWith(".m3u8")) {
          const playlistMode = name.replace(/\.m3u8$/, "");
          let manifest = hlsManifest.replace(
            /^([^#\r\n]+\.ts)$/gm,
            (segment) => {
              const target =
                playlistMode === "private-segment"
                  ? aliasUrl(`/hls/${segment}`)
                  : playlistMode === "redirect-segment"
                    ? `${baseUrl}/hls/redirect-segment.ts`
                    : `${baseUrl}/hls/${segment}`;
              return target;
            },
          );
          if (playlistMode === "private-key") {
            manifest = manifest.replace(
              "#EXT-X-MEDIA-SEQUENCE:0\n",
              `#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="${aliasUrl("/hls/key.bin")}",IV=0x00000000000000000000000000000000\n`,
            );
          }
          const body = Buffer.from(manifest);
          response.writeHead(200, {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Content-Length": String(body.length),
          });
          response.end(body);
          return;
        }
        if (name === "redirect-segment.ts") {
          response.writeHead(302, {
            Location: aliasUrl("/hls/segment000.ts"),
          });
          response.end();
          return;
        }
        const file = path.join(hlsDirectory, name);
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          const body = fs.readFileSync(file);
          response.writeHead(200, {
            "Content-Type": "video/mp2t",
            "Content-Length": String(body.length),
            "Accept-Ranges": "bytes",
          });
          response.end(body);
          return;
        }
      }
      if (url.pathname === "/thumb.png") {
        response.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": String(onePixelPng.length),
        });
        response.end(onePixelPng);
        return;
      }
      if (url.pathname === "/thumb-hold.png") {
        stalledThumbnails.hits += 1;
        response.writeHead(200, {
          "Content-Type": "image/png",
          Connection: "keep-alive",
        });
        response.flushHeaders();
        request.socket.once("close", () => {
          stalledThumbnails.closed += 1;
        });
        return;
      }
      if (url.pathname === "/thumb.svg") {
        const body = Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        );
        response.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Content-Length": String(body.length),
        });
        response.end(body);
        return;
      }
      if (url.pathname === "/thumb-large.png") {
        const body = Buffer.alloc(3 * 1024 * 1024, 0x41);
        response.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": String(body.length),
        });
        response.end(body);
        return;
      }
      if (url.pathname === "/metadata-safe") {
        const body = page(`${baseUrl}/thumb.png`);
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(body.length),
        });
        response.end(body);
        return;
      }
      if (url.pathname === "/metadata-stalled-thumbnail") {
        const body = page(`${baseUrl}/thumb-hold.png`);
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(body.length),
        });
        response.end(body);
        return;
      }
      if (url.pathname === "/metadata-rebinding") {
        const body = page(rebindingUrl("/thumb.png"));
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(body.length),
        });
        response.end(body);
        return;
      }
      if (url.pathname === "/metadata-private") {
        const body = page(aliasUrl("/thumb.png"));
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(body.length),
        });
        response.end(body);
        return;
      }
      if (url.pathname === "/metadata-svg") {
        const body = page(`${baseUrl}/thumb.svg`);
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(body.length),
        });
        response.end(body);
        return;
      }
      if (url.pathname === "/metadata-large") {
        const body = page(`${baseUrl}/thumb-large.png`);
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(body.length),
        });
        response.end(body);
        return;
      }
      if (url.pathname === "/redirect-private") {
        response.writeHead(302, { Location: aliasUrl("/blocked.mp4") });
        response.end();
        return;
      }
      if (url.pathname === "/blocked.mp4") {
        response.writeHead(200, { "Content-Type": "video/mp4" });
        response.end(deterministicBytes(1024, "blocked-private-destination"));
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    tlsServer = https.createServer(
      {
        cert: fs.readFileSync(tlsCertificate),
        key: fs.readFileSync(tlsPrivateKey),
      },
      (request, response) => {
        tlsRequests.push({ host: request.headers.host, path: request.url });
        if (request.url === "/video.mp4") {
          const body = deterministicBytes(
            128 * 1024,
            "rosi-security-tls-video",
          );
          response.writeHead(200, {
            "Content-Type": "video/mp4",
            "Content-Length": String(body.length),
            "Accept-Ranges": "bytes",
          });
          response.end(body);
          return;
        }
        response.writeHead(404);
        response.end("not found");
      },
    );
    await new Promise((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
    tlsBaseUrl = `https://127.0.0.1:${tlsServer.address().port}`;
    untrustedTlsServer = https.createServer(
      {
        cert: fs.readFileSync(untrustedTlsCertificate),
        key: fs.readFileSync(untrustedTlsPrivateKey),
      },
      (request, response) => {
        untrustedTlsRequests.push({
          host: request.headers.host,
          path: request.url,
        });
        const body = deterministicBytes(
          128 * 1024,
          "rosi-security-untrusted-tls-video",
        );
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": String(body.length),
        });
        response.end(body);
      },
    );
    await new Promise((resolve) =>
      untrustedTlsServer.listen(0, "127.0.0.1", resolve),
    );
    untrustedTlsBaseUrl = `https://127.0.0.1:${untrustedTlsServer.address().port}`;
    await waitForAppReady();
  });

  it("rejects credential-bearing URLs before queueing or external handoff", async () => {
    const target = "http://user:secret@93.184.216.34/video.mp4";
    const [formats, queued, external] = await Promise.all([
      api("getFormats", target),
      api("addToQueue", [target]),
      api("openExternal", target),
    ]);
    const passed =
      formats.ok === false &&
      queued.ok === true &&
      queued.data?.added === 0 &&
      queued.data?.skipped === 1 &&
      external.ok === false;
    record("credential-bearing-urls", {
      formatsRejected: formats.ok === false,
      queueAdded: queued.data?.added ?? null,
      queueSkipped: queued.data?.skipped ?? null,
      externalRejected: external.ok === false,
      invariantPassed: passed,
    });
    assert.equal(formats.ok, false, JSON.stringify(formats));
    assert.equal(queued.ok, true, JSON.stringify(queued));
    assert.equal(queued.data?.added, 0, JSON.stringify(queued));
    assert.equal(queued.data?.skipped, 1, JSON.stringify(queued));
    assert.equal(external.ok, false, JSON.stringify(external));
  });

  after(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    if (tlsServer) {
      tlsServer.closeAllConnections?.();
      await new Promise((resolve) => tlsServer.close(resolve));
    }
    if (untrustedTlsServer) {
      untrustedTlsServer.closeAllConnections?.();
      await new Promise((resolve) => untrustedTlsServer.close(resolve));
    }
    if (directory) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, "observations.json"),
        `${JSON.stringify(observations, null, 2)}\n`,
      );
    }
    if (resultsPath) {
      fs.writeFileSync(
        resultsPath,
        `${JSON.stringify(
          observations.map(({ name, invariantPassed }) => ({
            name,
            status: invariantPassed ? "passed" : "failed",
          })),
          null,
          2,
        )}\n`,
      );
    }
  });

  it("routes direct loopback preview and formats through the opted-in E2E exception", async () => {
    const preview = await api("getVideoInfo", `${baseUrl}/metadata-safe`);
    const formats = await api("getFormats", `${baseUrl}/video.mp4`);
    const thumbnail = preview.data?.thumbnail;
    const passed =
      preview.ok === true &&
      formats.ok === true &&
      typeof thumbnail === "string" &&
      /^data:image\/(?:png|jpeg|webp);base64,/i.test(thumbnail);
    record("loopback-exception-and-thumbnail-data", {
      previewOk: preview.ok,
      formatsOk: formats.ok,
      thumbnailPrefix: thumbnail?.slice(0, 40) ?? null,
      privateHits: [...privateHits],
      invariantPassed: passed,
    });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(formats.ok, true, JSON.stringify(formats));
    assert.match(thumbnail || "", /^data:image\//);
    const forwardedRequests = requests.filter(
      (request) =>
        request.path.startsWith("/metadata-safe") ||
        request.path === "/video.mp4",
    );
    assert.ok(forwardedRequests.length > 0, "no requests reached the fixture");
    assert.ok(
      forwardedRequests.every(
        (request) =>
          request.requestTarget.startsWith("/") &&
          !request.requestTarget.startsWith("http://") &&
          request.connectionHeaders === 1,
      ),
      `proxy must normalize origin-form and a single Connection header: ${JSON.stringify(forwardedRequests)}`,
    );

    const started = await api("downloadVideo", {
      url: `${baseUrl}/video.mp4`,
      outputPath: downloads,
      convertEnabled: false,
      hookBrowser: false,
      gpuAcceleration: false,
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    let activity;
    await browser.waitUntil(
      async () => {
        const response = await api("getDownloadActivity");
        activity = response.data?.find(
          (item) => item.url === `${baseUrl}/video.mp4`,
        );
        return Boolean(activity?.completedAt);
      },
      {
        timeout: 60_000,
        interval: 250,
        timeoutMsg: "loopback download did not finish",
      },
    );
    record("loopback-download", {
      outcome: activity.outcome,
      filename: activity.filename,
      invariantPassed: activity.outcome === "success",
    });
    assert.equal(activity.outcome, "success", JSON.stringify(activity));
  });

  it("keeps a delayed guarded HTTP response open until the complete body arrives", async () => {
    const url = `${baseUrl}/delayed-stream.mp4?repair=complete-body`;
    const started = await api("downloadVideo", {
      url,
      outputPath: downloads,
      convertEnabled: false,
      hookBrowser: false,
      gpuAcceleration: false,
    });
    assert.equal(started.ok, true, JSON.stringify(started));

    let activity;
    await browser.waitUntil(
      async () => {
        const response = await api("getDownloadActivity");
        activity = response.data?.find((item) => item.url === url);
        return Boolean(activity?.completedAt);
      },
      {
        timeout: 45_000,
        interval: 100,
        timeoutMsg: "delayed streamed download did not finish",
      },
    );

    const fileExists =
      typeof activity.outputPath === "string" &&
      fs.existsSync(activity.outputPath);
    const downloadedBody = fileExists
      ? fs.readFileSync(activity.outputPath)
      : null;
    const expectedSha256 = sha256(completedStream.body);
    const actualSha256 = downloadedBody ? sha256(downloadedBody) : null;
    const passed =
      activity.outcome === "success" &&
      completedStream.completedGetRequests >= 1 &&
      completedStream.bytesWritten >= completedStream.body.length &&
      downloadedBody?.length === completedStream.body.length &&
      actualSha256 === expectedSha256;
    record("proxy-delayed-http-response", {
      outcome: activity.outcome,
      getRequests: completedStream.getRequests,
      completedGetRequests: completedStream.completedGetRequests,
      bytesWritten: completedStream.bytesWritten,
      expectedBytes: completedStream.body.length,
      outputPath: activity.outputPath ?? null,
      expectedSha256,
      actualSha256,
      invariantPassed: passed,
    });
    assert.equal(activity.outcome, "success", JSON.stringify(activity));
    assert.equal(completedStream.completedGetRequests >= 1, true);
    assert.ok(completedStream.bytesWritten >= completedStream.body.length);
    assert.ok(
      downloadedBody,
      `download output is missing: ${activity.outputPath}`,
    );
    assert.equal(downloadedBody.length, completedStream.body.length);
    assert.equal(actualSha256, expectedSha256);
  });

  it("closes a delayed guarded HTTP response promptly when its download is cancelled", async () => {
    const url = `${baseUrl}/cancel-stream.mp4?repair=cancel-body`;
    const priorGetRequests = cancelledStream.getRequests;
    const priorClosedGetRequests = cancelledStream.closedGetRequests;
    const priorBytesWritten = cancelledStream.bytesWritten;
    const priorCompletedGetRequests = cancelledStream.completedGetRequests;
    const started = await api("downloadVideo", {
      url,
      outputPath: downloads,
      convertEnabled: false,
      hookBrowser: false,
      gpuAcceleration: false,
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    await browser.waitUntil(
      () =>
        cancelledStream.getRequests > priorGetRequests &&
        cancelledStream.bytesWritten > priorBytesWritten &&
        cancelledStream.activeGetRequests > 0,
      {
        timeout: 15_000,
        interval: 50,
        timeoutMsg:
          "delayed response did not begin streaming before cancellation",
      },
    );

    const cancellationStartedAt = Date.now();
    await api("cancelDownload");
    await browser.waitUntil(
      () => cancelledStream.closedGetRequests > priorClosedGetRequests,
      {
        timeout: 3_000,
        interval: 50,
        timeoutMsg: "cancelled stream left its origin socket open",
      },
    );
    await browser.waitUntil(() => cancelledStream.activeGetRequests === 0, {
      timeout: 1_000,
      interval: 25,
      timeoutMsg: "cancelled stream remained active after its socket closed",
    });
    const socketCloseLatencyMs = Date.now() - cancellationStartedAt;
    let activity;
    await browser.waitUntil(
      async () => {
        const response = await api("getDownloadActivity");
        activity = response.data?.find((item) => item.url === url);
        return Boolean(activity?.completedAt);
      },
      {
        timeout: 10_000,
        interval: 50,
        timeoutMsg: "cancelled streamed download did not settle",
      },
    );
    const passed =
      activity.outcome === "cancelled" &&
      cancelledStream.closedGetRequests > priorClosedGetRequests &&
      cancelledStream.activeGetRequests === 0 &&
      cancelledStream.completedGetRequests === priorCompletedGetRequests &&
      socketCloseLatencyMs < 1_000;
    record("proxy-cancels-streamed-response", {
      outcome: activity.outcome,
      socketCloseLatencyMs,
      getRequests: cancelledStream.getRequests - priorGetRequests,
      closedGetRequests:
        cancelledStream.closedGetRequests - priorClosedGetRequests,
      activeGetRequests: cancelledStream.activeGetRequests,
      completedGetRequests:
        cancelledStream.completedGetRequests - priorCompletedGetRequests,
      bytesWritten: cancelledStream.bytesWritten - priorBytesWritten,
      invariantPassed: passed,
    });
    assert.equal(activity.outcome, "cancelled", JSON.stringify(activity));
    assert.equal(cancelledStream.activeGetRequests, 0);
    assert.equal(
      cancelledStream.completedGetRequests,
      priorCompletedGetRequests,
    );
    assert.ok(socketCloseLatencyMs < 1_000);
  });

  it("verifies a real HTTPS response through the pinned CONNECT proxy", async () => {
    const url = `${tlsBaseUrl}/video.mp4`;
    const formats = await api("getFormats", url);
    assert.equal(formats.ok, true, JSON.stringify(formats));
    const started = await api("downloadVideo", {
      url,
      outputPath: downloads,
      convertEnabled: false,
      hookBrowser: false,
      gpuAcceleration: false,
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    let activity;
    await browser.waitUntil(
      async () => {
        const response = await api("getDownloadActivity");
        activity = response.data?.find((item) => item.url === url);
        return Boolean(activity?.completedAt);
      },
      {
        timeout: 60_000,
        interval: 250,
        timeoutMsg: "verified HTTPS fixture download did not finish",
      },
    );
    const tracePath = process.env.ROSI_E2E_PROXY_TRACE;
    const trace = fs
      .readFileSync(tracePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const allowedConnect = trace.some(
      (entry) =>
        entry.stage === "connection" &&
        entry.host === "127.0.0.1" &&
        entry.allowed === true,
    );
    const passed =
      formats.ok === true &&
      activity.outcome === "success" &&
      tlsRequests.some((request) => request.path === "/video.mp4") &&
      allowedConnect;
    record("verified-https-connect-proxy", {
      formatsOk: formats.ok,
      downloadOutcome: activity.outcome,
      tlsRequests: [...tlsRequests],
      allowedConnect,
      invariantPassed: passed,
    });
    assert.equal(activity.outcome, "success", JSON.stringify(activity));
    assert.ok(tlsRequests.some((request) => request.path === "/video.mp4"));
    assert.ok(
      allowedConnect,
      "HTTPS destination never crossed the proxy guard",
    );
  });

  it("rejects a TLS certificate not signed by the E2E trust root", async () => {
    const url = `${untrustedTlsBaseUrl}/video.mp4`;
    const tracePath = process.env.ROSI_E2E_PROXY_TRACE;
    assert.ok(tracePath, "ROSI_E2E_PROXY_TRACE is required");
    const traceBefore = fs
      .readFileSync(tracePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean).length;
    const formats = await api("getFormats", url);
    const traceAfter = fs
      .readFileSync(tracePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const attemptedGuardedConnect = traceAfter
      .slice(traceBefore)
      .some(
        (event) =>
          event.stage === "connection" &&
          event.host === "127.0.0.1" &&
          event.allowed === true,
      );
    const certificateRejected = /certificate|verify|ssl/i.test(
      String(formats.error?.message ?? ""),
    );
    const passed =
      formats.ok === false &&
      certificateRejected &&
      attemptedGuardedConnect &&
      untrustedTlsRequests.length === 0;
    record("untrusted-https-certificate-rejected", {
      formatsOk: formats.ok,
      certificateRejected,
      error: formats.error?.message ?? null,
      attemptedGuardedConnect,
      serverHttpRequests: [...untrustedTlsRequests],
      invariantPassed: passed,
    });
    assert.equal(formats.ok, false, JSON.stringify(formats));
    assert.ok(
      certificateRejected,
      `format request failed for a reason other than certificate verification: ${JSON.stringify(formats)}`,
    );
    assert.ok(
      attemptedGuardedConnect,
      "untrusted TLS fixture did not receive an attempt through the proxy",
    );
    assert.deepEqual(
      untrustedTlsRequests,
      [],
      "yt-dlp accepted an untrusted TLS certificate",
    );
  });

  it("blocks DNS aliases to loopback across preview, formats, downloads, and external handoff", async () => {
    const target = aliasUrl("/video.mp4");
    const [preview, formats, external] = await Promise.all([
      api("getVideoInfo", target),
      api("getFormats", target),
      api("openExternal", target),
    ]);
    const download = await api("downloadVideo", {
      url: target,
      outputPath: downloads,
      convertEnabled: false,
      hookBrowser: false,
      gpuAcceleration: false,
    });
    let activity;
    await browser.waitUntil(
      async () => {
        const response = await api("getDownloadActivity");
        activity = response.data?.find((item) => item.url === target);
        return Boolean(activity?.completedAt);
      },
      {
        timeout: 15_000,
        interval: 100,
        timeoutMsg: "private-alias download did not finish through the proxy",
      },
    );
    record("private-dns-alias", {
      previewRejected: preview.ok === false,
      formatsRejected: formats.ok === false,
      downloadOutcome: activity.outcome,
      externalRejected: external.ok === false,
      privateHits: [...privateHits],
      invariantPassed:
        preview.ok === false &&
        formats.ok === false &&
        download.ok === true &&
        activity.outcome === "failed" &&
        external.ok === false &&
        privateHits.length === 0,
    });
    for (const response of [preview, formats, external]) {
      assert.equal(response.ok, false, JSON.stringify(response));
    }
    assert.equal(download.ok, true, JSON.stringify(download));
    assert.equal(activity.outcome, "failed", JSON.stringify(activity));
    assert.deepEqual(
      privateHits,
      [],
      "private alias reached the local listener",
    );
  });

  it("blocks a public-preflight hostname that resolves privately at connection time", async () => {
    const target = rebindingUrl("/video.mp4");
    const tracePath = process.env.ROSI_E2E_PROXY_TRACE;
    assert.ok(tracePath, "ROSI_E2E_PROXY_TRACE is required");

    const [preview, formats] = await Promise.all([
      api("getVideoInfo", target),
      api("getFormats", target),
    ]);
    const thumbnailPreview = await api(
      "getVideoInfo",
      `${baseUrl}/metadata-rebinding`,
    );
    const started = await api("downloadVideo", {
      url: target,
      outputPath: downloads,
      convertEnabled: false,
      hookBrowser: false,
      gpuAcceleration: false,
    });
    assert.equal(started.ok, true, JSON.stringify(started));

    let activity;
    await browser.waitUntil(
      async () => {
        const response = await api("getDownloadActivity");
        activity = response.data?.find((item) => item.url === target);
        return Boolean(activity?.completedAt);
      },
      {
        timeout: 60_000,
        interval: 250,
        timeoutMsg: "rebinding download did not finish",
      },
    );

    const proxyDecisions = fs.existsSync(tracePath)
      ? fs
          .readFileSync(tracePath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter(
            (entry) =>
              entry.stage === "connection" && entry.host === "rebinding.test",
          )
      : [];
    const rejectedPrivateResolution = proxyDecisions.some(
      (entry) =>
        entry.allowed === false && entry.addresses.includes("127.0.0.1"),
    );
    const passed =
      preview.ok === false &&
      formats.ok === false &&
      thumbnailPreview.ok === true &&
      thumbnailPreview.data?.thumbnail == null &&
      activity.outcome === "failed" &&
      rejectedPrivateResolution &&
      rebindingHits.length === 0;
    record("dns-rebinding-connection-time", {
      previewError: preview.error?.message ?? null,
      formatsError: formats.error?.message ?? null,
      thumbnailPreviewOk: thumbnailPreview.ok,
      rebindingThumbnailReturned: thumbnailPreview.data?.thumbnail != null,
      downloadOutcome: activity.outcome,
      proxyDecisions,
      rebindingHits: [...rebindingHits],
      invariantPassed: passed,
    });
    assert.equal(preview.ok, false, JSON.stringify(preview));
    assert.equal(formats.ok, false, JSON.stringify(formats));
    assert.equal(thumbnailPreview.ok, true, JSON.stringify(thumbnailPreview));
    assert.equal(thumbnailPreview.data?.thumbnail ?? null, null);
    assert.equal(activity.outcome, "failed", JSON.stringify(activity));
    assert.ok(
      rejectedPrivateResolution,
      "the proxy did not record and reject the changed private DNS answer",
    );
    assert.deepEqual(
      rebindingHits,
      [],
      "the rebinding hostname reached the fixture",
    );
  });

  it("rechecks redirects and extractor thumbnails at each destination", async () => {
    const redirect = await api("getVideoInfo", `${baseUrl}/redirect-private`);
    const privateThumbnail = await api(
      "getVideoInfo",
      `${baseUrl}/metadata-private`,
    );
    const svgThumbnail = await api("getVideoInfo", `${baseUrl}/metadata-svg`);
    const largeThumbnail = await api(
      "getVideoInfo",
      `${baseUrl}/metadata-large`,
    );
    const privateThumbnailValue = privateThumbnail.data?.thumbnail;
    const svgThumbnailValue = svgThumbnail.data?.thumbnail;
    const largeThumbnailValue = largeThumbnail.data?.thumbnail;
    const passed =
      redirect.ok === false &&
      privateThumbnail.ok === true &&
      privateThumbnailValue == null &&
      svgThumbnailValue == null &&
      largeThumbnailValue == null &&
      !privateHits.includes("/blocked.mp4") &&
      !privateHits.includes("/thumb.png");
    record("redirect-and-extractor-handoffs", {
      redirectRejected: redirect.ok === false,
      metadataPreviewOk: privateThumbnail.ok,
      privateThumbnailReturned: privateThumbnailValue != null,
      svgThumbnailReturned: svgThumbnailValue != null,
      largeThumbnailReturned: largeThumbnailValue != null,
      privateHits: [...privateHits],
      invariantPassed: passed,
    });
    assert.equal(redirect.ok, false, JSON.stringify(redirect));
    assert.equal(privateThumbnail.ok, true, JSON.stringify(privateThumbnail));
    assert.equal(privateThumbnailValue, null);
    assert.equal(svgThumbnailValue, null);
    assert.equal(largeThumbnailValue, null);
    assert.ok(!privateHits.includes("/blocked.mp4"));
    assert.ok(!privateHits.includes("/thumb.png"));
  });

  it("downloads real native HLS fragments and blocks private segments, keys, and redirects", async () => {
    const goodUrl = `${baseUrl}/hls/valid.m3u8`;
    const started = await api("downloadVideo", {
      url: goodUrl,
      outputPath: downloads,
      convertEnabled: false,
      hookBrowser: false,
      gpuAcceleration: false,
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    const awaitOutcome = async (url) => {
      let item;
      await browser.waitUntil(
        async () => {
          const response = await api("getDownloadActivity");
          item = response.data?.find((candidate) => candidate.url === url);
          return Boolean(item?.completedAt);
        },
        {
          timeout: 60_000,
          interval: 250,
          timeoutMsg: `HLS download did not finish: ${url}`,
        },
      );
      return item;
    };
    const successful = await awaitOutcome(goodUrl);
    const realFragmentsRequested = requests.some((request) =>
      /^\/hls\/segment\d+\.ts$/.test(request.path),
    );
    assert.equal(successful.outcome, "success", JSON.stringify(successful));
    assert.ok(
      realFragmentsRequested,
      "native HLS did not request real fragments",
    );

    const blocked = [];
    for (const variant of [
      "private-segment",
      "private-key",
      "redirect-segment",
    ]) {
      const url = `${baseUrl}/hls/${variant}.m3u8`;
      const result = await api("downloadVideo", {
        url,
        outputPath: downloads,
        convertEnabled: false,
        hookBrowser: false,
        gpuAcceleration: false,
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      const item = await awaitOutcome(url);
      assert.equal(item.outcome, "failed", JSON.stringify(item));
      blocked.push({ variant, outcome: item.outcome });
    }
    const tracePath = process.env.ROSI_E2E_PROXY_TRACE;
    const proxyDecisions = fs
      .readFileSync(tracePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const privateRejections = proxyDecisions.filter(
      (entry) =>
        entry.stage === "connection" &&
        entry.host === "private.test" &&
        entry.allowed === false,
    );
    const passed =
      successful.outcome === "success" &&
      realFragmentsRequested &&
      blocked.length === 3 &&
      privateRejections.length >= 3 &&
      privateHits.length === 0;
    record("guarded-hls-fragments", {
      successOutcome: successful.outcome,
      realFragmentsRequested,
      blocked,
      privateRejections,
      privateHits: [...privateHits],
      invariantPassed: passed,
    });
    assert.ok(
      privateRejections.length >= 3,
      "private HLS segment, key, and redirect did not reach the proxy deny boundary",
    );
    assert.deepEqual(
      privateHits,
      [],
      "private HLS destinations reached the fixture",
    );
  });

  it("classifies bracketed public and unique-local IPv6 without opening external sockets", async () => {
    const encoded = await browser.executeAsync((done) => {
      window.__TAURI__.core.invoke("e2e_network_pipelining_probe").then(
        (value) => done(JSON.stringify({ ok: true, value })),
        (error) => done(JSON.stringify({ ok: false, error: String(error) })),
      );
    });
    const outcome = JSON.parse(encoded);
    const classification = outcome.value?.ipv6Classification;
    const passed =
      outcome.ok === true &&
      classification?.publicBracketedIsPublic === true &&
      classification?.uniqueLocalBracketedIsPrivate === true;
    record("bracketed-ipv6-classification", {
      classification: classification ?? null,
      invariantPassed: passed,
    });
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(
      classification?.publicBracketedIsPublic,
      true,
      "public bracketed IPv6 literal was not classified as public",
    );
    assert.equal(
      classification?.uniqueLocalBracketedIsPrivate,
      true,
      "bracketed unique-local IPv6 literal was not classified as private",
    );
  });

  it("closes slow metadata proxy sockets when an operation is cancelled", async () => {
    const startPending = async (method, url, flag) => {
      await browser.execute(
        (methodName, target, resultName) => {
          window[resultName] = { done: false, value: null };
          Promise.resolve()
            .then(() => window.api[methodName](target))
            .then(
              (value) => {
                window[resultName].value = value;
                window[resultName].done = true;
              },
              (error) => {
                window[resultName].value = String(error);
                window[resultName].done = true;
              },
            );
        },
        method,
        url,
        flag,
      );
    };
    const waitForHit = async (priorHits) =>
      browser.waitUntil(() => stalledConnections.hits > priorHits, {
        timeout: 10_000,
        interval: 50,
        timeoutMsg: "the stalled metadata fixture was not requested",
      });
    const waitForClosed = async (priorClosed) =>
      browser.waitUntil(() => stalledConnections.closed > priorClosed, {
        timeout: 5_000,
        interval: 50,
        timeoutMsg: "cancelled operation left its fixture connection open",
      });
    for (const [method, cancel, flag] of [
      ["getVideoInfo", "cancelVideoInfo", "__slowVideoInfo"],
      ["getFormats", "cancelFormats", "__slowFormats"],
    ]) {
      const priorHits = stalledConnections.hits;
      const priorClosed = stalledConnections.closed;
      await startPending(method, `${baseUrl}/hold-info`, flag);
      await waitForHit(priorHits);
      await api(cancel);
      await waitForClosed(priorClosed);
      await browser.waitUntil(
        () =>
          browser.execute(
            (resultName) => window[resultName]?.done === true,
            flag,
          ),
        {
          timeout: 10_000,
          interval: 50,
          timeoutMsg: `${method} did not settle after cancellation`,
        },
      );
    }
    record("proxy-cancellation-closes-active-sockets", {
      stalledConnections,
      invariantPassed:
        stalledConnections.closed === stalledConnections.hits &&
        stalledConnections.hits >= 2,
    });
    assert.equal(stalledConnections.closed, stalledConnections.hits);
    assert.ok(stalledConnections.hits >= 2);
  });

  it("cancels a stalled thumbnail transform and accepts fresh replacement metadata", async () => {
    const priorHits = stalledThumbnails.hits;
    const priorClosed = stalledThumbnails.closed;
    const resultName = "__stalledThumbnailMetadata";
    await browser.execute(
      (target, name) => {
        window[name] = { settled: false, ok: null, error: null, data: null };
        Promise.resolve()
          .then(() => window.api.getVideoInfo(target))
          .then(
            (value) => {
              window[name] = {
                settled: true,
                ok: value?.ok ?? null,
                error: value?.error?.message ?? null,
                data: value?.data ?? null,
              };
            },
            (error) => {
              window[name] = {
                settled: true,
                ok: false,
                error: String(error),
                data: null,
              };
            },
          );
      },
      `${baseUrl}/metadata-stalled-thumbnail`,
      resultName,
    );
    await browser.waitUntil(() => stalledThumbnails.hits > priorHits, {
      timeout: 15_000,
      interval: 50,
      timeoutMsg: "thumbnail fetch did not reach its stalled fixture",
    });

    const cancelStartedAt = Date.now();
    await api("cancelVideoInfo");
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          (name) => window[name]?.settled === true,
          resultName,
        )) && stalledThumbnails.closed > priorClosed,
      {
        timeout: 5_000,
        interval: 50,
        timeoutMsg:
          "thumbnail cancellation did not settle and close its fixture socket",
      },
    );
    const cancellationLatencyMs = Date.now() - cancelStartedAt;
    const staleResult = JSON.parse(
      await browser.execute(
        (name) => JSON.stringify(window[name] ?? null),
        resultName,
      ),
    );
    const replacement = await api("getVideoInfo", `${baseUrl}/metadata-safe`);
    const passed =
      cancellationLatencyMs < 1_000 &&
      staleResult?.ok === false &&
      String(staleResult?.error ?? "")
        .toLowerCase()
        .includes("cancel") &&
      stalledThumbnails.closed > priorClosed &&
      replacement.ok === true &&
      replacement.data?.thumbnail?.startsWith("data:image/png;base64,");
    record("thumbnail-fetch-cancellation", {
      cancellationLatencyMs,
      stalledThumbnailHits: stalledThumbnails.hits,
      stalledThumbnailClosed: stalledThumbnails.closed,
      staleResultOk: staleResult?.ok ?? null,
      staleResultError: staleResult?.error ?? null,
      replacementOk: replacement.ok,
      replacementThumbnailDataUrl:
        replacement.data?.thumbnail?.startsWith("data:image/png;base64,") ??
        false,
      invariantPassed: passed,
    });
    assert.ok(
      passed,
      `thumbnail cancellation or replacement failed: ${JSON.stringify({ cancellationLatencyMs, staleResult, stalledThumbnails, replacement })}`,
    );
  });

  it("cancels metadata and manual-download IPC during delayed connection DNS", async () => {
    const tracePath = process.env.ROSI_E2E_PROXY_TRACE;
    assert.ok(tracePath, "ROSI_E2E_PROXY_TRACE is required");
    const readTrace = () =>
      fs
        .readFileSync(tracePath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const waitPastSyntheticDns = () =>
      new Promise((resolve) => setTimeout(resolve, 2_500));
    const waitForDnsStart = async (host) =>
      browser.waitUntil(
        () =>
          readTrace().some(
            (event) => event.stage === "dns-resolving" && event.host === host,
          ),
        {
          timeout: 15_000,
          interval: 50,
          timeoutMsg: `${host} did not enter the guarded DNS resolver`,
        },
      );
    const startPending = async (method, args, resultName) =>
      browser.execute(
        (methodName, parameters, name) => {
          window[name] = { settled: false, ok: null, error: null };
          Promise.resolve()
            .then(() => window.api[methodName](...parameters))
            .then(
              (value) => {
                window[name] = {
                  settled: true,
                  ok: value?.ok ?? null,
                  error: value?.error?.message ?? null,
                };
              },
              (error) => {
                window[name] = {
                  settled: true,
                  ok: false,
                  error: String(error),
                };
              },
            );
        },
        method,
        args,
        resultName,
      );
    const readPending = async (resultName) =>
      JSON.parse(
        await browser.execute(
          (name) => JSON.stringify(window[name] ?? null),
          resultName,
        ),
      );

    const metadataHost = "rosi-dns-delay-metadata.invalid";
    const metadataUrl = `https://${metadataHost}/watch`;
    await startPending("getVideoInfo", [metadataUrl], "__delayedMetadata");
    await waitForDnsStart(metadataHost);
    const metadataCancelStartedAt = Date.now();
    await api("cancelVideoInfo");
    await browser.waitUntil(
      async () => (await readPending("__delayedMetadata"))?.settled === true,
      {
        timeout: 5_000,
        interval: 50,
        timeoutMsg: "metadata IPC did not settle after DNS cancellation",
      },
    );
    const metadataCancelLatencyMs = Date.now() - metadataCancelStartedAt;
    const metadataEvents = readTrace().filter(
      (event) => event.host === metadataHost,
    );
    const metadataResult = await readPending("__delayedMetadata");
    const replacementMetadata = await api(
      "getVideoInfo",
      `${baseUrl}/metadata-safe`,
    );
    const metadataCancelled =
      metadataResult?.settled === true &&
      metadataResult?.ok === false &&
      String(metadataResult?.error ?? "")
        .toLowerCase()
        .includes("cancel") &&
      metadataEvents.some((event) => event.stage === "dns-resolving") &&
      !metadataEvents.some((event) => event.stage === "preflight") &&
      !metadataEvents.some((event) => event.stage === "connection") &&
      metadataCancelLatencyMs < 1_000 &&
      replacementMetadata.ok === true;
    assert.ok(
      metadataCancelled,
      `metadata DNS cancellation was not bound to its reserved IPC operation: ${JSON.stringify({ metadataResult, metadataEvents })}`,
    );
    await waitPastSyntheticDns();
    const metadataEventsAfterDrain = readTrace().filter(
      (event) => event.host === metadataHost,
    );
    const metadataFixtureHitAfterDrain = requests.some((request) =>
      request.host?.startsWith(`${metadataHost}:`),
    );
    const metadataNoLateConnection =
      !metadataEventsAfterDrain.some((event) => event.stage === "connection") &&
      !metadataFixtureHitAfterDrain;
    assert.ok(
      metadataNoLateConnection,
      `metadata DNS completed after cancellation and reached a connection: ${JSON.stringify({ metadataEventsAfterDrain, metadataFixtureHitAfterDrain })}`,
    );

    const downloadHost = "rosi-dns-delay-manual.invalid";
    const downloadUrl = `https://${downloadHost}/video.mp4`;
    const started = await api("downloadVideo", {
      url: downloadUrl,
      outputPath: downloads,
      convertEnabled: false,
      hookBrowser: false,
      gpuAcceleration: false,
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    await waitForDnsStart(downloadHost);
    const downloadCancelStartedAt = Date.now();
    await api("cancelDownload");
    let activity;
    await browser.waitUntil(
      async () => {
        const response = await api("getDownloadActivity");
        activity = response.data?.find((item) => item.url === downloadUrl);
        return Boolean(activity?.completedAt);
      },
      {
        timeout: 10_000,
        interval: 100,
        timeoutMsg: "manual download did not settle after DNS cancellation",
      },
    );
    const downloadCancelLatencyMs = Date.now() - downloadCancelStartedAt;
    await waitPastSyntheticDns();
    const downloadEvents = readTrace().filter(
      (event) => event.host === downloadHost,
    );
    const downloadFixtureHit = requests.some((request) =>
      request.host?.startsWith(`${downloadHost}:`),
    );
    const manualCancelled =
      activity?.outcome === "cancelled" &&
      downloadEvents.some((event) => event.stage === "dns-resolving") &&
      !downloadEvents.some((event) => event.stage === "preflight") &&
      !downloadEvents.some((event) => event.stage === "connection") &&
      !downloadFixtureHit &&
      downloadCancelLatencyMs < 1_000;
    record("dns-cancellation-reserved-ipc", {
      metadataResult,
      metadataEvents,
      metadataEventsAfterDrain,
      metadataFixtureHitAfterDrain,
      replacementMetadataOk: replacementMetadata.ok,
      replacementMetadataTitle: replacementMetadata.data?.title ?? null,
      downloadOutcome: activity?.outcome ?? null,
      metadataCancelLatencyMs,
      downloadCancelLatencyMs,
      downloadEvents,
      downloadFixtureHit,
      invariantPassed:
        metadataCancelled && metadataNoLateConnection && manualCancelled,
    });
    assert.equal(activity?.outcome, "cancelled", JSON.stringify(activity));
    assert.ok(
      manualCancelled,
      `manual download DNS cancellation did not stop the reserved operation: ${JSON.stringify({ activity, downloadEvents })}`,
    );
  });

  it("does not forward an unreviewed pipelined absolute target", async () => {
    const encoded = await browser.executeAsync((done) => {
      window.__TAURI__.core.invoke("e2e_network_pipelining_probe").then(
        (value) => done(JSON.stringify({ ok: true, value })),
        (error) => done(JSON.stringify({ ok: false, error: String(error) })),
      );
    });
    const outcome = JSON.parse(encoded);
    const value = outcome.value;
    const passed =
      outcome.ok === true &&
      JSON.stringify(value?.requests) ===
        JSON.stringify(["GET /first HTTP/1.1"]) &&
      value?.responseStatus === 200 &&
      value?.responseBody === "OK" &&
      value?.secondTargetForwarded === false;
    record("proxy-rejects-unreviewed-pipelined-destination", {
      outcome,
      invariantPassed: passed,
    });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.deepEqual(value?.requests, ["GET /first HTTP/1.1"]);
    assert.equal(value?.responseStatus, 200);
    assert.equal(value?.responseBody, "OK");
    assert.equal(value?.secondTargetForwarded, false);

    const dns = value?.dnsResolution;
    const dnsPassed =
      dns?.batches === 3 &&
      dns?.requestAttempts === 72 &&
      dns?.workersStarted === dns?.workerLimit &&
      dns?.workerLimit === 4 &&
      dns?.maxActiveWorkers <= dns?.workerLimit &&
      dns?.queueHighWater === dns?.queueLimit &&
      dns?.queueHighWater <= 16 &&
      dns?.rejectedRequests > 0 &&
      dns?.cancelledWaits > 0 &&
      dns?.syntheticLookupsStarted > 0 &&
      dns?.syntheticDelayMs >= 2000 &&
      dns?.maxCallerReturnMs < 1000 &&
      dns?.pendingAfterDrain === 0 &&
      dns?.activeAfterDrain === 0;
    record("bounded-dns-cancellation", {
      dnsResolution: dns ?? null,
      invariantPassed: dnsPassed,
    });
    assert.ok(
      dnsPassed,
      `DNS resolver bounds were not proven: ${JSON.stringify(dns)}`,
    );
  });
});
