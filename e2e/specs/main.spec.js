import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { browser, $ } from "@wdio/globals";
import { snapshotDir } from "../helpers/legacy-v4.js";

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

const SCREENSHOT_DIR = env.ROSI_E2E_SCREENSHOTS;

function settingsOnDisk() {
  return JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf8"),
  );
}

async function waitForSavedSetting(key, value, timeoutMsg) {
  await browser.waitUntil(() => settingsOnDisk()[key] === value, {
    timeout: 10_000,
    interval: 200,
    timeoutMsg: `${timeoutMsg}: settings.json ${key}=${JSON.stringify(settingsOnDisk()[key])}`,
  });
}

async function waitForRenderedPreferences({ theme, flatUi }) {
  await browser.waitUntil(
    () =>
      browser.execute(
        ({ expectedTheme, expectedFlatUi }) => {
          const root = document.documentElement;
          const selectedTheme = document.getElementById("themeSelect")?.value;
          const flatUiToggle = document.getElementById("flatUiToggle");
          const renderedTheme = root.dataset.theme;
          const themeMatches =
            expectedTheme === undefined ||
            (selectedTheme === expectedTheme &&
              (expectedTheme === "system"
                ? renderedTheme === "light" || renderedTheme === "dark"
                : renderedTheme === expectedTheme));
          const flatUiMatches =
            expectedFlatUi === undefined ||
            (flatUiToggle?.checked === expectedFlatUi &&
              (root.dataset.flatUi === "true") === expectedFlatUi);
          return themeMatches && flatUiMatches;
        },
        { expectedTheme: theme, expectedFlatUi: flatUi },
      ),
    {
      timeout: 10_000,
      interval: 50,
      timeoutMsg: `renderer did not apply theme=${theme}, flatUi=${flatUi}`,
    },
  );
}

async function setRenderedPreferences({ theme, flatUi }) {
  if (flatUi !== undefined) {
    await setControlValue("flatUiToggle", flatUi);
    await waitForSavedSetting("flatUi", flatUi, "Flat UI was not saved");
  }
  if (theme !== undefined) {
    await setControlValue("themeSelect", theme);
    await waitForSavedSetting("theme", theme, `${theme} theme was not saved`);
  }
  await waitForRenderedPreferences({ theme, flatUi });
}

async function waitForStableSnapshot(
  readSnapshot,
  description,
  isReady = () => true,
) {
  let previous = null;
  let matchingSamples = 0;
  let current;
  let readyAndStable = false;
  try {
    await browser.waitUntil(
      async () => {
        current = await readSnapshot();
        const serialized = JSON.stringify(current);
        if (serialized === previous) matchingSamples += 1;
        else {
          previous = serialized;
          matchingSamples = 0;
        }
        readyAndStable = matchingSamples >= 2 && isReady(current);
        return readyAndStable;
      },
      {
        timeout: 10_000,
        interval: 100,
        timeoutMsg: `${description} did not settle across three samples`,
      },
    );
  } catch (error) {
    if (!String(error).includes("waitUntil condition timed out after")) {
      throw error;
    }
  }
  return { snapshot: current, readyAndStable };
}

/** Let CSS transitions (up to the 500 ms springy curve) finish. */
function settle(ms = 600) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickById(id) {
  await browser.execute((target) => {
    document.getElementById(target)?.click();
  }, id);
}

/** Dispatch a keydown the way a real key press reaches the renderer. */
async function pressKey(targetSelector, init) {
  await browser.execute(
    (selector, eventInit) => {
      const target = selector ? document.querySelector(selector) : document;
      if (target instanceof HTMLElement) target.focus();
      (target ?? document).dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...eventInit,
        }),
      );
    },
    targetSelector,
    init,
  );
}

async function setControlValue(id, value) {
  await browser.execute(
    (target, next) => {
      const control = document.getElementById(target);
      if (control.type === "checkbox") control.checked = next;
      else control.value = next;
      control.dispatchEvent(new Event("change", { bubbles: true }));
    },
    id,
    value,
  );
}

/** Which dock tab is selected and which panels are on screen. */
function dockState() {
  return browser.execute(() => {
    const tabs = [...document.querySelectorAll("[data-dock-tab]")];
    return {
      selected: tabs
        .filter((tab) => tab.getAttribute("aria-selected") === "true")
        .map((tab) => tab.dataset.dockTab),
      visiblePanels: tabs
        .map((tab) =>
          document.getElementById(tab.getAttribute("aria-controls")),
        )
        .filter(
          (panel) => panel && !panel.hidden && panel.offsetParent !== null,
        )
        .map((panel) => panel.id),
      focused: document.activeElement?.dataset?.dockTab ?? null,
      collapsed: document
        .getElementById("dock")
        .classList.contains("collapsed"),
    };
  });
}

/** Reload the webview and wait for the renderer to come back. */
async function reloadRenderer() {
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
    { timeout: 60_000, timeoutMsg: "renderer did not come back after reload" },
  );
}

/** Resize the window through Tauri and wait for layout to settle. */
async function resizeWindow(width, height) {
  const result = await browser.executeAsync(
    (w, h, done) => {
      const { getCurrentWindow } = window.__TAURI__.window;
      const { LogicalSize } = window.__TAURI__.dpi;
      getCurrentWindow()
        .setSize(new LogicalSize(w, h))
        .then(
          () => setTimeout(() => done(JSON.stringify({ ok: true })), 600),
          (error) => done(JSON.stringify({ error: String(error) })),
        );
    },
    width,
    height,
  );
  const parsed = JSON.parse(result);
  assert.equal(parsed.error, undefined, parsed.error);
}

/** Native window theme as Tauri reports it ("light", "dark" or null). */
async function windowTheme() {
  const result = await browser.executeAsync((done) => {
    window.__TAURI__.window
      .getCurrentWindow()
      .theme()
      .then(
        (theme) => done(JSON.stringify({ theme })),
        (error) => done(JSON.stringify({ error: String(error) })),
      );
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.error, undefined, parsed.error);
  return parsed.theme;
}

async function waitForWindowTheme(expected, timeoutMsg) {
  let last = null;
  await browser.waitUntil(
    async () => {
      last = await windowTheme();
      return last === expected;
    },
    {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: `${timeoutMsg}: window theme is ${last}`,
    },
  );
}

/** Computed scroll and glass styles of the sidebar and every scroller. */
function surfaceStyles() {
  return browser.execute(() => {
    // Resolve any CSS color (color-mix included) to its alpha through a canvas.
    const alpha = (color) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3] / 255;
    };
    const style = (selector) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element) : null;
    };
    const sidebar = style(".sidebar");
    const content = style(".sidebar-content");
    const version = document.querySelector(".version-info");
    const versionRect = version?.getBoundingClientRect();
    return {
      overscroll: Object.fromEntries(
        ["html", "body", ".main-stage", ".sidebar-content", ".dock-scroll"].map(
          (selector) => [
            selector,
            style(selector)?.overscrollBehaviorY ?? "missing",
          ],
        ),
      ),
      sidebarAlpha: alpha(sidebar.backgroundColor),
      sidebarFilter:
        sidebar.backdropFilter || sidebar.webkitBackdropFilter || "none",
      sidebarMask: content.maskImage || content.webkitMaskImage || "none",
      versionBottom: versionRect ? versionRect.bottom : null,
      versionHeight: versionRect ? versionRect.height : 0,
      viewportHeight: window.innerHeight,
    };
  });
}

/** Open or close the settings sidebar and wait for the slide to finish. */
async function setSidebarOpen(open) {
  await clickById(open ? "settingsBtn" : "closeSidebar");
  await browser.waitUntil(
    async () =>
      browser.execute(
        (want) =>
          document.getElementById("sidebar")?.classList.contains("open") ===
          want,
        open,
      ),
    {
      timeout: 10_000,
      timeoutMsg: `sidebar did not ${open ? "open" : "close"}`,
    },
  );
  await settle();
}

/**
 * Contrast of an element's text (or text stroke) against the colors painted
 * behind it, compositing translucent ancestor backgrounds over the page.
 */
function contrastOf(selector, { stroke = false } = {}) {
  return browser.execute(
    (target, useStroke) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const rgba = (color) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
      };
      const over = (top, bottom) => {
        const alpha = top[3] + bottom[3] * (1 - top[3]);
        if (alpha === 0) return [0, 0, 0, 0];
        return [
          ...[0, 1, 2].map(
            (i) =>
              (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / alpha,
          ),
          alpha,
        ];
      };
      const luminance = ([r, g, b]) => {
        const channel = (value) => {
          const c = value / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const element = document.querySelector(target);
      if (!element) return { error: `${target} missing` };
      const layers = [];
      const backgrounds = [];
      for (let node = element; node; node = node.parentElement) {
        const backgroundColor = getComputedStyle(node).backgroundColor;
        backgrounds.push(backgroundColor);
        layers.push(rgba(backgroundColor));
      }
      let background = [255, 255, 255, 1];
      for (const layer of layers.reverse())
        background = over(layer, background);
      const style = getComputedStyle(element);
      const ink = over(
        rgba(useStroke ? style.webkitTextStrokeColor : style.color),
        background,
      );
      const [light, dark] = [luminance(ink), luminance(background)].sort(
        (a, b) => b - a,
      );
      return {
        ratio: (light + 0.05) / (dark + 0.05),
        strokeWidth: parseFloat(style.webkitTextStrokeWidth) || 0,
        rendered: {
          theme: document.documentElement.dataset.theme ?? null,
          flatUi: document.documentElement.dataset.flatUi === "true",
          themePreference: document.getElementById("themeSelect")?.value,
          flatUiPreference: document.getElementById("flatUiToggle")?.checked,
          color: style.color,
          backgroundColor: style.backgroundColor,
          ancestorBackgrounds: backgrounds,
          opacity: style.opacity,
          disabled: "disabled" in element ? element.disabled : null,
        },
      };
    },
    selector,
    stroke,
  );
}

/** Settings keys the setup wizard manages; Skip resets exactly these. */
const WIZARD_KEYS = [
  "theme",
  "flatUi",
  "animateBackground",
  "askDownloadLocation",
  "downloadMode",
  "bestQuality",
  "audioOnly",
  "advancedOptions",
  "embedMetadata",
  "embedThumbnail",
  "sponsorblockRemove",
  "writeSubtitles",
  "subtitleLangs",
  "notifications",
  "checkUpdatesOnStartup",
];

/** Settings a failed test may have left changed; recovery restores these. */
const RECOVERABLE_SETTINGS = [
  "firstLaunch",
  "theme",
  "flatUi",
  "animateBackground",
  "showConsoleOutput",
  "dockTab",
  "dockCollapsed",
  "downloadMode",
  "downloadPresets",
  "askDownloadLocation",
  "downloadFolder",
  "audioFormat",
  "bestQuality",
  "audioOnly",
  "advancedOptions",
  "convertEnabled",
  "convertFormat",
  "keepOriginalAfterConvert",
  "gpuAcceleration",
  "gpuType",
  "hookBrowser",
  "browserChoice",
  "notifications",
  "checkUpdatesOnStartup",
  "updateChannel",
  "writeSubtitles",
  "subtitleLangs",
  "embedThumbnail",
  "embedMetadata",
  "sponsorblockRemove",
  "showTaskbarProgress",
];

/** Reload into the first-run wizard, optionally seeding settings first. */
async function openWizard(patch = {}) {
  const saved = await api("saveSettings", { ...patch, firstLaunch: true });
  assert.equal(saved.ok, true, saved.error?.message);
  await reloadRenderer();
  await browser.waitUntil(
    async () =>
      browser.execute(() =>
        document.getElementById("setup-wizard")?.classList.contains("active"),
      ),
    { timeout: 10_000, timeoutMsg: "setup wizard did not open" },
  );
}

/** Current wizard step index and whether the overlay is still open. */
function wizardState() {
  return browser.execute(() => {
    const overlay = document.getElementById("setup-wizard");
    const steps = [...overlay.querySelectorAll(".wizard-step")];
    return {
      open: overlay.classList.contains("active"),
      step: steps.findIndex((step) => step.classList.contains("active")),
      total: steps.length,
      skipHidden: document.getElementById("wizard-skip").hidden,
    };
  });
}

/** Check or select a wizard input and fire its change event. */
async function wizardPick(selector, checked = true) {
  await browser.execute(
    (target, value) => {
      const input = document.querySelector(target);
      input.checked = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    selector,
    checked,
  );
}

async function waitForWizardClosed() {
  await browser.waitUntil(async () => !(await wizardState()).open, {
    timeout: 10_000,
    timeoutMsg: "setup wizard did not close",
  });
}

/** Put the wizard-managed settings back and leave first-run mode. */
async function restoreWizardSettings(original) {
  const patch = Object.fromEntries(
    WIZARD_KEYS.map((key) => [key, original[key]]),
  );
  const saved = await api("saveSettings", { ...patch, firstLaunch: false });
  assert.equal(saved.ok, true, saved.error?.message);
  await reloadRenderer();
}

/**
 * Replace window.api methods with recorders for bridge calls that would
 * leave the app (browser, Finder, OS dialogs, notifications). Each stub
 * records its arguments and resolves to the given value.
 */
async function stubApi(stubs) {
  await browser.execute((map) => {
    window.__rosiStubs ??= { original: {}, calls: [] };
    for (const [name, value] of Object.entries(map)) {
      if (!(name in window.__rosiStubs.original)) {
        window.__rosiStubs.original[name] = window.api[name];
      }
      window.api[name] = (...args) => {
        window.__rosiStubs.calls.push({
          name,
          args: JSON.parse(JSON.stringify(args)),
        });
        return Promise.resolve(value);
      };
    }
  }, stubs);
}

/** Calls recorded by stubApi so far. */
function stubCalls(name) {
  return browser.execute(
    (target) =>
      (window.__rosiStubs?.calls ?? [])
        .filter((call) => !target || call.name === target)
        .map((call) => call.args),
    name ?? null,
  );
}

/** Put the real bridge methods back and return every recorded call. */
function restoreApi() {
  return browser.execute(() => {
    const stubs = window.__rosiStubs;
    if (!stubs) return [];
    Object.assign(window.api, stubs.original);
    window.__rosiStubs = undefined;
    return stubs.calls;
  });
}

/** The app's in-page modal: whether it is open, its title, and buttons. */
function modalState() {
  return browser.execute(() => {
    const modal = document.getElementById("app-modal");
    return {
      open: modal.classList.contains("active"),
      title: document.getElementById("modal-title").textContent,
      message: document.getElementById("modal-message").textContent,
      buttons: [...document.querySelectorAll("#modal-buttons button")].map(
        (button) => button.textContent.trim(),
      ),
    };
  });
}

async function waitForModal(open, timeoutMsg) {
  let state = null;
  await browser.waitUntil(
    async () => {
      state = await modalState();
      return state.open === open;
    },
    { timeout: 10_000, timeoutMsg },
  );
  return state;
}

async function clickModalButton(label) {
  const clicked = await browser.execute((text) => {
    const button = [...document.querySelectorAll("#modal-buttons button")].find(
      (candidate) => candidate.textContent.trim() === text,
    );
    button?.click();
    return Boolean(button);
  }, label);
  assert.ok(clicked, `modal has no "${label}" button`);
}

/** Type a URL, press Download, and wait for its new activity entry. */
async function downloadThroughUi(url, timeoutMsg) {
  await typeUrl(url);
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const button = document.getElementById("downloadBtn");
        return !button.disabled && !button.classList.contains("loading");
      }),
    { timeout: 15_000, timeoutMsg: "download button stayed disabled" },
  );
  const clickedAt = Date.now();
  await clickById("downloadBtn");
  const entry = await waitForActivity(
    (item) => item.url === url && item.completedAt >= clickedAt,
    timeoutMsg,
  );
  await waitForIdle();
  return entry;
}

/** Streams and tags of a media file, through the test FFprobe. */
function probeMedia(file) {
  const probe = spawnSync(
    FFPROBE,
    [
      "-v",
      "error",
      "-show_entries",
      "format_tags=title:stream=codec_type,codec_name:stream_disposition=attached_pic",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
  return JSON.parse(probe.stdout);
}

/** Record a scenario as skipped when FFmpeg fixtures are unavailable. */
function skipWithoutFfmpeg(context, name) {
  if (HAS_FFMPEG && FFPROBE) return false;
  results.push({ name, status: "skipped", reason: "no FFmpeg available" });
  context.skip();
  return true;
}

async function selectProfile(mode) {
  const ids = {
    compatible: "profileCompatibleBtn",
    "best-video": "profileBestVideoBtn",
    audio: "profileAudioBtn",
    custom: "profileCustomBtn",
  };
  await clickById(ids[mode]);
  await waitForSavedSetting(
    "downloadMode",
    mode,
    `${mode} profile was not saved`,
  );
}

/** Computed box-shadow values of the first element matching each selector. */
function boxShadows(selectors) {
  return browser.execute(
    (list) =>
      Object.fromEntries(
        list.map((selector) => {
          const element = document.querySelector(selector);
          return [
            selector,
            element ? getComputedStyle(element).boxShadow : "missing",
          ];
        }),
      ),
    selectors,
  );
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

  // One failed test must not strand the next one in its state (an open
  // sidebar leaves the page inert, a stray profile changes every download).
  // Settings return to how they were when the failed test started, stubs are
  // removed, and the renderer reloads to drop open dialogs and popovers.
  let settingsAtTestStart = null;
  beforeEach(() => {
    settingsAtTestStart = settingsOnDisk();
  });
  afterEach(async function () {
    if (this.currentTest?.state !== "failed" || !settingsAtTestStart) return;
    try {
      await browser.execute(() => {
        const stubs = window.__rosiStubs;
        if (stubs) Object.assign(window.api, stubs.original);
        window.__rosiStubs = undefined;
      });
      const patch = Object.fromEntries(
        RECOVERABLE_SETTINGS.filter((key) => key in settingsAtTestStart).map(
          (key) => [key, settingsAtTestStart[key]],
        ),
      );
      await api("saveSettings", patch);
      await reloadRenderer();
      await resizeWindow(1200, 900);
    } catch (error) {
      console.error(
        `[e2e] recovery after "${this.currentTest.title}" failed`,
        error,
      );
    }
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

  it("leaves ROSI 4 data alone when ROSI 5 settings exist", async () => {
    const seed = JSON.parse(env.ROSI_E2E_LEGACY_V4 || "{}");
    assert.ok(seed.dir, "ROSI_E2E_LEGACY_V4 is not set");
    assert.equal(
      fs.existsSync(path.join(DATA_DIR, "legacy-v4-import.json")),
      false,
      "import ran over existing ROSI 5 settings",
    );
    const settings = await api("getSettings");
    assert.equal(settings.theme, "system");
    assert.equal(settings.updateChannel, "auto");
    assert.equal(
      path.resolve(settings.downloadFolder),
      path.resolve(DOWNLOADS),
    );
    assert.equal((await api("getStats")).totalDownloads, 0);
    assert.deepEqual(await api("getQueue"), []);
    assert.deepEqual(snapshotDir(seed.dir), seed.snapshot, "ROSI 4 changed");
    record("legacy-v4-preserve", {
      covers: ["overwrites-v5", "mutates-v4"],
    });
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

  it("shows download profiles on the card and migrates beta settings", async () => {
    // The seed is a 5.0 beta profile with profiles off and downloadMode
    // "best-video"; it must come back as Compatible (same output as before).
    const loaded = await api("getSettings");
    assert.equal(loaded.downloadMode, "compatible");
    assert.equal(loaded.bestQuality, false);
    assert.equal("downloadProfilesEnabled" in loaded, false);
    assert.equal("downloadProfilesEnabled" in settingsOnDisk(), false);

    const card = await browser.execute(() => {
      const composer = document.getElementById("downloadProfilesComposer");
      const accentProbe = document.createElement("span");
      accentProbe.style.color = "var(--accent)";
      document.body.appendChild(accentProbe);
      const accent = getComputedStyle(accentProbe).color;
      accentProbe.remove();
      const selected = document.querySelector(
        '.download-profile-btn[aria-pressed="true"]',
      );
      const style = selected ? getComputedStyle(selected) : null;
      return {
        composerShown: Boolean(composer && composer.offsetParent !== null),
        hidden: composer?.classList.contains("hidden") ?? true,
        profiles: [...document.querySelectorAll(".download-profile-btn")].map(
          (button) => button.id,
        ),
        selected: selected?.id ?? null,
        summaryInComposer: Boolean(
          composer?.contains(document.getElementById("downloadOutputSummary")),
        ),
        formatsInComposer: Boolean(
          composer?.contains(document.getElementById("formatOptions")),
        ),
        accent,
        selectedBackground: style
          ? `${style.backgroundColor} ${style.backgroundImage}`
          : "",
        profileToggleGone: !document.getElementById("downloadProfilesToggle"),
      };
    });
    assert.equal(card.composerShown, true, "profile picker is not on screen");
    assert.equal(card.hidden, false);
    assert.equal(card.profileToggleGone, true);
    assert.deepEqual(card.profiles, [
      "profileCompatibleBtn",
      "profileBestVideoBtn",
      "profileAudioBtn",
      "profileCustomBtn",
    ]);
    assert.equal(card.selected, "profileCompatibleBtn");
    assert.equal(card.summaryInComposer, true);
    assert.equal(card.formatsInComposer, true);
    // The selected segment is raised neutral with an accent bar, never an
    // accent fill that competes with the Download button.
    assert.ok(
      !card.selectedBackground.includes(card.accent),
      `selected profile is filled with the accent: ${card.selectedBackground}`,
    );

    await clickById("profileAudioBtn");
    await waitForSavedSetting("downloadMode", "audio", "Audio was not saved");
    const audio = await browser.execute(() => ({
      formatShown: !document
        .getElementById("profileAudioFormatContainer")
        .classList.contains("hidden"),
      summary: document.getElementById("downloadOutputSummary").textContent,
    }));
    assert.equal(audio.formatShown, true);
    assert.match(audio.summary, /audio/i);
    assert.equal(settingsOnDisk().audioOnly, true);

    await clickById("profileCustomBtn");
    await waitForSavedSetting("downloadMode", "custom", "Custom was not saved");
    assert.equal(
      await browser.execute(() =>
        document.getElementById("formatOptions").classList.contains("visible"),
      ),
      true,
      "Custom did not reveal the format pickers",
    );

    await clickById("profileCompatibleBtn");
    await waitForSavedSetting(
      "downloadMode",
      "compatible",
      "Compatible was not saved",
    );
    const restored = await browser.execute(() => ({
      formats: document
        .getElementById("formatOptions")
        .classList.contains("visible"),
      saved: true,
    }));
    assert.equal(restored.formats, false);
    assert.equal(settingsOnDisk().bestQuality, false);

    // Saved presets live behind a menu button and close on Escape.
    await clickById("presetMenuBtn");
    const opened = await browser.execute(() => ({
      open: !document.getElementById("presetPopover").hidden,
      expanded: document
        .getElementById("presetMenuBtn")
        .getAttribute("aria-expanded"),
      focusInside: document
        .getElementById("presetPopover")
        .contains(document.activeElement),
    }));
    assert.deepEqual(opened, {
      open: true,
      expanded: "true",
      focusInside: true,
    });
    await pressKey("#presetNameInput", { key: "Escape" });
    const closed = await browser.execute(() => ({
      open: !document.getElementById("presetPopover").hidden,
      focus: document.activeElement?.id ?? null,
    }));
    assert.deepEqual(closed, { open: false, focus: "presetMenuBtn" });

    record("download-profiles", {
      migratedMode: loaded.downloadMode,
      selected: card.selected,
    });
  });

  it("lays out settings as equal-width rows with in-row help", async () => {
    await clickById("settingsBtn");
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          document.getElementById("sidebar")?.classList.contains("open"),
        ),
      { timeout: 10_000, timeoutMsg: "sidebar did not open" },
    );
    await settle();
    const layout = await browser.execute(() => {
      const sections = [...document.querySelectorAll(".settings-section")];
      return {
        sections: sections.map((section) => {
          const widths = [...section.querySelectorAll(".setting-row")]
            .filter((row) => row.offsetParent !== null)
            .map((row) => Math.round(row.getBoundingClientRect().width));
          return {
            title: section.querySelector(".settings-section-title")
              ?.textContent,
            widths,
            resetInHead: Boolean(
              section.querySelector(
                ".settings-section-head > .settings-section-reset",
              ),
            ),
          };
        }),
        helpInsideRow: [...document.querySelectorAll(".help-icon")].every(
          (help) => {
            const row = help.closest(".setting-row");
            if (!row) return false;
            const outer = row.getBoundingClientRect();
            const inner = help.getBoundingClientRect();
            return inner.left >= outer.left && inner.right <= outer.right;
          },
        ),
      };
    });
    for (const section of layout.sections) {
      assert.ok(section.widths.length > 0, `${section.title} has no rows`);
      const spread = Math.max(...section.widths) - Math.min(...section.widths);
      assert.ok(
        spread <= 1,
        `${section.title} rows differ in width: ${section.widths.join(", ")}`,
      );
      assert.equal(section.resetInHead, true, `${section.title} reset`);
    }
    assert.equal(
      layout.helpInsideRow,
      true,
      "a help badge sits outside its row",
    );
    await clickById("closeSidebar");
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => !document.getElementById("sidebar")?.classList.contains("open"),
        ),
      { timeout: 10_000, timeoutMsg: "sidebar did not close" },
    );
    record("settings-layout", {
      sections: layout.sections.map((section) => section.title),
    });
  });

  it("drops every raised shadow in Flat UI and restores them", async () => {
    const originalFlatUi = settingsOnDisk().flatUi === true;
    const selectors = [
      "#addToQueueBtn",
      "#changeDownloadFolderBtn",
      "#settingsBtn",
      '.download-profile-btn[aria-pressed="true"]',
      ".download-card",
      "#dock",
    ];
    try {
      await setRenderedPreferences({ flatUi: false });
      const raisedSample = await waitForStableSnapshot(
        () => boxShadows(selectors),
        "raised control shadows",
        (shadows) =>
          selectors.every(
            (selector) =>
              shadows[selector] !== "none" && shadows[selector] !== "missing",
          ),
      );
      const raised = raisedSample.snapshot;
      for (const selector of selectors) {
        assert.notEqual(raised[selector], "none", `${selector} is not raised`);
        assert.notEqual(raised[selector], "missing", `${selector} is missing`);
      }
      assert.ok(
        raisedSample.readyAndStable,
        `raised control shadows did not settle: ${JSON.stringify(raised)}`,
      );

      await setRenderedPreferences({ flatUi: true });
      const flatSample = await waitForStableSnapshot(
        () => boxShadows(selectors),
        "Flat UI control shadows",
        (shadows) =>
          selectors.every((selector) => shadows[selector] === "none"),
      );
      const flat = flatSample.snapshot;
      assert.equal(
        await browser.execute(() => document.documentElement.dataset.flatUi),
        "true",
      );
      for (const selector of selectors) {
        assert.equal(
          flat[selector],
          "none",
          `${selector} kept a shadow in Flat UI (settled=${flatSample.readyAndStable}, observed=${JSON.stringify(flat)})`,
        );
      }
      assert.ok(
        flatSample.readyAndStable,
        `Flat UI control shadows did not settle to none: ${JSON.stringify(flat)}`,
      );

      await setRenderedPreferences({ flatUi: false });
      const backSample = await waitForStableSnapshot(
        () => boxShadows(selectors),
        "restored control shadows",
        (shadows) =>
          selectors.every(
            (selector) =>
              shadows[selector] !== "none" && shadows[selector] !== "missing",
          ),
      );
      const back = backSample.snapshot;
      for (const selector of selectors) {
        assert.notEqual(
          back[selector],
          "none",
          `${selector} did not come back`,
        );
        assert.notEqual(back[selector], "missing", `${selector} is missing`);
      }
      assert.ok(
        backSample.readyAndStable,
        `restored control shadows did not settle: ${JSON.stringify(back)}`,
      );
    } finally {
      await setRenderedPreferences({ flatUi: originalFlatUi });
    }
    record("flat-ui-tokens", { checked: selectors.length });
  });

  it("keeps the native title bar on the rendered theme", async () => {
    const original = settingsOnDisk().theme;
    const seen = {};
    for (const [theme, expected] of [
      ["purple", "dark"],
      ["light", "light"],
      ["dark", "dark"],
    ]) {
      await setControlValue("themeSelect", theme);
      await waitForSavedSetting("theme", theme, `${theme} theme was not saved`);
      await waitForWindowTheme(expected, `${theme} theme left the title bar`);
      seen[theme] = expected;
    }
    // System resolves to the page's rendered theme, never to null.
    await setControlValue("themeSelect", "system");
    await waitForSavedSetting("theme", "system", "system theme was not saved");
    const rendered = await browser.execute(
      () => document.documentElement.dataset.theme,
    );
    const systemExpected = rendered === "light" ? "light" : "dark";
    await waitForWindowTheme(systemExpected, "system theme left the title bar");
    seen.system = systemExpected;
    await setControlValue("themeSelect", original);
    await waitForSavedSetting("theme", original, "theme was not restored");
    record("window-theme", { seen });
  });

  it("never rubber-bands the page or its scrollers", async () => {
    const styles = await surfaceStyles();
    for (const [selector, value] of Object.entries(styles.overscroll)) {
      assert.equal(
        value,
        "none",
        `${selector} overscroll-behavior is ${value}`,
      );
    }
    await resizeWindow(900, 560);
    const scroll = await browser.execute(() => {
      const root = document.scrollingElement;
      const stage = document.querySelector(".main-stage");
      // The dock flexes to fit, so force overflow with a temporary spacer.
      const spacer = document.createElement("div");
      spacer.style.cssText = "flex: 0 0 2000px";
      stage.append(spacer);
      root.scrollTop = 10_000;
      stage.scrollTop = stage.scrollHeight;
      const stageBottom = stage.scrollTop;
      const atBottom = {
        rootScroll: root.scrollTop,
        shellTop: document.querySelector(".app-shell").getBoundingClientRect()
          .top,
      };
      const range = {
        root: root.scrollHeight - root.clientHeight,
        stage: stage.scrollHeight - stage.clientHeight,
      };
      spacer.remove();
      stage.scrollTop = 0;
      return {
        rootRange: range.root,
        stageRange: range.stage,
        stageBottom,
        atBottom,
      };
    });
    await resizeWindow(1200, 900);
    assert.ok(scroll.rootRange <= 0, `page scrolls by ${scroll.rootRange}px`);
    assert.equal(scroll.atBottom.rootScroll, 0, "page scrolled as a whole");
    assert.equal(scroll.atBottom.shellTop, 0, "app shell moved off the top");
    assert.ok(scroll.stageRange > 0, "spacer did not overflow the main stage");
    assert.ok(scroll.stageBottom > 0, "main stage stopped scrolling");
    record("no-overscroll", {
      scrollers: Object.keys(styles.overscroll),
      stageRange: scroll.stageRange,
    });
  });

  it("frosts the floating sidebar and keeps Flat UI opaque", async () => {
    await setSidebarOpen(true);
    const floating = await surfaceStyles();
    assert.ok(
      floating.sidebarAlpha < 0.7,
      `floating sidebar alpha ${floating.sidebarAlpha} is too opaque`,
    );
    assert.match(floating.sidebarFilter, /blur\(/);
    assert.match(floating.sidebarFilter, /saturate\(/);
    assert.match(floating.sidebarMask, /linear-gradient/);
    await setSidebarOpen(false);

    await setControlValue("flatUiToggle", true);
    await waitForSavedSetting("flatUi", true, "Flat UI was not saved");
    await setSidebarOpen(true);
    const flat = await surfaceStyles();
    await setSidebarOpen(false);
    await setControlValue("flatUiToggle", false);
    await waitForSavedSetting("flatUi", false, "Flat UI off was not saved");

    assert.equal(flat.sidebarAlpha, 1, "Flat UI sidebar is see-through");
    assert.equal(flat.sidebarFilter, "none", "Flat UI sidebar still blurs");
    assert.ok(flat.versionHeight > 0, "version label is not rendered");
    assert.ok(
      flat.versionBottom <= flat.viewportHeight,
      `version label ends at ${flat.versionBottom}, past ${flat.viewportHeight}`,
    );
    record("sidebar-glass", {
      floatingAlpha: Number(floating.sidebarAlpha.toFixed(3)),
      floatingFilter: floating.sidebarFilter,
      flatVersionBottom: flat.versionBottom,
      viewportHeight: flat.viewportHeight,
    });
  });

  it("rejects private-network and non-http URLs in the backend", async () => {
    const privateHost = await api("getFormats", "http://192.168.1.10/video");
    assert.equal(privateHost.ok, false);
    assert.equal(privateHost.error.code, "INVALID_URL");
    const fileUrl = await api("addToQueue", ["file:///etc/passwd"]);
    assert.equal(fileUrl.ok, true);
    assert.equal(fileUrl.data.added, 0);
    assert.equal(fileUrl.data.skipped, 1);
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
    const publicDir = path.join(import.meta.dirname, "..", "..", "public");
    const assetsDir = path.join(import.meta.dirname, "..", "..", "assets");
    const componentLicenseSource = fs
      .readdirSync(assetsDir)
      .find((name) =>
        /^yt-dlp-(\d{4}\.\d{2}\.\d{2})-THIRD_PARTY_LICENSES\.txt$/.test(name),
      );
    assert.ok(
      componentLicenseSource,
      "versioned yt-dlp license source is missing",
    );
    const componentLicenseVersion = componentLicenseSource.match(
      /^yt-dlp-(\d{4}\.\d{2}\.\d{2})-THIRD_PARTY_LICENSES\.txt$/,
    )?.[1];
    assert.ok(componentLicenseVersion);
    const bundledNotices = JSON.parse(
      fs.readFileSync(path.join(publicDir, "bundled-licenses.json"), "utf8"),
    );
    const expectedComponentLabel = `yt-dlp bundled component licenses (${componentLicenseVersion})`;
    const componentNotice = bundledNotices.find(
      (notice) =>
        notice.label === expectedComponentLabel &&
        notice.file === "yt-dlp-third-party-licenses.txt",
    );
    assert.ok(
      componentNotice,
      "bundled license manifest is missing the version-matched yt-dlp component notice",
    );
    const expectedComponentText = fs.readFileSync(
      path.join(publicDir, componentNotice.file),
      "utf8",
    );
    assert.equal(
      expectedComponentText,
      fs.readFileSync(path.join(assetsDir, componentLicenseSource), "utf8"),
      "public component notice does not match its versioned source asset",
    );
    assert.equal(
      Buffer.byteLength(expectedComponentText),
      componentNotice.bytes,
      "bundled license manifest byte count does not match its component notice",
    );
    const expectedComponentPrefix = expectedComponentText.slice(0, 256);
    assert.match(
      expectedComponentPrefix,
      /^[\x00-\x7f]+$/,
      "component notice prefix must be ASCII-safe for WebDriver results",
    );

    await browser.execute(() =>
      document.getElementById("licensesLink")?.click(),
    );
    let counts = null;
    await browser.waitUntil(
      async () => {
        counts = await browser.execute(
          (expectedLabel, expectedPrefixLength) => {
            const frame = document.getElementById("licenses-frame");
            const doc = frame?.contentDocument;
            if (!doc) return null;
            const total = (id) =>
              Number(
                doc.querySelector(`#${id} .npm-total strong`)?.textContent ?? 0,
              );
            const bundledNotices = [
              ...doc.querySelectorAll("#bundled-licenses-container details"),
            ];
            const componentNotice = bundledNotices.find(
              (notice) =>
                notice.querySelector("summary")?.textContent === expectedLabel,
            );
            const componentText =
              componentNotice?.querySelector("pre")?.textContent ?? "";
            return {
              bundled: bundledNotices.length,
              bundledLabels: bundledNotices.map(
                (notice) => notice.querySelector("summary")?.textContent ?? "",
              ),
              componentTextLength: componentText.length,
              componentTextPrefix: componentText.slice(0, expectedPrefixLength),
              cargo: total("cargo-licenses-container"),
              npm: total("npm-licenses-container"),
              errors: doc.querySelectorAll(".npm-error").length,
            };
          },
          expectedComponentLabel,
          expectedComponentPrefix.length,
        );
        return Boolean(
          counts &&
          counts.bundled === bundledNotices.length &&
          counts.bundledLabels.includes(expectedComponentLabel) &&
          counts.componentTextLength === expectedComponentText.length &&
          counts.componentTextPrefix === expectedComponentPrefix &&
          counts.cargo &&
          counts.npm,
        );
      },
      { timeout: 30_000, timeoutMsg: "license notices did not render" },
    );
    assert.equal(counts.errors, 0);
    assert.equal(counts.bundled, bundledNotices.length);
    assert.deepEqual(
      counts.bundledLabels,
      bundledNotices.map((notice) => notice.label),
      "rendered bundled notice labels differ from the manifest",
    );
    assert.equal(counts.componentTextLength, expectedComponentText.length);
    assert.equal(counts.componentTextPrefix, expectedComponentPrefix);
    const renderedComponentTextJson = await browser.execute((expectedLabel) => {
      const frame = document.getElementById("licenses-frame");
      const details = [
        ...(frame?.contentDocument?.querySelectorAll(
          "#bundled-licenses-container details",
        ) ?? []),
      ].find(
        (notice) =>
          notice.querySelector("summary")?.textContent === expectedLabel,
      );
      const text = details?.querySelector("pre")?.textContent ?? null;
      return JSON.stringify(text).replace(
        /[\u0080-\uffff]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
    }, expectedComponentLabel);
    assert.equal(
      JSON.parse(renderedComponentTextJson),
      expectedComponentText,
      "the rendered yt-dlp component license differs from the packaged source",
    );
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

  it("switches Queue, Activity, and Console in one dock and remembers the tab", async () => {
    await browser.execute(() => window.rosiModules.dock.selectTab("queue"));
    let state = await dockState();
    assert.deepEqual(state.selected, ["queue"]);
    assert.deepEqual(state.visiblePanels, ["queueSection"]);

    // Roving focus: arrows wrap, Home/End jump, selection follows focus.
    await pressKey("#dockTabQueue", { key: "ArrowRight" });
    state = await dockState();
    assert.deepEqual(state.selected, ["activity"]);
    assert.deepEqual(state.visiblePanels, ["download-history"]);
    assert.equal(state.focused, "activity");
    await pressKey("#dockTabActivity", { key: "End" });
    assert.deepEqual((await dockState()).visiblePanels, ["console-section"]);
    await pressKey("#dockTabConsole", { key: "Home" });
    assert.deepEqual((await dockState()).selected, ["queue"]);
    await pressKey("#dockTabQueue", { key: "ArrowLeft" });
    assert.deepEqual((await dockState()).selected, ["console"]);

    // In a text field, macOS Option+digit types a character, so the dock
    // shortcut stands down there; other platforms still switch tabs.
    await pressKey("#url", { key: "1", code: "Digit1", altKey: true });
    assert.deepEqual(
      (await dockState()).selected,
      process.platform === "darwin" ? ["console"] : ["queue"],
    );

    // Alt+2 outside a text field shows Activity on every platform.
    await pressKey("body", { key: "2", code: "Digit2", altKey: true });
    state = await dockState();
    assert.deepEqual(state.selected, ["activity"]);
    await waitForSavedSetting("dockTab", "activity", "dock tab was not saved");

    await clickById("dockCollapseBtn");
    assert.equal((await dockState()).collapsed, true);
    await waitForSavedSetting("dockCollapsed", true, "collapse was not saved");
    await clickById("dockTabActivity");
    assert.equal((await dockState()).collapsed, false);
    await waitForSavedSetting("dockCollapsed", false, "expand was not saved");

    // Several links pasted into the card go to the queue, which comes to front.
    await api("clearQueue");
    await typeUrl(`${MEDIA}/clip-one.mp4?dock=1 ${MEDIA}/clip-two.mp4?dock=1`);
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          document
            .getElementById("downloadBtn")
            ?.textContent.includes("Add 2 to Queue"),
        ),
      { timeout: 10_000, timeoutMsg: "batch links were not detected" },
    );
    await clickById("downloadBtn");
    await browser.waitUntil(
      async () => (await dockState()).selected[0] === "queue",
      { timeout: 10_000, timeoutMsg: "queue tab did not come to front" },
    );
    assert.equal(
      await browser.execute(
        () => document.getElementById("queueCount").textContent,
      ),
      "2",
    );
    await api("clearQueue");
    await browser.execute(() => window.rosiModules.dock.selectTab("activity"));
    await waitForSavedSetting("dockTab", "activity", "dock tab was not saved");

    await reloadRenderer();
    await browser.waitUntil(
      async () => (await dockState()).selected[0] === "activity",
      { timeout: 15_000, timeoutMsg: "dock tab was not restored after reload" },
    );
    state = await dockState();
    assert.deepEqual(state.visiblePanels, ["download-history"]);
    await browser.execute(() => window.rosiModules.dock.selectTab("queue"));
    await waitForSavedSetting(
      "dockTab",
      "queue",
      "dock tab reset was not saved",
    );
    record("dock-tabs", { restored: "activity" });
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
      // Only the stage scrolls; the window chrome (header, tabs, footer) stays put.
      const pageScrolls = () =>
        document.scrollingElement.scrollHeight > window.innerHeight + 1;
      (async () => {
        const before = window.innerHeight;
        await win.setSize(new LogicalSize(900, 560));
        await settle();
        const out = {
          before,
          viewportHeight: window.innerHeight,
          resized: window.innerHeight !== before,
          downloadButton: reachable("#downloadBtn"),
          dockTabs: reachable("#dockTabQueue"),
          footer: reachable(".main-footer"),
          pageScrolls: pageScrolls(),
        };
        window.scrollTo(0, 0);
        await win.setSize(new LogicalSize(1200, 900));
        await settle();
        out.pageScrollsLarge = pageScrolls();
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
    assert.equal(sizes.dockTabs, true, "dock tabs unreachable");
    assert.equal(sizes.footer, true, "footer unreachable");
    assert.equal(sizes.pageScrolls, false, "the page scrolls at 900x560");
    assert.equal(sizes.pageScrollsLarge, false, "the page scrolls at 1200x900");
    record("small-window", sizes);
  });

  it("shrinks the dock to its empty message and grows it for content", async () => {
    const originalTab = await browser.execute(
      () => window.rosiModules.dock.getState().tab,
    );
    const measure = () =>
      browser.execute(() => {
        const dock = document.getElementById("dock");
        const stage = document.querySelector(".main-stage");
        return {
          empty: dock.classList.contains("is-empty"),
          height: dock.getBoundingClientRect().height,
          gapBelow:
            stage.getBoundingClientRect().bottom -
            dock.getBoundingClientRect().bottom,
        };
      });
    const waitForEmpty = async (want, timeoutMsg) => {
      await browser.waitUntil(async () => (await measure()).empty === want, {
        timeout: 10_000,
        timeoutMsg,
      });
      await settle();
      return measure();
    };

    await api("clearQueue");
    await browser.execute(() => window.rosiModules.dock.selectTab("queue"));
    const empty = await waitForEmpty(
      true,
      "empty queue did not shrink the dock",
    );
    assert.ok(
      empty.gapBelow > 150,
      `empty dock still fills the stage (${empty.gapBelow}px left)`,
    );

    const added = await api("addToQueue", [`${MEDIA}/clip-one.mp4?empty=1`]);
    assert.equal(added.ok, true, added.error?.message);
    const filled = await waitForEmpty(false, "queued item left the dock empty");
    assert.ok(
      filled.height > empty.height,
      `dock did not grow (${empty.height}px to ${filled.height}px)`,
    );
    assert.ok(filled.gapBelow < 40, `full dock left ${filled.gapBelow}px`);

    await api("clearQueue");
    await waitForEmpty(true, "cleared queue did not shrink the dock again");
    await browser.execute(() => window.rosiModules.dock.selectTab("activity"));
    const activity = await waitForEmpty(false, "activity with rows is empty");
    await browser.execute(
      (tab) => window.rosiModules.dock.selectTab(tab),
      originalTab,
    );
    record("dock-empty", {
      emptyHeight: Math.round(empty.height),
      filledHeight: Math.round(filled.height),
      activityHeight: Math.round(activity.height),
    });
  });

  it("keeps the save folder name visible on a long path", async () => {
    const folder = settingsOnDisk().downloadFolder;
    assert.ok(folder, "no download folder is saved");
    await resizeWindow(900, 560);
    const summary = await browser.execute(() => {
      const target = document.getElementById("downloadFolderSummary");
      const head = target.querySelector(".download-destination-head");
      const tail = target.querySelector(".download-destination-tail");
      const box = target.getBoundingClientRect();
      return {
        text: target.textContent,
        title: target.title,
        tail: tail?.textContent ?? null,
        tailClipped: tail ? tail.scrollWidth > tail.clientWidth : null,
        tailInside: tail
          ? tail.getBoundingClientRect().right <= box.right + 1
          : null,
        headClipped: head ? head.scrollWidth > head.clientWidth : null,
      };
    });
    await resizeWindow(1200, 900);
    const name = folder
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop();
    assert.equal(summary.text, folder, "summary lost part of the path");
    assert.equal(summary.title, folder);
    assert.equal(summary.tail, name);
    assert.equal(summary.tailClipped, false, "folder name was truncated");
    assert.equal(summary.tailInside, true, "folder name overflows the row");
    assert.equal(summary.headClipped, true, "parent folders did not truncate");
    record("save-path", { folderName: name, length: folder.length });
  });

  it("draws every icon from the bundled Lucide set", async () => {
    const icons = await browser.execute(() => {
      window.rosiModules.ui.showToast("Lucide check", { type: "success" });
      const svgs = [...document.querySelectorAll("svg")];
      return {
        placeholders: document.querySelectorAll("span[data-icon]").length,
        total: svgs.length,
        foreign: svgs
          .filter(
            (svg) =>
              !svg.dataset.icon || !svg.classList.contains("lucide-icon"),
          )
          .map((svg) => svg.outerHTML.slice(0, 80)),
        names: [...new Set(svgs.map((svg) => svg.dataset.icon))].sort(),
        settingsWidth: document
          .querySelector("#settingsBtn svg")
          ?.getBoundingClientRect().width,
        toastIcon:
          document.querySelector(".toast .toast-icon svg")?.dataset.icon ??
          null,
      };
    });
    assert.equal(icons.placeholders, 0, "icon placeholders were not replaced");
    assert.ok(icons.total >= 40, `only ${icons.total} icons rendered`);
    assert.deepEqual(icons.foreign, [], "inline SVGs outside the Lucide set");
    assert.equal(icons.settingsWidth, 22, "settings icon changed size");
    assert.equal(icons.toastIcon, "circle-check", "toast is missing its icon");
    const licenses = JSON.parse(
      fs.readFileSync(
        path.join(import.meta.dirname, "..", "..", "public", "licenses.json"),
        "utf8",
      ),
    );
    assert.ok(
      JSON.stringify(licenses).includes("lucide-static@"),
      "lucide-static is missing from the npm license notices",
    );
    record("lucide-icons", { count: icons.total, names: icons.names });
  });

  it("shows status emoji from the backend as icons", async () => {
    // A manual download clears the console and streams the backend's status
    // lines (which start with emoji) into it.
    const url = `${MEDIA}/clip-one.mp4?icons=1`;
    await typeUrl(url);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => !document.getElementById("downloadBtn")?.disabled,
        ),
      { timeout: 10_000, timeoutMsg: "download button stayed disabled" },
    );
    await clickById("downloadBtn");
    const entry = await waitForActivity(
      (item) => item.url === url,
      "status-icon download never finished",
    );
    assert.equal(entry.outcome, "success", entry.error ?? entry.statusMessage);

    // The button briefly offers the result, then goes back to Download.
    const buttonState = () =>
      browser.execute(() => {
        const button = document.getElementById("downloadBtn");
        const svg = button.querySelector("svg");
        return {
          icon: svg?.dataset.icon ?? null,
          lucide: svg?.classList.contains("lucide-icon") ?? false,
          label: button.textContent.trim(),
        };
      });
    let finished = null;
    await browser.waitUntil(
      async () => {
        finished = await buttonState();
        return ["folder-open", "check"].includes(finished.icon);
      },
      { timeout: 5_000, timeoutMsg: "download button never showed the result" },
    );
    assert.equal(
      finished.label,
      finished.icon === "folder-open"
        ? "Open File Location"
        : "Download complete",
    );
    let restored = null;
    await browser.waitUntil(
      async () => {
        restored = await buttonState();
        return restored.icon === "download";
      },
      { timeout: 12_000, timeoutMsg: "download button never came back" },
    );
    assert.equal(restored.lucide, true, "restored button lost its Lucide icon");
    assert.equal(restored.label, "Download");
    await waitForIdle();
    await typeUrl("");
    const result = await browser.execute(() => {
      const pictographic = /\p{Extended_Pictographic}/u;
      const probe = document.createElement("span");
      window.rosiModules.icons.renderStatus(probe, "\u274C Download failed.");
      const output = document.getElementById("output");
      return {
        probeIcon: probe.querySelector("svg")?.dataset.icon ?? null,
        probeText: probe.textContent,
        consoleLines: output.querySelectorAll(".console-line").length,
        consoleIcons: output.querySelectorAll(".console-line svg[data-icon]")
          .length,
        consoleEmoji: [...output.querySelectorAll(".console-line")]
          .map((line) => line.textContent)
          .filter((line) => pictographic.test(line))
          .slice(0, 5),
        pageEmoji: [...document.body.querySelectorAll("*")]
          .filter(
            (el) =>
              el.childElementCount === 0 && pictographic.test(el.textContent),
          )
          .map((el) => el.textContent.slice(0, 60)),
      };
    });
    assert.equal(result.probeIcon, "circle-x");
    assert.equal(result.probeText, "Download failed.");
    assert.ok(result.consoleLines > 0, "console has no lines after downloads");
    assert.ok(result.consoleIcons > 0, "no console status line has an icon");
    assert.deepEqual(result.consoleEmoji, [], "console still shows emoji");
    assert.deepEqual(result.pageEmoji, [], "emoji left in the page");
    record("status-icons", {
      button: [finished.icon, restored.icon],
      consoleLines: result.consoleLines,
      consoleIcons: result.consoleIcons,
    });
  });

  it("keeps console lines copyable, capped, and clearable", async () => {
    const originalTab = await browser.execute(
      () => window.rosiModules.dock.getState().tab,
    );
    await browser.execute(() => window.rosiModules.dock.selectTab("console"));
    const result = await browser.execute(() => {
      const output = document.getElementById("output");
      const lines = () =>
        [...output.querySelectorAll(".console-line")].map(
          (line) => line.textContent,
        );
      // Copying the log must keep one line per console line.
      const copied = output.textContent.split("\n").slice(0, -1);
      const before = { lines: lines(), copied };
      const bulk = Array.from({ length: 4100 }, (_, i) => `bulk line ${i}`);
      window.rosiModules.ui.appendConsoleOutput(output, bulk.join("\n"));
      const after = lines();
      return {
        before,
        count: after.length,
        first: after[0],
        last: after[after.length - 1],
        newlines: output.textContent.split("\n").length - 1,
      };
    });
    assert.ok(
      result.before.lines.length > 0,
      "console was empty before the cap test",
    );
    assert.deepEqual(
      result.before.copied,
      result.before.lines,
      "copied text lost lines",
    );
    assert.equal(result.count, 4000, "console is not capped at 4000 lines");
    assert.equal(
      result.first,
      "bulk line 100",
      "the oldest lines were not dropped",
    );
    assert.equal(result.last, "bulk line 4099");
    assert.equal(result.newlines, 4000, "line breaks drifted from line count");

    await clickById("clearConsole");
    await settle();
    const cleared = await browser.execute(() => ({
      nodes: document.getElementById("output").childNodes.length,
      dockEmpty: document.getElementById("dock").classList.contains("is-empty"),
    }));
    assert.equal(cleared.nodes, 0, "Clear left console content behind");
    assert.equal(
      cleared.dockEmpty,
      true,
      "cleared console did not shrink the dock",
    );
    await browser.execute(
      (tab) => window.rosiModules.dock.selectTab(tab),
      originalTab,
    );
    record("console-log", { capped: result.count, firstKept: result.first });
  });

  it("keeps Activity row actions as quiet icon buttons", async () => {
    await browser.execute(() => {
      window.rosiModules.dock.selectTab("activity");
      document.activeElement?.blur();
    });
    await settle();
    const rest = await browser.execute(() => {
      const row = document.querySelector("#history-list .history-item");
      const buttons = [...row.querySelectorAll(".history-item-actions button")];
      return {
        buttons: buttons.map((button) => ({
          icon: button.classList.contains("btn--icon"),
          label: button.getAttribute("aria-label"),
          title: button.title,
          svg: button.querySelector("svg")?.dataset.icon ?? null,
          text: button.textContent.trim(),
        })),
        opacity: Number(getComputedStyle(buttons[0]).opacity),
      };
    });
    assert.ok(rest.buttons.length >= 2, "activity row has too few actions");
    for (const button of rest.buttons) {
      assert.ok(button.icon, `${button.title} is not an icon button`);
      assert.ok(button.label, `${button.title} has no aria-label`);
      assert.ok(button.title, "an action has no tooltip");
      assert.ok(button.svg, `${button.title} has no icon`);
      assert.equal(button.text, "", `${button.title} still shows text`);
    }
    await browser.execute(() =>
      document
        .querySelector(
          "#history-list .history-item .history-item-actions button",
        )
        .focus(),
    );
    await settle();
    const focused = await browser.execute(() => {
      const button = document.querySelector(
        "#history-list .history-item .history-item-actions button",
      );
      return {
        opacity: Number(getComputedStyle(button).opacity),
        active: document.activeElement === button,
        windowFocused: document.hasFocus(),
      };
    });
    assert.ok(rest.opacity < 1, `actions are loud at rest (${rest.opacity})`);
    // WebKit can report the button as active while the embedded window is not
    // focused; CSS :focus-within is unavailable in that harness state.
    if (focused.windowFocused) {
      assert.equal(focused.opacity, 1, "focused row did not raise its actions");
    } else {
      assert.equal(
        focused.active,
        true,
        "focused action did not receive focus",
      );
    }
    record("activity-actions", {
      actions: rest.buttons.map((button) => button.svg),
      restOpacity: rest.opacity,
    });
  });

  it("runs each Activity row action", async () => {
    await browser.execute(() => window.rosiModules.dock.selectTab("activity"));
    await settle();
    const activity = (await api("getDownloadActivity")).data;
    const target = activity.find(
      (item) => item.outcome === "success" && item.outputPath,
    );
    assert.ok(target, "no finished download to act on");
    // Rows render newest first, in the same order as the activity log.
    const rowIndex = activity.indexOf(target);
    const clickAction = (icon) =>
      browser.execute(
        (index, name) => {
          const row = document.querySelectorAll("#history-list .history-item")[
            index
          ];
          const button = row
            ?.querySelector(`.history-item-actions svg[data-icon="${name}"]`)
            ?.closest("button");
          button?.click();
          return Boolean(button);
        },
        rowIndex,
        icon,
      );
    const lastToast = () =>
      browser.execute(
        () =>
          [...document.querySelectorAll(".toast .toast-message")].pop()
            ?.textContent ?? null,
      );

    // Open folder: stub the bridge so the test does not open Finder.
    await browser.execute(() => {
      window.__rosiOpened = [];
      window.__rosiOpenFileLocation = window.api.openFileLocation;
      window.api.openFileLocation = async (filePath) => {
        window.__rosiOpened.push(filePath);
        return { ok: true };
      };
    });
    assert.ok(
      await clickAction("folder-open"),
      "row has no Open folder action",
    );
    await settle(300);
    const opened = await browser.execute(() => {
      window.api.openFileLocation = window.__rosiOpenFileLocation;
      return window.__rosiOpened;
    });
    assert.deepEqual(
      opened,
      [target.outputPath],
      "Open folder used the wrong path",
    );

    // Copy source: the real clipboard, read back through the OS on macOS.
    assert.ok(await clickAction("link"), "row has no Copy source action");
    let toast = null;
    await browser.waitUntil(
      async () => {
        toast = await lastToast();
        return /source link/i.test(toast ?? "");
      },
      { timeout: 5_000, timeoutMsg: "Copy source showed no toast" },
    );
    assert.equal(toast, "Source link copied.", `copy failed: ${toast}`);
    if (process.platform === "darwin") {
      const pasted = spawnSync("pbpaste", { encoding: "utf8" }).stdout;
      assert.equal(
        pasted,
        target.url,
        "clipboard does not hold the source URL",
      );
    }

    // Download again: a new activity entry for the same URL.
    const clickedAt = Date.now();
    assert.ok(
      await clickAction("rotate-ccw"),
      "row has no Download again action",
    );
    const replay = await waitForActivity(
      (item) => item.url === target.url && item.completedAt >= clickedAt,
      "Download again never produced a new download",
    );
    assert.equal(
      replay.outcome,
      "success",
      replay.error ?? replay.statusMessage,
    );
    await waitForIdle();
    record("activity-action-clicks", {
      opened: path.basename(target.outputPath),
      replayed: path.basename(replay.outputPath ?? ""),
    });
  });

  it("keeps the logo and disabled buttons readable in every theme", async () => {
    const original = settingsOnDisk();
    const originalTheme = original.theme ?? "system";
    const originalFlatUi = original.flatUi === true;
    const seen = {};
    try {
      await typeUrl("");
      for (const [theme, flat] of ["light", "dark", "purple"].flatMap(
        (name) => [
          [name, false],
          [name, true],
        ],
      )) {
        await setRenderedPreferences({ theme, flatUi: flat });
        const disabled = await browser.execute(() => {
          const button = document.getElementById("downloadBtn");
          return button.disabled || button.classList.contains("is-disabled");
        });
        assert.ok(disabled, "download button is enabled with an empty URL");
        const buttonSample = await waitForStableSnapshot(
          () => contrastOf("#downloadBtn"),
          `${theme} disabled download contrast`,
          (sample) =>
            sample.rendered.theme === theme &&
            sample.rendered.flatUi === flat &&
            sample.ratio >= 3,
        );
        const button = buttonSample.snapshot;
        assert.equal(
          button.rendered.theme,
          theme,
          `disabled button sampled under ${button.rendered.theme} instead of ${theme}`,
        );
        assert.equal(
          button.rendered.flatUi,
          flat,
          `disabled button sampled with flatUi=${button.rendered.flatUi} instead of ${flat}`,
        );
        assert.ok(
          button.ratio >= 3,
          `${theme} disabled download text contrast ${button.ratio.toFixed(2)}; settled=${buttonSample.readyAndStable}; rendered=${JSON.stringify(button.rendered)}`,
        );
        assert.ok(
          buttonSample.readyAndStable,
          `${theme} disabled download contrast did not settle: ${JSON.stringify(button)}`,
        );
        const logoSample = await waitForStableSnapshot(
          () =>
            contrastOf(".app-name .char-white", {
              stroke: theme === "light",
            }),
          `${theme} logo contrast`,
          (sample) =>
            sample.rendered.theme === theme &&
            sample.rendered.flatUi === flat &&
            sample.ratio >= 3,
        );
        const logo = logoSample.snapshot;
        if (theme === "light") {
          assert.ok(logo.strokeWidth > 0, "light logo letters have no outline");
        }
        assert.ok(
          logo.ratio >= 3,
          `${theme} logo contrast ${logo.ratio.toFixed(2)}; settled=${logoSample.readyAndStable}; rendered=${JSON.stringify(logo.rendered)}`,
        );
        assert.ok(
          logoSample.readyAndStable,
          `${theme} logo contrast did not settle: ${JSON.stringify(logo)}`,
        );
        seen[`${theme}${flat ? "-flat" : ""}`] = {
          button: Number(button.ratio.toFixed(2)),
          logo: Number(logo.ratio.toFixed(2)),
        };
      }
    } finally {
      await setRenderedPreferences({
        theme: originalTheme,
        flatUi: originalFlatUi,
      });
    }
    record("theme-contrast", seen);
  });

  it("walks the setup wizard and saves every choice", async () => {
    const original = settingsOnDisk();
    await openWizard({
      theme: "system",
      flatUi: false,
      animateBackground: false,
    });
    let state = await wizardState();
    assert.equal(state.step, 0);
    assert.equal(state.total, 7, "wizard step count changed");
    assert.equal(state.skipHidden, false, "Skip is missing on the first step");
    const next = async () => {
      await clickById("wizard-next");
      await settle(200);
      return wizardState();
    };
    const shots = [];
    const shoot = async (name) => {
      if (!SCREENSHOT_DIR) return;
      await settle();
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      const file = path.join(SCREENSHOT_DIR, `${name}.png`);
      await browser.saveScreenshot(file);
      shots.push({ name, sha256: sha256File(file) });
    };
    await shoot("wizard-welcome");

    state = await next();
    assert.equal(state.step, 1);
    await wizardPick('input[name="wizard-theme"][value="purple"]');
    await wizardPick("#wizard-flat-ui");
    await wizardPick("#wizard-animate-bg");
    const preview = await browser.execute(() => ({
      theme: document.documentElement.dataset.theme,
      flat: document.documentElement.dataset.flatUi ?? null,
      animated: document.body.classList.contains("animate-bg"),
    }));
    assert.deepEqual(preview, {
      theme: "purple",
      flat: "true",
      animated: true,
    });
    await wizardPick("#wizard-flat-ui", false);
    await shoot("wizard-look");
    await wizardPick("#wizard-flat-ui");

    state = await next();
    assert.equal(state.step, 2);
    await wizardPick('input[name="wizard-profile"][value="audio"]');

    state = await next();
    assert.equal(state.step, 3);
    for (const id of [
      "#wizard-embed-metadata",
      "#wizard-embed-thumbnail",
      "#wizard-sponsorblock",
      "#wizard-subtitles",
    ]) {
      await wizardPick(id);
    }
    const setLangs = (value) =>
      browser.execute((text) => {
        const input = document.getElementById("wizard-subtitle-langs");
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
    await setLangs("en es!");
    state = await next();
    assert.equal(state.step, 3, "invalid subtitle languages left the step");
    const langError = await browser.execute(
      () => document.getElementById("wizard-subtitle-langs-error").textContent,
    );
    assert.ok(langError, "no error for invalid subtitle languages");
    await setLangs("en,es");
    await shoot("wizard-extras");

    // Back and forward again keeps every choice made so far.
    await clickById("wizard-back");
    await clickById("wizard-back");
    await settle(200);
    assert.equal((await wizardState()).step, 1);
    await next();
    state = await next();
    assert.equal(state.step, 3);
    const kept = await browser.execute(() => ({
      theme: document.querySelector('input[name="wizard-theme"]:checked')
        ?.value,
      profile: document.querySelector('input[name="wizard-profile"]:checked')
        ?.value,
      metadata: document.getElementById("wizard-embed-metadata").checked,
      subtitles: document.getElementById("wizard-subtitles").checked,
      langs: document.getElementById("wizard-subtitle-langs").value,
    }));
    assert.deepEqual(kept, {
      theme: "purple",
      profile: "audio",
      metadata: true,
      subtitles: true,
      langs: "en,es",
    });

    state = await next();
    assert.equal(state.step, 4);
    let deno = null;
    await browser.waitUntil(
      async () => {
        deno = await browser.execute(() => {
          const status = document.getElementById("wizard-deno-status");
          const action = document.getElementById("wizard-deno-action");
          return {
            state: status.dataset.state,
            text: status.textContent.trim(),
            icon: status.querySelector("svg")?.dataset.icon ?? null,
            action: action.hidden ? null : action.textContent,
          };
        });
        return deno.state && deno.state !== "checking";
      },
      { timeout: 15_000, timeoutMsg: "Deno check never finished" },
    );
    assert.ok(["installed", "missing", "error"].includes(deno.state));
    assert.ok(deno.icon, "Deno status has no icon");
    if (deno.state !== "installed") {
      assert.ok(deno.action, "missing Deno offers no next step");
    }
    await shoot("wizard-deno");

    state = await next();
    assert.equal(state.step, 5);
    await wizardPick("#wizard-notifications", false);
    state = await next();
    assert.equal(state.step, 6);
    assert.equal(state.skipHidden, true, "Skip still shows on the last step");
    await clickById("wizard-next");
    await waitForWizardClosed();

    await waitForSavedSetting("firstLaunch", false, "wizard did not finish");
    const saved = settingsOnDisk();
    const expected = {
      theme: "purple",
      flatUi: true,
      animateBackground: true,
      downloadMode: "audio",
      audioOnly: true,
      embedMetadata: true,
      embedThumbnail: true,
      sponsorblockRemove: true,
      writeSubtitles: true,
      subtitleLangs: "en,es",
      notifications: false,
    };
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(saved[key], value, `wizard saved ${key}=${saved[key]}`);
    }
    await settle(1500);
    const followUp = await browser.execute(
      () =>
        document.querySelector(".modal-overlay.active, .modal.active")
          ?.textContent ?? null,
    );
    assert.equal(followUp, null, `a prompt followed the wizard: ${followUp}`);

    await restoreWizardSettings(original);
    record("setup-wizard", { steps: state.total, deno: deno.state, shots });
  });

  it("skips the setup wizard straight to the defaults", async () => {
    const original = settingsOnDisk();
    const defaults = (await api("getDefaultSettings")).data;
    await openWizard({
      theme: "dark",
      flatUi: true,
      animateBackground: false,
      embedMetadata: !defaults.embedMetadata,
      sponsorblockRemove: !defaults.sponsorblockRemove,
      notifications: !defaults.notifications,
      downloadMode: "best-video",
    });
    // Walk partway and change things, then skip: none of it may stick.
    await clickById("wizard-next");
    await wizardPick('input[name="wizard-theme"][value="light"]');
    await clickById("wizard-skip");
    await waitForWizardClosed();
    await waitForSavedSetting(
      "firstLaunch",
      false,
      "skip did not finish setup",
    );
    const saved = settingsOnDisk();
    const mismatched = WIZARD_KEYS.filter(
      (key) => JSON.stringify(saved[key]) !== JSON.stringify(defaults[key]),
    ).map(
      (key) =>
        `${key}: ${JSON.stringify(saved[key])} != ${JSON.stringify(defaults[key])}`,
    );
    assert.deepEqual(mismatched, [], "skip left non-default settings");
    assert.equal(
      saved.downloadFolder,
      original.downloadFolder,
      "skip moved the folder",
    );
    const applied = await browser.execute(() => ({
      flat: document.documentElement.dataset.flatUi ?? null,
    }));
    assert.equal(applied.flat, defaults.flatUi ? "true" : null);

    await restoreWizardSettings(original);
    record("setup-wizard-skip", { keys: WIZARD_KEYS.length });
  });

  it("asks before Escape skips setup, then applies the defaults", async () => {
    const original = settingsOnDisk();
    const defaults = (await api("getDefaultSettings")).data;
    await openWizard({ theme: "dark", embedMetadata: !defaults.embedMetadata });
    await clickById("wizard-next");
    await wizardPick('input[name="wizard-theme"][value="light"]');
    const modalState = () =>
      browser.execute(() => {
        const modal = document.getElementById("app-modal");
        return {
          open: modal.classList.contains("active"),
          title: document.getElementById("modal-title").textContent,
          buttons: [...document.querySelectorAll("#modal-buttons button")].map(
            (button) => button.textContent.trim(),
          ),
        };
      });
    const pressEscape = () => pressKey("#wizard-next", { key: "Escape" });
    const clickModal = (label) =>
      browser.execute((text) => {
        [...document.querySelectorAll("#modal-buttons button")]
          .find((button) => button.textContent.trim() === text)
          ?.click();
      }, label);
    const waitModal = (open) =>
      browser.waitUntil(async () => (await modalState()).open === open, {
        timeout: 5_000,
        timeoutMsg: `skip prompt did not ${open ? "open" : "close"}`,
      });

    await pressEscape();
    await waitModal(true);
    const prompt = await modalState();
    assert.equal(prompt.title, "Skip setup?");
    assert.deepEqual(prompt.buttons, ["Keep setting up", "Skip setup"]);
    await clickModal("Keep setting up");
    await waitModal(false);
    const kept = await wizardState();
    assert.equal(kept.open, true, "Keep setting up closed the wizard");
    assert.equal(kept.step, 1, "Keep setting up changed the step");
    assert.equal(
      await browser.execute(
        () =>
          document.querySelector('input[name="wizard-theme"]:checked')?.value,
      ),
      "light",
      "Keep setting up lost the theme choice",
    );

    await pressEscape();
    await waitModal(true);
    await clickModal("Skip setup");
    await waitForWizardClosed();
    await waitForSavedSetting(
      "firstLaunch",
      false,
      "Escape skip did not finish setup",
    );
    const saved = settingsOnDisk();
    const mismatched = WIZARD_KEYS.filter(
      (key) => JSON.stringify(saved[key]) !== JSON.stringify(defaults[key]),
    );
    assert.deepEqual(mismatched, [], "Escape skip kept wizard choices");
    await restoreWizardSettings(original);
    record("setup-wizard-escape");
  });

  it("fits every wizard step in the smallest window", async () => {
    const original = settingsOnDisk();
    await resizeWindow(900, 560);
    await openWizard();
    const steps = [];
    for (let step = 0; step < 7; step += 1) {
      if (step === 3) await wizardPick("#wizard-subtitles");
      const fit = await browser.execute(() => {
        const inView = (element) => {
          const box = element.getBoundingClientRect();
          return (
            box.top >= 0 && box.bottom <= window.innerHeight && box.height > 0
          );
        };
        const active = document.querySelector(".wizard-step.active");
        // The last control on the step must be reachable by scrolling it.
        const controls = [
          ...active.querySelectorAll("input, button, select"),
        ].filter((control) => control.getClientRects().length > 0);
        const lastControl = controls[controls.length - 1];
        lastControl?.scrollIntoView({ block: "nearest" });
        return {
          card: inView(document.querySelector(".wizard-card")),
          next: inView(document.getElementById("wizard-next")),
          skip:
            document.getElementById("wizard-skip").hidden ||
            inView(document.getElementById("wizard-skip")),
          lastControl: lastControl ? inView(lastControl) : true,
        };
      });
      steps.push(fit);
      assert.deepEqual(
        fit,
        { card: true, next: true, skip: true, lastControl: true },
        `step ${step} does not fit 900x560`,
      );
      if (step < 6) await clickById("wizard-next");
      await settle(200);
    }
    await clickById("wizard-next");
    await waitForWizardClosed();
    await resizeWindow(1200, 900);
    await restoreWizardSettings(original);
    record("setup-wizard-small", { steps: steps.length });
  });

  it("guides every Deno outcome in the wizard", async () => {
    const original = settingsOnDisk();
    // The Deno check looks in fixed system paths, so the page-side bridge is
    // stubbed to drive each outcome; nothing is installed for real.
    const stubDeno = (mode) =>
      browser.execute((how) => {
        window.__rosiDeno = { installs: 0, external: [] };
        if (how.linux) {
          Object.defineProperty(navigator, "userAgent", {
            configurable: true,
            get: () => "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15",
          });
        }
        window.api.checkDenoInstalled = async () => {
          if (how.check === "throw") throw new Error("lookup failed");
          return false;
        };
        window.api.installDeno = async () => {
          window.__rosiDeno.installs += 1;
          const next = how.installs.shift();
          if (next === "fail") throw new Error("winget exploded");
          return next === "cancel" ? { cancelled: true } : { success: true };
        };
        window.api.openExternal = async (url) => {
          window.__rosiDeno.external.push(url);
        };
      }, mode);
    const denoView = () =>
      browser.execute(() => {
        const status = document.getElementById("wizard-deno-status");
        const action = document.getElementById("wizard-deno-action");
        const note = document.querySelector(
          '[data-wizard-step="deno"] .wizard-note',
        );
        return {
          state: status.dataset.state ?? null,
          text: status.textContent.trim(),
          icon: status.querySelector("svg")?.dataset.icon ?? null,
          action: action.hidden ? null : action.textContent.trim(),
          note: note ? getComputedStyle(note).display !== "none" : false,
          calls: window.__rosiDeno,
        };
      });
    const waitDeno = async (state) => {
      let view = null;
      await browser.waitUntil(
        async () => {
          view = await denoView();
          return view.state === state;
        },
        { timeout: 5_000, timeoutMsg: `Deno step never reached ${state}` },
      );
      return view;
    };
    const toDenoStep = async (mode) => {
      await openWizard();
      await stubDeno(mode);
      for (let i = 0; i < 4; i += 1) await clickById("wizard-next");
      assert.equal((await wizardState()).step, 4);
    };
    const leave = async () => {
      await clickById("wizard-skip");
      await waitForWizardClosed();
    };
    const seen = {};

    // Missing on macOS/Windows: cancel keeps the offer, then install succeeds.
    await toDenoStep({ installs: ["cancel", "ok"] });
    let view = await waitDeno("missing");
    assert.equal(view.icon, "triangle-alert");
    assert.equal(view.action, "Install Deno");
    assert.equal(view.note, true, "optional note hidden while Deno is missing");
    await clickById("wizard-deno-action");
    view = await waitDeno("missing");
    assert.equal(view.calls.installs, 1);
    assert.equal(
      view.action,
      "Install Deno",
      "cancel removed the Install button",
    );
    await clickById("wizard-deno-action");
    view = await waitDeno("installed");
    assert.equal(view.icon, "circle-check");
    assert.equal(view.action, null, "Install button stayed after success");
    assert.equal(view.note, false, "optional note shown after install");
    assert.match(view.text, /restart/i);
    seen.install = view.state;
    await leave();

    // Install failure points to the Deno website.
    await toDenoStep({ installs: ["fail"] });
    await waitDeno("missing");
    await clickById("wizard-deno-action");
    view = await waitDeno("error");
    assert.equal(view.icon, "circle-x");
    assert.match(view.text, /winget exploded/);
    assert.equal(view.action, "Open Deno website");
    await clickById("wizard-deno-action");
    await settle(200);
    assert.deepEqual((await denoView()).calls.external, ["https://deno.land"]);
    seen.installFailure = view.state;
    await leave();

    // A failed lookup still offers the instructions.
    await toDenoStep({ check: "throw", installs: [] });
    view = await waitDeno("error");
    assert.equal(view.action, "Open install instructions");
    seen.checkFailure = view.state;
    await leave();

    // Linux has no automatic install: it links to the instructions.
    await toDenoStep({ linux: true, installs: [] });
    view = await waitDeno("missing");
    assert.equal(view.action, "Open install instructions");
    await clickById("wizard-deno-action");
    await settle(200);
    view = await denoView();
    assert.equal(view.calls.installs, 0, "Linux tried an automatic install");
    assert.deepEqual(view.calls.external, [
      "https://docs.deno.com/runtime/getting_started/installation/",
    ]);
    seen.linux = view.state;
    await leave();

    await restoreWizardSettings(original);
    record("setup-wizard-deno", seen);
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
    await reloadRenderer();
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

  it("captures the key UI states as screenshots", async () => {
    assert.ok(SCREENSHOT_DIR, "ROSI_E2E_SCREENSHOTS is not set");
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const shots = [];
    const shoot = async (name) => {
      await settle();
      const file = path.join(SCREENSHOT_DIR, `${name}.png`);
      await browser.saveScreenshot(file);
      const bytes = fs.statSync(file).size;
      assert.ok(bytes > 1000, `${name} screenshot is empty`);
      shots.push({
        name,
        file: path.basename(file),
        sha256: sha256File(file),
        bytes,
      });
    };
    const selectDock = (tab) =>
      browser.execute((name) => window.rosiModules.dock.selectTab(name), tab);

    await resizeWindow(1200, 900);
    await typeUrl("");
    await setControlValue("themeSelect", "dark");
    await waitForSavedSetting("theme", "dark", "dark theme was not saved");
    await selectDock("activity");
    await shoot("default-dark");

    await clickById("profileBestVideoBtn");
    await shoot("profile-best-video");
    await clickById("profileAudioBtn");
    await shoot("profile-audio");
    await clickById("profileCustomBtn");
    await shoot("profile-custom");
    await clickById("profileCompatibleBtn");
    await waitForSavedSetting("downloadMode", "compatible", "profile reset");

    await clickById("presetMenuBtn");
    await shoot("presets-popover");
    await pressKey("#presetNameInput", { key: "Escape" });

    await selectDock("queue");
    await shoot("dock-queue");
    await selectDock("console");
    await shoot("dock-console");
    await selectDock("activity");

    await clickById("settingsBtn");
    await shoot("settings-open");
    await clickById("closeSidebar");

    await setControlValue("flatUiToggle", true);
    await waitForSavedSetting("flatUi", true, "Flat UI was not saved");
    await shoot("flat-ui");
    await setControlValue("flatUiToggle", false);
    await waitForSavedSetting("flatUi", false, "Flat UI off was not saved");

    await setControlValue("themeSelect", "light");
    await waitForSavedSetting("theme", "light", "light theme was not saved");
    await shoot("theme-light");
    await setControlValue("themeSelect", "purple");
    await waitForSavedSetting("theme", "purple", "purple theme was not saved");
    await shoot("theme-purple");
    await setSidebarOpen(true);
    await shoot("settings-floating-purple");
    await setSidebarOpen(false);
    await setControlValue("flatUiToggle", true);
    await waitForSavedSetting("flatUi", true, "Flat UI was not saved");
    await setSidebarOpen(true);
    await shoot("settings-flat-purple");
    await setSidebarOpen(false);
    await setControlValue("flatUiToggle", false);
    await waitForSavedSetting("flatUi", false, "Flat UI off was not saved");
    await setControlValue("themeSelect", "dark");
    await waitForSavedSetting("theme", "dark", "dark theme was not restored");

    await resizeWindow(900, 560);
    await shoot("compact-900x560");
    await resizeWindow(1200, 900);
    await selectDock("queue");
    await setControlValue("themeSelect", "system");
    await waitForSavedSetting(
      "theme",
      "system",
      "system theme was not restored",
    );

    record("ui-screenshots", { directory: SCREENSHOT_DIR, shots });
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

  it("searches, collapses, and resets settings sections", async () => {
    const original = settingsOnDisk();
    await clickById("settingsBtn");
    await settle();
    const search = (query) =>
      browser.execute((text) => {
        const input = document.getElementById("settingsSearch");
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const sections = [...document.querySelectorAll(".settings-section")];
        return {
          status: document.getElementById("settingsSearchStatus").textContent,
          visible: sections
            .filter((section) => !section.classList.contains("search-hidden"))
            .map(
              (section) =>
                section.querySelector(".settings-section-title").textContent,
            ),
        };
      }, query);
    const subtitle = await search("subtitle");
    assert.deepEqual(subtitle.visible, ["Enhancements"]);
    assert.equal(subtitle.status, "1 section matches your search.");
    const none = await search("zzz-not-a-setting");
    assert.deepEqual(none.visible, []);
    assert.equal(none.status, "No settings match your search.");
    await pressKey("#settingsSearch", { key: "Escape" });
    const cleared = await browser.execute(() => ({
      value: document.getElementById("settingsSearch").value,
      hidden: document.querySelectorAll(".settings-section.search-hidden")
        .length,
    }));
    assert.deepEqual(
      cleared,
      { value: "", hidden: 0 },
      "Escape did not clear the search",
    );

    // Collapse and expand a section from its header.
    const header = "#settingsSectionHeaderEnhancements";
    const sectionState = () =>
      browser.execute((selector) => {
        const button = document.querySelector(selector);
        return {
          collapsed: button
            .closest(".settings-section")
            .classList.contains("collapsed"),
          expanded: button.getAttribute("aria-expanded"),
        };
      }, header);
    const start = await sectionState();
    await browser.execute(
      (selector) => document.querySelector(selector).click(),
      header,
    );
    const toggled = await sectionState();
    assert.notEqual(
      toggled.collapsed,
      start.collapsed,
      "header did not toggle the section",
    );
    assert.equal(toggled.expanded, String(!toggled.collapsed));
    await browser.execute(
      (selector) => document.querySelector(selector).click(),
      header,
    );
    assert.deepEqual(
      await sectionState(),
      start,
      "section did not toggle back",
    );

    // Per-section reset puts that section's keys back to the defaults only.
    const defaults = (await api("getDefaultSettings")).data;
    await setControlValue("embedMetadataToggle", !defaults.embedMetadata);
    await setControlValue("sponsorblockToggle", !defaults.sponsorblockRemove);
    await setControlValue(
      "taskbarProgressToggle",
      !defaults.showTaskbarProgress,
    );
    await waitForSavedSetting(
      "sponsorblockRemove",
      !defaults.sponsorblockRemove,
      "SponsorBlock change was not saved",
    );
    await browser.execute(() =>
      document
        .querySelector(
          '.settings-section-reset[data-reset-section="enhancements"]',
        )
        .click(),
    );
    await waitForSavedSetting(
      "embedMetadata",
      defaults.embedMetadata,
      "section reset missed metadata",
    );
    await waitForSavedSetting(
      "sponsorblockRemove",
      defaults.sponsorblockRemove,
      "section reset missed SponsorBlock",
    );
    assert.equal(
      settingsOnDisk().showTaskbarProgress,
      !defaults.showTaskbarProgress,
      "Enhancements reset touched the Interface section",
    );
    await setControlValue(
      "taskbarProgressToggle",
      original.showTaskbarProgress,
    );
    await waitForSavedSetting(
      "showTaskbarProgress",
      original.showTaskbarProgress,
      "taskbar progress was not restored",
    );
    await clickById("closeSidebar");
    record("settings-search-reset", { matched: subtitle.visible });
  });

  it("saves every settings control through the real UI", async () => {
    const original = settingsOnDisk();
    const checked = [];
    // [control id, settings key, element that must show while on]
    const toggles = [
      ["convertToggle", "convertEnabled", "convertFormatContainer"],
      ["keepOriginalToggle", "keepOriginalAfterConvert", null],
      ["gpuAccelerationToggle", "gpuAcceleration", "gpuTypeContainer"],
      ["embedMetadataToggle", "embedMetadata", null],
      ["embedThumbnailToggle", "embedThumbnail", null],
      ["sponsorblockToggle", "sponsorblockRemove", null],
      ["writeSubtitlesToggle", "writeSubtitles", "subtitleLangsContainer"],
      ["hookBrowserToggle", "hookBrowser", "browserChoiceContainer"],
      ["animateBackgroundToggle", "animateBackground", null],
      ["taskbarProgressToggle", "showTaskbarProgress", null],
      ["notificationsToggle", "notifications", null],
      ["checkUpdatesOnStartupToggle", "checkUpdatesOnStartup", null],
      ["askDownloadLocationToggle", "askDownloadLocation", null],
    ];
    for (const [id, key, shows] of toggles) {
      for (const value of [!original[key], original[key]]) {
        await setControlValue(id, value);
        await waitForSavedSetting(
          key,
          value,
          `${id} did not save ${key}=${value}`,
        );
        if (shows && value) {
          const visible = await browser.execute(
            (target) =>
              document.getElementById(target).classList.contains("visible"),
            shows,
          );
          assert.ok(visible, `${id} on did not reveal #${shows}`);
        }
      }
      checked.push(id);
    }

    // Side effects the toggles drive outside Settings.
    await setControlValue("animateBackgroundToggle", true);
    await waitForSavedSetting(
      "animateBackground",
      true,
      "animated background was not saved",
    );
    assert.ok(
      await browser.execute(() =>
        document.body.classList.contains("animate-bg"),
      ),
      "animated background did not start",
    );
    await setControlValue(
      "animateBackgroundToggle",
      original.animateBackground,
    );
    await waitForSavedSetting(
      "animateBackground",
      original.animateBackground,
      "animated background was not restored",
    );
    await setControlValue("consoleToggle", false);
    await waitForSavedSetting(
      "showConsoleOutput",
      false,
      "console toggle was not saved",
    );
    assert.ok(
      await browser.execute(
        () => document.getElementById("dockTabConsole").hidden,
      ),
      "hiding the console left its dock tab",
    );
    await setControlValue("consoleToggle", true);
    await waitForSavedSetting(
      "showConsoleOutput",
      true,
      "console toggle was not restored",
    );
    checked.push("consoleToggle");

    // Selects, each set away from and back to its saved value.
    const selects = [
      ["convertFormat", "convertFormat", "mov"],
      ["gpuType", "gpuType", "intel"],
      ["profileAudioFormatSelect", "audioFormat", "flac"],
    ];
    for (const [id, key, value] of selects) {
      await setControlValue(id, value);
      await waitForSavedSetting(key, value, `${id} did not save ${value}`);
      await setControlValue(id, original[key]);
      await waitForSavedSetting(key, original[key], `${id} was not restored`);
      checked.push(id);
    }

    // The update channel sits behind a reveal button.
    await clickById("showUpdateChannelBtn");
    assert.ok(
      await browser.execute(() =>
        document
          .getElementById("updateChannelContainer")
          .classList.contains("visible"),
      ),
      "update channel did not reveal",
    );
    await setControlValue("updateChannelSelect", "beta");
    await waitForSavedSetting(
      "updateChannel",
      "beta",
      "update channel was not saved",
    );
    await setControlValue("updateChannelSelect", original.updateChannel);
    await waitForSavedSetting(
      "updateChannel",
      original.updateChannel,
      "update channel was not restored",
    );
    checked.push("updateChannelSelect");

    // Subtitle languages reject bad input and keep the saved value.
    const setLangs = (value) =>
      browser.execute((text) => {
        const input = document.getElementById("subtitleLangsInput");
        input.value = text;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return document.getElementById("subtitleLangsError").textContent;
      }, value);
    const error = await setLangs("en es!");
    assert.ok(error, "invalid subtitle languages showed no error");
    assert.equal(settingsOnDisk().subtitleLangs, original.subtitleLangs);
    assert.equal(await setLangs("en,fr"), "", "valid languages kept the error");
    await waitForSavedSetting(
      "subtitleLangs",
      "en,fr",
      "subtitle languages were not saved",
    );
    await setLangs(original.subtitleLangs);
    await waitForSavedSetting(
      "subtitleLangs",
      original.subtitleLangs,
      "subtitle languages were not restored",
    );
    checked.push("subtitleLangsInput");
    record("settings-controls", { controls: checked.length });
  });

  it("asks before Reset All, then resets and restarts", async () => {
    // The real reset restarts the app, which would end the WebDriver session;
    // the bridge call is recorded instead.
    await stubApi({ resetSettings: { ok: true } });
    await clickById("resetSettings");
    let modal = await waitForModal(true, "Reset All asked nothing");
    assert.equal(modal.buttons.length, 2);
    await clickModalButton("Cancel");
    await waitForModal(false, "Cancel did not close the reset prompt");
    assert.deepEqual(
      await stubCalls("resetSettings"),
      [],
      "Cancel still reset",
    );
    await clickById("resetSettings");
    modal = await waitForModal(true, "Reset All asked nothing the second time");
    await clickModalButton(modal.buttons.find((label) => /reset/i.test(label)));
    await settle(300);
    const calls = await stubCalls("resetSettings");
    await restoreApi();
    assert.equal(calls.length, 1, "confirming did not reset");
    record("settings-reset-all", { prompt: modal.title });
  });

  it("opens every help and support link at the right address", async () => {
    await stubApi({ openExternal: null });
    const links = {
      helpLink: "https://help.rosie.run/rosi/en-us/faq",
      supportLink: "https://rosie.run/support",
      websiteLink: "https://rosie.run",
      supportProjectLink: "https://rosie.run/support",
      sponsorblockHelp: "https://sponsor.ajay.app/",
      browserCookiesHelp:
        "https://help.rosie.run/rosi/en-us/about-browser-cookies",
    };
    for (const id of Object.keys(links)) await clickById(id);
    await settle(200);
    const opened = (await restoreApi()).map((call) => call.args[0]);
    assert.deepEqual(opened, Object.values(links));
    record("external-links", { links: opened.length });
  });

  it("handles every app menu action", async () => {
    const emit = (action) =>
      browser.executeAsync((name, done) => {
        window.__TAURI__.event.emit("menu-action", name).then(
          () => setTimeout(done, 400),
          (error) => done(String(error)),
        );
      }, action);
    const sidebarOpen = () =>
      browser.execute(() =>
        document.getElementById("sidebar").classList.contains("open"),
      );
    assert.equal(await emit("open-settings"), null);
    assert.equal(
      await sidebarOpen(),
      true,
      "open-settings did not open Settings",
    );
    await emit("open-settings");
    assert.equal(
      await sidebarOpen(),
      true,
      "open-settings closed an open sidebar",
    );
    await emit("toggle-sidebar");
    assert.equal(
      await sidebarOpen(),
      false,
      "toggle-sidebar did not close Settings",
    );
    await emit("show-licenses");
    assert.ok(
      await browser.execute(() =>
        document
          .getElementById("licenses-overlay")
          .classList.contains("active"),
      ),
      "show-licenses did not open the licenses",
    );
    await clickById("close-licenses");
    await emit("check-for-updates");
    const modal = await waitForModal(true, "check-for-updates showed nothing");
    assert.equal(modal.title, "Development Mode");
    await clickModalButton("OK");
    await waitForModal(false, "update result did not close");
    record("menu-actions", {
      actions: [
        "open-settings",
        "toggle-sidebar",
        "show-licenses",
        "check-for-updates",
      ],
    });
  });

  it("checks for updates from Settings", async () => {
    await clickById("checkUpdateBtn");
    const modal = await waitForModal(true, "Check for Updates showed nothing");
    // Unpackaged builds never reach the network; they say so instead.
    assert.equal(modal.title, "Development Mode");
    await clickModalButton("OK");
    await waitForModal(false, "update result did not close");
    record("update-check", { result: modal.title });
  });

  it("shows the keyboard shortcuts and statistics, and resets statistics", async () => {
    await clickById("shortcutsBtn");
    let modal = await waitForModal(true, "shortcuts did not open");
    assert.equal(modal.title, "Keyboard Shortcuts");
    assert.match(modal.message, /Alt\+1 \/ Alt\+2 \/ Alt\+3/);
    await clickModalButton("OK");
    await waitForModal(false, "shortcuts did not close");

    const stats = await api("getStats");
    await clickById("viewStatsBtn");
    modal = await waitForModal(true, "statistics did not open");
    assert.equal(modal.title, "Download Statistics");
    assert.match(
      modal.message,
      new RegExp(`Total downloads: ${stats.totalDownloads}\\b`),
    );
    assert.match(
      modal.message,
      new RegExp(`Successful: ${stats.successfulDownloads}\\b`),
    );
    await clickModalButton("Reset Stats");
    await waitForModal(false, "Reset Stats did not close the dialog");
    let reset = null;
    await browser.waitUntil(
      async () => {
        reset = await api("getStats");
        return reset.totalDownloads === 0;
      },
      { timeout: 5_000, timeoutMsg: "statistics were not reset" },
    );
    assert.equal(reset.successfulDownloads, 0);
    record("dialogs", { statsBeforeReset: stats.totalDownloads });
  });

  it("pastes, clears, and batches links on the download card", async () => {
    const one = `${MEDIA}/clip-one.mp4?paste=1`;
    const two = `${MEDIA}/clip-two.mp4?paste=1`;
    // The system clipboard prompts in WebKit; the page's clipboard read is
    // replaced with fixed text so the button's own handling is what's tested.
    await browser.execute((text) => {
      Object.defineProperty(navigator.clipboard, "readText", {
        configurable: true,
        value: () => Promise.resolve(text),
      });
    }, `look at ${one}\nand ${two}`);
    await typeUrl("");
    await clickById("pasteUrl");
    let card = null;
    await browser.waitUntil(
      async () => {
        card = await browser.execute(() => ({
          url: document.getElementById("url").value,
          button: document.getElementById("downloadBtn").textContent.trim(),
          clearShown: !document
            .getElementById("clearUrl")
            .classList.contains("hidden"),
        }));
        return card.url.length > 0;
      },
      { timeout: 5_000, timeoutMsg: "Paste did not fill the URL" },
    );
    assert.equal(
      card.url,
      `${one} ${two}`,
      "Paste did not keep only the links",
    );
    assert.match(card.button, /Add 2 to Queue/);
    assert.equal(
      card.clearShown,
      true,
      "Clear did not appear for a filled URL",
    );
    await clickById("clearUrl");
    const after = await browser.execute(() => ({
      url: document.getElementById("url").value,
      pasteShown: !document
        .getElementById("pasteUrl")
        .classList.contains("hidden"),
    }));
    assert.deepEqual(
      after,
      { url: "", pasteShown: true },
      "Clear left the URL",
    );
    record("download-card-input");
  });

  it("saves, applies, and deletes presets", async () => {
    const original = settingsOnDisk();
    await clickById("presetMenuBtn");
    const presetStatus = () =>
      browser.execute(
        () => document.getElementById("presetStatus").textContent,
      );
    const setName = (name) =>
      browser.execute((value) => {
        const input = document.getElementById("presetNameInput");
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, name);

    await setName("");
    await clickById("savePresetBtn");
    assert.match(await presetStatus(), /Enter a name/);

    await selectProfile("audio");
    await setControlValue("profileAudioFormatSelect", "flac");
    await waitForSavedSetting(
      "audioFormat",
      "flac",
      "audio format was not saved",
    );
    await setName("E2E Audio");
    await clickById("savePresetBtn");
    await browser.waitUntil(
      async () => /Saved E2E Audio/.test(await presetStatus()),
      {
        timeout: 5_000,
        timeoutMsg: "preset was not saved",
      },
    );
    const saved = settingsOnDisk().downloadPresets.find(
      (preset) => preset.name === "E2E Audio",
    );
    assert.ok(saved, "preset missing from settings.json");
    assert.equal(saved.profile, "audio");
    assert.equal(saved.audioFormat, "flac");

    // Apply it after switching away.
    await selectProfile("compatible");
    await browser.execute((id) => {
      const select = document.getElementById("downloadPresetSelect");
      select.value = id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, saved.id);
    await clickById("applyPresetBtn");
    await waitForSavedSetting(
      "downloadMode",
      "audio",
      "preset did not apply its profile",
    );
    assert.equal(settingsOnDisk().audioFormat, "flac");
    assert.match(await presetStatus(), /Applied E2E Audio/);

    await clickById("deletePresetBtn");
    await browser.waitUntil(
      async () =>
        !settingsOnDisk().downloadPresets.some(
          (preset) => preset.id === saved.id,
        ),
      { timeout: 5_000, timeoutMsg: "preset was not deleted" },
    );
    assert.match(await presetStatus(), /Deleted E2E Audio/);
    await pressKey("#presetNameInput", { key: "Escape" });
    await setControlValue("profileAudioFormatSelect", original.audioFormat);
    await waitForSavedSetting(
      "audioFormat",
      original.audioFormat,
      "audio format not restored",
    );
    await selectProfile(original.downloadMode);
    record("presets", { preset: saved.name });
  });

  it("downloads chosen formats from the Custom profile", async function () {
    if (skipWithoutFfmpeg(this, "custom-formats")) return;
    const original = settingsOnDisk();
    const url = `${MEDIA}/dash/manifest.mpd`;
    await selectProfile("custom");
    await typeUrl(url);
    await clickById("fetchFormatsBtn");
    let formats = null;
    await browser.waitUntil(
      async () => {
        formats = await browser.execute(() => {
          const values = (id) =>
            [...document.getElementById(id).options]
              .map((option) => option.value)
              .filter(Boolean);
          return { video: values("videoFormat"), audio: values("audioFormat") };
        });
        return formats.video.length > 0 && formats.audio.length > 0;
      },
      { timeout: 60_000, timeoutMsg: "formats never loaded" },
    );
    await setControlValue("videoFormat", formats.video[0]);
    await setControlValue("audioFormat", formats.audio[0]);
    const clickedAt = Date.now();
    await clickById("downloadBtn");
    const entry = await waitForActivity(
      (item) => item.url === url && item.completedAt >= clickedAt,
      "custom-format download never finished",
    );
    await waitForIdle();
    assert.equal(entry.outcome, "success", entry.error ?? entry.statusMessage);
    const streams = probeMedia(entry.outputPath)
      .streams.map((stream) => stream.codec_type)
      .sort();
    assert.deepEqual(
      streams,
      ["audio", "video"],
      "custom formats were not merged",
    );
    await typeUrl("");
    await selectProfile(original.downloadMode);
    record("custom-formats", {
      video: formats.video[0],
      audio: formats.audio[0],
    });
  });

  it("downloads a playlist range chosen in the UI", async function () {
    if (skipWithoutFfmpeg(this, "playlist-range")) return;
    const url = `${MEDIA}/list.html`;
    await typeUrl(url);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            !document
              .getElementById("playlistScope")
              .classList.contains("hidden"),
        ),
      { timeout: 60_000, timeoutMsg: "playlist choices never appeared" },
    );
    const setRange = (start, end) =>
      browser.execute(
        (from, to) => {
          const radio = document.querySelector(
            'input[name="playlist-scope"][value="range"]',
          );
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
          for (const [id, value] of [
            ["playlistRangeStart", from],
            ["playlistRangeEnd", to],
          ]) {
            const input = document.getElementById(id);
            input.value = String(value);
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
        },
        start,
        end,
      );
    // A backwards range is refused before anything downloads.
    await setRange(3, 2);
    await clickById("downloadBtn");
    await settle();
    const refused = await browser.execute(() => ({
      // An `error` key would read as a thrown error to the WebDriver bridge.
      scopeError: document.getElementById("playlistScopeError").textContent,
      busy: document
        .getElementById("downloadBtn")
        .classList.contains("loading"),
    }));
    assert.ok(refused.scopeError, "a backwards range showed no error");
    assert.equal(
      refused.busy,
      false,
      "a backwards range still started a download",
    );

    const before = new Set(fs.readdirSync(DOWNLOADS));
    await setRange(2, 3);
    const clickedAt = Date.now();
    await clickById("downloadBtn");
    await waitForActivity(
      (item) => item.url === url && item.completedAt >= clickedAt,
      "playlist range download never finished",
    );
    await waitForIdle();
    const added = fs
      .readdirSync(DOWNLOADS)
      .filter(
        (name) =>
          !before.has(name) && /ROSI List/.test(name) && name.endsWith(".mp4"),
      )
      .sort();
    assert.equal(
      added.length,
      2,
      `expected items 2 and 3, got ${added.join(", ")}`,
    );
    assert.ok(
      added.every((name) => !/\(1\)|list-1\b/.test(name)),
      `item 1 was downloaded: ${added.join(", ")}`,
    );
    await typeUrl("");
    record("playlist-range", { files: added });
  });

  it("embeds metadata, thumbnail, and subtitles into the file", async function () {
    if (skipWithoutFfmpeg(this, "embed-extras")) return;
    const original = settingsOnDisk();
    const extras = [
      ["embedMetadataToggle", "embedMetadata"],
      ["embedThumbnailToggle", "embedThumbnail"],
      ["writeSubtitlesToggle", "writeSubtitles"],
    ];
    for (const [id, key] of extras) {
      await setControlValue(id, true);
      await waitForSavedSetting(key, true, `${id} was not saved`);
    }
    await browser.execute(() => {
      const input = document.getElementById("subtitleLangsInput");
      input.value = "en";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitForSavedSetting(
      "subtitleLangs",
      "en",
      "subtitle language was not saved",
    );
    const entry = await downloadThroughUi(
      `${MEDIA}/page.html`,
      "extras download never finished",
    );
    assert.equal(entry.outcome, "success", entry.error ?? entry.statusMessage);
    const media = probeMedia(entry.outputPath);
    const types = media.streams.map((stream) => stream.codec_type);
    const embedded = {
      title: media.format?.tags?.title ?? null,
      thumbnail: media.streams.some(
        (stream) => stream.disposition?.attached_pic === 1,
      ),
      subtitles: types.includes("subtitle"),
    };
    assert.ok(embedded.title, "no title tag was embedded");
    assert.equal(embedded.thumbnail, true, "no cover art was embedded");
    assert.equal(embedded.subtitles, true, "no subtitle track was embedded");
    for (const [id, key] of extras) {
      await setControlValue(id, original[key]);
      await waitForSavedSetting(key, original[key], `${id} was not restored`);
    }
    await browser.execute((value) => {
      const input = document.getElementById("subtitleLangsInput");
      input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, original.subtitleLangs);
    await typeUrl("");
    record("embed-extras", {
      file: path.basename(entry.outputPath),
      ...embedded,
    });
  });

  it("runs the queue entirely from its controls", async () => {
    await api("clearQueue");
    await browser.execute(() => window.rosiModules.dock.selectTab("queue"));
    const urls = [`${MEDIA}/clip-two.mp4?ui=1`, `${MEDIA}/clip-three.mp4?ui=1`];
    const fillQueueInput = (text) =>
      browser.execute((value) => {
        const input = document.getElementById("queueUrlInput");
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, text);
    await fillQueueInput(urls.join("\n"));
    await clickById("addToQueueBtn");
    let queue = null;
    await browser.waitUntil(
      async () => {
        queue = await api("getQueue");
        return urls.every((url) => queue.some((item) => item.url === url));
      },
      { timeout: 10_000, timeoutMsg: "Add did not queue both links" },
    );
    assert.equal(
      await browser.execute(
        () => document.getElementById("queueUrlInput").value,
      ),
      "",
      "Add left the links in the box",
    );
    await clickById("startQueueBtn");
    await browser.waitUntil(
      async () => {
        queue = await api("getQueue");
        return urls.every(
          (url) =>
            queue.find((item) => item.url === url)?.status === "completed",
        );
      },
      { timeout: 120_000, timeoutMsg: "Start did not finish the queue" },
    );

    // Stop asks first, then cancels the running item.
    const slow = `${MEDIA}/slow.mp4?ui=1`;
    await fillQueueInput(slow);
    await clickById("addToQueueBtn");
    await browser.waitUntil(
      async () => (await api("getQueue")).some((item) => item.url === slow),
      {
        timeout: 10_000,
        timeoutMsg: "slow link was not queued",
      },
    );
    await clickById("startQueueBtn");
    await browser.waitUntil(
      async () =>
        (await api("getQueue")).find((item) => item.url === slow)?.status ===
        "downloading",
      { timeout: 30_000, timeoutMsg: "slow item never started" },
    );
    await clickById("cancelQueueBtn");
    const stop = await waitForModal(true, "Stop asked nothing");
    assert.equal(stop.title, "Cancel Queue");
    await clickModalButton("Cancel Queue");
    await browser.waitUntil(
      async () =>
        (await api("getQueue")).find((item) => item.url === slow)?.status ===
        "cancelled",
      { timeout: 30_000, timeoutMsg: "Stop did not cancel the running item" },
    );

    // Clear asks first, then empties the queue.
    await clickById("clearQueueBtn");
    const clear = await waitForModal(true, "Clear asked nothing");
    assert.equal(clear.title, "Clear Queue");
    await clickModalButton("Clear");
    await browser.waitUntil(async () => (await api("getQueue")).length === 0, {
      timeout: 10_000,
      timeoutMsg: "Clear did not empty the queue",
    });
    record("queue-controls", { completed: urls.length, cancelled: 1 });
  });

  it("changes the save folder and asks every time when told to", async () => {
    const original = settingsOnDisk();
    const picked = path.join(DOWNLOADS, "picked folder");
    const asked = path.join(DOWNLOADS, "asked folder");
    fs.mkdirSync(picked, { recursive: true });
    fs.mkdirSync(asked, { recursive: true });
    // The OS folder dialog is replaced by a recorder that returns a folder.
    await stubApi({ selectDownloadLocation: picked });
    await clickById("changeDownloadFolderBtn");
    await waitForSavedSetting(
      "downloadFolder",
      picked,
      "Change… did not save the folder",
    );
    assert.equal(
      await browser.execute(
        () => document.getElementById("downloadFolderSummary").title,
      ),
      picked,
    );

    await stubApi({ selectDownloadLocation: asked });
    await setControlValue("askDownloadLocationToggle", true);
    await waitForSavedSetting(
      "askDownloadLocation",
      true,
      "Ask every time was not saved",
    );
    const entry = await downloadThroughUi(
      `${MEDIA}/clip-one.mp4?ask=1`,
      "ask-every-time download never finished",
    );
    assert.equal(entry.outcome, "success", entry.error ?? entry.statusMessage);
    assert.ok(
      entry.outputPath.startsWith(asked),
      `saved to ${entry.outputPath}`,
    );
    const pickerCalls = await stubCalls("selectDownloadLocation");
    assert.equal(
      pickerCalls.length,
      2,
      "the folder picker was not asked for the download",
    );

    // A cancelled picker cancels the download.
    await stubApi({ selectDownloadLocation: null });
    await typeUrl(`${MEDIA}/clip-one.mp4?ask=cancel`);
    await clickById("downloadBtn");
    await settle();
    const cancelled = await browser.execute(() => ({
      busy: document
        .getElementById("downloadBtn")
        .classList.contains("loading"),
      console: document.getElementById("output").textContent,
    }));
    assert.equal(cancelled.busy, false, "a cancelled picker still downloaded");
    assert.match(cancelled.console, /No save location selected/);

    await restoreApi();
    await setControlValue("askDownloadLocationToggle", false);
    await waitForSavedSetting(
      "askDownloadLocation",
      false,
      "Ask every time was not restored",
    );
    const restored = await api("saveSettings", {
      downloadFolder: original.downloadFolder,
    });
    assert.equal(restored.ok, true, restored.error?.message);
    await reloadRenderer();
    await typeUrl("");
    record("save-location", {
      picked: path.basename(picked),
      asked: path.basename(asked),
    });
  });

  it("notifies when a download finishes", async () => {
    const original = settingsOnDisk().notifications;
    await setControlValue("notificationsToggle", true);
    await waitForSavedSetting(
      "notifications",
      true,
      "notifications were not saved",
    );
    await stubApi({ showNotification: { ok: true } });
    const entry = await downloadThroughUi(
      `${MEDIA}/clip-one.mp4?notify=1`,
      "notified download never finished",
    );
    assert.equal(entry.outcome, "success");
    let calls = [];
    await browser.waitUntil(
      async () => {
        calls = await stubCalls("showNotification");
        return calls.length > 0;
      },
      { timeout: 5_000, timeoutMsg: "no notification was shown" },
    );
    await restoreApi();
    assert.equal(calls[0][0].title, "Download Complete!");
    await setControlValue("notificationsToggle", original);
    await waitForSavedSetting(
      "notifications",
      original,
      "notifications were not restored",
    );
    await typeUrl("");
    record("notifications", { title: calls[0][0].title });
  });

  it("starts a new download right after one finishes", async () => {
    // For a few seconds after a download the button offers "Open File
    // Location". Typing a new link must turn it back into Download.
    await stubApi({ openFileLocation: { ok: true } });
    await downloadThroughUi(
      `${MEDIA}/clip-one.mp4?again=1`,
      "first download never finished",
    );
    const second = `${MEDIA}/clip-two.mp4?again=2`;
    await typeUrl(second);
    const button = await browser.execute(() =>
      document.getElementById("downloadBtn").textContent.trim(),
    );
    const clickedAt = Date.now();
    await clickById("downloadBtn");
    await settle(500);
    const opened = await stubCalls("openFileLocation");
    await restoreApi();
    assert.equal(
      button,
      "Download",
      `button still read "${button}" after typing`,
    );
    assert.deepEqual(opened, [], "Download opened the old file's folder");
    const entry = await waitForActivity(
      (item) => item.url === second && item.completedAt >= clickedAt,
      "the second download never started",
    );
    await waitForIdle();
    assert.equal(entry.outcome, "success");
    await typeUrl("");
    record("download-again-quickly");
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
    assert.match(
      log,
      /Settings (?:and download queue )?flushed; closing main window\./,
    );
    assert.doesNotMatch(log, /Timed out waiting for renderer settings flush/);
    const after = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf8"),
    );
    assert.equal(after.notifications, target);
    record("close-flow", { flushedSetting: "notifications" });
  });
});
