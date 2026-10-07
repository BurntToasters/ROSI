import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "./helpers/app-bridge.js";

const directory = process.env.ROSI_REPAIRS_DIRECTORY;
const downloads = process.env.ROSI_E2E_DOWNLOADS;
const media = process.env.ROSI_REPAIRS_MEDIA;
const authenticatedMedia = process.env.ROSI_REPAIRS_AUTH_MEDIA;
const terminationReady = process.env.ROSI_REPAIRS_TERMINATION_READY;
const malformedLauncher = process.env.ROSI_REPAIRS_MALFORMED_LAUNCHER;
const observations = [];
const failures = [];
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, details) {
  const observation = { name, ...details };
  observations.push(observation);
  fs.writeFileSync(
    path.join(directory, "observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
  if (details.invariantPassed === false) failures.push(name);
}

async function activity(url, oldId) {
  let found;
  await browser.waitUntil(
    async () => {
      const response = await api("getDownloadActivity");
      found = response.data.find(
        (item) => item.url === url && item.id !== oldId,
      );
      return Boolean(found);
    },
    { timeout: 30_000, interval: 100, timeoutMsg: `No completion for ${url}` },
  );
  return found;
}

async function download(url, overrides = {}, oldId) {
  const response = await api("downloadVideo", {
    url,
    outputPath: downloads,
    convertEnabled: false,
    hookBrowser: false,
    gpuAcceleration: false,
    ...overrides,
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  return activity(url, oldId);
}

async function downloadWithStagedSibling(url, fixturePath, overrides = {}) {
  const response = await api("downloadVideo", {
    url,
    outputPath: downloads,
    convertEnabled: false,
    hookBrowser: false,
    gpuAcceleration: false,
    ...overrides,
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  let stageDirectory;
  await browser.waitUntil(
    () => {
      const stages = fs
        .readdirSync(downloads, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() && entry.name.startsWith(".rosi-download-"),
        );
      if (stages.length > 1) {
        throw new Error(
          `Expected one active private download stage, found ${stages.length}`,
        );
      }
      if (stages.length !== 1) return false;
      stageDirectory = path.join(downloads, stages[0].name);
      return true;
    },
    {
      timeout: 10_000,
      interval: 25,
      timeoutMsg: `Download did not reserve a private staging directory: ${url}`,
    },
  );
  let fixtureName = path.basename(fixturePath);
  const urlStem = path.parse(new URL(url).pathname).name;
  const captionSuffix = fixtureName.startsWith(`${urlStem}.`)
    ? fixtureName.slice(urlStem.length)
    : null;
  if (
    captionSuffix &&
    /\.(?:ass|json3|lrc|srt|ssa|srv1|srv2|srv3|ttml|vtt)$/i.test(fixtureName)
  ) {
    let stagedMedia;
    await browser.waitUntil(
      () => {
        stagedMedia = filesUnder(stageDirectory).find((file) =>
          /\.(?:mkv|mka|mp4|m4v|mov|webm|avi|flv|ts|mp3|m4a|ogg|opus|wav)$/i.test(
            file,
          ),
        );
        return Boolean(stagedMedia);
      },
      {
        timeout: 10_000,
        interval: 25,
        timeoutMsg: `Media file was not staged before its caption: ${url}`,
      },
    );
    fixtureName = `${path.basename(stagedMedia, path.extname(stagedMedia))}${captionSuffix}`;
  }
  const stagedFixturePath = path.join(stageDirectory, fixtureName);
  fs.copyFileSync(fixturePath, stagedFixturePath);
  const stagedFixtureSha256 = hash(fs.readFileSync(stagedFixturePath));
  return {
    completion: await activity(url),
    stageDirectory,
    stagedFixturePath,
    stagedFixtureSha256,
  };
}

function inputDirectory(input) {
  try {
    const localPath = input.startsWith("file:") ? fileURLToPath(input) : input;
    return path.dirname(localPath);
  } catch {
    return null;
  }
}

function processMatches(marker, urlFragment = media) {
  if (process.platform === "win32") return [];
  const result = spawnSync("ps", ["-Ao", "pid=,command="], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split("\n")
    .filter(
      (line) =>
        line.includes("rosi-yt-dlp") &&
        line.includes(marker) &&
        line.includes(urlFragment),
    )
    .map(describeProcess);
}

function toolProcessMatches(marker, toolName) {
  if (process.platform === "win32") return [];
  const result = spawnSync("ps", ["-Ao", "pid=,command="], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split("\n")
    .filter(
      (line) =>
        line.includes(marker) &&
        line.toLowerCase().includes(toolName.toLowerCase()) &&
        !line.includes("rosi-yt-dlp"),
    )
    .map(describeProcess);
}

function describeProcess(line) {
  const command = line
    .trim()
    .replace(/(--proxy(?:=|\s+)http:\/\/)[^@\s]+@/gi, "$1<redacted>@");
  return {
    pid: Number(command.split(/\s+/)[0]),
    command,
  };
}

function readToolInvocations() {
  const tracePath = process.env.ROSI_REPAIRS_TOOL_TRACE;
  if (!tracePath || !fs.existsSync(tracePath)) return [];
  return fs
    .readFileSync(tracePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function downloadStageDirectories() {
  return fs
    .readdirSync(downloads, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(".rosi-download-"),
    )
    .map((entry) => path.join(downloads, entry.name));
}

function filesUnder(directory) {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function probeMediaStreams(filePath) {
  const result = spawnSync(
    process.env.ROSI_AUDIT3_REAL_FFPROBE,
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).streams ?? [];
}

function killMarkedProcesses(marker) {
  for (const child of processMatches(marker)) {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {}
  }
}

async function metadataCancellation(method, marker) {
  const startedAt = performance.now();
  await browser.execute(
    (baseUrl, methodName, queryMarker) => {
      window.repairMetadataResults = [];
      for (let index = 0; index < 10; index += 1) {
        const url = `${baseUrl}/slow.html?${queryMarker}=1&n=${index}`;
        window.api[methodName](url).then(
          (result) =>
            window.repairMetadataResults.push({
              ok: result?.ok ?? null,
              error: result?.error?.message ?? null,
            }),
          (error) =>
            window.repairMetadataResults.push({
              ok: false,
              error: String(error),
            }),
        );
      }
    },
    media,
    method,
    marker,
  );
  await pause(1500);
  const before = processMatches(marker);
  await api(method === "getFormats" ? "cancelFormats" : "cancelVideoInfo");
  await browser.waitUntil(
    () => browser.execute(() => window.repairMetadataResults.length === 10),
    { timeout: 15_000, interval: 100 },
  );
  const elapsedMs = Math.round(performance.now() - startedAt);
  const after = processMatches(marker);
  const results = await browser.execute(() =>
    window.repairMetadataResults.slice(),
  );
  const cancelledCount = results.filter(
    (result) =>
      result.ok === false &&
      String(result.error ?? "")
        .toLowerCase()
        .includes("cancel"),
  ).length;
  const replacement = await api(
    method,
    `${authenticatedMedia}/auth.html?repair-metadata-replacement=${method}`,
  );
  record(`metadata-${method}-cancellation`, {
    elapsedMs,
    processesBefore: before,
    processesAfter: after,
    results,
    cancelledCount,
    replacementOk: replacement.ok,
    invariantPassed:
      elapsedMs <= 15_000 &&
      before.length > 0 &&
      after.length === 0 &&
      results.length === 10 &&
      cancelledCount === 10 &&
      replacement.ok === true,
  });
  killMarkedProcesses(marker);
}

describe("ROSI downloader and process repairs", () => {
  before(waitForAppReady);

  it("preserves ownership and bounds every helper operation", async function () {
    this.timeout(360_000);

    // The reserved helper marker with missing operands must fail before Tauri
    // startup instead of accidentally creating an ordinary GUI process.
    try {
      const results = JSON.parse(fs.readFileSync(malformedLauncher, "utf8"));
      const cases = results.map((result) => ({
        name: result.name,
        status: result.status,
        signal: result.signal,
        error: result.error,
        rejectionReported: result.stderrTail.includes(result.expected),
        passed:
          result.status === 1 && result.stderrTail.includes(result.expected),
      }));
      record("malformed-private-launcher-invocation", {
        cases,
        invariantPassed:
          cases.length === 4 && cases.every((item) => item.passed),
      });
    } catch (error) {
      record("malformed-private-launcher-invocation", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F01: a failed encode and a cancelled encode must never delete an old
    // destination. A successful collision must use a distinct owned path.
    try {
      const brokenUrl = `${media}/broken.mp4?repair-preserve=1`;
      const initial = await download(brokenUrl);
      const failedTarget = initial.outputPath.replace(/\.mp4$/i, ".m4a");
      const failedSentinel = Buffer.from("preserve failed target\n");
      fs.writeFileSync(failedTarget, failedSentinel);
      const failed = await download(
        brokenUrl,
        { convertEnabled: true, convertFormat: "m4a", keepOriginal: true },
        initial.id,
      );
      const failedExists = fs.existsSync(failedTarget);

      const collisionUrl = `${media}/collision.mp4?repair-collision=1`;
      const collisionTarget = path.join(downloads, "collision.m4a");
      const collisionSentinel = Buffer.from("preserve collision target\n");
      fs.writeFileSync(collisionTarget, collisionSentinel);
      const converted = await download(collisionUrl, {
        convertEnabled: true,
        convertFormat: "m4a",
        keepOriginal: true,
      });
      record("conversion-attempt-ownership", {
        failedOutcome: failed.outcome,
        failedTargetSha256: failedExists
          ? hash(fs.readFileSync(failedTarget))
          : null,
        failedTargetPreserved:
          failedExists && fs.readFileSync(failedTarget).equals(failedSentinel),
        collisionOutcome: converted.outcome,
        collisionOutputPath: converted.outputPath,
        collisionTargetSha256: fs.existsSync(collisionTarget)
          ? hash(fs.readFileSync(collisionTarget))
          : null,
        collisionTargetPreserved:
          fs.existsSync(collisionTarget) &&
          fs.readFileSync(collisionTarget).equals(collisionSentinel),
        invariantPassed:
          failed.outcome === "failed" &&
          failedExists &&
          fs.readFileSync(failedTarget).equals(failedSentinel) &&
          converted.outcome === "success" &&
          fs.existsSync(collisionTarget) &&
          fs.readFileSync(collisionTarget).equals(collisionSentinel) &&
          converted.outputPath !== collisionTarget,
      });
    } catch (error) {
      record("conversion-attempt-ownership", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F01: distinct MP4/WebM source paths with the same yt-dlp stem and ID
    // must collide at the requested M4A destination without losing the first.
    try {
      const names = [
        `${media}/same-title.mp4?repair-same-stem-collision=mp4`,
        `${media}/same-title.webm?repair-same-stem-collision=webm`,
      ];
      const first = await download(names[0], {
        convertEnabled: true,
        convertFormat: "m4a",
        keepOriginal: true,
      });
      const firstBytes = fs.readFileSync(first.outputPath);
      const second = await download(names[1], {
        convertEnabled: true,
        convertFormat: "m4a",
        keepOriginal: true,
      });
      const outputPaths = [first.outputPath, second.outputPath];
      const sourcePaths = fs
        .readdirSync(downloads)
        .filter((name) => /^same-title.*\.(?:mp4|webm)$/i.test(name))
        .map((name) => path.join(downloads, name))
        .sort();
      const sourceStems = sourcePaths.map((sourcePath) =>
        path.basename(sourcePath).replace(/\.[^.]*$/, ""),
      );
      const expectedTarget =
        sourceStems.length > 0
          ? path.join(downloads, `${sourceStems[0]}.m4a`)
          : null;
      record("same-stem-container-conversion-collision", {
        sourceUrls: names,
        sourcePaths,
        sourceStems,
        expectedTarget,
        outputPaths,
        firstOutputSha256: hash(firstBytes),
        firstOutputStillPresent:
          fs.existsSync(first.outputPath) &&
          fs.readFileSync(first.outputPath).equals(firstBytes),
        outcomes: [first.outcome, second.outcome],
        invariantPassed:
          first.outcome === "success" &&
          second.outcome === "success" &&
          sourcePaths.length === 2 &&
          sourceStems[0] === sourceStems[1] &&
          new Set(sourcePaths.map((sourcePath) => path.extname(sourcePath)))
            .size === 2 &&
          first.outputPath === expectedTarget &&
          outputPaths[0] !== outputPaths[1] &&
          outputPaths.includes(expectedTarget) &&
          outputPaths.every((outputPath) => fs.existsSync(outputPath)) &&
          fs.readFileSync(first.outputPath).equals(firstBytes),
      });
    } catch (error) {
      record("same-stem-container-conversion-collision", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F09: all playlist outputs, not only the last after_move path, are
    // converted and the completion points at a real requested-format file.
    try {
      const playlistUrl = `${media}/list.html?repair-playlist=1`;
      const completed = await download(playlistUrl, {
        playlist: { mode: "all" },
        convertEnabled: true,
        convertFormat: "m4a",
        keepOriginal: false,
      });
      const names = fs
        .readdirSync(downloads)
        .filter((name) => /\[list-[12]\]\.(?:mp4|m4a)$/i.test(name));
      const converted = names.filter((name) => name.endsWith(".m4a"));
      const originals = names.filter((name) => name.endsWith(".mp4"));
      const outputPaths = completed.outputPaths ?? [];
      const outputBytes = outputPaths.reduce(
        (total, outputPath) => total + fs.statSync(outputPath).size,
        0,
      );
      record("playlist-conversion-accounting", {
        outcome: completed.outcome,
        outputPath: completed.outputPath,
        outputPaths,
        failedPaths: completed.failedPaths ?? [],
        sizeBytes: completed.sizeBytes,
        outputBytes,
        names,
        convertedCount: converted.length,
        originalCount: originals.length,
        invariantPassed:
          completed.outcome === "success" &&
          converted.length === 2 &&
          originals.length === 0 &&
          outputPaths.length === 2 &&
          outputPaths.every((outputPath) => outputPath.endsWith(".m4a")) &&
          (completed.failedPaths ?? []).length === 0 &&
          completed.sizeBytes === outputBytes,
      });
    } catch (error) {
      record("playlist-conversion-accounting", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F09: a failed second entry must report partial failure and retain the
    // successful first output in the completion result.
    try {
      const url = `${media}/partial-list.html?repair-partial-playlist=1`;
      const completion = await download(url, {
        playlist: { mode: "all" },
        convertEnabled: true,
        convertFormat: "m4a",
        keepOriginal: false,
      });
      const outputPaths = completion.outputPaths ?? [];
      const failedPaths = completion.failedPaths ?? [];
      record("playlist-partial-failure-accounting", {
        outcome: completion.outcome,
        outputPaths,
        failedPaths,
        sizeBytes: completion.sizeBytes,
        invariantPassed:
          completion.outcome === "failed" &&
          outputPaths.length === 1 &&
          outputPaths.every((outputPath) => fs.existsSync(outputPath)) &&
          failedPaths.length === 1 &&
          typeof completion.sizeBytes === "number" &&
          completion.sizeBytes ===
            outputPaths.reduce(
              (total, outputPath) => total + fs.statSync(outputPath).size,
              0,
            ),
      });
    } catch (error) {
      record("playlist-partial-failure-accounting", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F09: cancelling while the second entry is being probed must retain the
    // first converted result and the second completed original, with no visible
    // in-progress conversion file.
    try {
      const url = `${media}/cancel-between.html?repair-cancel-between=1`;
      const oldId = (await api("getDownloadActivity")).data[0]?.id;
      const response = await api("downloadVideo", {
        url,
        outputPath: downloads,
        playlist: { mode: "all" },
        convertEnabled: true,
        convertFormat: "m4a",
        keepOriginal: false,
        gpuAcceleration: false,
      });
      assert.equal(response.ok, true, JSON.stringify(response));
      await browser.waitUntil(
        () => fs.existsSync(process.env.ROSI_REPAIRS_CANCEL_BETWEEN_READY),
        { timeout: 15_000, interval: 50 },
      );
      const probeProcessesBefore = toolProcessMatches(
        "cancel-between-2",
        "ffmpeg",
      );
      await api("cancelDownload");
      const completion = await activity(url, oldId);
      const probeProcessesAfter = toolProcessMatches(
        "cancel-between-2",
        "ffmpeg",
      );
      const outputPaths = completion.outputPaths ?? [];
      const firstOutput = path.join(
        downloads,
        "Cancel between entries (1) [cancel-between-1].m4a",
      );
      const secondOutput = path.join(
        downloads,
        "Cancel between entries (2) [cancel-between-2].m4a",
      );
      const secondOriginal = path.join(
        downloads,
        "Cancel between entries (2) [cancel-between-2].mp4",
      );
      const staging = fs
        .readdirSync(downloads)
        .filter((name) => name.startsWith(".rosi-convert-"));
      record("playlist-cancel-retains-completed-entry", {
        outcome: completion.outcome,
        probeProcessesBefore,
        probeProcessesAfter,
        outputPaths,
        firstOutput,
        firstOutputPresent: fs.existsSync(firstOutput),
        secondOutput,
        secondOutputAbsent: !fs.existsSync(secondOutput),
        failedPaths: completion.failedPaths ?? [],
        sizeBytes: completion.sizeBytes,
        staging,
        invariantPassed:
          completion.outcome === "cancelled" &&
          probeProcessesBefore.length > 0 &&
          probeProcessesAfter.length === 0 &&
          outputPaths.length === 2 &&
          outputPaths.includes(firstOutput) &&
          outputPaths.includes(secondOriginal) &&
          fs.existsSync(firstOutput) &&
          outputPaths.every((outputPath) => fs.existsSync(outputPath)) &&
          !fs.existsSync(secondOutput) &&
          completion.sizeBytes ===
            outputPaths.reduce(
              (total, outputPath) => total + fs.statSync(outputPath).size,
              0,
            ) &&
          staging.length === 0,
      });
    } catch (error) {
      record("playlist-cancel-retains-completed-entry", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F10: WebM/VP8 to MP4 must encode on CPU when GPU use is off.
    try {
      const url = `${media}/vp8.webm?repair-cpu=1`;
      const completion = await download(url, {
        convertEnabled: true,
        convertFormat: "mp4",
        keepOriginal: true,
        gpuAcceleration: false,
      });
      const probe = completion.outputPath
        ? spawnSync(
            process.env.ROSI_REPAIRS_FFMPEG,
            ["-hide_banner", "-i", completion.outputPath],
            { encoding: "utf8" },
          )
        : null;
      const codec =
        `${probe?.stderr ?? ""}`.match(/Video:\s*([a-zA-Z0-9_]+)/)?.[1] ?? null;
      record("cpu-encoder-incompatible-video", {
        outcome: completion.outcome,
        outputPath: completion.outputPath,
        videoCodec: codec,
        invariantPassed: completion.outcome === "success" && codec === "h264",
      });
    } catch (error) {
      record("cpu-encoder-incompatible-video", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F10: a hardware encoder initialization failure must retry with libx264.
    try {
      const url = `${media}/force-gpu-fail.webm?repair-gpu-fallback=1`;
      const completion = await download(url, {
        convertEnabled: true,
        convertFormat: "mp4",
        keepOriginal: true,
        gpuAcceleration: true,
        gpuType: "nvidia",
      });
      const probe = completion.outputPath
        ? spawnSync(
            process.env.ROSI_REPAIRS_FFMPEG,
            ["-hide_banner", "-i", completion.outputPath],
            { encoding: "utf8" },
          )
        : null;
      const codec =
        `${probe?.stderr ?? ""}`.match(/Video:\s*([a-zA-Z0-9_]+)/)?.[1] ?? null;
      const forcedFailureObserved = fs.existsSync(
        process.env.ROSI_REPAIRS_GPU_FAILURE_MARKER,
      );
      record("gpu-encoder-fallback-to-cpu", {
        outcome: completion.outcome,
        outputPath: completion.outputPath,
        videoCodec: codec,
        forcedFailureObserved,
        invariantPassed:
          completion.outcome === "success" &&
          codec === "h264" &&
          forcedFailureObserved,
      });
    } catch (error) {
      record("gpu-encoder-fallback-to-cpu", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F10: cancellation during the codec probe must terminate it without
    // creating a conversion staging file or completing later.
    try {
      const url = `${media}/cancel-probe.webm?repair-cancel-probe=1`;
      const oldId = (await api("getDownloadActivity")).data[0]?.id;
      const response = await api("downloadVideo", {
        url,
        outputPath: downloads,
        convertEnabled: true,
        convertFormat: "mp4",
        keepOriginal: true,
        gpuAcceleration: false,
      });
      assert.equal(response.ok, true, JSON.stringify(response));
      await browser.waitUntil(
        () => fs.existsSync(process.env.ROSI_REPAIRS_CODEC_PROBE_READY),
        { timeout: 15_000, interval: 50 },
      );
      const probeProcessesBefore = toolProcessMatches("cancel-probe", "ffmpeg");
      const cancelStarted = performance.now();
      await api("cancelDownload");
      const completion = await activity(url, oldId);
      const elapsedMs = Math.round(performance.now() - cancelStarted);
      const probeProcessesAfter = toolProcessMatches("cancel-probe", "ffmpeg");
      const staging = fs
        .readdirSync(downloads)
        .filter((name) => name.startsWith(".rosi-convert-"));
      record("codec-probe-cancellation", {
        outcome: completion.outcome,
        elapsedMs,
        probeProcessesBefore,
        probeProcessesAfter,
        staging,
        invariantPassed:
          completion.outcome === "cancelled" &&
          probeProcessesBefore.length > 0 &&
          probeProcessesAfter.length === 0 &&
          elapsedMs <= 15_000 &&
          staging.length === 0,
      });
    } catch (error) {
      record("codec-probe-cancellation", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F03: overlapping manual starts and a queue start must leave no helper
    // tree after both cancellation paths have acknowledged the operation.
    try {
      const marker = "repair-owner-race=1";
      const queueUrl = `${media}/slow.mp4?${marker}&owner=queue`;
      const queued = await api("addToQueue", [queueUrl]);
      const manualUrl = `${media}/slow.mp4?${marker}&owner=manual`;
      const starts = await browser.executeAsync(
        (url, output, done) => {
          Promise.all([
            window.api.downloadVideo({
              url,
              outputPath: output,
              convertEnabled: false,
            }),
            window.api.startQueue(),
          ]).then(
            (results) => done(JSON.stringify(results)),
            (error) => done(JSON.stringify({ error: String(error) })),
          );
        },
        manualUrl,
        downloads,
      );
      await pause(1000);
      const before = processMatches(marker);
      await api("cancelDownload");
      await api("cancelQueue");
      await pause(6500);
      const after = processMatches(marker);
      const queue = await api("getQueue");
      record("manual-queue-start-ownership", {
        addToQueue: queued,
        starts: JSON.parse(starts),
        processesBefore: before,
        processesAfter: after,
        downloadingQueueItems: queue.filter(
          (item) => item.status === "downloading",
        ).length,
        invariantPassed:
          after.length === 0 &&
          queue.every((item) => item.status !== "downloading"),
      });
      killMarkedProcesses(marker);

      const fanoutMarker = "repair-manual-fanout=1";
      const concurrent = await browser.executeAsync(
        (baseUrl, output, done) => {
          Promise.all(
            Array.from({ length: 10 }, (_, index) =>
              window.api.downloadVideo({
                url: `${baseUrl}/slow.mp4?repair-manual-fanout=1&n=${index}`,
                outputPath: output,
                convertEnabled: false,
              }),
            ),
          ).then(
            (results) => done(JSON.stringify(results)),
            (error) => done(JSON.stringify({ error: String(error) })),
          );
        },
        media,
        downloads,
      );
      await pause(1000);
      const fanoutBefore = processMatches(fanoutMarker);
      await api("cancelDownload");
      await pause(6500);
      const fanoutAfter = processMatches(fanoutMarker);
      record("concurrent-manual-start-cancellation", {
        starts: JSON.parse(concurrent),
        processesBefore: fanoutBefore,
        processesAfter: fanoutAfter,
        invariantPassed: fanoutAfter.length === 0,
      });
      killMarkedProcesses(fanoutMarker);
    } catch (error) {
      record("manual-queue-start-ownership", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F03: after a real cancel/start sequence, stale legacy and structured
    // completion plus idle progress must not clear the current renderer state.
    try {
      await browser.execute((baseUrl) => {
        window.repairStartedSessions = [];
        const original = window.api.downloadVideo;
        window.api.downloadVideo = async (...args) => {
          const result = await original(...args);
          if (result?.ok === true && result.data?.sessionId) {
            window.repairStartedSessions.push(result.data.sessionId);
          }
          return result;
        };
        const input = document.getElementById("url");
        input.value = `${baseUrl}/slow.mp4?repair-stale-first=1`;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("downloadBtn").click();
      }, media);
      await browser.waitUntil(
        () => browser.execute(() => window.repairStartedSessions.length >= 1),
        { timeout: 15_000 },
      );
      const firstSessionId = await browser.execute(
        () => window.repairStartedSessions[0],
      );
      const firstUrl = `${media}/slow.mp4?repair-stale-first=1`;
      await api("cancelDownload");
      const firstCompletion = await activity(firstUrl);

      const secondUrl = `${media}/slow.mp4?repair-stale-second=1`;
      await browser.execute((url) => {
        const input = document.getElementById("url");
        input.value = url;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("downloadBtn").click();
      }, secondUrl);
      await browser.waitUntil(
        () => browser.execute(() => window.repairStartedSessions.length >= 2),
        { timeout: 15_000 },
      );
      const secondSessionId = await browser.execute(
        () => window.repairStartedSessions[1],
      );
      await browser.waitUntil(
        () =>
          browser.execute(
            () =>
              document
                .getElementById("downloadBtn")
                ?.classList.contains("loading") &&
              document
                .getElementById("progress-container")
                ?.classList.contains("visible"),
          ),
        { timeout: 10_000 },
      );
      await browser.execute(
        (currentSessionId) =>
          window.__TAURI__.core.invoke("e2e_emit_stale_download_events", {
            currentSessionId,
          }),
        secondSessionId,
      );
      await pause(3000);
      const ui = await browser.execute(() => ({
        loading: document
          .getElementById("downloadBtn")
          ?.classList.contains("loading"),
        progressVisible: document
          .getElementById("progress-container")
          ?.classList.contains("visible"),
      }));
      await api("cancelDownload");
      const secondCompletion = await activity(secondUrl, firstCompletion.id);
      record("stale-session-events-do-not-clear-active-operation", {
        firstSessionId,
        secondSessionId,
        firstOutcome: firstCompletion.outcome,
        secondOutcome: secondCompletion.outcome,
        ui,
        invariantPassed:
          secondSessionId > firstSessionId &&
          firstCompletion.outcome === "cancelled" &&
          secondCompletion.outcome === "cancelled" &&
          ui.loading === true &&
          ui.progressVisible === true,
      });
    } catch (error) {
      record("stale-session-events-do-not-clear-active-operation", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F04: both tracked slots must invalidate pending starts and reap every
    // process from replaced metadata requests.
    try {
      await metadataCancellation("getVideoInfo", "repair-preview=1");
    } catch (error) {
      record("metadata-getVideoInfo-cancellation", {
        error: String(error),
        invariantPassed: false,
      });
    }
    try {
      await metadataCancellation("getFormats", "repair-formats=1");
    } catch (error) {
      record("metadata-getFormats-cancellation", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F04: reserve the formats slot before delayed DNS, then settle cancellation
    // without a late connection or helper. A replacement request must work.
    try {
      const tracePath = process.env.ROSI_E2E_PROXY_TRACE;
      assert.ok(tracePath, "ROSI_E2E_PROXY_TRACE is required");
      const host = "rosi-dns-delay-formats-repair.invalid";
      const url = `https://${host}/watch?repair-formats-dns=1`;
      const readTrace = () =>
        fs.existsSync(tracePath)
          ? fs
              .readFileSync(tracePath, "utf8")
              .split(/\r?\n/)
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
      await browser.execute((target) => {
        window.repairDelayedFormats = { settled: false, response: null };
        window.api.getFormats(target).then(
          (response) => {
            window.repairDelayedFormats = { settled: true, response };
          },
          (error) => {
            window.repairDelayedFormats = {
              settled: true,
              response: { ok: false, error: { message: String(error) } },
            };
          },
        );
      }, url);
      await browser.waitUntil(
        () =>
          readTrace().some(
            (event) => event.stage === "dns-resolving" && event.host === host,
          ),
        { timeout: 15_000, interval: 50 },
      );
      const processesBefore = processMatches("repair-formats-dns=1", host);
      const cancelStartedAt = performance.now();
      await api("cancelFormats");
      await browser.waitUntil(
        () => browser.execute(() => window.repairDelayedFormats?.settled),
        { timeout: 5_000, interval: 50 },
      );
      const cancelLatencyMs = Math.round(performance.now() - cancelStartedAt);
      const cancelled = await browser.execute(
        () => window.repairDelayedFormats,
      );
      const processesAfter = processMatches("repair-formats-dns=1", host);
      await pause(2_500);
      const eventsAfterDrain = readTrace().filter(
        (event) => event.host === host,
      );
      const replacement = await api(
        "getFormats",
        `${media}/a.mp4?repair-format-replacement=1`,
      );
      const invariantPassed =
        cancelled?.settled === true &&
        cancelled?.response?.ok === false &&
        String(cancelled?.response?.error?.message ?? "")
          .toLowerCase()
          .includes("cancel") &&
        cancelLatencyMs < 1_000 &&
        processesAfter.length === 0 &&
        eventsAfterDrain.some((event) => event.stage === "dns-resolving") &&
        !eventsAfterDrain.some(
          (event) =>
            event.stage === "preflight" || event.stage === "connection",
        ) &&
        replacement.ok === true;
      record("formats-delayed-dns-cancellation", {
        cancelled,
        cancelLatencyMs,
        processesBefore,
        processesAfter,
        eventsAfterDrain,
        replacementOk: replacement.ok,
        invariantPassed,
      });
      assert.ok(
        invariantPassed,
        "formats IPC cancellation escaped its reservation",
      );
    } catch (error) {
      record("formats-delayed-dns-cancellation", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F05: the wrapper's parent exits on SIGTERM while its child ignores it
    // and retains output pipes. Escalation must still kill the remaining tree.
    try {
      const url = `${media}/trigger-cancel-tree.mp4?repair-tree=1`;
      const collisionTarget = path.join(downloads, "trigger-cancel-tree.m4a");
      const sentinel = Buffer.from("preserve cancelled conversion target\n");
      fs.writeFileSync(collisionTarget, sentinel);
      const response = await api("downloadVideo", {
        url,
        outputPath: downloads,
        ffmpegPath: process.env.ROSI_REPAIRS_FFMPEG,
        convertEnabled: true,
        convertFormat: "m4a",
        keepOriginal: true,
      });
      assert.equal(response.ok, true, JSON.stringify(response));
      await browser.waitUntil(() => fs.existsSync(terminationReady), {
        timeout: 30_000,
      });
      const child = JSON.parse(fs.readFileSync(terminationReady, "utf8"));
      const cancelStarted = performance.now();
      await api("cancelDownload");
      const cancelElapsedMs = Math.round(performance.now() - cancelStarted);
      const completion = await activity(url);
      const listing = spawnSync(
        "ps",
        ["-p", String(child.pid), "-o", "pid=,stat=,command="],
        { encoding: "utf8" },
      );
      const alive =
        listing.status === 0 &&
        listing.stdout.includes(process.env.ROSI_REPAIRS_FFMPEG) &&
        !/^\s*\d+\s+Z/.test(listing.stdout);
      record("process-tree-escalation-after-parent-exit", {
        child,
        cancelElapsedMs,
        descendantAlive: alive,
        descendantListing: listing.stdout.trim(),
        outcome: completion.outcome,
        collisionTargetPreserved:
          fs.existsSync(collisionTarget) &&
          fs.readFileSync(collisionTarget).equals(sentinel),
        invariantPassed:
          !alive &&
          cancelElapsedMs <= 2_000 &&
          completion.outcome === "cancelled" &&
          fs.existsSync(collisionTarget) &&
          fs.readFileSync(collisionTarget).equals(sentinel),
      });
      if (alive) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {}
      }
    } catch (error) {
      record("process-tree-escalation-after-parent-exit", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F15: the isolated Firefox cookie database authenticates this local page.
    // Preview, format discovery, and download must all reach it with cookies.
    try {
      const url = `${authenticatedMedia}/auth.html?repair-auth=1`;
      const preview = await api("getVideoInfo", url);
      const formats = await api("getFormats", url);
      const completed = await download(url, {
        hookBrowser: true,
        browserChoice: "firefox",
      });
      const requests = fs.existsSync(
        process.env.ROSI_REPAIRS_AUTH_REQUESTS_FILE,
      )
        ? JSON.parse(
            fs.readFileSync(
              process.env.ROSI_REPAIRS_AUTH_REQUESTS_FILE,
              "utf8",
            ),
          )
        : [];
      record("shared-browser-cookie-arguments", {
        previewOk: preview.ok,
        formatsOk: formats.ok,
        downloadOutcome: completed.outcome,
        authenticatedRequestCount: requests.filter((item) => item.authorized)
          .length,
        invariantPassed:
          preview.ok &&
          formats.ok &&
          completed.outcome === "success" &&
          requests.length >= 3 &&
          requests.every((item) => item.authorized),
      });
    } catch (error) {
      record("shared-browser-cookie-arguments", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F08: HlsFD can hand unsupported manifests to FFmpegFD. The fixture's
    // SAMPLE-AES key uses a local file URL and its segment targets a tracked
    // loopback server. The FFmpeg downloader must reject the network manifest
    // before either nested input is opened.
    try {
      const localSegmentPath = process.env.ROSI_REPAIRS_FALLBACK_LOCAL_SEGMENT;
      const requestPath = process.env.ROSI_REPAIRS_FALLBACK_REQUESTS_FILE;
      const localSegmentSha256 = hash(fs.readFileSync(localSegmentPath));
      const url = `${media}/fallback-escape.m3u8?repair-fallback-protocol=1`;
      const completion = await download(url, { convertEnabled: false });
      await pause(250);
      const consoleLines = await browser.execute(() =>
        [...document.querySelectorAll("#output .console-line")].map(
          (node) => node.textContent ?? "",
        ),
      );
      const diagnostics = consoleLines.join("\n");
      const requests = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      const helperCalls = readToolInvocations().filter(
        (entry) =>
          entry.toolKind === "ffmpeg" &&
          entry.inputArguments?.some((input) =>
            input.includes("fallback-escape"),
          ),
      );
      const helperRejected = helperCalls.some((entry) =>
        /protocol ['"]?http['"]? not on whitelist/i.test(
          entry.stderrTail ?? "",
        ),
      );
      const helperWasRestricted = helperCalls.some((entry) =>
        entry.protocolWhitelists?.includes("file,pipe"),
      );
      const localSegmentPreserved =
        hash(fs.readFileSync(localSegmentPath)) === localSegmentSha256;
      const outputPaths = completion.outputPaths ?? [];
      record("hls-ffmpeg-fallback-protocol-guard", {
        outcome: completion.outcome,
        fallbackDelegated: /delegated to ffmpeg/i.test(diagnostics),
        rejectedByProtocolWhitelist: helperRejected,
        guardedHelperCalls: helperCalls,
        helperWasRestricted,
        nestedSegmentRequests: requests,
        localSegmentPreserved,
        outputPath: completion.outputPath,
        outputPaths,
        invariantPassed:
          completion.outcome === "failed" &&
          /delegated to ffmpeg/i.test(diagnostics) &&
          helperCalls.length > 0 &&
          helperWasRestricted &&
          helperRejected &&
          requests.length === 0 &&
          localSegmentPreserved &&
          !completion.outputPath &&
          outputPaths.length === 0,
      });
    } catch (error) {
      record("hls-ffmpeg-fallback-protocol-guard", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // Direct yt-dlp ffprobe calls bypass its postprocessor-argument hooks.
    // This audio-typed response downloads as an ffconcat file that references
    // a safe sibling HLS playlist with a private HTTP segment.
    try {
      const requestPath = process.env.ROSI_REPAIRS_FALLBACK_REQUESTS_FILE;
      const maliciousUrl = `${media}/ffprobe-escape.m4a?repair-ffprobe-escape=1`;
      const blockedAttempt = await downloadWithStagedSibling(
        maliciousUrl,
        path.join(downloads, "nested-probe.m3u8"),
        {
          audioOnly: true,
          audioOutputFormat: "mp3",
        },
      );
      const blocked = blockedAttempt.completion;
      await pause(250);
      const requests = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      const maliciousProbeCalls = readToolInvocations().filter(
        (entry) =>
          entry.toolKind === "ffprobe" &&
          entry.input?.includes("ffprobe-escape"),
      );
      const normalUrl = `${media}/audio-ok.m4a?repair-ffprobe-normal=1`;
      const normal = await download(normalUrl, {
        audioOnly: true,
        audioOutputFormat: "mp3",
      });
      const normalProbeCalls = readToolInvocations().filter(
        (entry) =>
          entry.toolKind === "ffprobe" && entry.input?.includes("audio-ok"),
      );
      const maliciousProbeRejected = maliciousProbeCalls.some((entry) =>
        /protocol ['"]?http['"]? not on whitelist/i.test(
          entry.stderrTail ?? "",
        ),
      );
      const maliciousProbeRestricted = maliciousProbeCalls.some((entry) =>
        entry.protocolWhitelists?.includes("file,pipe"),
      );
      const maliciousProbeUsesStagedFixture = maliciousProbeCalls.some(
        (entry) =>
          inputDirectory(entry.input) === blockedAttempt.stageDirectory,
      );
      const normalProbeSucceeded = normalProbeCalls.some(
        (entry) =>
          entry.exitCode === 0 &&
          entry.protocolWhitelists?.includes("file,pipe"),
      );
      record("ffprobe-local-playlist-network-guard", {
        maliciousOutcome: blocked.outcome,
        maliciousError: blocked.error,
        nestedSegmentRequests: requests,
        maliciousProbeCalls,
        stagedFixturePath: blockedAttempt.stagedFixturePath,
        stagedFixtureSha256: blockedAttempt.stagedFixtureSha256,
        maliciousProbeUsesStagedFixture,
        maliciousProbeRejected,
        maliciousProbeRestricted,
        normalAudioOutcome: normal.outcome,
        normalAudioPath: normal.outputPath,
        normalProbeCalls,
        invariantPassed:
          blocked.outcome === "failed" &&
          maliciousProbeCalls.length > 0 &&
          maliciousProbeUsesStagedFixture &&
          maliciousProbeRestricted &&
          maliciousProbeRejected &&
          requests.length === 0 &&
          normalProbeSucceeded &&
          normal.outcome === "success" &&
          normal.outputPath.endsWith(".mp3") &&
          fs.existsSync(normal.outputPath),
      });
    } catch (error) {
      record("ffprobe-local-playlist-network-guard", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F15: simulate no available FFmpeg while keeping only the PATH-discovered
    // ffprobe. The private directory override must wrap that probe, preserve a
    // direct download, and block its nested private HTTP reference.
    try {
      const requestPath = process.env.ROSI_REPAIRS_FALLBACK_REQUESTS_FILE;
      fs.writeFileSync(requestPath, "[]\n");
      const directUrl = `${media}/a.mp4?repair-ffprobe-only=1`;
      const direct = await download(directUrl);
      const maliciousUrl = `${media}/ffprobe-escape.m4a?repair-ffprobe-only=1`;
      const blockedAttempt = await downloadWithStagedSibling(
        maliciousUrl,
        path.join(downloads, "nested-probe.m3u8"),
        {
          audioOnly: true,
          audioOutputFormat: "mp3",
        },
      );
      const blocked = blockedAttempt.completion;
      await pause(250);
      const requests = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      const probeCalls = readToolInvocations().filter(
        (entry) =>
          entry.toolKind === "ffprobe" &&
          entry.input?.includes("ffprobe-escape"),
      );
      const probeRejected = probeCalls.some((entry) =>
        /protocol ['"]?http['"]? not on whitelist/i.test(
          entry.stderrTail ?? "",
        ),
      );
      const probeRestricted = probeCalls.some((entry) =>
        entry.protocolWhitelists?.includes("file,pipe"),
      );
      const probeUsesStagedFixture = probeCalls.some(
        (entry) =>
          inputDirectory(entry.input) === blockedAttempt.stageDirectory,
      );
      const probeFailedSafely = probeCalls.some(
        (entry) =>
          entry.exitCode !== 0 &&
          entry.protocolWhitelists?.includes("file,pipe"),
      );
      record("ffprobe-only-path-without-ffmpeg", {
        directOutcome: direct.outcome,
        blockedOutcome: blocked.outcome,
        blockedError: blocked.error,
        nestedSegmentRequests: requests,
        probeCalls,
        stagedFixturePath: blockedAttempt.stagedFixturePath,
        stagedFixtureSha256: blockedAttempt.stagedFixtureSha256,
        probeUsesStagedFixture,
        probeRejected,
        probeRestricted,
        invariantPassed:
          direct.outcome === "success" &&
          blocked.outcome === "failed" &&
          probeCalls.length > 0 &&
          probeUsesStagedFixture &&
          probeRestricted &&
          probeRejected &&
          probeFailedSafely &&
          requests.length === 0,
      });
    } catch (error) {
      record("ffprobe-only-path-without-ffmpeg", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // F16: emit a multi-megabyte UTF-8 line without an early newline through
    // the configured helper and verify the renderer receives a bounded line.
    try {
      await download(`${media}/large-output.mp4?repair-large-output=1`, {
        convertEnabled: true,
        convertFormat: "m4a",
        keepOriginal: true,
      });
      const rendered = await browser.execute(() => {
        const lines = [
          ...document.querySelectorAll("#output .console-line"),
        ].map((node) => node.textContent ?? "");
        return {
          longestLine: Math.max(0, ...lines.map((line) => line.length)),
          truncationMarker: lines.some((line) => line.includes("[truncated]")),
          tailMarker: lines.some((line) =>
            line.includes("AUDIT_LARGE_LINE_TAIL"),
          ),
        };
      });
      record("bounded-long-helper-line", {
        ...rendered,
        invariantPassed:
          rendered.longestLine <= 100_000 &&
          rendered.truncationMarker &&
          rendered.tailMarker,
      });
    } catch (error) {
      record("bounded-long-helper-line", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // Audit 3 F02: a failed yt-dlp playlist must publish the first complete
    // source and never expose the missing or partial second entry.
    try {
      const url = `${media}/partial-download-list.html?audit3-ytdlp-failure=1`;
      const completion = await download(url, {
        playlist: { mode: "all" },
        convertEnabled: false,
      });
      const outputPaths = completion.outputPaths ?? [];
      const stageDirectories = downloadStageDirectories();
      const visiblePartials = fs
        .readdirSync(downloads)
        .filter((name) => name.endsWith(".part"));
      const outputBytes = outputPaths
        .filter((outputPath) => fs.existsSync(outputPath))
        .reduce((total, outputPath) => total + fs.statSync(outputPath).size, 0);
      record("audit3-playlist-ytdlp-failure-preserves-complete-entry", {
        outcome: completion.outcome,
        outputPaths,
        failedPaths: completion.failedPaths ?? [],
        sizeBytes: completion.sizeBytes,
        outputBytes,
        stageDirectories,
        visiblePartials,
        invariantPassed:
          completion.outcome === "failed" &&
          outputPaths.length === 1 &&
          outputPaths.every(
            (outputPath) =>
              fs.existsSync(outputPath) &&
              !outputPath.includes(`${path.sep}.rosi-download-`),
          ) &&
          completion.sizeBytes === outputBytes &&
          stageDirectories.length === 0 &&
          visiblePartials.length === 0,
      });
    } catch (error) {
      record("audit3-playlist-ytdlp-failure-preserves-complete-entry", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // Audit 3 F02: cancel after one playlist member is complete and the next
    // has a live .part file. The completion must report the published member.
    try {
      const url = `${media}/cancel-download-list.html?audit3-ytdlp-cancel=1`;
      const oldId = (await api("getDownloadActivity")).data[0]?.id;
      const started = await api("downloadVideo", {
        url,
        outputPath: downloads,
        playlist: { mode: "all" },
        convertEnabled: false,
        hookBrowser: false,
      });
      assert.equal(started.ok, true, JSON.stringify(started));
      let stagedBeforeCancel = [];
      await browser.waitUntil(
        () => {
          stagedBeforeCancel = downloadStageDirectories().flatMap((directory) =>
            filesUnder(directory),
          );
          return (
            stagedBeforeCancel.some((file) =>
              /\.(?:mp4|mkv|webm)$/i.test(file),
            ) && stagedBeforeCancel.some((file) => file.endsWith(".part"))
          );
        },
        {
          timeout: 45_000,
          interval: 50,
          timeoutMsg:
            "playlist did not reach one complete and one partial entry",
        },
      );
      await api("cancelDownload");
      const completion = await activity(url, oldId);
      await browser.waitUntil(() => downloadStageDirectories().length === 0, {
        timeout: 15_000,
        interval: 50,
      });
      const outputPaths = completion.outputPaths ?? [];
      const visiblePartials = filesUnder(downloads).filter((file) =>
        file.endsWith(".part"),
      );
      const outputBytes = outputPaths
        .filter((outputPath) => fs.existsSync(outputPath))
        .reduce((total, outputPath) => total + fs.statSync(outputPath).size, 0);
      record("audit3-playlist-ytdlp-cancel-preserves-complete-entry", {
        outcome: completion.outcome,
        stagedBeforeCancel,
        outputPaths,
        failedPaths: completion.failedPaths ?? [],
        sizeBytes: completion.sizeBytes,
        outputBytes,
        visiblePartials,
        invariantPassed:
          completion.outcome === "cancelled" &&
          outputPaths.length === 1 &&
          outputPaths.every(
            (outputPath) =>
              fs.existsSync(outputPath) &&
              !outputPath.includes(`${path.sep}.rosi-download-`),
          ) &&
          completion.sizeBytes === outputBytes &&
          visiblePartials.length === 0,
      });
    } catch (error) {
      record("audit3-playlist-ytdlp-cancel-preserves-complete-entry", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // Audit 3 F04: same-extension playlist entries must enter session metadata
    // only after their stage source is installed at its final public path.
    try {
      fs.rmSync(process.env.ROSI_REPAIRS_CODEC_PROBE_READY, { force: true });
      const url = `${media}/cancel-same-extension-list.html?audit3-final-session-path=1`;
      const oldId = (await api("getDownloadActivity")).data[0]?.id;
      const started = await api("downloadVideo", {
        url,
        outputPath: downloads,
        playlist: { mode: "all" },
        convertEnabled: true,
        convertFormat: "mp4",
        keepOriginal: false,
        gpuAcceleration: false,
      });
      assert.equal(started.ok, true, JSON.stringify(started));
      await browser.waitUntil(
        () => fs.existsSync(process.env.ROSI_REPAIRS_CODEC_PROBE_READY),
        { timeout: 30_000, interval: 50 },
      );
      const firstOutput = fs
        .readdirSync(downloads)
        .filter(
          (name) =>
            /cancel-same-extension-list-1.*\.mp4$/i.test(name) &&
            !name.startsWith(".rosi-"),
        )
        .map((name) => path.join(downloads, name));
      await api("cancelDownload");
      const completion = await activity(url, oldId);
      await browser.waitUntil(() => downloadStageDirectories().length === 0, {
        timeout: 15_000,
        interval: 50,
      });
      const outputPaths = completion.outputPaths ?? [];
      const outputBytes = outputPaths
        .filter((outputPath) => fs.existsSync(outputPath))
        .reduce((total, outputPath) => total + fs.statSync(outputPath).size, 0);
      record("audit3-same-extension-cancel-records-final-path", {
        outcome: completion.outcome,
        firstOutput,
        outputPaths,
        sizeBytes: completion.sizeBytes,
        outputBytes,
        invariantPassed:
          completion.outcome === "cancelled" &&
          firstOutput.length === 1 &&
          outputPaths.length === 1 &&
          outputPaths[0] === firstOutput[0] &&
          fs.existsSync(outputPaths[0]) &&
          !outputPaths[0].includes(`${path.sep}.rosi-download-`) &&
          completion.sizeBytes === outputBytes,
      });
    } catch (error) {
      record("audit3-same-extension-cancel-records-final-path", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // Audit 3 F03: MP4 conversion maps embedded text subtitles to mov_text.
    try {
      const url = `${media}/subtitled-source.mkv?audit3-embedded-caption=1`;
      const completion = await download(url, {
        convertEnabled: true,
        convertFormat: "mp4",
        keepOriginal: false,
        writeSubtitles: false,
      });
      const outputPath = completion.outputPath;
      const streams = outputPath ? probeMediaStreams(outputPath) : [];
      const subtitleCodecs = streams
        .filter((stream) => stream.codec_type === "subtitle")
        .map((stream) => stream.codec_name);
      const originalPaths = fs
        .readdirSync(downloads)
        .filter((name) => /^subtitled-source.*\.mkv$/i.test(name));
      record("audit3-embedded-subtitle-survives-mp4-conversion", {
        outcome: completion.outcome,
        outputPath,
        subtitleCodecs,
        originalPaths,
        invariantPassed:
          completion.outcome === "success" &&
          Boolean(outputPath && fs.existsSync(outputPath)) &&
          subtitleCodecs.length === 1 &&
          subtitleCodecs[0] === "mov_text" &&
          originalPaths.length === 0,
      });
    } catch (error) {
      record("audit3-embedded-subtitle-survives-mp4-conversion", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // Audit 3 F03: requested external captions remain available next to the
    // converted output when yt-dlp supplies a sidecar rather than a stream.
    try {
      const url = `${media}/sidecar-source.mkv?audit3-external-caption=mp4`;
      const attempt = await downloadWithStagedSibling(
        url,
        process.env.ROSI_AUDIT3_SIDECAR_FIXTURE,
        {
          convertEnabled: true,
          convertFormat: "mp4",
          keepOriginal: false,
          writeSubtitles: true,
        },
      );
      const sidecarPath = path.join(
        downloads,
        path.basename(attempt.stagedFixturePath),
      );
      const matches = fs
        .readdirSync(downloads)
        .filter((name) => /^sidecar-source.*\.srt$/i.test(name));
      const completion = attempt.completion;
      const outputPath = completion.outputPath;
      record("audit3-external-caption-sidecar-survives-mp4-conversion", {
        outcome: completion.outcome,
        outputPath,
        sidecarPath,
        sidecarSha256: fs.existsSync(sidecarPath)
          ? hash(fs.readFileSync(sidecarPath))
          : null,
        expectedSidecarSha256: attempt.stagedFixtureSha256,
        matches,
        invariantPassed:
          completion.outcome === "success" &&
          Boolean(outputPath && fs.existsSync(outputPath)) &&
          fs.existsSync(sidecarPath) &&
          hash(fs.readFileSync(sidecarPath)) === attempt.stagedFixtureSha256 &&
          matches.length === 1,
      });
    } catch (error) {
      record("audit3-external-caption-sidecar-survives-mp4-conversion", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // Audit 3 F03: audio-only containers cannot carry the requested external
    // caption as a stream, so the sidecar must still be installed.
    try {
      const url = `${media}/audio-sidecar-source.mkv?audit3-external-caption=m4a`;
      const attempt = await downloadWithStagedSibling(
        url,
        process.env.ROSI_AUDIT3_AUDIO_SIDECAR_FIXTURE,
        {
          convertEnabled: true,
          convertFormat: "m4a",
          keepOriginal: false,
          writeSubtitles: true,
        },
      );
      const sidecarPath = path.join(
        downloads,
        path.basename(attempt.stagedFixturePath),
      );
      const outputPath = attempt.completion.outputPath;
      record("audit3-audio-container-keeps-external-caption", {
        outcome: attempt.completion.outcome,
        outputPath,
        sidecarPath,
        sidecarSha256: fs.existsSync(sidecarPath)
          ? hash(fs.readFileSync(sidecarPath))
          : null,
        expectedSidecarSha256: attempt.stagedFixtureSha256,
        invariantPassed:
          attempt.completion.outcome === "success" &&
          Boolean(outputPath && outputPath.endsWith(".m4a")) &&
          fs.existsSync(outputPath) &&
          fs.existsSync(sidecarPath) &&
          hash(fs.readFileSync(sidecarPath)) === attempt.stagedFixtureSha256,
      });
    } catch (error) {
      record("audit3-audio-container-keeps-external-caption", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // Audit 3 F03: when an audio-only output cannot contain embedded subtitle
    // streams, retain the source so the embedded caption is not discarded.
    try {
      const url = `${media}/subtitled-source.mkv?audit3-audio-container-embedded=1`;
      const completion = await download(url, {
        convertEnabled: true,
        convertFormat: "m4a",
        keepOriginal: false,
        writeSubtitles: false,
      });
      const outputPath = completion.outputPath;
      const originalPaths = fs
        .readdirSync(downloads)
        .filter((name) => /^subtitled-source.*\.mkv$/i.test(name));
      record("audit3-audio-container-retains-embedded-caption-source", {
        outcome: completion.outcome,
        outputPath,
        originalPaths,
        invariantPassed:
          completion.outcome === "success" &&
          Boolean(outputPath && fs.existsSync(outputPath)) &&
          originalPaths.length === 1,
      });
    } catch (error) {
      record("audit3-audio-container-retains-embedded-caption-source", {
        error: String(error),
        invariantPassed: false,
      });
    }

    // Audit 3 F01: the same publication path is exercised on Unix here; the
    // report keeps platform identity so Windows durability remains distinct.
    try {
      const direct = await download(
        `${media}/a.mp4?audit3-publication-download=1`,
        { convertEnabled: false },
      );
      const converted = await download(
        `${media}/a.mp4?audit3-publication-conversion=1`,
        {
          convertEnabled: true,
          convertFormat: "m4a",
          keepOriginal: true,
        },
      );
      record("audit3-download-and-conversion-publication", {
        platform: process.platform,
        directOutcome: direct.outcome,
        directOutputPaths: direct.outputPaths ?? [],
        convertedOutcome: converted.outcome,
        convertedOutputPaths: converted.outputPaths ?? [],
        invariantPassed:
          direct.outcome === "success" &&
          converted.outcome === "success" &&
          (direct.outputPaths ?? []).every((outputPath) =>
            fs.existsSync(outputPath),
          ) &&
          (converted.outputPaths ?? []).every((outputPath) =>
            fs.existsSync(outputPath),
          ),
      });
    } catch (error) {
      record("audit3-download-and-conversion-publication", {
        platform: process.platform,
        error: String(error),
        invariantPassed: false,
      });
    }

    // Audit 3 F13: block a positive probe for FFmpeg A, change settings to B,
    // then release A. A's late result must not seed B's capability cache.
    try {
      const settingsBefore = await api("getSettings");
      const savedA = await api("saveSettings", {
        ffmpegPath: process.env.ROSI_AUDIT3_GPU_PROBE_A,
      });
      assert.equal(savedA.ok, true, JSON.stringify(savedA));
      await browser.execute(() => {
        window.audit3GpuProbeA = { settled: false, result: null };
        window.api.detectGpu().then(
          (result) => {
            window.audit3GpuProbeA = { settled: true, result };
          },
          (error) => {
            window.audit3GpuProbeA = { settled: true, error: String(error) };
          },
        );
      });
      await browser.waitUntil(
        () => fs.existsSync(process.env.ROSI_AUDIT3_GPU_PROBE_A_READY),
        { timeout: 15_000, interval: 25 },
      );
      const savedB = await api("saveSettings", {
        ffmpegPath: process.env.ROSI_AUDIT3_GPU_PROBE_B,
      });
      assert.equal(savedB.ok, true, JSON.stringify(savedB));
      fs.writeFileSync(process.env.ROSI_AUDIT3_GPU_PROBE_A_RELEASE, "go\n");
      await browser.waitUntil(
        () => browser.execute(() => window.audit3GpuProbeA?.settled === true),
        { timeout: 15_000, interval: 25 },
      );
      const probeA = await browser.execute(() => window.audit3GpuProbeA);
      const probeB = await api("detectGpu");
      const probeBTrace = fs.existsSync(
        process.env.ROSI_AUDIT3_GPU_PROBE_B_TRACE,
      )
        ? fs
            .readFileSync(process.env.ROSI_AUDIT3_GPU_PROBE_B_TRACE, "utf8")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
      record("audit3-gpu-cache-bound-to-ffmpeg-generation", {
        settingsBeforeFfmpegPath: settingsBefore.ffmpegPath,
        probeA: probeA.result ?? null,
        probeAError: probeA.error ?? null,
        probeB,
        probeBTrace,
        invariantPassed:
          probeA.settled === true &&
          probeA.result?.nvidia === true &&
          probeB.nvidia === false &&
          probeBTrace.some((entry) => entry.encoder === "h264_nvenc"),
      });
      const restored = await api("saveSettings", {
        ffmpegPath: process.env.ROSI_REPAIRS_FFMPEG,
      });
      assert.equal(restored.ok, true, JSON.stringify(restored));
    } catch (error) {
      fs.writeFileSync(process.env.ROSI_AUDIT3_GPU_PROBE_A_RELEASE, "go\n");
      await api("saveSettings", {
        ffmpegPath: process.env.ROSI_REPAIRS_FFMPEG,
      }).catch(() => {});
      record("audit3-gpu-cache-bound-to-ffmpeg-generation", {
        error: String(error),
        invariantPassed: false,
      });
    }

    assert.deepEqual(
      failures,
      [],
      `Repair invariants failed: ${failures.join(", ")}`,
    );
  });
});
