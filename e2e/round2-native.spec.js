import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "./helpers/app-bridge.js";
import { readListFile } from "./helpers/persisted.js";

const env = process.env;
const downloads = env.ROSI_E2E_DOWNLOADS;
const dataDirectory = env.ROSI_E2E_DATA_DIR;
const artifactDirectory = env.ROSI_ROUND2_NATIVE_ARTIFACTS;
const tonePath = env.ROSI_ROUND2_NATIVE_TONE;
const replacementReady = env.ROSI_ROUND2_NATIVE_REPLACEMENT_READY;
const replacementRelease = env.ROSI_ROUND2_NATIVE_REPLACEMENT_RELEASE;
const observations = [];
const failures = [];
let mediaServer;
let mediaUrl;
let mediaState;
const mediaRequests = [];
const routeCounts = new Map();

const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

function record(name, details) {
  observations.push({ name, ...details });
  fs.writeFileSync(
    path.join(artifactDirectory, "observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
  if (details.invariantPassed === false) failures.push(name);
}

async function completedActivity(url) {
  let found;
  await browser.waitUntil(
    async () => {
      const response = await api("getDownloadActivity");
      found = response.data.find((entry) => entry.url === url);
      return Boolean(found);
    },
    { timeout: 90_000, interval: 150, timeoutMsg: `No completion for ${url}` },
  );
  return found;
}

async function startDownload(url, overrides = {}) {
  const response = await api("downloadVideo", {
    url,
    outputPath: downloads,
    convertEnabled: false,
    hookBrowser: false,
    gpuAcceleration: false,
    ...overrides,
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data;
}

function startMediaServer() {
  const tone = fs.readFileSync(tonePath);
  const foreignArrival = Buffer.concat([
    tone,
    Buffer.from("\nROSI_ROUND2_FOREIGN_ARRIVAL\n"),
  ]);
  mediaServer = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    mediaRequests.push({ method: request.method, path: url.pathname });
    const knownPaths = new Set([
      "/arriving-owned.mp4",
      "/replace-source.mp4",
      "/plain.mp4",
      "/failure.mp4",
      "/cancel.mp4",
      "/retry.mp4",
    ]);
    if (!knownPaths.has(url.pathname)) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
      return;
    }
    if (url.pathname === "/failure.mp4") {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("intentional round two failure");
      return;
    }
    if (url.pathname === "/retry.mp4" && request.method !== "HEAD") {
      const count = (routeCounts.get(url.pathname) ?? 0) + 1;
      routeCounts.set(url.pathname, count);
      if (count === 1) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("first attempt fails so queue retry can be checked");
        return;
      }
    }
    if (url.pathname === "/cancel.mp4" && request.method !== "HEAD") {
      const totalBytes = 32 * 1024 * 1024;
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Length": String(totalBytes),
      });
      const send = () => {
        if (response.destroyed || sent >= totalBytes) return;
        const next = chunk.subarray(
          0,
          Math.min(chunk.length, totalBytes - sent),
        );
        sent += next.length;
        response.write(next);
        if (sent >= totalBytes) response.end();
      };
      send();
      const interval = setInterval(send, 100);
      response.on("close", () => clearInterval(interval));
      return;
    }
    if (url.pathname === "/arriving-owned.mp4" && request.method !== "HEAD") {
      const foreignPath = path.join(downloads, "arriving-owned.mp4");
      if (!fs.existsSync(foreignPath))
        fs.writeFileSync(foreignPath, foreignArrival);
    }
    response.writeHead(200, {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Length": String(tone.length),
    });
    if (request.method === "HEAD") response.end();
    else response.end(tone);
  });
  return new Promise((resolve, reject) => {
    mediaServer.once("error", reject);
    mediaServer.listen(0, "127.0.0.1", () => {
      mediaUrl = `http://127.0.0.1:${mediaServer.address().port}`;
      resolve({ requests: mediaRequests, foreignArrival });
    });
  });
}

async function waitForNoStaging(timeout = 10_000) {
  await browser.waitUntil(
    () =>
      fs
        .readdirSync(downloads)
        .every((name) => !name.startsWith(".rosi-download-")),
    {
      timeout,
      interval: 50,
      timeoutMsg: "Owned download staging did not retire",
    },
  );
}

function guardTempRoots() {
  return [
    os.tmpdir(),
    env.TMPDIR,
    env.TMP,
    env.TEMP,
    path.join(dataDirectory, "tmp"),
  ].filter(
    (root, index, roots) =>
      root && roots.findIndex((candidate) => candidate === root) === index,
  );
}

function listGuardLaunchers() {
  const launchers = [];
  for (const root of guardTempRoots()) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("rosi-media-tools-"))
        continue;
      const directory = path.join(root, entry.name);
      const configPath = path.join(directory, "launcher.json");
      const aliasPath = path.join(
        directory,
        process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
      );
      try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (
          !config.ffmpeg ||
          !fs.existsSync(config.ffmpeg) ||
          !fs.statSync(aliasPath).isFile()
        ) {
          continue;
        }
        launchers.push({
          root,
          directory,
          configPath,
          config,
          aliasPath,
          modifiedAt: fs.statSync(directory).mtimeMs,
        });
      } catch {
        // Ignore unrelated or concurrently retired private tool directories.
      }
    }
  }
  return launchers;
}

function guardLauncherKey(launcher) {
  return path.resolve(launcher.configPath).toLocaleLowerCase();
}

function isAppOwnedAlias(launcher) {
  const appBinary = env.ROSI_E2E_BINARY;
  if (!appBinary || !fs.existsSync(appBinary)) return false;
  if (process.platform === "win32") {
    return (
      sha256(fs.readFileSync(launcher.aliasPath)) ===
      sha256(fs.readFileSync(appBinary))
    );
  }
  const script = fs.readFileSync(launcher.aliasPath, "utf8");
  return (
    script.startsWith("#!/bin/sh\n") &&
    script.includes(path.resolve(appBinary)) &&
    script.includes("--rosi-private-media-tool") &&
    script.includes(launcher.configPath)
  );
}

async function terminateProbeTree(child) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    child.kill("SIGKILL");
    return;
  }
  await new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", resolve);
    killer.once("close", resolve);
  });
}

async function probeAppCreatedFfmpegAlias(existingLaunchers) {
  const existingKeys = new Set(existingLaunchers.map(guardLauncherKey));
  const deadline = Date.now() + 10_000;
  let observedLaunchers = [];
  let launcher;
  while (Date.now() < deadline) {
    observedLaunchers = listGuardLaunchers();
    launcher = observedLaunchers.find(
      (candidate) => !existingKeys.has(guardLauncherKey(candidate)),
    );
    if (launcher) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!launcher) {
    return {
      timedOut: true,
      exitCode: null,
      aliasRoots: guardTempRoots(),
      observedLaunchers: observedLaunchers.map((candidate) => ({
        directory: candidate.directory,
        configPath: candidate.configPath,
        ffmpeg: candidate.config.ffmpeg,
      })),
      invariantPassed: false,
    };
  }
  const aliasOwnedByApp = isAppOwnedAlias(launcher);
  if (!aliasOwnedByApp) {
    return {
      timedOut: false,
      exitCode: null,
      aliasRoots: guardTempRoots(),
      aliasDirectory: launcher.directory,
      launcherConfigPath: launcher.configPath,
      configuredFfmpeg: launcher.config.ffmpeg,
      aliasOwnedByApp,
      invariantPassed: false,
    };
  }
  const child = spawn(launcher.aliasPath, ["-version"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(async () => {
      await terminateProbeTree(child);
      finish({ timedOut: true, exitCode: null, signal: null });
    }, 5000);
    child.once("error", (error) =>
      finish({ timedOut: false, exitCode: null, error: error.message }),
    );
    child.once("close", (exitCode, signal) =>
      finish({ timedOut: false, exitCode, signal }),
    );
  });
  return {
    aliasDirectory: launcher.directory,
    launcherConfigPath: launcher.configPath,
    configuredFfmpeg: launcher.config.ffmpeg,
    configuredFfprobe: launcher.config.ffprobe,
    aliasOwnedByApp,
    ...result,
    invariantPassed:
      aliasOwnedByApp && !result.timedOut && result.exitCode === 0,
  };
}

describe("ROSI round 2 native repairs", () => {
  before(async () => {
    await waitForAppReady();
    mediaState = await startMediaServer();
  });

  after(async () => {
    if (mediaServer) {
      await new Promise((resolve) => {
        mediaServer.closeAllConnections?.();
        mediaServer.close(resolve);
      });
    }
  });

  it("installs normal downloads and retires failed, cancelled, and retried staging", async function () {
    this.timeout(240_000);

    const plainUrl = `${mediaUrl}/plain.mp4?round2-plain=1`;
    await startDownload(plainUrl);
    const plain = await completedActivity(plainUrl);
    await waitForNoStaging();
    const plainPaths = plain.outputPaths ?? [];
    const plainPassed =
      plain.outcome === "success" &&
      plainPaths.length > 0 &&
      plainPaths.every(
        (output) =>
          fs.existsSync(output) &&
          path.dirname(path.resolve(output)) === path.resolve(downloads),
      );
    record("download-only-final-placement", {
      outcome: plain.outcome,
      outputPaths: plainPaths,
      invariantPassed: plainPassed,
    });
    assert.equal(
      plainPassed,
      true,
      "A completed download was not installed in the selected folder",
    );

    const failureUrl = `${mediaUrl}/failure.mp4?round2-failure=1`;
    await startDownload(failureUrl);
    const failed = await completedActivity(failureUrl);
    await waitForNoStaging();
    const failedNames = fs
      .readdirSync(downloads)
      .filter((name) => name.startsWith("failure"));
    const failurePassed =
      failed.outcome === "failed" &&
      (failed.outputPaths ?? []).length === 0 &&
      failedNames.length === 0;
    record("download-failure-cleans-staging", {
      outcome: failed.outcome,
      visibleFailureFiles: failedNames,
      invariantPassed: failurePassed,
    });
    assert.equal(
      failurePassed,
      true,
      "A failed transfer left an installed or owned staging file",
    );

    const cancelUrl = `${mediaUrl}/cancel.mp4?round2-cancel=1`;
    const priorGuardLaunchers = listGuardLaunchers();
    await startDownload(cancelUrl);
    await browser.waitUntil(
      () =>
        mediaRequests.some(
          (item) => item.method === "GET" && item.path === "/cancel.mp4",
        ),
      {
        timeout: 30_000,
        interval: 50,
        timeoutMsg: "The slow local transfer did not begin",
      },
    );
    const guardedFfmpeg = await probeAppCreatedFfmpegAlias(priorGuardLaunchers);
    await api("cancelDownload");
    const cancelled = await completedActivity(cancelUrl);
    await waitForNoStaging();
    const cancelNames = fs
      .readdirSync(downloads)
      .filter((name) => name.startsWith("cancel"));
    const cancellationPassed =
      cancelled.outcome === "cancelled" &&
      (cancelled.outputPaths ?? []).length === 0 &&
      cancelNames.length === 0 &&
      guardedFfmpeg.invariantPassed;
    record("download-cancel-cleans-staging", {
      outcome: cancelled.outcome,
      visibleCancelFiles: cancelNames,
      guardedFfmpeg,
      invariantPassed: cancellationPassed,
    });
    assert.equal(
      cancellationPassed,
      true,
      "Cancelling left an output/staging file or the private FFmpeg alias did not exit",
    );

    const retryUrl = `${mediaUrl}/retry.mp4?round2-retry=1`;
    const added = await api("addToQueue", [retryUrl], {
      outputPath: downloads,
      convertEnabled: false,
    });
    assert.equal(added.ok, true, JSON.stringify(added));
    const queueItem = (await api("getQueue")).find(
      (item) => item.url === retryUrl,
    );
    assert.ok(queueItem, "Retry fixture was not added to the queue");
    assert.equal((await api("startQueue")).ok, true);
    await browser.waitUntil(
      async () =>
        (await api("getQueue")).find((item) => item.id === queueItem.id)
          ?.status === "failed",
      {
        timeout: 60_000,
        interval: 100,
        timeoutMsg: "The intentional first queue attempt did not fail",
      },
    );
    await waitForNoStaging();
    assert.equal((await api("retryQueueItem", queueItem.id)).ok, true);
    assert.equal((await api("startQueue")).ok, true);
    await browser.waitUntil(
      async () =>
        (await api("getQueue")).find((item) => item.id === queueItem.id)
          ?.status === "completed",
      {
        timeout: 60_000,
        interval: 100,
        timeoutMsg: "The queue retry did not complete",
      },
    );
    const retried = await completedActivity(retryUrl);
    await waitForNoStaging();
    const retryHistory = (await api("getDownloadActivity")).data.filter(
      (entry) => entry.url === retryUrl,
    );
    const retryPaths = retried.outputPaths ?? [];
    const retryGetCount = routeCounts.get("/retry.mp4") ?? 0;
    const retryPassed =
      retryGetCount >= 2 &&
      retryHistory.some((entry) => entry.outcome === "failed") &&
      retryHistory.some((entry) => entry.outcome === "success") &&
      retried.outcome === "success" &&
      retryPaths.length > 0 &&
      retryPaths.every((output) => fs.existsSync(output)) &&
      retryPaths.every(
        (output) =>
          path.dirname(path.resolve(output)) === path.resolve(downloads),
      );
    record("download-retry-cleans-staging", {
      firstAttemptFailed: retryHistory.some(
        (entry) => entry.outcome === "failed",
      ),
      retryOutcome: retried.outcome,
      serverGetCount: retryGetCount,
      outputPaths: retryPaths,
      invariantPassed: retryPassed,
    });
    assert.equal(
      retryPassed,
      true,
      "Queue retry did not install a final output and retire staging",
    );
  });

  it("isolates downloads, preserves replaced sources, verifies Deno, and keeps Activity durable", async function () {
    this.timeout(300_000);
    const arrivingUrl = `${mediaUrl}/arriving-owned.mp4?round2-arrival=1`;
    const arrivalPath = path.join(downloads, "arriving-owned.mp4");
    const { foreignArrival } = mediaState;
    const arrivalStarted = await startDownload(arrivingUrl, {
      convertEnabled: true,
      convertFormat: "m4a",
      keepOriginal: false,
    });
    const arrivalCompletion = await completedActivity(arrivingUrl);
    const arrivalBytes = fs.existsSync(arrivalPath)
      ? fs.readFileSync(arrivalPath)
      : Buffer.alloc(0);
    const arrivalOutputs = arrivalCompletion.outputPaths ?? [];
    const stagingLeftovers = fs
      .readdirSync(downloads)
      .filter(
        (name) =>
          name.startsWith(".rosi-download-") || name.startsWith(".rosi-path-"),
      );
    const arrivalPassed =
      arrivalCompletion.outcome === "success" &&
      sha256(arrivalBytes) === sha256(foreignArrival) &&
      arrivalOutputs.length > 0 &&
      arrivalOutputs.every((output) => fs.existsSync(output)) &&
      stagingLeftovers.length === 0;
    record("download-staging-preserves-arrival", {
      sessionId: arrivalStarted.sessionId,
      outcome: arrivalCompletion.outcome,
      foreignPath: arrivalPath,
      foreignBytes: arrivalBytes.length,
      foreignSha256: sha256(arrivalBytes),
      expectedForeignSha256: sha256(foreignArrival),
      outputPaths: arrivalOutputs,
      stagingLeftovers,
      invariantPassed: arrivalPassed,
    });
    assert.equal(
      arrivalPassed,
      true,
      "A file that arrived during the request was replaced or deleted",
    );

    if (process.platform === "win32") {
      record("source-identity-preserves-replacement", {
        skipped: true,
        skipReason:
          "The POSIX FFmpeg gate wrapper used to replace a source during conversion is unavailable on Windows.",
        invariantPassed: true,
      });
    } else {
      const replacementUrl = `${mediaUrl}/replace-source.mp4?round2-replacement=1`;
      await startDownload(replacementUrl, {
        convertEnabled: true,
        convertFormat: "m4a",
        keepOriginal: false,
      });
      await browser.waitUntil(() => fs.existsSync(replacementReady), {
        timeout: 45_000,
        interval: 100,
        timeoutMsg: "FFmpeg did not reach source replacement gate",
      });
      const replacement = JSON.parse(fs.readFileSync(replacementReady, "utf8"));
      const replacementSource = replacement.input;
      const publicSource = path.join(
        downloads,
        path.basename(replacementSource),
      );
      const foreignReplacement = Buffer.from(
        "foreign replacement after FFmpeg read the source\n",
      );
      assert.ok(
        path
          .basename(path.dirname(replacementSource))
          .startsWith(".rosi-download-"),
        `FFmpeg source was not held in owned staging: ${replacementSource}`,
      );
      assert.equal(fs.existsSync(publicSource), false);
      const heldOriginal = fs.openSync(replacementSource, "r");
      let replacementCompletion;
      try {
        fs.unlinkSync(replacementSource);
        fs.writeFileSync(replacementSource, foreignReplacement);
        fs.writeFileSync(replacementRelease, "release\n");
        replacementCompletion = await completedActivity(replacementUrl);
      } finally {
        fs.closeSync(heldOriginal);
      }
      const replacementBytes = fs.existsSync(publicSource)
        ? fs.readFileSync(publicSource)
        : Buffer.alloc(0);
      const replacementOutputs = replacementCompletion.outputPaths ?? [];
      const replacementPassed =
        replacementCompletion.outcome === "success" &&
        sha256(replacementBytes) === sha256(foreignReplacement) &&
        replacementOutputs.some((output) => fs.existsSync(output)) &&
        !fs.existsSync(replacementSource) &&
        !fs
          .readdirSync(downloads)
          .some((name) => name.startsWith(".rosi-download-"));
      record("source-identity-preserves-replacement", {
        outcome: replacementCompletion.outcome,
        sourceStagePath: replacementSource,
        publicReplacementPath: publicSource,
        replacementSha256: sha256(replacementBytes),
        expectedReplacementSha256: sha256(foreignReplacement),
        outputPaths: replacementOutputs,
        invariantPassed: replacementPassed,
      });
      assert.equal(
        replacementPassed,
        true,
        "Conversion did not preserve a foreign replacement of its staged source",
      );
    }

    const deno = await probeDeno();
    record("deno-version-probe", deno);
    assert.equal(
      deno.invariantPassed,
      true,
      "Deno detection accepted a broken executable or rejected a valid one",
    );

    const activityPath = path.join(dataDirectory, "download-activity.json");
    const beforeClear = await api("getDownloadActivity");
    assert.ok(
      beforeClear.data.length >= 2,
      "Completed native downloads are missing from Activity",
    );
    const activityBytes = fs.statSync(activityPath).size;
    const persistedActivity = readListFile(activityPath);
    const remainingSeedRecords = persistedActivity.filter((entry) =>
      entry.id.startsWith("round2-seed-"),
    ).length;
    const latestNativeEntries = beforeClear.data.filter((entry) =>
      [
        arrivingUrl,
        `${mediaUrl}/replace-source.mp4?round2-replacement=1`,
      ].includes(entry.url),
    );
    const budgetPassed =
      activityBytes <= 16 * 1024 * 1024 &&
      persistedActivity.length === beforeClear.data.length &&
      persistedActivity.length <= 100 &&
      remainingSeedRecords < 99 &&
      latestNativeEntries.length >= 1 &&
      latestNativeEntries.every(
        (entry) =>
          entry.statusMessage.length > 0 && entry.outcome === "success",
      );
    record("activity-byte-budget-preserves-newest", {
      seedBytes: Number(env.ROSI_ROUND2_NATIVE_ACTIVITY_SEED_BYTES ?? 0),
      diskBytes: activityBytes,
      readLimitBytes: 16 * 1024 * 1024,
      diskRecordCount: persistedActivity.length,
      memoryRecordCount: beforeClear.data.length,
      remainingSeedRecords,
      latestNativeUrls: latestNativeEntries.map((entry) => entry.url),
      invariantPassed: budgetPassed,
    });
    assert.equal(
      budgetPassed,
      true,
      "Activity writing exceeded the read limit or dropped newest detail",
    );
    const backupActivity = `${activityPath}.round2-backup`;
    fs.renameSync(activityPath, backupActivity);
    fs.mkdirSync(activityPath);
    const failedClear = await api("clearDownloadActivity");
    const retained = await api("getDownloadActivity");
    const failurePreserved =
      failedClear.ok === false &&
      retained.data.map((entry) => entry.id).join(",") ===
        beforeClear.data.map((entry) => entry.id).join(",");
    record("activity-clear-persist-failure-preserves-memory", {
      clearOk: failedClear.ok,
      priorEntryCount: beforeClear.data.length,
      retainedEntryCount: retained.data.length,
      invariantPassed: failurePreserved,
    });
    assert.equal(
      failurePreserved,
      true,
      "Failed Activity persistence cleared the in-memory list",
    );
    fs.rmSync(activityPath, { recursive: true, force: true });
    fs.renameSync(backupActivity, activityPath);
    const successfulClear = await api("clearDownloadActivity");
    const cleared = await api("getDownloadActivity");
    const diskActivity = readListFile(activityPath);
    const clearPassed =
      successfulClear.ok === true &&
      cleared.data.length === 0 &&
      diskActivity.length === 0 &&
      fs
        .readdirSync(dataDirectory)
        .every(
          (name) =>
            !name.startsWith(".download-activity.json.") ||
            !name.endsWith(".tmp"),
        );
    record("activity-clear-durable-retry", {
      clearOk: successfulClear.ok,
      memoryCount: cleared.data.length,
      diskCount: diskActivity.length,
      diskBytes: fs.statSync(activityPath).size,
      invariantPassed: clearPassed,
    });
    assert.equal(
      clearPassed,
      true,
      "Activity retry did not persist a parseable empty file",
    );
  });

  it("retires the renderer deadline before bounded asynchronous shutdown", async function () {
    this.timeout(30_000);
    const logPath = path.join(dataDirectory, "logs", "rosi.log");
    const delayMs = Number(env.ROSI_E2E_CLOSE_SHUTDOWN_DELAY_MS ?? 0);
    const startedAt = Date.now();
    await browser.execute(() => {
      void window.__TAURI__.window.getCurrentWindow().close();
    });
    await browser.waitUntil(
      () => {
        const log = fs.existsSync(logPath)
          ? fs.readFileSync(logPath, "utf8")
          : "";
        return log.includes("Main window closed.");
      },
      {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: "Native close did not finish",
      },
    );
    const elapsedMs = Date.now() - startedAt;
    const log = fs.readFileSync(logPath, "utf8");
    const timedOut = log.includes(
      "Timed out waiting for renderer settings flush; leaving the app open.",
    );
    const passed = elapsedMs > 1500 && elapsedMs >= delayMs && !timedOut;
    record("close-ack-survives-async-shutdown", {
      elapsedMs,
      injectedShutdownDelayMs: delayMs,
      rendererTimeoutReported: timedOut,
      invariantPassed: passed,
    });
    assert.equal(
      passed,
      true,
      "The renderer deadline cancelled a close after its flush acknowledgement",
    );
    globalThis.rosiMainWindowClosed = true;
  });

  it("reports the Windows leader-exit Job Object case as unproven", function () {
    record("windows-job-object-leader-exit", {
      skipped: true,
      skipReason:
        "This suite does not force a real app helper leader to exit while a descendant keeps an inherited pipe open.",
      invariantPassed: true,
    });
  });
});

async function probeDeno() {
  if (process.platform === "win32") {
    return {
      platform: process.platform,
      skipped: true,
      skipReason:
        "The isolated executable fixture currently uses a POSIX script.",
      invariantPassed: true,
    };
  }
  const denoPath = env.ROSI_ROUND2_NATIVE_DENO;
  const writeScript = (body) => {
    fs.writeFileSync(denoPath, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    fs.chmodSync(denoPath, 0o700);
  };
  writeScript("echo unrelated-tool 1.0; exit 0");
  const invalidDetected = await api("checkDenoInstalled");
  writeScript(
    "echo 'deno 2.5.1 (stable, release, x86_64-apple-darwin)'; exit 0",
  );
  const validDetected = await api("checkDenoInstalled");
  writeScript("sleep 10; echo 'deno 2.5.1'; exit 0");
  const startedAt = Date.now();
  const hangingDetected = await api("checkDenoInstalled");
  const elapsedMs = Date.now() - startedAt;
  return {
    platform: process.platform,
    invalidDetected,
    validDetected,
    hangingDetected,
    elapsedMs,
    invariantPassed:
      invalidDetected === false &&
      validDetected === true &&
      hangingDetected === false &&
      elapsedMs < 5000,
  };
}
