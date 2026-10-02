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
    const selectors = [
      "#addToQueueBtn",
      "#changeDownloadFolderBtn",
      "#settingsBtn",
      '.download-profile-btn[aria-pressed="true"]',
      ".download-card",
      "#dock",
    ];
    const raised = await boxShadows(selectors);
    for (const selector of selectors) {
      assert.notEqual(raised[selector], "none", `${selector} is not raised`);
    }
    await setControlValue("flatUiToggle", true);
    await waitForSavedSetting("flatUi", true, "Flat UI was not saved");
    await settle();
    const flat = await boxShadows(selectors);
    assert.equal(
      await browser.execute(() => document.documentElement.dataset.flatUi),
      "true",
    );
    for (const selector of selectors) {
      assert.equal(
        flat[selector],
        "none",
        `${selector} kept a shadow in Flat UI`,
      );
    }
    await setControlValue("flatUiToggle", false);
    await waitForSavedSetting("flatUi", false, "Flat UI off was not saved");
    await settle();
    const back = await boxShadows(selectors);
    for (const selector of selectors) {
      assert.notEqual(back[selector], "none", `${selector} did not come back`);
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

    // Alt+2 from anywhere shows Activity.
    await pressKey("#url", { key: "2", code: "Digit2", altKey: true });
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
