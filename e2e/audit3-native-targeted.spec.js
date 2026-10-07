import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "./helpers/app-bridge.js";

const directory = process.env.ROSI_REPAIRS_DIRECTORY;
const downloads = process.env.ROSI_E2E_DOWNLOADS;
const media = process.env.ROSI_REPAIRS_MEDIA;
const observations = [];
const failures = [];
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function record(name, details) {
  observations.push({ name, ...details });
  fs.writeFileSync(
    path.join(directory, "audit3-observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
  if (details.invariantPassed === false) failures.push(name);
}

async function activity(url, oldId) {
  let completion;
  await browser.waitUntil(
    async () => {
      const response = await api("getDownloadActivity");
      completion = response.data.find(
        (item) => item.url === url && item.id !== oldId,
      );
      return Boolean(completion);
    },
    { timeout: 45_000, interval: 100, timeoutMsg: `No completion for ${url}` },
  );
  return completion;
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

function stageDirectories() {
  return fs
    .readdirSync(downloads, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(".rosi-download-"),
    )
    .map((entry) => path.join(downloads, entry.name));
}

function filesUnder(directoryPath) {
  if (!fs.existsSync(directoryPath)) return [];
  return fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directoryPath, entry.name);
      return entry.isDirectory() ? filesUnder(entryPath) : [entryPath];
    });
}

function probeStreams(filePath) {
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

async function sidecarDownload(url, fixturePath, format, afterStaging) {
  const sidecarsBefore = fs
    .readdirSync(downloads)
    .filter((entry) => entry.endsWith(".en.srt")).length;
  const response = await api("downloadVideo", {
    url,
    outputPath: downloads,
    convertEnabled: true,
    convertFormat: format,
    keepOriginal: false,
    writeSubtitles: true,
    hookBrowser: false,
    gpuAcceleration: false,
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  let stage;
  let sidecar;
  await browser.waitUntil(
    () => {
      const stages = stageDirectories();
      if (stages.length !== 1) return false;
      stage = stages[0];
      const mediaPath = filesUnder(stage).find((file) => file.endsWith(".mkv"));
      if (!mediaPath) return false;
      sidecar = path.join(
        stage,
        `${path.basename(mediaPath, path.extname(mediaPath))}.en.srt`,
      );
      fs.copyFileSync(fixturePath, sidecar);
      return true;
    },
    { timeout: 15_000, interval: 25, timeoutMsg: `No staged media for ${url}` },
  );
  await afterStaging?.({ sidecar, stage });
  const completion = await activity(url);
  return {
    completion,
    stage,
    sidecar,
    sidecarCountBefore: sidecarsBefore,
    sidecarHash: hash(fs.readFileSync(fixturePath)),
  };
}

describe("ROSI audit 3 native targeted repairs", () => {
  it("preserves completed playlist files, captions, final paths, and GPU generations", async () => {
    await waitForAppReady();

    try {
      const url = `${media}/partial-download-list.html?audit3-ytdlp-failure=1`;
      const completion = await download(url, { playlist: { mode: "all" } });
      const outputPaths = completion.outputPaths ?? [];
      const visiblePartials = fs
        .readdirSync(downloads)
        .filter((name) => name.endsWith(".part"));
      const outputBytes = outputPaths.reduce(
        (total, file) => total + fs.statSync(file).size,
        0,
      );
      record("playlist-ytdlp-failure-preserves-complete-entry", {
        outcome: completion.outcome,
        outputPaths,
        failedPaths: completion.failedPaths ?? [],
        sizeBytes: completion.sizeBytes,
        outputBytes,
        stageDirectories: stageDirectories(),
        visiblePartials,
        invariantPassed:
          completion.outcome === "failed" &&
          outputPaths.length === 1 &&
          outputPaths.every(
            (file) => fs.existsSync(file) && !file.includes(".rosi-download-"),
          ) &&
          completion.sizeBytes === outputBytes &&
          visiblePartials.length === 0 &&
          stageDirectories().length === 0,
      });
    } catch (error) {
      record("playlist-ytdlp-failure-preserves-complete-entry", {
        error: String(error),
        invariantPassed: false,
      });
    }

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
      let staged = [];
      await browser.waitUntil(
        () => {
          staged = stageDirectories().flatMap(filesUnder);
          return (
            staged.some((file) => /\.(?:mp4|mkv|webm)$/i.test(file)) &&
            staged.some((file) => file.endsWith(".part"))
          );
        },
        {
          timeout: 45_000,
          interval: 50,
          timeoutMsg: "Playlist did not reach partial second entry",
        },
      );
      await api("cancelDownload");
      const completion = await activity(url, oldId);
      const outputPaths = completion.outputPaths ?? [];
      const visiblePartials = filesUnder(downloads).filter((file) =>
        file.endsWith(".part"),
      );
      const outputBytes = outputPaths.reduce(
        (total, file) => total + fs.statSync(file).size,
        0,
      );
      record("playlist-ytdlp-cancel-preserves-complete-entry", {
        outcome: completion.outcome,
        staged,
        outputPaths,
        failedPaths: completion.failedPaths ?? [],
        sizeBytes: completion.sizeBytes,
        outputBytes,
        visiblePartials,
        invariantPassed:
          completion.outcome === "cancelled" &&
          outputPaths.length === 1 &&
          outputPaths.every(
            (file) => fs.existsSync(file) && !file.includes(".rosi-download-"),
          ) &&
          completion.sizeBytes === outputBytes &&
          visiblePartials.length === 0 &&
          stageDirectories().length === 0,
      });
    } catch (error) {
      record("playlist-ytdlp-cancel-preserves-complete-entry", {
        error: String(error),
        invariantPassed: false,
      });
    }

    try {
      const ready = process.env.ROSI_REPAIRS_CODEC_PROBE_READY;
      fs.rmSync(ready, { force: true });
      const url = `${media}/cancel-same-extension-list.html?audit3-final-session-path=1`;
      const oldId = (await api("getDownloadActivity")).data[0]?.id;
      const started = await api("downloadVideo", {
        url,
        outputPath: downloads,
        playlist: { mode: "all" },
        convertEnabled: true,
        convertFormat: "mp4",
        keepOriginal: false,
        hookBrowser: false,
        gpuAcceleration: false,
      });
      assert.equal(started.ok, true, JSON.stringify(started));
      await browser.waitUntil(() => fs.existsSync(ready), {
        timeout: 30_000,
        interval: 50,
        timeoutMsg: "Same-extension playlist did not reach codec probe",
      });
      const firstOutput = fs
        .readdirSync(downloads)
        .filter(
          (name) =>
            /cancel-same-extension-list-1.*\.mp4$/i.test(name) &&
            !name.startsWith(".rosi-"),
        )
        .map((name) => path.join(downloads, name));
      const secondOriginal = fs
        .readdirSync(downloads)
        .filter((name) => /\.webm$/i.test(name) && !name.startsWith(".rosi-"))
        .map((name) => path.join(downloads, name));
      await api("cancelDownload");
      const completion = await activity(url, oldId);
      const outputPaths = completion.outputPaths ?? [];
      const outputBytes = outputPaths.reduce(
        (total, file) => total + fs.statSync(file).size,
        0,
      );
      record("same-extension-cancel-records-final-path", {
        outcome: completion.outcome,
        firstOutput,
        secondOriginal,
        outputPaths,
        format: completion.format,
        sizeBytes: completion.sizeBytes,
        outputBytes,
        stageDirectories: stageDirectories(),
        invariantPassed:
          completion.outcome === "cancelled" &&
          firstOutput.length === 1 &&
          secondOriginal.length === 1 &&
          outputPaths.length === 2 &&
          outputPaths.includes(firstOutput[0]) &&
          outputPaths.includes(secondOriginal[0]) &&
          outputPaths.every(
            (output) =>
              fs.existsSync(output) && !output.includes(".rosi-download-"),
          ) &&
          completion.format === "webm" &&
          completion.sizeBytes === outputBytes &&
          stageDirectories().length === 0,
      });
    } catch (error) {
      record("same-extension-cancel-records-final-path", {
        error: String(error),
        invariantPassed: false,
      });
    }

    try {
      const failingFfmpeg = path.join(directory, "conversion-failure-ffmpeg");
      fs.writeFileSync(failingFfmpeg, "#!/bin/sh\nexit 23\n", { mode: 0o700 });
      fs.chmodSync(failingFfmpeg, 0o700);
      const configured = await api("saveSettings", {
        ffmpegPath: failingFfmpeg,
      });
      assert.equal(configured.ok, true, JSON.stringify(configured));
      const url = `${media}/plain-source.mkv?audit3-conversion-failure-output=1`;
      const completion = await download(url, {
        convertEnabled: true,
        convertFormat: "mp4",
        keepOriginal: false,
        writeSubtitles: false,
      });
      const outputPaths = completion.outputPaths ?? [];
      const failedPaths = completion.failedPaths ?? [];
      const preserved = fs
        .readdirSync(downloads)
        .filter((name) => /^plain-source.*\.mkv$/i.test(name))
        .map((name) => path.join(downloads, name));
      const outputBytes = outputPaths.reduce(
        (total, file) => total + fs.statSync(file).size,
        0,
      );
      record("conversion-failure-records-preserved-final-original", {
        outcome: completion.outcome,
        outputPath: completion.outputPath,
        outputPaths,
        failedPaths,
        preserved,
        format: completion.format,
        sizeBytes: completion.sizeBytes,
        outputBytes,
        invariantPassed:
          completion.outcome === "failed" &&
          preserved.length === 1 &&
          outputPaths.length === 1 &&
          outputPaths[0] === preserved[0] &&
          failedPaths.includes(preserved[0]) &&
          completion.outputPath === preserved[0] &&
          completion.format === "mkv" &&
          completion.sizeBytes === outputBytes &&
          fs.existsSync(preserved[0]) &&
          stageDirectories().length === 0,
      });
    } catch (error) {
      record("conversion-failure-records-preserved-final-original", {
        error: String(error),
        invariantPassed: false,
      });
    } finally {
      const restored = await api("saveSettings", {
        ffmpegPath: process.env.ROSI_REPAIRS_FFMPEG,
      });
      assert.equal(restored.ok, true, JSON.stringify(restored));
    }

    try {
      const url = `${media}/probe-unknown-caption.mkv?audit3-codec-probe-unreliable=1`;
      const completion = await download(url, {
        convertEnabled: true,
        convertFormat: "mp4",
        keepOriginal: false,
        writeSubtitles: false,
      });
      const outputPaths = completion.outputPaths ?? [];
      const originals = fs
        .readdirSync(downloads)
        .filter((name) => /^probe-unknown-caption.*\.mkv$/i.test(name));
      record("unreliable-codec-probe-retains-embedded-caption-source", {
        outcome: completion.outcome,
        outputPaths,
        outputPath: completion.outputPath,
        originals,
        invariantPassed:
          completion.outcome === "success" &&
          Boolean(
            completion.outputPath && fs.existsSync(completion.outputPath),
          ) &&
          originals.length === 1 &&
          outputPaths.includes(completion.outputPath) &&
          outputPaths.includes(path.join(downloads, originals[0])),
      });
    } catch (error) {
      record("unreliable-codec-probe-retains-embedded-caption-source", {
        error: String(error),
        invariantPassed: false,
      });
    }

    try {
      const url = `${media}/subtitled-source.mkv?audit3-embedded-caption=1`;
      const completion = await download(url, {
        convertEnabled: true,
        convertFormat: "mp4",
        keepOriginal: false,
        writeSubtitles: false,
      });
      const output = completion.outputPath;
      const subtitleCodecs = output
        ? probeStreams(output)
            .filter((stream) => stream.codec_type === "subtitle")
            .map((stream) => stream.codec_name)
        : [];
      const originals = fs
        .readdirSync(downloads)
        .filter((name) => /^subtitled-source.*\.mkv$/i.test(name));
      record("embedded-subtitle-survives-mp4-conversion", {
        outcome: completion.outcome,
        outputPath: output,
        subtitleCodecs,
        originals,
        invariantPassed:
          completion.outcome === "success" &&
          Boolean(output && fs.existsSync(output)) &&
          subtitleCodecs.length === 1 &&
          subtitleCodecs[0] === "mov_text" &&
          originals.length === 0,
      });
    } catch (error) {
      record("embedded-subtitle-survives-mp4-conversion", {
        error: String(error),
        invariantPassed: false,
      });
    }

    for (const [name, url, format] of [
      [
        "conversion-selects-only-the-inspected-primary-video-track",
        `${media}/mixed-video-tracks.mkv?audit3-mixed-video-tracks=1`,
        "mp4",
      ],
      [
        "conversion-excludes-attached-cover-art-from-video-selection",
        `${media}/cover-art-source.mp4?audit3-cover-art=1`,
        "mkv",
      ],
    ]) {
      try {
        const completion = await download(url, {
          convertEnabled: true,
          convertFormat: format,
          keepOriginal: false,
          writeSubtitles: false,
        });
        const streams = completion.outputPath
          ? probeStreams(completion.outputPath)
          : [];
        const videoCodecs = streams
          .filter((stream) => stream.codec_type === "video")
          .map((stream) => stream.codec_name);
        const audioCodecs = streams
          .filter((stream) => stream.codec_type === "audio")
          .map((stream) => stream.codec_name);
        record(name, {
          outcome: completion.outcome,
          outputPath: completion.outputPath,
          videoCodecs,
          audioCodecs,
          invariantPassed:
            completion.outcome === "success" &&
            Boolean(
              completion.outputPath && fs.existsSync(completion.outputPath),
            ) &&
            videoCodecs.length === 1 &&
            videoCodecs[0] === "mpeg4" &&
            audioCodecs.length === 1 &&
            audioCodecs[0] === "aac",
        });
      } catch (error) {
        record(name, { error: String(error), invariantPassed: false });
      }
    }

    for (const [name, url, fixture, format] of [
      [
        "external-caption-survives-mp4-conversion",
        `${media}/sidecar-source.mkv?audit3-external-caption=mp4`,
        process.env.ROSI_AUDIT3_SIDECAR_FIXTURE,
        "mp4",
      ],
      [
        "external-caption-survives-audio-conversion",
        `${media}/audio-sidecar-source.mkv?audit3-external-caption=m4a`,
        process.env.ROSI_AUDIT3_AUDIO_SIDECAR_FIXTURE,
        "m4a",
      ],
    ]) {
      try {
        const attempt = await sidecarDownload(url, fixture, format);
        const completion = attempt.completion;
        const matches = fs
          .readdirSync(downloads)
          .filter((entry) => entry.endsWith(".en.srt"));
        const sidecarExists = fs.existsSync(attempt.sidecar);
        record(name, {
          outcome: completion.outcome,
          outputPath: completion.outputPath,
          sidecarPath: attempt.sidecar,
          sidecarSha256: sidecarExists
            ? hash(fs.readFileSync(attempt.sidecar))
            : null,
          expectedSidecarSha256: attempt.sidecarHash,
          matches,
          invariantPassed:
            completion.outcome === "success" &&
            Boolean(
              completion.outputPath && fs.existsSync(completion.outputPath),
            ) &&
            sidecarExists &&
            hash(fs.readFileSync(attempt.sidecar)) === attempt.sidecarHash &&
            matches.length === attempt.sidecarCountBefore + 1,
        });
      } catch (error) {
        record(name, { error: String(error), invariantPassed: false });
      }
    }

    try {
      const ready = process.env.ROSI_AUDIT3_CAPTION_ENUMERATION_READY;
      const release = process.env.ROSI_AUDIT3_CAPTION_ENUMERATION_RELEASE;
      const url = `${media}/caption-enumeration-failure.mkv?audit3-caption-enumeration=1`;
      const attempt = await sidecarDownload(
        url,
        process.env.ROSI_AUDIT3_SIDECAR_FIXTURE,
        "mp4",
        async ({ sidecar }) => {
          await browser.waitUntil(() => fs.existsSync(ready), {
            timeout: 30_000,
            interval: 25,
            timeoutMsg:
              "Caption enumeration fixture did not reach its permission barrier",
          });
          fs.renameSync(sidecar, `${sidecar}.recovery`);
          fs.writeFileSync(release, "go\n");
        },
      );
      const recoveredCaption = filesUnder(attempt.stage).find(
        (file) => hash(fs.readFileSync(file)) === attempt.sidecarHash,
      );
      const outputPaths = attempt.completion.outputPaths ?? [];
      const originalMedia = fs
        .readdirSync(downloads)
        .filter((name) => /^caption-enumeration-failure.*\.mkv$/i.test(name))
        .map((name) => path.join(downloads, name));
      record("caption-enumeration-error-retains-recovery-and-final-path", {
        outcome: attempt.completion.outcome,
        outputPaths,
        outputPath: attempt.completion.outputPath,
        originalMedia,
        stage: attempt.stage,
        sidecar: attempt.sidecar,
        recoveredCaption,
        recoveredCaptionSha256: recoveredCaption
          ? hash(fs.readFileSync(recoveredCaption))
          : null,
        expectedSidecarSha256: attempt.sidecarHash,
        invariantPassed:
          attempt.completion.outcome === "failed" &&
          Boolean(
            attempt.completion.outputPath &&
            fs.existsSync(attempt.completion.outputPath),
          ) &&
          outputPaths.includes(attempt.completion.outputPath) &&
          originalMedia.length === 1 &&
          outputPaths.includes(originalMedia[0]) &&
          fs.existsSync(originalMedia[0]) &&
          recoveredCaption !== undefined &&
          hash(fs.readFileSync(recoveredCaption)) === attempt.sidecarHash &&
          fs.existsSync(attempt.stage),
      });
    } catch (error) {
      fs.writeFileSync(
        process.env.ROSI_AUDIT3_CAPTION_ENUMERATION_RELEASE,
        "go\n",
      );
      record("caption-enumeration-error-retains-recovery-and-final-path", {
        error: String(error),
        invariantPassed: false,
      });
    }

    try {
      const ready = process.env.ROSI_AUDIT3_CAPTION_RACE_READY;
      const release = process.env.ROSI_AUDIT3_CAPTION_RACE_RELEASE;
      const replacement = Buffer.from(
        "1\n00:00:00,000 --> 00:00:04,000\nreplacement caption\n\n",
      );
      const originalSidecarCount = fs
        .readdirSync(downloads)
        .filter(
          (name) =>
            name.startsWith("caption-identity-race") &&
            name.endsWith(".en.srt"),
        ).length;
      const url = `${media}/caption-identity-race.mkv?audit3-caption-identity-race=1`;
      const attempt = await sidecarDownload(
        url,
        process.env.ROSI_AUDIT3_SIDECAR_FIXTURE,
        "mp4",
        async ({ sidecar }) => {
          await browser.waitUntil(() => fs.existsSync(ready), {
            timeout: 30_000,
            interval: 25,
            timeoutMsg:
              "Caption identity fixture did not reach its publication barrier",
          });
          const replacementPath = `${sidecar}.replacement`;
          fs.writeFileSync(replacementPath, replacement);
          fs.renameSync(replacementPath, sidecar);
          fs.writeFileSync(release, "go\n");
        },
      );
      const outputPaths = attempt.completion.outputPaths ?? [];
      const originalMedia = fs
        .readdirSync(downloads)
        .filter((name) => /^caption-identity-race.*\.mkv$/i.test(name))
        .map((name) => path.join(downloads, name));
      const stageReplacement = fs.existsSync(attempt.sidecar)
        ? fs.readFileSync(attempt.sidecar)
        : null;
      const publishedSidecars = fs
        .readdirSync(downloads)
        .filter(
          (name) =>
            name.startsWith("caption-identity-race") &&
            name.endsWith(".en.srt"),
        );
      record("caption-replacement-is-not-published-as-owned-sidecar", {
        outcome: attempt.completion.outcome,
        outputPaths,
        outputPath: attempt.completion.outputPath,
        originalMedia,
        sidecar: attempt.sidecar,
        stageReplacementSha256: stageReplacement
          ? hash(stageReplacement)
          : null,
        expectedReplacementSha256: hash(replacement),
        publishedSidecars,
        originalSidecarCount,
        invariantPassed:
          attempt.completion.outcome === "failed" &&
          Boolean(
            attempt.completion.outputPath &&
            fs.existsSync(attempt.completion.outputPath),
          ) &&
          outputPaths.includes(attempt.completion.outputPath) &&
          originalMedia.length === 1 &&
          outputPaths.includes(originalMedia[0]) &&
          fs.existsSync(originalMedia[0]) &&
          stageReplacement !== null &&
          hash(stageReplacement) === hash(replacement) &&
          publishedSidecars.length === originalSidecarCount,
      });
    } catch (error) {
      fs.writeFileSync(process.env.ROSI_AUDIT3_CAPTION_RACE_RELEASE, "go\n");
      record("caption-replacement-is-not-published-as-owned-sidecar", {
        error: String(error),
        invariantPassed: false,
      });
    }

    try {
      const url = `${media}/subtitled-source.mkv?audit3-audio-container-embedded=1`;
      const completion = await download(url, {
        convertEnabled: true,
        convertFormat: "m4a",
        keepOriginal: false,
        writeSubtitles: false,
      });
      const originals = fs
        .readdirSync(downloads)
        .filter((name) => /^subtitled-source.*\.mkv$/i.test(name));
      record("audio-conversion-retains-embedded-caption-source", {
        outcome: completion.outcome,
        outputPath: completion.outputPath,
        outputPaths: completion.outputPaths ?? [],
        originals,
        invariantPassed:
          completion.outcome === "success" &&
          Boolean(
            completion.outputPath && fs.existsSync(completion.outputPath),
          ) &&
          originals.length === 1 &&
          (completion.outputPaths ?? []).includes(completion.outputPath) &&
          (completion.outputPaths ?? []).includes(
            path.join(downloads, originals[0]),
          ),
      });
    } catch (error) {
      record("audio-conversion-retains-embedded-caption-source", {
        error: String(error),
        invariantPassed: false,
      });
    }

    try {
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
        {
          timeout: 15_000,
          interval: 25,
        },
      );
      const savedB = await api("saveSettings", {
        ffmpegPath: process.env.ROSI_AUDIT3_GPU_PROBE_B,
      });
      assert.equal(savedB.ok, true, JSON.stringify(savedB));
      fs.writeFileSync(process.env.ROSI_AUDIT3_GPU_PROBE_A_RELEASE, "go\n");
      await browser.waitUntil(
        () => browser.execute(() => window.audit3GpuProbeA?.settled === true),
        {
          timeout: 15_000,
          interval: 25,
        },
      );
      const probeA = await browser.execute(() => window.audit3GpuProbeA);
      const probeB = await api("detectGpu");
      const tracePath = process.env.ROSI_AUDIT3_GPU_PROBE_B_TRACE;
      const trace = fs.existsSync(tracePath)
        ? fs
            .readFileSync(tracePath, "utf8")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
      record("gpu-cache-bound-to-ffmpeg-generation", {
        probeA: probeA.result ?? null,
        probeAError: probeA.error ?? null,
        probeB,
        probeBTrace: trace,
        invariantPassed:
          probeA.settled === true &&
          probeA.result?.nvidia === true &&
          probeB.nvidia === false &&
          trace.some((entry) => entry.encoder === "h264_nvenc"),
      });
      await api("saveSettings", {
        ffmpegPath: process.env.ROSI_REPAIRS_FFMPEG,
      });
    } catch (error) {
      fs.writeFileSync(process.env.ROSI_AUDIT3_GPU_PROBE_A_RELEASE, "go\n");
      record("gpu-cache-bound-to-ffmpeg-generation", {
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
