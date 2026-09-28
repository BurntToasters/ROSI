import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";

const env = process.env;
const DOWNLOADS = env.ROSI_E2E_DOWNLOADS;
const DATA_DIR = env.ROSI_E2E_DATA_DIR;
const MEDIA = env.ROSI_E2E_MEDIA_URL;
const FIXTURES = JSON.parse(env.ROSI_E2E_FIXTURES || "{}");
const HAS_FFMPEG = env.ROSI_E2E_HAS_FFMPEG === "1";
const RESULTS_PATH = env.ROSI_E2E_RESULTS;
const FFPROBE = env.ROSI_E2E_FFPROBE;
// Mixes a non-Latin-1 script with Cyrillic and a Latin-1 accent so a legacy
// Windows code page cannot represent it.
const UNICODE_FIXTURE = "日本語-Привет-café.mp4";

const results = [];

function record(name, details = {}) {
  results.push({ name, status: "passed", ...details });
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

/** Call a `window.api` method in the app and return its resolved value. */
async function api(method, ...args) {
  // The WebDriver bridge fails on script results containing non-ASCII text,
  // so the page returns ASCII-escaped JSON and Node parses it.
  const encoded = await browser.executeAsync(
    (name, params, done) => {
      const ascii = (value) =>
        JSON.stringify(value).replace(
          /[\u0080-\uffff]/g,
          (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
        );
      Promise.resolve()
        .then(() => window.api[name](...params))
        .then(
          (value) => done(ascii({ ok: true, value: value ?? null })),
          (error) =>
            done(
              ascii({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
        );
    },
    method,
    args,
  );
  const outcome = JSON.parse(encoded);
  if (!outcome.ok)
    throw new Error(`window.api.${method} failed: ${outcome.error}`);
  return outcome.value;
}

/** Command lines of live processes that mention `needle` (never this test). */
function processesMatching(needle) {
  const listing =
    process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }",
          ],
          { encoding: "utf8" },
        ).stdout
      : spawnSync("ps", ["-Ao", "command="], { encoding: "utf8" }).stdout;
  return (listing ?? "")
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.includes(needle) &&
        !line.includes("ps -Ao") &&
        !line.includes("Get-CimInstance"),
    );
}

async function waitForNoProcess(needle, timeoutMsg) {
  await browser.waitUntil(async () => processesMatching(needle).length === 0, {
    // Unix sends SIGTERM, then SIGKILL after 5 s.
    timeout: 15_000,
    interval: 250,
    timeoutMsg: `${timeoutMsg}: ${processesMatching(needle).join(" | ")}`,
  });
}

async function waitForActivity(predicate, timeoutMsg, timeout = 120_000) {
  let match = null;
  await browser.waitUntil(
    async () => {
      const activity = await api("getDownloadActivity");
      match = (activity?.data ?? []).find(predicate) ?? null;
      return Boolean(match);
    },
    { timeout, interval: 500, timeoutMsg },
  );
  return match;
}

async function waitForIdle() {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const button = document.getElementById("downloadBtn");
        return Boolean(button && !button.classList.contains("loading"));
      }),
    { timeout: 60_000, timeoutMsg: "download button stayed busy" },
  );
}

async function typeUrl(url) {
  await browser.execute((value) => {
    const input = document.getElementById("url");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, url);
}

describe("ROSI main window", () => {
  before(async () => {
    await $("#url").waitForExist({ timeout: 60_000 });
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => Boolean(window.__ROSI_E2E__?.ready) && Boolean(window.api),
        ),
      { timeout: 60_000, timeoutMsg: "E2E hook / window.api not installed" },
    );
  });

  after(() => {
    if (RESULTS_PATH) {
      fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);
    }
  });

  it("launches with the backend bridge and skips first-run setup", async () => {
    // Layout-based check: WebDriver "displayed" also depends on CSS entrance
    // animations, which the engine pauses while the session is locked or the
    // display sleeps (document.visibilityState === "hidden").
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const button = document.getElementById("downloadBtn");
          if (!button) return false;
          const rect = button.getBoundingClientRect();
          return (
            getComputedStyle(button).display !== "none" &&
            rect.width > 0 &&
            rect.height > 0
          );
        }),
      { timeout: 20_000, timeoutMsg: "download button was not laid out" },
    );
    const visibility = await browser.execute(() => document.visibilityState);
    const wizardActive = await browser.execute(
      () =>
        document.getElementById("setup-wizard")?.classList.contains("active") ??
        false,
    );
    assert.equal(wizardActive, false);
    const version = await api("getAppVersion");
    const platform = await api("getAppPlatform");
    const channel = await api("getChannel");
    assert.match(version, /^\d+\.\d+\.\d+/);
    assert.ok(["darwin", "win32", "linux"].includes(platform));
    assert.equal(channel, "github");
    const versionText = await $("#versionLink").getText();
    assert.equal(versionText, `v${version}`);
    record("launch", { version, platform, channel, visibility });
  });

  it("opens and closes the settings sidebar", async () => {
    await browser.execute(() =>
      document.getElementById("settingsBtn")?.click(),
    );
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          document.getElementById("sidebar")?.classList.contains("open"),
        ),
      { timeout: 10_000, timeoutMsg: "sidebar did not open" },
    );
    await browser.execute(() =>
      document.getElementById("closeSidebar")?.click(),
    );
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => !document.getElementById("sidebar")?.classList.contains("open"),
        ),
      { timeout: 10_000, timeoutMsg: "sidebar did not close" },
    );
    record("settings-sidebar");
  });

  it("validates and persists settings through the Rust backend", async () => {
    const rejected = await api("saveSettings", { theme: "neon" });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "VALIDATION_ERROR");
    const saved = await api("saveSettings", {
      theme: "purple",
      subtitleLangs: "en,es",
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.data.theme, "purple");
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf8"),
    );
    assert.equal(onDisk.theme, "purple");
    assert.equal(onDisk.subtitleLangs, "en,es");
    assert.equal(onDisk.downloadFolder, DOWNLOADS);
    record("settings-persistence", { settingsFile: "settings.json" });
  });

  it("rejects private-network and non-http URLs in the backend", async () => {
    const privateHost = await api("getFormats", "http://192.168.1.10/video");
    assert.equal(privateHost.ok, false);
    assert.equal(privateHost.error.code, "INVALID_URL");
    const fileUrl = await api("addToQueue", ["file:///etc/passwd"]);
    assert.equal(fileUrl.ok, false);
    record("url-safety");
  });

  it("downloads a file through the UI with the bundled yt-dlp sidecar", async () => {
    const url = `${MEDIA}/clip-one.mp4`;
    await typeUrl(url);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => !document.getElementById("downloadBtn")?.disabled,
        ),
      { timeout: 10_000, timeoutMsg: "download button stayed disabled" },
    );
    await browser.execute(() =>
      document.getElementById("downloadBtn")?.click(),
    );
    const entry = await waitForActivity(
      (item) => item.url === url,
      "manual download never reached the activity log",
    );
    assert.equal(entry.outcome, "success", entry.error ?? entry.statusMessage);
    assert.equal(entry.owner, "manual");
    assert.ok(entry.outputPath, "completion is missing outputPath");
    assert.ok(
      entry.outputPath.startsWith(DOWNLOADS),
      `${entry.outputPath} is outside ${DOWNLOADS}`,
    );
    const digest = sha256File(entry.outputPath);
    assert.equal(digest, FIXTURES["clip-one.mp4"]);
    await waitForIdle();
    record("manual-download", {
      file: path.basename(entry.outputPath),
      sha256: digest,
      sizeBytes: entry.sizeBytes,
    });
  });

  it("downloads a file with a non-ASCII title", async () => {
    // The generic extractor titles direct links from the URL path, so the
    // name travels through yt-dlp stdout, --print-to-file, and the activity log.
    const url = `${MEDIA}/${encodeURIComponent(UNICODE_FIXTURE)}`;
    // The UI button shows "Open File Location" for a few seconds after the
    // previous download, so start this one through the backend API.
    const started = await api("downloadVideo", { url, outputPath: DOWNLOADS });
    assert.equal(started.ok, true, started.error?.message);
    const entry = await waitForActivity(
      (item) => item.url === url,
      "non-ASCII download never reached the activity log",
    );
    assert.equal(entry.outcome, "success", entry.error ?? entry.statusMessage);
    assert.ok(entry.outputPath, "completion is missing outputPath");
    const name = path.basename(entry.outputPath).normalize("NFC");
    const stem = UNICODE_FIXTURE.replace(/\.mp4$/, "");
    assert.ok(name.includes(stem), `output name ${name} lost ${stem}`);
    assert.ok(fs.existsSync(entry.outputPath), `${entry.outputPath} missing`);
    const digest = sha256File(entry.outputPath);
    assert.equal(digest, FIXTURES[UNICODE_FIXTURE]);
    await waitForIdle();
    record("unicode-download", { file: name, sha256: digest });
  });

  it("runs the queue to completion and persists it", async () => {
    await api("clearQueue");
    const urls = [`${MEDIA}/clip-two.mp4`, `${MEDIA}/clip-three.mp4`];
    const added = await api("addToQueue", [...urls, urls[0]]);
    assert.equal(added.ok, true);
    assert.equal(added.data.added, 2);
    assert.equal(added.data.skipped, 1);
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.getElementById("queueCount")?.textContent,
        )) === "2",
      { timeout: 10_000, timeoutMsg: "queue count did not update" },
    );
    const started = await api("startQueue");
    assert.equal(started.ok, true);
    await browser.waitUntil(
      async () => {
        const queue = await api("getQueue");
        return queue.every((item) =>
          ["completed", "failed", "cancelled"].includes(item.status),
        );
      },
      { timeout: 180_000, interval: 500, timeoutMsg: "queue did not finish" },
    );
    const queue = await api("getQueue");
    for (const item of queue) {
      assert.equal(item.status, "completed", item.error ?? item.url);
    }
    const files = [];
    for (const item of queue) {
      const name = new URL(item.url).pathname.slice(1);
      assert.equal(sha256File(item.outputPath), FIXTURES[name]);
      files.push({
        file: path.basename(item.outputPath),
        sha256: FIXTURES[name],
      });
    }
    await browser.waitUntil(
      () =>
        fs.existsSync(path.join(DATA_DIR, "download-queue.json")) &&
        JSON.parse(
          fs.readFileSync(path.join(DATA_DIR, "download-queue.json"), "utf8"),
        ).filter((item) => item.status === "completed").length === 2,
      { timeout: 10_000, timeoutMsg: "queue was not persisted" },
    );
    record("queue", { files });
  });

  it("cancels an in-flight download and stops the yt-dlp process", async () => {
    const url = `${MEDIA}/slow.mp4`;
    const started = await api("downloadVideo", { url, outputPath: DOWNLOADS });
    assert.equal(started.ok, true);
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          document
            .getElementById("progress-container")
            ?.classList.contains("visible"),
        ),
      { timeout: 60_000, timeoutMsg: "download progress never appeared" },
    );
    assert.ok(
      processesMatching("slow.mp4").length > 0,
      "yt-dlp was not running for the in-flight download",
    );
    await api("cancelDownload");
    const entry = await waitForActivity(
      (item) => item.url === url,
      "cancelled download never reached the activity log",
    );
    assert.equal(entry.outcome, "cancelled");
    await waitForNoProcess("slow.mp4", "yt-dlp survived cancellation");
    record("cancel", { outcome: entry.outcome, processTreeStopped: true });
  });

  it("converts a download with FFmpeg", async function () {
    if (!HAS_FFMPEG) {
      results.push({
        name: "conversion",
        status: "skipped",
        reason: "no FFmpeg available (development sidecar stubs)",
      });
      this.skip();
    }
    const url = `${MEDIA}/tone.mp4`;
    const started = await api("downloadVideo", {
      url,
      outputPath: DOWNLOADS,
      convertEnabled: true,
      convertFormat: "m4a",
      keepOriginal: false,
    });
    assert.equal(started.ok, true);
    const entry = await waitForActivity(
      (item) => item.url === url,
      "conversion never reached the activity log",
    );
    assert.equal(entry.outcome, "success", entry.error ?? entry.statusMessage);
    assert.equal(entry.format, "m4a");
    assert.ok(entry.outputPath.endsWith(".m4a"));
    assert.ok(fs.statSync(entry.outputPath).size > 0);
    const originals = fs
      .readdirSync(DOWNLOADS)
      .filter((name) => name.startsWith("tone") && name.endsWith(".mp4"));
    assert.deepEqual(originals, [], "original file should be deleted");
    record("conversion", {
      file: path.basename(entry.outputPath),
      sizeBytes: entry.sizeBytes,
    });
  });

  it("extracts audio through yt-dlp with the configured FFmpeg", async function () {
    if (!HAS_FFMPEG) {
      results.push({
        name: "audio-extract",
        status: "skipped",
        reason: "no FFmpeg available (development sidecar stubs)",
      });
      this.skip();
    }
    const url = `${MEDIA}/tone.mp4?audio=1`;
    const started = await api("downloadVideo", {
      url,
      outputPath: DOWNLOADS,
      audioOnly: true,
      audioOutputFormat: "mp3",
    });
    assert.equal(started.ok, true);
    const entry = await waitForActivity(
      (item) => item.url === url,
      "audio extraction never reached the activity log",
    );
    assert.equal(entry.outcome, "success", entry.error ?? entry.statusMessage);
    assert.ok(entry.outputPath.endsWith(".mp3"), entry.outputPath);
    const header = fs.readFileSync(entry.outputPath).subarray(0, 3);
    const isMp3 =
      header.toString("latin1") === "ID3" ||
      (header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
    assert.ok(isMp3, "extracted file is not an MP3 stream");
    record("audio-extract", {
      file: path.basename(entry.outputPath),
      sizeBytes: entry.sizeBytes,
    });
  });

  it("probes hardware encoders through the backend", async () => {
    const gpu = await api("detectGpu");
    for (const vendor of ["nvidia", "amd", "intel"]) {
      assert.equal(typeof gpu[vendor], "boolean");
    }
    record("gpu-detect", gpu);
  });

  it("renders bundled, Rust, and npm license notices", async () => {
    await browser.execute(() =>
      document.getElementById("licensesLink")?.click(),
    );
    let counts = null;
    await browser.waitUntil(
      async () => {
        counts = await browser.execute(() => {
          const frame = document.getElementById("licenses-frame");
          const doc = frame?.contentDocument;
          if (!doc) return null;
          const total = (id) =>
            Number(
              doc.querySelector(`#${id} .npm-total strong`)?.textContent ?? 0,
            );
          return {
            bundled: doc.querySelectorAll("#bundled-licenses-container details")
              .length,
            cargo: total("cargo-licenses-container"),
            npm: total("npm-licenses-container"),
            errors: doc.querySelectorAll(".npm-error").length,
          };
        });
        return Boolean(counts && counts.bundled && counts.cargo && counts.npm);
      },
      { timeout: 30_000, timeoutMsg: "license notices did not render" },
    );
    assert.equal(counts.errors, 0);
    assert.equal(counts.bundled, 4);
    await browser.execute(() =>
      document.getElementById("close-licenses")?.click(),
    );
    record("licenses", counts);
  });

  it("keeps the main webview on the bundled app", async () => {
    const before = await browser.execute(() => window.location.href);
    // A loopback http URL is neither an app URL nor a safe external URL, so
    // the Rust navigation guard must cancel it without opening a browser.
    // Use the media server's port: WebKitGTK refuses restricted ports such as
    // 9 before asking the app, which would bypass the guard under test.
    await browser.execute((target) => {
      window.location.assign(target);
    }, `${MEDIA}/rosi-e2e-blocked`);
    await browser.pause(1500);
    const after = await browser.execute(() => ({
      href: window.location.href,
      api: typeof window.api?.getAppVersion,
    }));
    assert.equal(after.href, before);
    assert.equal(after.api, "function");
    const log = fs.readFileSync(
      path.join(DATA_DIR, "logs", "rosi.log"),
      "utf8",
    );
    assert.match(log, /Blocked navigation to http/);
    const appUrl = new URL(before);
    record("navigation-guard", { app: `${appUrl.protocol}//${appUrl.host}` });
  });

  it("previews media metadata through the UI", async () => {
    const url = `${MEDIA}/clip-one.mp4?preview=1`;
    await typeUrl(url);
    const previewState = () =>
      browser.execute(() => {
        const card = document.getElementById("preview-card");
        const button = document.getElementById("previewBtn");
        return {
          title: document.getElementById("preview-title")?.textContent ?? "",
          card: card?.className ?? "",
          button: `${button?.className ?? ""} disabled=${button?.disabled} text=${button?.textContent?.trim() ?? ""}`,
          input: document.getElementById("url")?.value ?? "",
          visibility: document.visibilityState,
        };
      });
    try {
      // The title element keeps the previous preview's text while hidden, so
      // require the card itself to be shown and settled.
      await browser.waitUntil(
        async () => {
          const state = await previewState();
          return (
            state.title === "clip-one" &&
            /\bvisible\b/.test(state.card) &&
            !/\bloading\b/.test(state.card)
          );
        },
        {
          timeout: 60_000,
          interval: 500,
        },
      );
    } catch {
      throw new Error(
        `preview card never showed the title: ${JSON.stringify(await previewState())}`,
      );
    }
    // The UI owns the single preview slot (a new lookup cancels the previous
    // one, as in v4), so read the result from the rendered card.
    const card = await browser.execute(() => ({
      sub: document.getElementById("preview-sub")?.textContent ?? "",
      visible: document
        .getElementById("preview-card")
        ?.classList.contains("visible"),
      loading: document
        .getElementById("preview-card")
        ?.classList.contains("loading"),
    }));
    assert.equal(card.visible, true);
    assert.equal(card.loading, false);
    await typeUrl("");
    record("preview", { title: "clip-one", sub: card.sub });
  });

  it("lists available formats", async () => {
    const url = HAS_FFMPEG
      ? `${MEDIA}/dash/manifest.mpd`
      : `${MEDIA}/clip-one.mp4`;
    const formats = await api("getFormats", url);
    assert.equal(formats.ok, true, formats.error?.message);
    if (HAS_FFMPEG) {
      assert.match(formats.data, /audio only/);
      assert.match(formats.data, /video only/);
    }
    record("formats", {
      lines: formats.data.split(/\r?\n/).filter(Boolean).length,
    });
  });

  it("downloads separate video and audio and merges them", async function () {
    if (!HAS_FFMPEG) {
      results.push({
        name: "merge-download",
        status: "skipped",
        reason: "no FFmpeg available (development sidecar stubs)",
      });
      this.skip();
    }
    await browser.execute(() => {
      window.__rosiPhases = [];
      void window.__TAURI__.event.listen("job-progress", (event) => {
        window.__rosiPhases.push(
          `${event.payload.phase}:${event.payload.status}`,
        );
      });
    });
    const url = `${MEDIA}/dash/manifest.mpd`;
    const started = await api("downloadVideo", {
      url,
      outputPath: DOWNLOADS,
      profileEnabled: true,
      profile: "best-video",
    });
    assert.equal(started.ok, true);
    const entry = await waitForActivity(
      (item) => item.url === url,
      "merged download never reached the activity log",
    );
    assert.equal(entry.outcome, "success", entry.error ?? entry.statusMessage);
    assert.ok(entry.outputPath.endsWith(".mp4"), entry.outputPath);
    const phases = await browser.execute(() => window.__rosiPhases);
    assert.ok(
      phases.includes("merge:Merging video and audio..."),
      `merge phase not reported: ${phases.join(", ")}`,
    );
    let streams = null;
    if (FFPROBE) {
      const probe = spawnSync(
        FFPROBE,
        [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type",
          "-of",
          "csv=p=0",
          entry.outputPath,
        ],
        { encoding: "utf8" },
      );
      streams = probe.stdout.split(/\r?\n/).filter(Boolean).sort();
      assert.deepEqual(streams, ["audio", "video"]);
    }
    record("merge-download", {
      file: path.basename(entry.outputPath),
      streams,
      phases: Array.from(new Set(phases)),
    });
  });

  it("reorders, retries, and removes queue items", async () => {
    await api("clearQueue");
    const good = `${MEDIA}/clip-two.mp4?queue=manage`;
    const missing = `${MEDIA}/missing.mp4`;
    const added = await api("addToQueue", [missing, good]);
    assert.equal(added.ok, true);
    assert.equal(added.data.added, 2);
    let queue = await api("getQueue");
    const goodItem = queue.find((item) => item.url === good);
    const moved = await api("reorderQueueItem", {
      id: goodItem.id,
      direction: "up",
    });
    assert.equal(moved.ok, true);
    queue = await api("getQueue");
    assert.deepEqual(
      queue.map((item) => item.url),
      [good, missing],
    );
    const blocked = await api("reorderQueueItem", {
      id: goodItem.id,
      direction: "up",
    });
    assert.equal(blocked.ok, false);
    assert.equal((await api("startQueue")).ok, true);
    await browser.waitUntil(
      async () =>
        (await api("getQueue")).every((item) =>
          ["completed", "failed", "cancelled"].includes(item.status),
        ),
      { timeout: 120_000, interval: 500, timeoutMsg: "queue did not finish" },
    );
    queue = await api("getQueue");
    const byUrl = Object.fromEntries(queue.map((item) => [item.url, item]));
    assert.equal(byUrl[good].status, "completed");
    assert.equal(byUrl[missing].status, "failed");
    const retry = await api("retryQueueItem", byUrl[missing].id);
    assert.equal(retry.ok, true);
    assert.equal(
      (await api("getQueue")).find((i) => i.url === missing).status,
      "pending",
    );
    const retryDone = await api("retryQueueItem", byUrl[good].id);
    assert.equal(retryDone.ok, false);
    const removed = await api("removeFromQueue", byUrl[missing].id);
    assert.equal(removed.ok, true);
    queue = await api("getQueue");
    assert.deepEqual(
      queue.map((item) => item.url),
      [good],
    );
    record("queue-management", { failedThenRetried: missing.split("/").pop() });
  });

  it("cancels a running queue with one outcome per item", async () => {
    await api("clearQueue");
    const slow = `${MEDIA}/slow.mp4?queue=cancel`;
    const next = `${MEDIA}/clip-three.mp4?queue=cancel`;
    assert.equal((await api("addToQueue", [slow, next])).ok, true);
    assert.equal((await api("startQueue")).ok, true);
    await browser.waitUntil(
      async () =>
        (await api("getQueue")).some(
          (item) => item.url === slow && item.status === "downloading",
        ),
      { timeout: 60_000, timeoutMsg: "queue item never started" },
    );
    await browser.pause(1500);
    assert.ok(processesMatching("queue=cancel").length > 0);
    assert.equal((await api("cancelQueue")).ok, true);
    await browser.waitUntil(
      async () =>
        (await api("getQueue")).every((item) => item.status === "cancelled"),
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg: "queue items were not cancelled",
      },
    );
    await browser.pause(1000);
    const activity = (await api("getDownloadActivity")).data;
    const slowEntries = activity.filter((item) => item.url === slow);
    const nextEntries = activity.filter((item) => item.url === next);
    assert.equal(slowEntries.length, 1, "running item recorded more than once");
    assert.equal(nextEntries.length, 1, "pending item recorded more than once");
    assert.equal(slowEntries[0].outcome, "cancelled");
    assert.equal(nextEntries[0].outcome, "cancelled");
    await waitForNoProcess(
      "queue=cancel",
      "queue yt-dlp survived cancellation",
    );
    const leftovers = fs
      .readdirSync(DOWNLOADS)
      .filter((name) => name.startsWith("slow") && name.endsWith(".part"));
    record("queue-cancel", {
      activityEntries: 2,
      partialFiles: leftovers.length,
    });
  });

  it("blocks webview reload, print, and page context menus", async () => {
    const result = await browser.execute(() => {
      const key = (init) => {
        const event = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...init,
        });
        document.body.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const menu = (target) => {
        const event = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      window.getSelection()?.removeAllRanges();
      const url = document.getElementById("url");
      document.body.focus();
      const mac = navigator.platform.toLowerCase().includes("mac");
      const focusShortcut = key({ key: "f", ctrlKey: !mac, metaKey: mac });
      const frame = document.querySelector("#licenses-overlay iframe");
      return {
        installed: window.__ROSI_WEBVIEW_GUARD__ === true,
        f5: key({ key: "F5" }),
        ctrlR: key({ key: "r", ctrlKey: true }),
        ctrlShiftR: key({ key: "R", ctrlKey: true, shiftKey: true }),
        metaR: key({ key: "r", metaKey: true }),
        ctrlP: key({ key: "p", ctrlKey: true }),
        plainR: key({ key: "r" }),
        pageMenu: menu(document.body),
        inputMenu: menu(url),
        appShortcutStillWorks: focusShortcut && document.activeElement === url,
        iframeGuard: frame?.contentWindow?.__ROSI_WEBVIEW_GUARD__ ?? null,
      };
    });
    assert.equal(result.installed, true, "guard script was not injected");
    for (const name of ["f5", "ctrlR", "ctrlShiftR", "metaR", "ctrlP"]) {
      assert.equal(result[name], true, `${name} was not blocked`);
    }
    assert.equal(result.plainR, false, "plain typing must not be blocked");
    assert.equal(result.pageMenu, true, "page context menu was not blocked");
    assert.equal(result.inputMenu, false, "input context menu must stay");
    assert.equal(result.appShortcutStillWorks, true);
    record("webview-guard", result);
  });

  it("accepts links dropped onto the download card", async () => {
    const link = `${MEDIA}/clip-two.mp4`;
    const dropped = await browser.execute((value) => {
      const card = document.querySelector(".download-card");
      const input = document.getElementById("url");
      input.value = "";
      const data = new DataTransfer();
      data.setData("text/uri-list", value);
      const over = new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
      });
      card.dispatchEvent(over);
      const highlighted = card.classList.contains("drag-over");
      card.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
        }),
      );
      return {
        value: input.value,
        highlighted,
        overPrevented: over.defaultPrevented,
        cleared: !card.classList.contains("drag-over"),
      };
    }, link);
    await typeUrl("");
    assert.equal(dropped.value, link);
    assert.equal(dropped.overPrevented, true, "dragover must allow a drop");
    assert.equal(dropped.highlighted, true);
    assert.equal(dropped.cleared, true);
    record("link-drop", { link: "clip-two.mp4" });
  });

  it("keeps the UI reachable in a small window", async () => {
    // 1366x768 laptops at 125% scaling leave roughly 1093x570 logical pixels.
    // Measure the CSS viewport: Tauri's innerSize() on Linux includes GTK
    // chrome, and Xvfb without a window manager ignores resize requests.
    const result = await browser.executeAsync((done) => {
      const { getCurrentWindow } = window.__TAURI__.window;
      const { LogicalSize } = window.__TAURI__.dpi;
      const win = getCurrentWindow();
      const settle = () => new Promise((resolve) => setTimeout(resolve, 600));
      const reachable = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        element.scrollIntoView({ block: "nearest" });
        const rect = element.getBoundingClientRect();
        // Sub-pixel layout can put the last element a fraction past the edge.
        return (
          rect.height > 0 &&
          rect.top >= -1 &&
          rect.bottom <= window.innerHeight + 1
        );
      };
      (async () => {
        const before = window.innerHeight;
        await win.setSize(new LogicalSize(900, 560));
        await settle();
        const out = {
          before,
          viewportHeight: window.innerHeight,
          resized: window.innerHeight !== before,
          downloadButton: reachable("#downloadBtn"),
          footer: reachable(".main-footer"),
        };
        window.scrollTo(0, 0);
        await win.setSize(new LogicalSize(1200, 900));
        await settle();
        return out;
      })().then(
        (value) => done(JSON.stringify(value)),
        (error) => done(JSON.stringify({ error: String(error) })),
      );
    });
    const sizes = JSON.parse(result);
    assert.equal(sizes.error, undefined, sizes.error);
    if (sizes.resized) {
      // minHeight must admit a 560px window (viewport = 560 minus title bar).
      assert.ok(sizes.viewportHeight <= 560, `560px window refused: ${result}`);
    }
    assert.equal(sizes.downloadButton, true, "download button unreachable");
    assert.equal(sizes.footer, true, "footer unreachable");
    record("small-window", sizes);
  });

  it("keeps the cookie browser choice across a reload", async () => {
    await browser.execute(() => {
      const select = document.getElementById("browserChoice");
      select.value = "firefox";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const settingsFile = path.join(DATA_DIR, "settings.json");
    await browser.waitUntil(
      () =>
        JSON.parse(fs.readFileSync(settingsFile, "utf8")).browserChoice ===
        "firefox",
      { timeout: 10_000, timeoutMsg: "browserChoice was not saved" },
    );
    // Defer the reload: WebView2 tears down the script context before the
    // embedded WebDriver can answer a synchronous execute that navigates.
    await browser.execute(() => {
      window.__ROSI_E2E__.ready = false;
      window.setTimeout(() => window.location.reload(), 50);
    });
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => Boolean(window.__ROSI_E2E__?.ready) && Boolean(window.api),
        ),
      {
        timeout: 60_000,
        timeoutMsg: "renderer did not come back after reload",
      },
    );
    // The select shows the built-in default until saved settings load.
    let shown = null;
    await browser.waitUntil(
      async () => {
        shown = await browser.execute(
          () => document.getElementById("browserChoice")?.value ?? null,
        );
        return shown === "firefox";
      },
      {
        timeout: 15_000,
        timeoutMsg: `browser select never showed the saved choice (showed "${shown}")`,
      },
    );
    record("browser-choice", { stored: "firefox", shown });
  });

  it("accepts the OS Downloads folder outside the home directory", async function () {
    const outside = path.join(env.ROSI_E2E_PROFILE, "not-a-download-root");
    if (process.platform === "win32") {
      // Windows accepts any absolute path outside system folders.
      results.push({
        name: "xdg-download-dir",
        status: "skipped",
        reason: "windows",
      });
      this.skip();
    }
    // Negative control: an arbitrary folder outside HOME stays rejected.
    const rejected = await api("downloadVideo", {
      url: `${MEDIA}/clip-one.mp4`,
      outputPath: outside,
    });
    assert.equal(rejected.ok, false, "a path outside HOME was accepted");
    assert.equal(rejected.error?.code, "INVALID_PATH");
    if (process.platform !== "linux") {
      results.push({
        name: "xdg-download-dir",
        status: "skipped",
        reason: "linux only",
        rejectedOutside: true,
      });
      this.skip();
    }
    const xdg = env.ROSI_E2E_XDG_DOWNLOADS;
    const escape = await api("downloadVideo", {
      url: `${MEDIA}/clip-one.mp4`,
      outputPath: path.join(xdg, "..", "..", "not-a-download-root"),
    });
    assert.equal(escape.ok, false, "'..' escaped the XDG Downloads folder");
    const target = path.join(xdg, "sub folder");
    const url = `${MEDIA}/clip-three.mp4`;
    const started = await api("downloadVideo", { url, outputPath: target });
    assert.equal(started.ok, true, started.error?.message);
    const entry = await waitForActivity(
      (item) => item.url === url && item.outputPath?.startsWith(target),
      "download to the XDG Downloads folder never finished",
    );
    assert.equal(entry.outcome, "success", entry.error ?? entry.statusMessage);
    assert.equal(sha256File(entry.outputPath), FIXTURES["clip-three.mp4"]);
    await waitForIdle();
    record("xdg-download-dir", {
      rejectedOutside: true,
      rejectedEscape: true,
      file: path.basename(entry.outputPath),
    });
  });

  it("records lifetime statistics", async () => {
    const stats = await api("getStats");
    assert.ok(stats.successfulDownloads >= (HAS_FFMPEG ? 8 : 5));
    assert.ok(stats.cancelledDownloads >= 1);
    assert.ok(stats.totalBytesDownloaded > 0);
    record("stats", {
      successfulDownloads: stats.successfulDownloads,
      cancelledDownloads: stats.cancelledDownloads,
    });
  });

  it("clears download activity", async () => {
    const cleared = await api("clearDownloadActivity");
    assert.equal(cleared.ok, true);
    const activity = await api("getDownloadActivity");
    assert.deepEqual(activity.data, []);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, "download-activity.json"), "utf8"),
    );
    assert.deepEqual(onDisk, []);
    record("activity-clear");
  });

  it("flushes pending settings and closes the window", async () => {
    const before = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf8"),
    );
    const target = !before.notifications;
    // Flip a toggle (saved after a 300 ms debounce) and close immediately:
    // the close flow must flush it before the window goes away.
    await browser.execute((checked) => {
      const toggle = document.getElementById("notificationsToggle");
      toggle.checked = checked;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      void window.__TAURI__.window.getCurrentWindow().close();
    }, target);
    globalThis.rosiMainWindowClosed = true;
    const logFile = path.join(DATA_DIR, "logs", "rosi.log");
    await browser.waitUntil(
      () => {
        const log = fs.existsSync(logFile)
          ? fs.readFileSync(logFile, "utf8")
          : "";
        return log.includes("Main window closed.");
      },
      {
        timeout: 20_000,
        interval: 250,
        timeoutMsg: "main window never closed",
      },
    );
    const log = fs.readFileSync(logFile, "utf8");
    assert.match(log, /Settings flushed; closing main window\./);
    assert.doesNotMatch(log, /Timed out waiting for renderer settings flush/);
    const after = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf8"),
    );
    assert.equal(after.notifications, target);
    record("close-flow", { flushedSetting: "notifications" });
  });
});
