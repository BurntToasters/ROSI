import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, clickById, waitForAppReady } from "../../helpers/app-bridge.js";
import { REPO_ROOT } from "../../helpers/profile.js";

// Rows are numbered in longterm-audit.failure-modes.md. Each check lists the rows it covers.

const MEDIA = process.env.ROSI_E2E_MEDIA_URL;
const PREVIEW_A_URL = `${MEDIA}/longterm-audit/preview-a.mp4`;
const PREVIEW_B_URL = `${MEDIA}/longterm-audit/preview-b.mp4`;
const VIDEO_URL = `${MEDIA}/longterm-audit/clip.mp4`;
// The gate's media server answers 404 for this path, so yt-dlp fails without network.
const MISSING_URL = `${MEDIA}/missing-longterm.mp4`;
const MISSING_FILE_NAME = "missing-longterm.mp4";
const PLACEHOLDER = "Loading preview…";
const PREVIEW_HOLD_MATCH = "preview-b.mp4";
const INFO_A = {
  title: "Longterm audit clip A",
  uploader: "Longterm uploader A",
  durationSeconds: 42,
  thumbnail: null,
  ext: "mp4",
  viewCount: 1500,
  isPlaylist: false,
  playlistCount: null,
  webpageUrl: null,
};
const INFO_B = {
  title: "Longterm audit clip B",
  uploader: "Longterm uploader B",
  durationSeconds: 65,
  thumbnail: null,
  ext: "mp4",
  viewCount: 10,
  isPlaylist: false,
  playlistCount: null,
  webpageUrl: null,
};
const PROFILE_BUTTONS = {
  compatible: "profileCompatibleBtn",
  "best-video": "profileBestVideoBtn",
  audio: "profileAudioBtn",
  custom: "profileCustomBtn",
};
const DOWNLOAD_HELD_ERROR = {
  ok: false,
  error: {
    code: "INTERNAL_ERROR",
    message: "longterm audit released the held start",
  },
};

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-longterm-audit-${process.pid}`,
);
// The gate passes ROSI_E2E_SCREENSHOTS, so the shots land in the folder that
// verifyScreenshots re-hashes. A standalone run keeps them beside its report.
const screenshotDir =
  process.env.ROSI_E2E_SCREENSHOTS || path.join(artifactDir, "screenshots");
// The gate attaches every record with this name to the v5-fixes/ui-polish scenario.
const GATE_SCREENSHOT_RECORD = "v5-screenshots";
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-longterm-audit",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  runtime: { node: process.version },
  source: null,
  checks: [],
  screenshots: [],
};

// Starting values, read from the app before any check changes them.
let startSettings = null;
let startUrl = "";
let startAskDownloadLocation = false;

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

// Source identity for this report: HEAD, a hash of the tracked diff, and the
// hash of each changed or untracked file. Enough to tell which tree produced it.
function sourceIdentity() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  const trackedChanges = execFileSync(
    "git",
    ["diff", "HEAD", "--name-only", "-z"],
    { cwd: REPO_ROOT, encoding: "buffer" },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: REPO_ROOT, encoding: "buffer" },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const dirtyFiles = [...new Set([...trackedChanges, ...untracked])]
    .sort()
    .map((relativePath) => {
      const filePath = path.join(REPO_ROOT, relativePath);
      return {
        path: relativePath.replaceAll(path.sep, "/"),
        sha256:
          fs.existsSync(filePath) && fs.statSync(filePath).isFile()
            ? sha256(fs.readFileSync(filePath))
            : null,
      };
    });
  const dirtyFingerprint = dirtyFiles
    .map((file) => `${file.path}\0${file.sha256 ?? "deleted"}`)
    .join("\n");
  return {
    head,
    workingTree: dirtyFiles.length === 0 ? "clean" : "dirty",
    dirtyFiles,
    dirtyFingerprintSha256: sha256(dirtyFingerprint),
  };
}

function writeReport() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  const temporaryPath = `${reportPath}.tmp`;
  fs.writeFileSync(temporaryPath, contents);
  fs.renameSync(temporaryPath, reportPath);
  fs.writeFileSync(
    `${reportPath}.sha256`,
    `${sha256(contents)}  report.json\n`,
  );
}

// One check per E2E case. `failureModes` names the rows of
// longterm-audit.failure-modes.md that the case exercises.
async function scenario(name, failureModes, body) {
  try {
    const details = await body();
    report.checks.push({
      name,
      failureModes,
      status: "passed",
      invariantPassed: true,
      ...details,
    });
    writeReport();
  } catch (error) {
    report.checks.push({
      name,
      failureModes,
      status: "failed",
      invariantPassed: false,
      reason: error instanceof Error ? error.message : String(error),
    });
    writeReport();
    throw error;
  }
}

// Every page read goes through window.__longtermAscii, so non-ASCII text (the
// ellipsis, the bullet separator) crosses the WebDriver bridge as ASCII JSON.
async function readPage(script, ...args) {
  return JSON.parse(await browser.execute(script, ...args));
}

// Polls a read until `done` accepts it. On timeout the error includes the last
// value read, so a failure shows what the page actually showed.
async function waitForState(read, done, message, timeout = 10_000) {
  let last = null;
  try {
    await browser.waitUntil(
      async () => {
        last = await read();
        return done(last);
      },
      { timeout, interval: 100 },
    );
  } catch {
    throw new Error(`${message}; last state ${JSON.stringify(last)}`);
  }
  return last;
}

async function setControl(id, value) {
  await browser.execute(
    (target, next) => {
      const control = document.getElementById(target);
      if (!control) throw new Error(`missing control ${target}`);
      if (control.type === "checkbox") control.checked = Boolean(next);
      else control.value = String(next);
      control.dispatchEvent(new Event("change", { bubbles: true }));
    },
    id,
    value,
  );
}

// Sets the URL field the way typing does, so the preview and summary follow it.
async function setUrlField(value) {
  await browser.execute((text) => {
    const input = document.getElementById("url");
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function waitForBackendSetting(key, value, message) {
  await browser.waitUntil(
    async () => (await api("getSettings"))[key] === value,
    { timeout: 10_000, interval: 150, timeoutMsg: message },
  );
}

async function setSidebarOpen(open) {
  const isOpen = await readPage(() =>
    window.__longtermAscii(
      document.getElementById("sidebar")?.classList.contains("open") === true,
    ),
  );
  if (isOpen === open) return;
  await clickById(open ? "settingsBtn" : "closeSidebar");
  await waitForState(
    () =>
      readPage(() =>
        window.__longtermAscii(
          document.getElementById("sidebar")?.classList.contains("open") ===
            true,
        ),
      ),
    (value) => value === open,
    `settings did not ${open ? "open" : "close"}`,
  );
}

async function selectDock(tab) {
  await browser.execute(
    (name) => window.__ROSI_E2E__.modules.dock.selectTab(name),
    tab,
  );
}

// Replaces one bridge method with a recorder. The renderer calls the bridge at
// call time, so the stub is seen by every caller. A call is held (its promise
// waits) when `hold` is set, or when its first argument contains `holdMatch`.
// Held calls resolve with `value` unless releaseHeld() supplies another value.
async function stubBridge(
  name,
  value,
  { hold = false, holdMatch = null } = {},
) {
  await browser.execute(
    (target, result, options) => {
      const bridge = window.__ROSI_E2E__.api;
      const state = (window.__longtermAudit ??= {
        originals: {},
        calls: {},
        held: [],
      });
      if (!(target in state.originals)) {
        state.originals[target] = bridge[target];
      }
      state.calls[target] = [];
      const stub = (...args) => {
        state.calls[target].push(JSON.parse(JSON.stringify(args)));
        const first = typeof args[0] === "string" ? args[0] : "";
        const shouldHold =
          options.hold ||
          (options.holdMatch && first.includes(options.holdMatch));
        if (!shouldHold) return Promise.resolve(result);
        return new Promise((resolve) =>
          state.held.push({ name: target, resolve, value: result }),
        );
      };
      stub.longtermStub = true;
      bridge[target] = stub;
    },
    name,
    value,
    { hold, holdMatch },
  );
}

async function releaseHeld(name, replacement = null) {
  return browser.execute(
    (target, next) => {
      const state = window.__longtermAudit;
      if (!state) return 0;
      const mine = state.held.filter((entry) => entry.name === target);
      state.held = state.held.filter((entry) => entry.name !== target);
      mine.forEach((entry) => entry.resolve(next ?? entry.value));
      return mine.length;
    },
    name,
    replacement,
  );
}

async function stubCallCount(name) {
  return browser.execute(
    (target) => window.__longtermAudit?.calls?.[target]?.length ?? 0,
    name,
  );
}

// Settles any held call, then puts the original method back.
async function restoreBridge(name) {
  await browser.execute((target) => {
    const state = window.__longtermAudit;
    if (!state) return;
    const mine = state.held.filter((entry) => entry.name === target);
    state.held = state.held.filter((entry) => entry.name !== target);
    mine.forEach((entry) => entry.resolve(entry.value));
    if (target in state.originals) {
      window.__ROSI_E2E__.api[target] = state.originals[target];
      delete state.originals[target];
    }
  }, name);
}

async function clearToasts() {
  await browser.execute(() =>
    document.querySelectorAll(".toast").forEach((node) => node.remove()),
  );
}

// Turns "Ask every time" off so a download click does not open a folder picker.
async function ensureAskEveryTimeOff() {
  const settings = await api("getSettings");
  if (!settings.askDownloadLocation) return;
  await setControl("askDownloadLocationToggle", false);
  await waitForBackendSetting(
    "askDownloadLocation",
    false,
    "askDownloadLocation did not turn off",
  );
}

// Puts "Ask every time" back to its starting value after a download check.
async function restoreAskEveryTime() {
  if (!startAskDownloadLocation) return;
  if ((await api("getSettings")).askDownloadLocation === true) return;
  await setControl("askDownloadLocationToggle", true);
  await waitForBackendSetting(
    "askDownloadLocation",
    true,
    "askDownloadLocation was not restored",
  );
}

async function readSummary() {
  return readPage(() => {
    const summary = document.getElementById("downloadOutputSummary");
    return window.__longtermAscii({
      state: summary?.dataset.state ?? null,
      profile: summary?.dataset.profile ?? null,
      text: summary?.textContent ?? "",
    });
  });
}

async function readDownloadButton() {
  return readPage(() => {
    const button = document.getElementById("downloadBtn");
    return window.__longtermAscii({
      disabled: button.disabled,
      loading: button.classList.contains("loading"),
      text: button.innerText.trim(),
      hasLoaderImage: Boolean(button.querySelector('img[src*="loader.svg"]')),
      ariaLabel: button.getAttribute("aria-label"),
    });
  });
}

async function readPreviewButton() {
  return readPage(() => {
    const button = document.getElementById("previewBtn");
    return window.__longtermAscii({
      disabled: button.disabled,
      loading: button.classList.contains("loading"),
      text: button.innerText.trim(),
      hasLoaderImage: Boolean(button.querySelector('img[src*="loader.svg"]')),
      ariaLabel: button.getAttribute("aria-label"),
    });
  });
}

async function readPreviewCard() {
  return readPage(() => {
    const card = document.getElementById("preview-card");
    return window.__longtermAscii({
      visible: card.classList.contains("visible"),
      loading: card.classList.contains("loading"),
      title:
        document.getElementById("preview-title")?.textContent?.trim() ?? "",
      subtitle:
        document.getElementById("preview-sub")?.textContent?.trim() ?? "",
      duration:
        document.getElementById("preview-duration")?.textContent?.trim() ?? "",
    });
  });
}

// The Activity rows that belong to one URL, from the backend's own history.
async function activityFor(url) {
  const envelope = await api("getDownloadActivity");
  assert.equal(envelope?.ok, true, "getDownloadActivity failed");
  return envelope.data.filter((entry) => entry.url === url);
}

async function readActivityRow(id) {
  return readPage((target) => {
    const row = [...document.querySelectorAll(".history-item")].find(
      (item) => item.dataset.activityId === target,
    );
    if (!row) return window.__longtermAscii(null);
    return window.__longtermAscii({
      title: row.querySelector(".history-filename")?.textContent?.trim() ?? "",
      subtitle: row.querySelector(".history-time")?.textContent?.trim() ?? "",
      error: row.querySelector(".history-error")?.textContent?.trim() ?? "",
    });
  }, String(id));
}

// Reads the two toasts through the real container. Each one reports its rect,
// its live region, and whether its entrance animation has finished.
async function readToasts() {
  return readPage(() => {
    const find = (prefix) =>
      [...document.querySelectorAll(".toast")].find((toast) =>
        (toast.querySelector(".toast-message")?.textContent ?? "").startsWith(
          prefix,
        ),
      );
    const describe = (toast) => {
      if (!toast) return null;
      const rect = toast.getBoundingClientRect();
      return {
        rect: {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          height: rect.height,
        },
        visible: toast.classList.contains("visible"),
        animations: toast.getAnimations({ subtree: true }).length,
        liveRegion: toast.parentElement?.getAttribute("aria-live") ?? null,
      };
    };
    return window.__longtermAscii({
      info: describe(find("Longterm audit info toast")),
      error: describe(find("Longterm audit error toast")),
    });
  });
}

// Measures the rendered contrast of each element, the way contrast-layout.spec.js
// does. Translucent ancestors are composited over the page base (white). The
// element's computed opacity is applied to its text and its surface, so the
// result is the rest-state contrast a user sees.
async function measureContrast(mode) {
  return readPage((kind) => {
    const parse = (value) => {
      const text = value.trim();
      const rgba = text.match(/^rgba?\((.+)\)$/);
      if (rgba) {
        const parts = rgba[1]
          .split(/[\s,/]+/)
          .filter(Boolean)
          .map(Number);
        return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
      }
      const srgb = text.match(/^color\(srgb\s+(.+)\)$/);
      if (srgb) {
        const parts = srgb[1]
          .split(/[\s/]+/)
          .filter(Boolean)
          .map(Number);
        return [
          parts[0] * 255,
          parts[1] * 255,
          parts[2] * 255,
          parts.length > 3 ? parts[3] : 1,
        ];
      }
      throw new Error(`unsupported computed color ${value}`);
    };
    const over = (top, bottom) =>
      [0, 1, 2]
        .map((i) => top[i] * top[3] + bottom[i] * (1 - top[3]))
        .concat(1);
    const luminance = ([red, green, blue]) => {
      const linear = (channel) => {
        const value = channel / 255;
        return value <= 0.03928
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      };
      return (
        0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
      );
    };
    const contrast = (first, second) => {
      const a = luminance(first);
      const b = luminance(second);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const chainOf = (element) => {
      const chain = [];
      for (let node = element; node; node = node.parentElement)
        chain.unshift(node);
      return chain;
    };
    const measureElement = (element) => {
      const chain = chainOf(element);
      let backdrop = [255, 255, 255, 1];
      for (const node of chain.slice(0, -1)) {
        const layer = parse(getComputedStyle(node).backgroundColor);
        if (layer[3] > 0) backdrop = over(layer, backdrop);
      }
      const style = getComputedStyle(element);
      const own = parse(style.backgroundColor);
      const surface = own[3] > 0 ? over(own, backdrop) : backdrop;
      const text = over(parse(style.color), surface);
      const opacity = chain.reduce(
        (product, node) => product * Number(getComputedStyle(node).opacity),
        1,
      );
      const blend = (color, under) =>
        [0, 1, 2]
          .map((i) => color[i] * opacity + under[i] * (1 - opacity))
          .concat(1);
      const renderedText = blend(text, backdrop);
      const renderedSurface = blend(surface, backdrop);
      return {
        color: style.color,
        opacity,
        background: `rgb(${renderedSurface
          .slice(0, 3)
          .map((value) => Math.round(value))
          .join(", ")})`,
        ratio: contrast(renderedText, renderedSurface),
      };
    };
    if (kind === "danger-probe") {
      const host =
        document.querySelector(".download-card") ??
        document.querySelector(".main-stage") ??
        document.body;
      const probe = document.createElement("p");
      probe.className = "longterm-audit-probe";
      probe.textContent = "Longterm audit danger probe";
      probe.style.cssText =
        "display:block;margin:0;font-size:14px;color:var(--danger-text);";
      host.appendChild(probe);
      try {
        return window.__longtermAscii([
          { label: "--danger-text probe", ...measureElement(probe) },
        ]);
      } finally {
        probe.remove();
      }
    }
    return window.__longtermAscii(
      [...document.querySelectorAll(".settings-section-reset")]
        .filter((element) => {
          const style = getComputedStyle(element);
          return (
            style.display !== "none" &&
            style.visibility === "visible" &&
            element.getClientRects().length > 0
          );
        })
        .map((element) => ({
          label: element.textContent.trim(),
          ...measureElement(element),
        })),
    );
  }, mode);
}

// The reset links are measured only once the settings panel has finished
// sliding in: open, identity transform, every ancestor at opacity 1, and no
// link hovered or focused (their own opacity rises on hover and focus). The
// theme must be applied, no animation or transition may run on a link or its
// ancestors, and the colours must match the previous read.
async function readResetReadiness() {
  return readPage(() => {
    const sidebar = document.getElementById("sidebar");
    const links = [
      ...document.querySelectorAll(".settings-section-reset"),
    ].filter((element) => {
      const style = getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility === "visible" &&
        element.getClientRects().length > 0
      );
    });
    const ancestorsOpaque = (element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        if (Number(getComputedStyle(node).opacity) !== 1) return false;
      }
      return true;
    };
    const chainOf = (element) => {
      const chain = [];
      for (let node = element; node; node = node.parentElement)
        chain.push(node);
      return chain;
    };
    // Unfinished animations or transitions on the link or any ancestor.
    const animating = [];
    for (const link of links) {
      for (const node of chainOf(link)) {
        for (const animation of node.getAnimations()) {
          if (animation.playState !== "finished") {
            animating.push(
              `${node.id || node.className || node.tagName}:${animation.transitionProperty ?? animation.animationName ?? "animation"}`,
            );
          }
        }
      }
    }
    // Colour, background and opacity of each link and its ancestors, to
    // compare two consecutive reads.
    const signature = links
      .map((link) =>
        chainOf(link)
          .map((node) => {
            const style = getComputedStyle(node);
            return `${style.color}|${style.backgroundColor}|${style.opacity}`;
          })
          .join(";"),
      )
      .join("#");
    const transform = getComputedStyle(sidebar).transform;
    const active = document.activeElement;
    return window.__longtermAscii({
      theme: document.documentElement.dataset.theme ?? null,
      animating: [...new Set(animating)],
      signature,
      open: sidebar.classList.contains("open"),
      transformIdentity:
        transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)",
      transform,
      count: links.length,
      ancestorsOpaque: links.map(ancestorsOpaque),
      hovered: links.some((element) => element.matches(":hover")),
      focused: links.some(
        (element) => element === active || element.matches(":focus-visible"),
      ),
    });
  });
}

async function waitForResetReadiness(theme) {
  // Move focus off any reset link first, so its own opacity is not raised.
  await browser.execute(() => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active.matches(".settings-section-reset")
    ) {
      active.blur();
    }
  });
  let previous = null;
  return waitForState(
    readResetReadiness,
    (state) => {
      const stable = previous !== null && state.signature === previous;
      previous = state.signature;
      return (
        state.open &&
        state.count > 0 &&
        state.theme === theme &&
        state.transformIdentity &&
        state.ancestorsOpaque.every(Boolean) &&
        state.animating.length === 0 &&
        !state.hovered &&
        !state.focused &&
        stable
      );
    },
    "settings reset links never settled for measurement",
    15_000,
  );
}

async function readInertState() {
  return readPage(() => {
    const sidebar = document.getElementById("sidebar");
    const banner = document.getElementById("update-banner");
    return window.__longtermAscii({
      sidebarOpen: sidebar?.classList.contains("open") === true,
      sidebarInert: sidebar?.inert === true,
      bannerActive: banner?.classList.contains("active") === true,
      bannerInert: banner?.inert === true,
    });
  });
}

async function readThemeState() {
  return readPage(() =>
    window.__longtermAscii({
      theme: document.documentElement.dataset.theme ?? null,
      flat: document.documentElement.dataset.flatUi ?? null,
      themeSelect: document.getElementById("themeSelect")?.value ?? null,
      flatChecked: document.getElementById("flatUiToggle")?.checked === true,
    }),
  );
}

// The screenshot format ui-polish.spec.js uses: the PNG in the gate's folder, its
// hash in the report, and a record the gate re-hashes later.
async function screenshot(name) {
  const file = `${name}.png`;
  const destination = path.join(screenshotDir, file);
  await browser.saveScreenshot(destination);
  const bytes = fs.statSync(destination).size;
  assert.ok(bytes > 1000, `${name} screenshot is empty`);
  const shot = {
    name,
    file,
    path: path.relative(REPO_ROOT, destination).replaceAll(path.sep, "/"),
    sha256: sha256(fs.readFileSync(destination)),
    bytes,
  };
  report.screenshots.push(shot);
  writeReport();
  return shot;
}

// Appends this spec's shots to the pass results file (ROSI_E2E_RESULTS). Records
// already in the file come from other specs in the same pass and are kept.
function writeGateScreenshotRecord(shots) {
  const resultsPath = process.env.ROSI_E2E_RESULTS;
  if (!resultsPath) return;
  let records = [];
  try {
    if (fs.existsSync(resultsPath)) {
      const parsed = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
      if (Array.isArray(parsed)) records = parsed;
    }
  } catch {
    records = [];
  }
  records.push({ name: GATE_SCREENSHOT_RECORD, status: "passed", shots });
  fs.writeFileSync(resultsPath, `${JSON.stringify(records, null, 2)}\n`);
}

// Sets the profile, waits for the summary to resolve for it, and returns that state.
async function selectProfileAndWait(mode) {
  await clickById(PROFILE_BUTTONS[mode]);
  return waitForState(
    readSummary,
    (state) => state.state === "resolved" && state.profile === mode,
    `summary never resolved for the ${mode} profile`,
  );
}

describe("ROSI long-term audit: summary, preview, busy buttons, toasts, activity, panel, contrast", () => {
  before(async () => {
    assert.ok(MEDIA, "ROSI_E2E_MEDIA_URL is not set");
    fs.mkdirSync(screenshotDir, { recursive: true });
    await waitForAppReady();
    await browser.execute(() => {
      window.__longtermAscii = (value) =>
        JSON.stringify(value).replace(
          /[\u0080-￿]/g,
          (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
        );
    });
    report.source = sourceIdentity();
    const backend = await api("getSettings");
    startSettings = {
      downloadMode: backend.downloadMode,
      convertEnabled: backend.convertEnabled,
      askDownloadLocation: backend.askDownloadLocation,
      theme: backend.theme ?? "system",
      flatUi: Boolean(backend.flatUi),
    };
    startAskDownloadLocation = Boolean(backend.askDownloadLocation);
    startUrl = await browser.execute(
      () => document.getElementById("url")?.value ?? "",
    );
    writeReport();
  });

  after(async () => {
    // One record for the whole spec, written once, as ui-polish.spec.js does for
    // its shots. The gate reads every v5-screenshots record it finds.
    if (report.screenshots.length > 0) {
      writeGateScreenshotRecord(
        report.screenshots.map((shot) => ({
          name: shot.name,
          file: shot.file,
          sha256: shot.sha256,
          bytes: shot.bytes,
        })),
      );
    }
    try {
      await setSidebarOpen(false);
    } catch {
      // Restored below as far as the page allows.
    }
    for (const name of ["getVideoInfo", "downloadVideo"]) {
      await restoreBridge(name);
    }
    await clearToasts();
    await browser.execute((text) => {
      const input = document.getElementById("url");
      if (input) input.value = text;
    }, startUrl);
    if (startAskDownloadLocation) {
      await setControl("askDownloadLocationToggle", true);
    }
    await browser.execute(() => {
      delete window.__longtermAscii;
    });
    report.completedAt = new Date().toISOString();
    report.passed = report.checks.filter(
      (check) => check.status === "passed",
    ).length;
    report.failed = report.checks.filter(
      (check) => check.status === "failed",
    ).length;
    report.result =
      report.failed === 0 && report.checks.length > 0 ? "passed" : "failed";
    writeReport();
  });

  // U1: the audio output format appears only in the audio profile's summary.
  it("U1 the audio output format is shown only for the audio profile", async () =>
    scenario("summary-audio-format-follows-profile", [1, 2, 3, 4], async () => {
      const startMode = await api("getSettings");
      try {
        await setUrlField(VIDEO_URL);
        const audio = await selectProfileAndWait("audio");
        const resolved = await api("resolveDownloadOptions", {
          url: VIDEO_URL,
        });
        assert.equal(resolved?.ok, true, "resolveDownloadOptions failed");
        const token = String(resolved.data.audioOutputFormat).toUpperCase();
        assert.ok(token.length > 0, "no audio output format was resolved");
        assert.ok(
          audio.text.includes(token),
          `audio profile summary lacks ${token}: ${audio.text}`,
        );

        const video = await selectProfileAndWait("compatible");
        assert.ok(video.text.length > 0, "video summary is empty");
        assert.ok(
          !video.text.includes(token),
          `video summary shows ${token}: ${video.text}`,
        );
        await screenshot("longterm-audit-u1-summary");
        return { token, audio, video };
      } finally {
        await clickById(PROFILE_BUTTONS[startMode.downloadMode]);
        await waitForBackendSetting(
          "downloadMode",
          startMode.downloadMode,
          "downloadMode was not restored",
        );
        if (
          (await api("getSettings")).convertEnabled !== startMode.convertEnabled
        ) {
          await setControl("convertToggle", startMode.convertEnabled);
          await waitForBackendSetting(
            "convertEnabled",
            startMode.convertEnabled,
            "convertEnabled was not restored",
          );
        }
        await browser.execute((text) => {
          document.getElementById("url").value = text;
        }, startUrl);
      }
    }));

  // U2: a preview that is still loading does not show the previous video.
  it("U2 a loading preview does not show the previous video", async () =>
    scenario("preview-loading-hides-previous-video", [6, 7, 8, 9], async () => {
      await stubBridge(
        "getVideoInfo",
        { ok: true, data: INFO_A },
        { holdMatch: PREVIEW_HOLD_MATCH },
      );
      try {
        await setUrlField(PREVIEW_A_URL);
        const rendered = await waitForState(
          readPreviewCard,
          (card) =>
            card.visible && !card.loading && card.title === INFO_A.title,
          "preview A never rendered",
        );
        assert.equal(rendered.title, INFO_A.title);

        await setUrlField(PREVIEW_B_URL);
        const loading = await waitForState(
          readPreviewCard,
          (card) => card.loading,
          "the card never entered the loading state for preview B",
        );
        await waitForState(
          () => stubCallCount("getVideoInfo"),
          (count) => count >= 2,
          "preview B never called getVideoInfo",
        );
        const card = await readPreviewCard();
        assert.notEqual(
          loading.title,
          INFO_A.title,
          "loading card shows the previous video's title",
        );
        assert.equal(
          card.title,
          PLACEHOLDER,
          `loading card title is ${JSON.stringify(card.title)}`,
        );
        assert.ok(
          !card.subtitle.includes(INFO_A.uploader) &&
            !card.subtitle.includes("1.5K"),
          `loading card subtitle shows A: ${JSON.stringify(card.subtitle)}`,
        );
        assert.notEqual(
          card.duration,
          "0:42",
          "loading card shows the previous duration",
        );
        await screenshot("longterm-audit-u2-loading-preview");
        return { previous: INFO_A.title, loadingCard: card };
      } finally {
        await releaseHeld("getVideoInfo", { ok: true, data: INFO_B });
        await restoreBridge("getVideoInfo");
        await waitForState(
          readPreviewCard,
          (card) => !card.loading,
          "preview B did not settle after release",
        );
        await clickById("previewClose");
        await browser.execute((text) => {
          document.getElementById("url").value = text;
        }, startUrl);
      }
    }));

  // U3: the busy Download and Preview buttons say Cancel and keep their labels.
  it("U3 busy buttons show a Cancel label", async () =>
    scenario(
      "busy-buttons-show-cancel-label",
      [11, 12, 13, 14, 15],
      async () => {
        await ensureAskEveryTimeOff();
        await stubBridge("getVideoInfo", { ok: true, data: INFO_A });
        await stubBridge("downloadVideo", DOWNLOAD_HELD_ERROR, { hold: true });
        try {
          await setUrlField(VIDEO_URL);
          await waitForState(
            readDownloadButton,
            (button) => !button.disabled,
            "Download button never became ready",
          );
          await clickById("downloadBtn");
          await waitForState(
            readDownloadButton,
            (button) => button.loading,
            "Download button never entered the busy state",
          );
          await waitForState(
            () => stubCallCount("downloadVideo"),
            (count) => count >= 1,
            "downloadVideo was never called",
          );
          const busyNow = await readDownloadButton();
          assert.ok(
            busyNow.text.includes("Cancel"),
            `busy Download button shows no Cancel text: ${JSON.stringify(busyNow.text)}`,
          );
          assert.equal(
            busyNow.hasLoaderImage,
            false,
            "busy Download button still shows the loader image",
          );
          assert.equal(
            busyNow.ariaLabel,
            "Cancel download",
            "busy Download button lost its cancel label",
          );
          await screenshot("longterm-audit-u3-busy-button");

          await releaseHeld("downloadVideo");
          const idle = await waitForState(
            readDownloadButton,
            (button) => !button.loading,
            "Download button stayed busy after the start was refused",
          );
          assert.equal(
            idle.text.includes("Cancel"),
            false,
            `Download label stuck on Cancel: ${JSON.stringify(idle.text)}`,
          );
          await clearToasts();

          // Preview busy state: a held lookup, then released with a real result.
          await stubBridge(
            "getVideoInfo",
            { ok: true, data: INFO_A },
            { hold: true },
          );
          await clickById("previewBtn");
          const previewBusy = await waitForState(
            readPreviewButton,
            (button) => button.loading,
            "Preview button never entered the busy state",
          );
          assert.ok(
            previewBusy.text.includes("Cancel"),
            `busy Preview button shows no Cancel text: ${JSON.stringify(previewBusy.text)}`,
          );
          assert.equal(
            previewBusy.hasLoaderImage,
            false,
            "busy Preview button still shows the loader image",
          );
          assert.equal(
            previewBusy.ariaLabel,
            "Cancel preview",
            "busy Preview button lost its cancel label",
          );
          await releaseHeld("getVideoInfo");
          const previewIdle = await waitForState(
            readPreviewButton,
            (button) => !button.loading,
            "Preview button stayed busy after release",
          );
          return { download: busyNow, preview: previewBusy, previewIdle };
        } finally {
          await releaseHeld("downloadVideo");
          await restoreBridge("downloadVideo");
          await restoreBridge("getVideoInfo");
          await clearToasts();
          await restoreAskEveryTime();
          await browser.execute((text) => {
            document.getElementById("url").value = text;
          }, startUrl);
        }
      },
    ));

  // U4: an info toast and an error toast shown together do not overlap.
  it("U4 info and error toasts do not overlap", async () =>
    scenario("toasts-do-not-overlap", [17, 18, 19, 20], async () => {
      await clearToasts();
      // A two-line error: taller than the 80 px offset the audit names.
      const errorText =
        "Longterm audit error toast. The second line keeps this message taller than eighty pixels so the stack has to account for its real height.";
      await browser.execute((text) => {
        const ui = window.__ROSI_E2E__.modules.ui;
        ui.showToast("Longterm audit info toast", {
          type: "info",
          duration: 60_000,
        });
        ui.showToast(text, { type: "error", duration: 60_000 });
      }, errorText);
      const settled = await waitForState(
        readToasts,
        (state) =>
          state.info &&
          state.error &&
          state.info.visible &&
          state.error.visible &&
          state.info.animations === 0 &&
          state.error.animations === 0,
        "the two toasts never finished their entrance",
      );
      const { info, error } = settled;
      assert.equal(
        error.liveRegion,
        "assertive",
        "error toast left the assertive region",
      );
      assert.equal(
        info.liveRegion,
        "polite",
        "info toast left the polite region",
      );
      const overlaps = !(
        error.rect.bottom <= info.rect.top ||
        info.rect.bottom <= error.rect.top ||
        error.rect.right <= info.rect.left ||
        info.rect.right <= error.rect.left
      );
      assert.equal(
        overlaps,
        false,
        `error toast ${JSON.stringify(error.rect)} overlaps info toast ${JSON.stringify(info.rect)}`,
      );
      await screenshot("longterm-audit-u4-toasts");
      await clearToasts();
      return {
        info: info.rect,
        error: error.rect,
        errorHeight: error.rect.height,
      };
    }));

  // U5 and U6: a real download of a missing file, then its Activity row.
  it("U5 and U6 a failed download reports the yt-dlp reason and names its file", async () => {
    try {
      await scenario(
        "real-failed-download-shows-ytdlp-reason",
        [21, 22, 23, 24],
        async () => {
          await ensureAskEveryTimeOff();
          const beforeCount = (await activityFor(MISSING_URL)).length;
          await selectDock("activity");
          await setUrlField(MISSING_URL);
          await waitForState(
            readDownloadButton,
            (button) => !button.disabled && !button.loading,
            "Download button never became ready",
          );
          await clickById("downloadBtn");
          const matches = await waitForState(
            () => activityFor(MISSING_URL),
            (list) => list.length > beforeCount,
            "the failed download never reached Activity",
            90_000,
          );
          const entry = matches[matches.length - 1];
          assert.equal(entry.outcome, "failed", `outcome was ${entry.outcome}`);
          const error = String(entry.error ?? "");
          assert.ok(
            error.includes("HTTP Error 404"),
            `Activity error lacks the yt-dlp reason: ${JSON.stringify(error)}`,
          );
          assert.match(
            error,
            /code 1\b/,
            `Activity error lost the exit code: ${JSON.stringify(error)}`,
          );
          const row = await waitForState(
            () => readActivityRow(entry.id),
            (value) => value !== null && value.error.length > 0,
            "the Activity row shows no error text",
          );
          assert.ok(
            row.error.includes("HTTP Error 404"),
            `Activity row error lacks the reason: ${JSON.stringify(row.error)}`,
          );
          await screenshot("longterm-audit-u5-failed-reason");
          return { id: entry.id, error, row };
        },
      );

      await scenario(
        "activity-missing-file-row-title",
        [27, 28, 29],
        async () => {
          const matches = await activityFor(MISSING_URL);
          const entry = matches[matches.length - 1];
          assert.ok(entry, "the failed download is not in Activity");
          const row = await readActivityRow(entry.id);
          assert.ok(row, "the failed download has no Activity row");
          assert.equal(
            row.title,
            MISSING_FILE_NAME,
            `row title is ${JSON.stringify(row.title)}`,
          );
          // The host may stay in the subtitle under a file-name title. The bug is
          // the same text as both title and first subtitle part.
          const firstPart = row.subtitle.split("•")[0].trim();
          assert.notEqual(
            firstPart,
            row.title,
            `row subtitle repeats the title first: ${JSON.stringify(row.subtitle)}`,
          );
          await screenshot("longterm-audit-u6-file-row-title");
          return { title: row.title, subtitle: row.subtitle };
        },
      );
    } finally {
      await restoreAskEveryTime();
      await browser.execute((text) => {
        document.getElementById("url").value = text;
      }, startUrl);
    }
  });

  // U8: a closed settings panel and a hidden banner are inert.
  it("U8 the closed settings panel and hidden banner are inert", async () =>
    scenario(
      "closed-settings-and-banner-inert",
      [31, 32, 33, 34, 35],
      async () => {
        await setSidebarOpen(false);
        const closed = await readInertState();
        assert.equal(
          closed.sidebarInert,
          true,
          "closed settings panel is not inert",
        );
        if (!closed.bannerActive) {
          assert.equal(
            closed.bannerInert,
            true,
            "hidden update banner is not inert",
          );
        }
        const focusLanded = await browser.execute(() => {
          const button = document.getElementById("closeSidebar");
          button?.focus();
          return document.activeElement === button;
        });
        assert.equal(
          focusLanded,
          false,
          "a closed settings control took focus",
        );

        await clickById("settingsBtn");
        const open = await waitForState(
          readInertState,
          (state) => state.sidebarOpen === true,
          "settings did not open",
        );
        assert.equal(open.sidebarInert, false, "open settings panel is inert");

        await clickById("closeSidebar");
        const reclosed = await waitForState(
          readInertState,
          (state) => state.sidebarOpen === false,
          "settings did not close",
        );
        assert.equal(
          reclosed.sidebarInert,
          true,
          "settings panel is not inert after closing",
        );
        await setSidebarOpen(false);
        await screenshot("longterm-audit-u8-closed-settings");
        return { closed, open, reclosed };
      },
    ));

  // U9: danger text in Flat dark and the light reset links reach 4.5:1.
  it("U9 danger text and light reset links reach 4.5:1", async () => {
    const startTheme = startSettings.theme;
    const startFlat = startSettings.flatUi;
    try {
      await scenario(
        "flat-dark-danger-text-contrast",
        [36, 37, 39, 40],
        async () => {
          await setControl("themeSelect", "dark");
          await setControl("flatUiToggle", true);
          await waitForState(
            readThemeState,
            (state) => state.theme === "dark" && state.flat === "true",
            "dark theme with Flat UI did not apply",
          );
          const [sample] = await measureContrast("danger-probe");
          assert.ok(
            sample.ratio >= 4.5,
            `Flat dark ${sample.label} is ${sample.color} on ${sample.background}: ${sample.ratio.toFixed(2)}:1`,
          );
          await screenshot("longterm-audit-u9-flat-dark");
          return { sample };
        },
      );

      await scenario(
        "light-settings-reset-contrast",
        [38, 39, 46],
        async () => {
          await setControl("flatUiToggle", false);
          await setControl("themeSelect", "light");
          await waitForState(
            readThemeState,
            (state) => state.theme === "light" && state.flat !== "true",
            "light theme did not apply",
          );
          await setSidebarOpen(true);
          const settled = await waitForResetReadiness("light");
          const resets = await measureContrast("reset-links");
          assert.ok(resets.length > 0, "no visible settings reset link");
          const failing = resets.filter((reset) => reset.ratio < 4.5);
          assert.deepEqual(
            failing.map(
              (reset) =>
                `${reset.label} ${reset.ratio.toFixed(2)}:1 color ${reset.color} on ${reset.background} opacity ${reset.opacity}`,
            ),
            [],
            "light reset links below 4.5:1",
          );
          await screenshot("longterm-audit-u9-light-reset");
          await setSidebarOpen(false);
          return { settled, resets };
        },
      );
    } finally {
      await setSidebarOpen(false);
      await setControl("flatUiToggle", startFlat);
      await setControl("themeSelect", startTheme);
      await waitForState(
        readThemeState,
        (state) =>
          state.themeSelect === startTheme && state.flatChecked === startFlat,
        "theme and Flat UI were not restored",
      );
      await waitForBackendSetting(
        "theme",
        startTheme,
        "backend theme was not restored",
      );
      await waitForBackendSetting(
        "flatUi",
        startFlat,
        "backend Flat UI was not restored",
      );
    }
  });

  // Shared profile: everything this spec changed is back to its start.
  it("shared state is put back", async () =>
    scenario("shared-state-restored", [42, 43, 44], async () => {
      await api("clearDownloadActivity");
      const page = await readPage(() =>
        window.__longtermAscii({
          getVideoInfoStub: Boolean(
            window.__ROSI_E2E__.api.getVideoInfo.longtermStub,
          ),
          downloadVideoStub: Boolean(
            window.__ROSI_E2E__.api.downloadVideo.longtermStub,
          ),
          heldCalls: window.__longtermAudit?.held.length ?? 0,
          stubsInstalled: Object.keys(window.__longtermAudit?.originals ?? {})
            .length,
          sidebarOpen: document
            .getElementById("sidebar")
            .classList.contains("open"),
          url: document.getElementById("url").value,
          downloadLoading: document
            .getElementById("downloadBtn")
            .classList.contains("loading"),
        }),
      );
      assert.equal(
        page.getVideoInfoStub,
        false,
        "getVideoInfo is still stubbed",
      );
      assert.equal(
        page.downloadVideoStub,
        false,
        "downloadVideo is still stubbed",
      );
      assert.equal(page.heldCalls, 0, "a held call was never released");
      assert.equal(
        page.stubsInstalled,
        0,
        "a bridge original was not restored",
      );
      assert.equal(page.sidebarOpen, false, "settings panel is still open");
      assert.equal(
        page.downloadLoading,
        false,
        "Download button is still busy",
      );
      assert.equal(page.url, startUrl, "URL field was not restored");

      const backend = await api("getSettings");
      assert.equal(
        backend.downloadMode,
        startSettings.downloadMode,
        "downloadMode was not restored",
      );
      assert.equal(
        backend.convertEnabled,
        startSettings.convertEnabled,
        "convertEnabled was not restored",
      );
      assert.equal(
        backend.askDownloadLocation,
        startSettings.askDownloadLocation,
        "askDownloadLocation was not restored",
      );
      assert.equal(
        backend.theme ?? "system",
        startSettings.theme,
        "theme was not restored",
      );
      assert.equal(
        Boolean(backend.flatUi),
        startSettings.flatUi,
        "Flat UI was not restored",
      );

      const leftover = await activityFor(MISSING_URL);
      assert.equal(
        leftover.length,
        0,
        "the failed download is still in Activity",
      );
      return { settings: startSettings, page };
    }));
});
