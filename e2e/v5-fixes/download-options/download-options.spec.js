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

/** Request snapshots differ only by the URL and output folder they were started with. */
function omitUrlAndOutput(request) {
  const copy = { ...request };
  delete copy.url;
  delete copy.outputPath;
  return copy;
}

/** Reload the page and wait until its bridge and preset list are installed. */
async function reloadApp() {
  await browser.refresh();
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          document.readyState === "complete" &&
          typeof window.__ROSI_E2E__?.api?.resolveDownloadOptions ===
            "function" &&
          typeof window.__ROSI_E2E__?.api?.addToQueue === "function",
      ),
    {
      timeout: 60_000,
      timeoutMsg: "reloaded page never installed window.__ROSI_E2E__.api",
    },
  );
  await waitForAppReady();
}

/** Record the renderer's own resolve and queue calls, not the harness's `api()` calls. */
async function armRendererRecorder() {
  await browser.execute(() => {
    window.__b2Calls = [];
    window.__b2Armed = false;
    for (const name of [
      "resolveDownloadOptions",
      "resolvePresetOptions",
      "addToQueue",
    ]) {
      const original = window.__ROSI_E2E__.api[name];
      window.__ROSI_E2E__.api[name] = (...args) => {
        if (window.__b2Armed) {
          window.__b2Calls.push({
            name,
            args: JSON.parse(JSON.stringify(args)),
          });
        }
        return original(...args);
      };
    }
  });
}

async function recordRendererCalls(action) {
  await browser.execute(() => {
    window.__b2Calls = [];
    window.__b2Armed = true;
  });
  await action();
}

async function takeRendererCalls() {
  return browser.execute(() => {
    window.__b2Armed = false;
    const calls = window.__b2Calls ?? [];
    window.__b2Calls = [];
    return calls;
  });
}

async function selectAndApplyPreset(presetId, presetName) {
  // After a reload the preset list is rebuilt during startup, so wait for the option.
  await browser.waitUntil(
    () =>
      browser.execute(
        (id) =>
          [
            ...(document.getElementById("downloadPresetSelect")?.options ?? []),
          ].some((option) => option.value === id),
        presetId,
      ),
    { timeout: 20_000, timeoutMsg: "preset option never appeared" },
  );
  await browser.execute((id) => {
    const select = document.getElementById("downloadPresetSelect");
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("applyPresetBtn").click();
  }, presetId);
  let lastStatus = "";
  try {
    await browser.waitUntil(
      async () => {
        lastStatus = await presetStatus();
        return lastStatus.includes(`Applied ${presetName}.`);
      },
      { timeout: 20_000, timeoutMsg: "preset was not applied" },
    );
  } catch (error) {
    throw new Error(
      `preset was not applied; last status: "${lastStatus}" (${error.message})`,
    );
  }
}

async function presetStatus() {
  return browser.execute(
    () => document.getElementById("presetStatus")?.textContent ?? "",
  );
}

async function setUrlField(value) {
  await browser.execute((text) => {
    const input = document.getElementById("url");
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function summaryState() {
  return browser.execute(() => {
    const summary = document.getElementById("downloadOutputSummary");
    return {
      state: summary?.dataset.state ?? "",
      text: summary?.textContent ?? "",
    };
  });
}

async function waitForSummary(fragment) {
  await browser.waitUntil(
    async () => {
      const summary = await summaryState();
      return summary.state === "resolved" && summary.text.includes(fragment);
    },
    {
      timeout: 20_000,
      timeoutMsg: `effective-options summary never showed ${fragment}`,
    },
  );
  return summaryState();
}

async function waitForSettingOnDisk(key, value) {
  await browser.waitUntil(
    async () => (await api("getSettings"))[key] === value,
    { timeout: 10_000, timeoutMsg: `${key} was not saved as ${value}` },
  );
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
  it("applied preset follows the stored value in Rust, not the renderer copy", async () => {
    await api("clearQueue");
    const stored = {
      id: "resolver-applied",
      name: "Resolver Applied",
      profile: "best-video",
      bestQuality: true,
      audioOnly: false,
      convertEnabled: true,
      convertFormat: "m4a",
      keepOriginalAfterConvert: false,
      gpuAcceleration: false,
    };
    const saved = await api("saveSettings", {
      downloadMode: "compatible",
      bestQuality: false,
      audioOnly: false,
      advancedOptions: false,
      convertEnabled: false,
      convertFormat: "mp4",
      keepOriginalAfterConvert: true,
      gpuAcceleration: false,
      // A folder prompt would block the queue add, so save to the E2E folder.
      askDownloadLocation: false,
      downloadFolder: DOWNLOADS,
      downloadPresets: [stored],
    });
    assert.equal(saved.ok, true, saved.error?.message);

    // Reload so the renderer's preset cache holds the stored preset before Apply.
    await reloadApp();
    await armRendererRecorder();
    await selectAndApplyPreset(stored.id, stored.name);
    await waitForSettingOnDisk("convertFormat", "m4a");
    // Apply saved the copied values, so the renderer's next save carries no preset edit.

    // The stored preset changes after Apply. The controls still show the copied m4a.
    const edited = await api("saveSettings", {
      downloadPresets: [{ ...stored, convertFormat: "mp3" }],
    });
    assert.equal(edited.ok, true, edited.error?.message);

    const url = `${MEDIA}/clip-one.mp4?resolver=applied-${Date.now()}`;
    await recordRendererCalls(async () => {
      await setUrlField(url);
      await waitForSummary("Convert to MP3");
    });
    const [summaryCall] = (await takeRendererCalls())
      .filter(
        (call) =>
          call.name === "resolveDownloadOptions" && call.args[0]?.url === url,
      )
      .slice(-1);
    assert.ok(summaryCall, "summary did not resolve through the backend");
    const summaryKeys = Object.keys(summaryCall.args[0]).filter(
      (key) => !["url", "outputPath"].includes(key),
    );
    assert.deepEqual(
      summaryKeys,
      ["presetId"],
      "summary sent copied preset values as explicit overrides",
    );
    const summaryText = (await summaryState()).text;
    assert.doesNotMatch(
      summaryText,
      /Convert to M4A/,
      "summary showed the cached copy",
    );
    const summaryRust = await api(
      "resolveDownloadOptions",
      summaryCall.args[0],
    );
    assert.equal(summaryRust.ok, true, summaryRust.error?.message);
    assert.equal(summaryRust.data.convertFormat, "mp3");
    assert.equal(summaryRust.data.presetName, stored.name);

    // Saving from the renderer would write its cached preset list back over the
    // stored edit, so reload before starting, then apply the edited preset.
    await reloadApp();
    await armRendererRecorder();
    await selectAndApplyPreset(stored.id, stored.name);
    await waitForSettingOnDisk("convertFormat", "mp3");

    // The queue add goes through the renderer's builder. The stored request is
    // checked below against Rust's own resolution, so copied values would show.
    await setUrlField(url);
    await waitForSummary("Convert to MP3");
    await browser.execute((queueUrl) => {
      document.getElementById("queueUrlInput").value = queueUrl;
      document.getElementById("addToQueueBtn").click();
    }, url);

    await browser.waitUntil(
      async () => {
        const queue = await api("getQueue");
        return queue.some((item) => item.url === url && item.request);
      },
      {
        timeout: 20_000,
        interval: 250,
        timeoutMsg: "queue item was not stored",
      },
    );
    const queue = await api("getQueue");
    const queued = queue.find((item) => item.url === url);
    const queueRust = await api("resolveDownloadOptions", {
      presetId: stored.id,
      url,
    });
    assert.equal(queueRust.ok, true, queueRust.error?.message);
    assert.deepEqual(
      queued.request,
      queueRust.data,
      "queued request differs from resolve_download_options for the same request",
    );
    assert.equal(queued.request.convertFormat, "mp3");
    assert.equal(queued.request.presetName, stored.name);
    assert.deepEqual(
      omitUrlAndOutput(queued.request),
      omitUrlAndOutput(summaryRust.data),
      "summary and queued request disagree",
    );
  });

  it("preset preview takes no URL and shows backend values", async () => {
    await api("clearQueue");
    const stored = {
      id: "resolver-preview",
      name: "Resolver Preview",
      profile: "best-video",
      bestQuality: true,
      audioOnly: false,
      convertEnabled: true,
      convertFormat: "m4a",
      keepOriginalAfterConvert: false,
      gpuAcceleration: false,
    };
    const saved = await api("saveSettings", {
      downloadMode: "compatible",
      bestQuality: false,
      audioOnly: false,
      advancedOptions: false,
      convertEnabled: false,
      convertFormat: "mp4",
      keepOriginalAfterConvert: true,
      gpuAcceleration: false,
      askDownloadLocation: false,
      downloadFolder: DOWNLOADS,
      downloadPresets: [stored],
    });
    assert.equal(saved.ok, true, saved.error?.message);

    await reloadApp();
    await armRendererRecorder();
    await recordRendererCalls(() =>
      selectAndApplyPreset(stored.id, stored.name),
    );
    const calls = await takeRendererCalls();
    const previews = calls.filter(
      (call) => call.name === "resolvePresetOptions",
    );
    assert.equal(
      previews.length,
      1,
      "Apply did not call resolve_preset_options once",
    );
    assert.deepEqual(
      previews[0].args,
      [stored.id],
      "Apply sent more than the preset id",
    );
    assert.equal(
      calls.some((call) => JSON.stringify(call.args).includes("example.com")),
      false,
      "a request during Apply carried the example.com placeholder",
    );
    assert.equal(
      calls.some((call) => call.name === "resolveDownloadOptions"),
      false,
      "Apply still resolved through the URL-based command",
    );

    // The controls show the backend's preset values, not the saved settings.
    const controls = await browser.execute(() => ({
      convertEnabled: document.getElementById("convertToggle")?.checked,
      convertFormat: document.getElementById("convertFormat")?.value,
      keepOriginal: document.getElementById("keepOriginalToggle")?.checked,
    }));
    assert.deepEqual(
      controls,
      { convertEnabled: true, convertFormat: "m4a", keepOriginal: false },
      "controls did not show the preset values Rust resolved",
    );

    // The URL-less preview matches the URL-validated preset layer for the same preset.
    const preview = await api("resolvePresetOptions", stored.id);
    assert.equal(preview.ok, true, preview.error?.message);
    assert.equal(preview.data.convertFormat, "m4a");
    assert.equal(preview.data.presetName, stored.name);
    const withUrl = await api("resolveDownloadOptions", {
      url: `${MEDIA}/clip-one.mp4?resolver=preview-${Date.now()}`,
      outputPath: DOWNLOADS,
      presetId: stored.id,
    });
    assert.equal(withUrl.ok, true, withUrl.error?.message);
    assert.deepEqual(
      omitUrlAndOutput(preview.data),
      omitUrlAndOutput(withUrl.data),
      "URL-less preview and URL-validated resolution disagree for the same preset",
    );

    const unknown = await api("resolvePresetOptions", "no-such-preset");
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "VALIDATION_ERROR");

    // A malformed payload comes back as an envelope, not a rejected invoke.
    const malformed = await browser.executeAsync((done) => {
      window.__TAURI__.core
        .invoke("resolve_preset_options", { options: "wrong-shape" })
        .then(
          (result) => done({ rejected: false, result }),
          (error) => done({ rejected: true, error: String(error) }),
        );
    });
    assert.equal(malformed.rejected, false, malformed.error);
    assert.equal(malformed.result.ok, false);
    assert.equal(malformed.result.error.code, "VALIDATION_ERROR");

    // Preview only resolves values: no queue item was added.
    const queue = await api("getQueue");
    assert.equal(queue.length, 0, "preset preview added a queue item");
  });
});
