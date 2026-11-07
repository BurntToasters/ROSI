import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";

const MEDIA = process.env.ROSI_E2E_MEDIA_URL;
const DOWNLOADS = process.env.ROSI_E2E_DOWNLOADS;

function withoutUrl(options) {
  const copy = { ...options };
  delete copy.url;
  return copy;
}

describe("shared download option resolution", () => {
  let originalSettings;

  before(async () => {
    await waitForAppReady();
    originalSettings = await api("getSettings");
    assert.ok(MEDIA, "ROSI_E2E_MEDIA_URL is required");
    assert.ok(DOWNLOADS, "ROSI_E2E_DOWNLOADS is required");
  });

  after(async () => {
    await api("clearQueue");
    if (originalSettings) {
      const restored = await api("saveSettings", originalSettings);
      assert.equal(restored.ok, true, restored.error?.message);
    }
  });

  it("shares preset and explicit-option precedence across manual and queue requests", async () => {
    await api("clearQueue");
    const preset = {
      id: "resolver-e2e",
      name: "Resolver E2E",
      profile: "audio",
      bestQuality: true,
      audioOnly: true,
      audioFormat: "flac",
      convertEnabled: true,
      convertFormat: "m4a",
      keepOriginalAfterConvert: false,
      gpuAcceleration: true,
      gpuType: "nvidia",
      playlist: { mode: "all" },
    };
    const saved = await api("saveSettings", {
      downloadMode: "custom",
      advancedOptions: true,
      bestQuality: false,
      audioOnly: false,
      convertEnabled: false,
      gpuAcceleration: false,
      downloadPresets: [preset],
    });
    assert.equal(saved.ok, true, saved.error?.message);

    const url = `${MEDIA}/clip-one.mp4?resolver=manual-${Date.now()}`;
    const explicit = {
      url,
      outputPath: DOWNLOADS,
      presetId: preset.id,
      profile: "compatible",
      bestQuality: false,
      audioOnly: false,
      convertEnabled: false,
      gpuAcceleration: false,
      playlist: { mode: "current" },
    };
    const manual = await api("resolveDownloadOptions", explicit);
    assert.equal(manual.ok, true, manual.error?.message);
    assert.equal(manual.data.profile, "compatible");
    assert.equal(manual.data.bestQuality, false);
    assert.equal(manual.data.audioOnly, false);
    assert.equal(manual.data.convertEnabled, false);
    assert.equal(manual.data.gpuAcceleration, false);
    assert.equal(manual.data.convertFormat, "m4a");
    assert.equal(manual.data.keepOriginal, false);
    assert.equal(manual.data.audioOutputFormat, "flac");
    assert.deepEqual(manual.data.playlist, { mode: "current" });

    const nullsInherit = await api("resolveDownloadOptions", {
      ...explicit,
      profile: null,
      bestQuality: null,
      audioOnly: null,
      convertEnabled: null,
      gpuAcceleration: null,
      playlist: null,
    });
    assert.equal(nullsInherit.ok, true, nullsInherit.error?.message);
    assert.equal(nullsInherit.data.profile, "audio");
    assert.equal(nullsInherit.data.bestQuality, true);
    assert.equal(nullsInherit.data.audioOnly, true);
    assert.equal(nullsInherit.data.convertEnabled, true);
    assert.equal(nullsInherit.data.gpuAcceleration, true);
    assert.deepEqual(nullsInherit.data.playlist, { mode: "all" });

    const queuedUrl = `${MEDIA}/clip-one.mp4?resolver=queue-${Date.now()}`;
    const queued = await api("addToQueue", [queuedUrl], {
      ...withoutUrl(explicit),
      outputPath: DOWNLOADS,
    });
    assert.equal(queued.ok, true, queued.error?.message);
    assert.equal(queued.data.added, 1);
    const queue = await api("getQueue");
    const queuedItem = queue.find((item) => item.url === queuedUrl);
    assert.ok(
      queuedItem?.request,
      "queue admission did not save a request snapshot",
    );
    assert.deepEqual(
      { ...manual.data, url: queuedUrl },
      queuedItem.request,
      "queue and manual resolution produced different request options",
    );

    const profileUrl = `${MEDIA}/clip-one.mp4?resolver=profile-${Date.now()}`;
    const profileOnly = {
      url: profileUrl,
      outputPath: DOWNLOADS,
      profile: "audio",
    };
    const profileManual = await api("resolveDownloadOptions", profileOnly);
    assert.equal(profileManual.ok, true, profileManual.error?.message);
    assert.equal(profileManual.data.audioOnly, true);
    assert.equal(profileManual.data.bestQuality, false);
    assert.equal(profileManual.data.advancedOptions, false);
    const profileQueueUrl = `${MEDIA}/clip-one.mp4?resolver=profile-queue-${Date.now()}`;
    const profileQueued = await api("addToQueue", [profileQueueUrl], {
      outputPath: DOWNLOADS,
      profile: "audio",
    });
    assert.equal(profileQueued.ok, true, profileQueued.error?.message);
    const afterProfileQueue = await api("getQueue");
    const profileItem = afterProfileQueue.find(
      (item) => item.url === profileQueueUrl,
    );
    assert.ok(
      profileItem?.request,
      "profile-only queue request was not captured",
    );
    assert.deepEqual(
      { ...profileManual.data, url: profileQueueUrl },
      profileItem.request,
      "profile-only manual and queue resolution diverged",
    );
  });

  it("keeps an enqueue-time request on replay and returns validation envelopes", async () => {
    await api("clearQueue");
    const preset = {
      id: "resolver-replay",
      name: "Resolver Replay",
      profile: "best-video",
      bestQuality: true,
      audioOnly: false,
      convertEnabled: false,
      gpuAcceleration: false,
      playlist: { mode: "current" },
    };
    const saved = await api("saveSettings", {
      downloadMode: "compatible",
      bestQuality: false,
      audioOnly: false,
      downloadPresets: [preset],
    });
    assert.equal(saved.ok, true, saved.error?.message);

    const url = `${MEDIA}/missing-resolver-replay-${Date.now()}.mp4`;
    const added = await api("addToQueue", [url], {
      outputPath: DOWNLOADS,
      presetId: preset.id,
      convertEnabled: false,
    });
    assert.equal(added.ok, true, added.error?.message);
    const before = await api("getQueue");
    const queued = before.find((item) => item.url === url);
    assert.ok(queued?.request, "queue item lacks its resolved options");
    const snapshot = queued.request;

    const changed = await api("saveSettings", {
      downloadMode: "custom",
      advancedOptions: true,
      bestQuality: false,
      audioOnly: true,
      convertEnabled: true,
      gpuAcceleration: true,
      downloadPresets: [
        { ...preset, audioFormatId: "999", videoFormat: "888" },
      ],
    });
    assert.equal(changed.ok, true, changed.error?.message);
    const started = await api("startQueue");
    assert.equal(started.ok, true, started.error?.message);
    await browser.waitUntil(
      async () => {
        const queue = await api("getQueue");
        const item = queue.find((candidate) => candidate.url === url);
        return (
          item && ["completed", "failed", "cancelled"].includes(item.status)
        );
      },
      {
        timeout: 120_000,
        interval: 500,
        timeoutMsg: "queued replay did not finish",
      },
    );
    const after = await api("getQueue");
    const replayed = after.find((item) => item.url === url);
    assert.deepEqual(
      replayed.request,
      snapshot,
      "queue request changed while replaying",
    );

    await browser.waitUntil(
      async () => {
        const activity = await api("getDownloadActivity");
        return activity.ok && activity.data.some((entry) => entry.url === url);
      },
      {
        timeout: 20_000,
        interval: 250,
        timeoutMsg: "queue replay was not recorded",
      },
    );
    const activity = await api("getDownloadActivity");
    const completion = activity.data.find((entry) => entry.url === url);
    assert.deepEqual(
      completion.request,
      snapshot,
      "replayed completion used settings changed after queue admission",
    );
    assert.equal(
      completion.request.audioFormat ?? null,
      snapshot.audioFormat ?? null,
      "a later preset format ID was added to the stored snapshot",
    );
    assert.equal(
      completion.request.videoFormat ?? null,
      snapshot.videoFormat ?? null,
      "a later preset video format was added to the stored snapshot",
    );

    const wrongResolverShape = await api(
      "resolveDownloadOptions",
      "wrong-shape",
    );
    assert.equal(wrongResolverShape.ok, false);
    assert.equal(wrongResolverShape.error.code, "VALIDATION_ERROR");
    const wrongDownloadShape = await api("downloadVideo", "wrong-shape");
    assert.equal(wrongDownloadShape.ok, false);
    assert.equal(wrongDownloadShape.error.code, "VALIDATION_ERROR");
    const wrongQueueShape = await api("addToQueue", "wrong-shape");
    assert.equal(wrongQueueShape.ok, false);
    assert.equal(wrongQueueShape.error.code, "VALIDATION_ERROR");
    const rejectedPath = await api("resolveDownloadOptions", {
      url: `${MEDIA}/clip-one.mp4`,
      outputPath: "relative-output",
    });
    assert.equal(rejectedPath.ok, false);
    assert.equal(rejectedPath.error.code, "INVALID_PATH");
  });
});
