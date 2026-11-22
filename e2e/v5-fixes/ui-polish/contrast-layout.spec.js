import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { setControl, waitFor, waitForAppReady } from "../../helpers/ui.js";
import { REPO_ROOT, e2eBinaryPath } from "../../helpers/profile.js";

// Covers the checks in contrast-layout.failure-modes.md. Each check names the
// failure-mode rows it proves, and a row that cannot run on this platform is
// recorded as not-proven (invariantPassed null), never as passed. It is also
// written to the pass results file as a skipped case, so the gate rejects it
// unless e2e/suites.json allows it for this platform.

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-contrast-layout-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-contrast-layout",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  runtime: { node: process.version },
  source: null,
  binary: null,
  checks: [],
};

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

// Source identity for this report: HEAD, a hash of the tracked diff, and the
// hash of each untracked file. Enough to tell which working tree produced it.
function sourceIdentity() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  const diff = execFileSync("git", ["diff", "HEAD", "--binary"], {
    cwd: REPO_ROOT,
    maxBuffer: 256 * 1024 * 1024,
  });
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  return {
    head,
    workingTree:
      diff.length === 0 && untracked.length === 0 ? "clean" : "dirty",
    dirtyPatchSha256: sha256(diff),
    untrackedFiles: untracked.map((file) => ({
      path: file,
      sha256: sha256(fs.readFileSync(path.join(REPO_ROOT, file))),
    })),
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

// Appends a skipped case to this pass's results file (ROSI_E2E_RESULTS). The
// gate reads skipped records there and fails the area unless a case allowance
// matches. Records already in the file come from other specs and are kept.
function recordGateSkip(name, reason) {
  const resultsPath = process.env.ROSI_E2E_RESULTS;
  if (!resultsPath) return;
  const records = fs.existsSync(resultsPath)
    ? JSON.parse(fs.readFileSync(resultsPath, "utf8"))
    : [];
  assert.ok(Array.isArray(records), "pass results file is not a JSON array");
  records.push({ name, skipped: true, reason });
  fs.writeFileSync(resultsPath, `${JSON.stringify(records, null, 2)}\n`);
}

// A body that returns { notProven: true, reason } records the row as
// not-proven. Any thrown error records the row as failed and rethrows.
async function scenario(name, failureModes, body) {
  try {
    const details = await body();
    if (details?.notProven) {
      const rest = { ...details };
      delete rest.notProven;
      recordGateSkip(name, rest.reason);
      report.checks.push({
        name,
        failureModes,
        status: "not-proven",
        invariantPassed: null,
        ...rest,
      });
    } else {
      report.checks.push({
        name,
        failureModes,
        status: "passed",
        invariantPassed: true,
        ...details,
      });
    }
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

// True when no CSS transition is running. Infinite animations are ignored.
function transitionsSettled() {
  return document
    .getAnimations({ subtree: true })
    .every((animation) => !(animation instanceof CSSTransition));
}

async function selectDock(tab) {
  await browser.execute(
    (name) => window.__ROSI_E2E__.modules.dock.selectTab(name),
    tab,
  );
}

const near = (size, width, height) =>
  Math.abs(size.width - width) <= 4 && Math.abs(size.height - height) <= 4;

// Sets the 900x560 minimum window and reports whether the platform applied it.
// The outer or inner size may be the one that matches, depending on the
// platform's window model.
async function applyMinimumWindow() {
  await browser.setWindowSize(900, 560);
  // A platform that ignores the size never reaches it, so the wait is bounded
  // and the result below reports whether it did.
  await browser
    .waitUntil(
      async () =>
        near(await browser.getWindowSize(), 900, 560) ||
        near(
          await browser.execute(() => ({
            width: window.innerWidth,
            height: window.innerHeight,
          })),
          900,
          560,
        ),
      { timeout: 3_000, interval: 100 },
    )
    .catch(() => {});
  await waitFor(
    transitionsSettled,
    "layout transitions after resize did not settle",
    5_000,
  );
  const outer = await browser.getWindowSize();
  const inner = await browser.execute(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  return {
    resized: near(outer, 900, 560) || near(inner, 900, 560),
    outer,
    inner,
  };
}

// The theme attribute, the computed text tokens and the sample's composited
// background are read in the page. Each sample is appended inside the live
// download card, so its translucent ancestors are part of the measurement.
function measureTextTokens(tokens) {
  const root = document.documentElement;
  const parse = (value) => {
    const text = value.trim();
    let match = text.match(/^rgba?\((.+)\)$/);
    if (match) {
      const parts = match[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    }
    match = text.match(/^color\(srgb\s+(.+)\)$/);
    if (match) {
      const parts = match[1]
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
  // Source-over: top (with its alpha) painted on an opaque bottom.
  const over = (top, bottom) =>
    [0, 1, 2]
      .map((index) => top[index] * top[3] + bottom[index] * (1 - top[3]))
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
  const host =
    document.querySelector(".download-card") ??
    document.querySelector(".main-stage") ??
    document.body;
  return tokens.map((token) => {
    const raw = getComputedStyle(root).getPropertyValue(token.prop).trim();
    const probe = document.createElement("p");
    probe.className = "contrast-layout-probe";
    probe.textContent = `Contrast probe ${token.key}`;
    probe.style.cssText = `display:block;margin:0;font-size:14px;color:var(${token.prop});`;
    host.appendChild(probe);
    try {
      const style = getComputedStyle(probe);
      const rect = probe.getBoundingClientRect();
      const chain = [];
      for (
        let element = probe.parentElement;
        element;
        element = element.parentElement
      ) {
        chain.unshift(element);
      }
      let background = [255, 255, 255, 1];
      const layers = [];
      for (const element of chain) {
        const layer = parse(getComputedStyle(element).backgroundColor);
        if (layer[3] > 0) {
          layers.push({
            tag: element.tagName.toLowerCase(),
            alpha: layer[3],
          });
          background = over(layer, background);
        }
      }
      const foreground = over(parse(style.color), background);
      return {
        token: token.key,
        prop: token.prop,
        raw,
        color: style.color,
        display: style.display,
        width: rect.width,
        height: rect.height,
        background: `rgb(${background
          .slice(0, 3)
          .map((value) => Math.round(value))
          .join(", ")})`,
        layers,
        ratio: contrast(foreground, background),
      };
    } finally {
      probe.remove();
    }
  });
}

const TEXT_TOKENS = [
  { key: "success", prop: "--success-text" },
  { key: "warning", prop: "--warning-text" },
  { key: "danger", prop: "--danger-text" },
  { key: "accent", prop: "--accent-text" },
];

// The theme names as the settings select offers them. "system" resolves to
// dark or light, so the resolved value is what gets measured.
const THEMES = ["system", "light", "dark", "purple"];

// Source-level checks on the four CSS files this package owns. They cover what
// no live element shows: the fill tokens still color the fills and icons.
function readCss(name) {
  return fs.readFileSync(path.join(REPO_ROOT, "src", "css", name), "utf8");
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

// Shared state set by the window checks.
let modalSnapshot = null;
let shortModalSnapshot = null;
let queueSnapshot = null;
let toastSnapshot = null;

async function measureLongModal() {
  const message = "yt-dlp reported a long error line. "
    .repeat(160)
    .slice(0, 4000);
  await browser.execute((text) => {
    window.__ROSI_E2E__.modules.overlays.showModal({
      title: "Contrast layout long error",
      message: text,
      key: "contrast-layout-long",
      buttons: [
        { label: "Cancel", action: () => {} },
        { label: "Retry", primary: true, action: () => {} },
      ],
    });
  }, message);
  await waitFor(
    () =>
      document.getElementById("app-modal")?.classList.contains("active") &&
      !document.getElementById("app-modal")?.classList.contains("showing"),
    "long modal did not open",
    5_000,
  );
  await waitFor(
    transitionsSettled,
    "long modal animation did not settle",
    5_000,
  );
  const snapshot = await browser.execute(() => {
    const modal = document.getElementById("app-modal");
    const box = modal.querySelector(".modal-box");
    const text = document.getElementById("modal-message");
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      messageLength: text.textContent.length,
      box: rect(box),
      title: rect(box.querySelector("h3")),
      buttons: [...document.querySelectorAll("#modal-buttons .btn")].map(
        (button) => ({
          label: button.textContent.trim(),
          ...rect(button),
          height: button.getBoundingClientRect().height,
        }),
      ),
      message: {
        clientHeight: text.clientHeight,
        scrollHeight: text.scrollHeight,
        overflowY: getComputedStyle(text).overflowY,
      },
    };
  });
  // Scroll the message to its end, then read the buttons again.
  await browser.execute(() => {
    const text = document.getElementById("modal-message");
    text.scrollTop = text.scrollHeight;
  });
  const afterScroll = await browser.execute(() => {
    const text = document.getElementById("modal-message");
    const buttons = [...document.querySelectorAll("#modal-buttons .btn")].map(
      (button) => {
        const r = button.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      },
    );
    return { scrollTop: text.scrollTop, buttons };
  });
  await browser.execute(() => {
    const button = [...document.querySelectorAll("#modal-buttons button")].find(
      (candidate) => candidate.textContent.trim() === "Cancel",
    );
    if (!button) throw new Error("missing Cancel button in long modal");
    button.click();
  });
  await waitFor(
    () => !document.getElementById("app-modal")?.classList.contains("active"),
    "long modal did not close",
    5_000,
  );
  return { ...snapshot, afterScroll };
}

async function measureShortModal() {
  await browser.execute(() => {
    window.__ROSI_E2E__.modules.overlays.showModal({
      title: "Contrast layout short note",
      message: "Short note.",
      key: "contrast-layout-short",
      buttons: [{ label: "OK", primary: true, action: () => {} }],
    });
  });
  await waitFor(
    () =>
      document.getElementById("app-modal")?.classList.contains("active") &&
      !document.getElementById("app-modal")?.classList.contains("showing"),
    "short modal did not open",
    5_000,
  );
  await waitFor(
    transitionsSettled,
    "short modal animation did not settle",
    5_000,
  );
  const snapshot = await browser.execute(() => {
    const modal = document.getElementById("app-modal");
    const box = modal.querySelector(".modal-box");
    const text = document.getElementById("modal-message");
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      box: rect(box),
      title: {
        ...rect(box.querySelector("h3")),
        text: box.querySelector("h3").textContent.trim(),
      },
      message: {
        clientHeight: text.clientHeight,
        scrollHeight: text.scrollHeight,
        text: text.textContent,
      },
    };
  });
  await browser.execute(() => {
    const button = [...document.querySelectorAll("#modal-buttons button")].find(
      (candidate) => candidate.textContent.trim() === "OK",
    );
    if (!button) throw new Error("missing OK button in short modal");
    button.click();
  });
  await waitFor(
    () => !document.getElementById("app-modal")?.classList.contains("active"),
    "short modal did not close",
    5_000,
  );
  return snapshot;
}

function insideViewport(rect, viewport) {
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= viewport.height &&
    rect.right <= viewport.width
  );
}

async function measureQueue(textValue) {
  await selectDock("queue");
  await browser.execute((value) => {
    const area = document.getElementById("queueUrlInput");
    if (!area) throw new Error("queue textarea is missing");
    document.activeElement?.blur();
    area.blur();
    area.value = value;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }, textValue);
  await waitFor(
    transitionsSettled,
    "queue input transitions did not settle",
    5_000,
  );
  return browser.execute(() => {
    const area = document.getElementById("queueUrlInput");
    const style = getComputedStyle(area);
    const borderX =
      parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    const borderY =
      parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    return {
      placeholderShown: area.matches(":placeholder-shown"),
      focused: document.activeElement === area,
      value: area.value,
      height: style.height,
      resize: style.resize,
      overflowY: style.overflowY,
      clientHeight: area.clientHeight,
      clientWidth: area.clientWidth,
      scrollHeight: area.scrollHeight,
      verticalScrollbarPx: area.offsetWidth - borderX - area.clientWidth,
      horizontalScrollbarPx: area.offsetHeight - borderY - area.clientHeight,
    };
  });
}

// The app shows paste only while the URL field is empty, and clear only while
// it has text (url-actions.ts). The worst case for each state is measured with
// the preview button forced visible, because preview shows only for a valid URL.
async function measureUrl(url) {
  await browser.execute((value) => {
    const input = document.getElementById("url");
    if (!input) throw new Error("URL input is missing");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, url);
  await waitFor(
    transitionsSettled,
    "URL input transitions did not settle",
    5_000,
  );
  return browser.execute(() => {
    const input = document.getElementById("url");
    const actions = document.querySelector(".url-input-actions");
    const preview = document.getElementById("previewBtn");
    const ids = ["previewBtn", "pasteUrl", "clearUrl"];
    const read = (id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return { id, visible: r.width > 0, left: r.left, width: r.width };
    };
    const natural = ids.map(read);
    const previousInline = preview.style.display;
    preview.style.display = "inline-flex";
    try {
      const style = getComputedStyle(input);
      const inputRect = input.getBoundingClientRect();
      return {
        paddingRight: parseFloat(style.paddingRight),
        borderRight: parseFloat(style.borderRightWidth),
        inputRight: inputRect.right,
        rightOffset: parseFloat(getComputedStyle(actions).right),
        actionsWidthWorst: actions.getBoundingClientRect().width,
        natural,
        worst: ids.map(read),
      };
    } finally {
      preview.style.display = previousInline;
    }
  });
}

const overlaps = (a, b) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

async function measureToast() {
  await selectDock("queue");
  const dockExpanded = await browser.execute(
    () => !document.querySelector(".dock")?.classList.contains("collapsed"),
  );
  await browser.execute(() => {
    const ui = window.__ROSI_E2E__.modules.ui;
    ui.showToast("Contrast layout probe", { type: "info", duration: 60_000 });
    ui.showToast("Contrast layout error probe", {
      type: "error",
      duration: 60_000,
    });
  });
  await waitFor(
    () => document.querySelectorAll(".toast.visible").length >= 2,
    "probe toasts did not appear",
    5_000,
  );
  await waitFor(
    () =>
      [...document.querySelectorAll(".toast.visible")].every(
        (toast) => toast.getAnimations().length === 0,
      ),
    "probe toast animations did not settle",
    5_000,
  );
  const snapshot = await browser.execute(() => {
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const toolbar = document.querySelector("#queueSection .dock-toolbar");
    const download = document.getElementById("downloadBtn");
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      toasts: [...document.querySelectorAll(".toast.visible")].map((toast) => ({
        type: toast.classList.contains("toast-error") ? "error" : "info",
        rect: rect(toast),
      })),
      toolbar: toolbar ? rect(toolbar) : null,
      toolbarVisible: toolbar
        ? toolbar.getBoundingClientRect().height > 0
        : false,
      download: rect(download),
      downloadVisible: download.getBoundingClientRect().height > 0,
      politeTop: getComputedStyle(document.getElementById("toast-container"))
        .top,
      assertiveBottom: getComputedStyle(
        document.getElementById("toast-container-assertive"),
      ).bottom,
    };
  });
  await browser.execute(() => {
    document
      .querySelectorAll(".toast .toast-dismiss")
      .forEach((button) => button.click());
  });
  return { ...snapshot, dockExpanded };
}

describe("ROSI contrast, layout, and toast placement", () => {
  before(async () => {
    await waitForAppReady();
    report.source = sourceIdentity();
    const binaryPath = e2eBinaryPath();
    report.binary = {
      path: path.relative(REPO_ROOT, binaryPath).replaceAll(path.sep, "/"),
      sha256: fs.existsSync(binaryPath)
        ? sha256(fs.readFileSync(binaryPath))
        : null,
      mtime: fs.existsSync(binaryPath)
        ? fs.statSync(binaryPath).mtime.toISOString()
        : null,
    };
    assert.ok(report.binary.sha256, "fresh E2E binary is missing");
    writeReport();
  });

  after(async () => {
    if (originalWindow) {
      await browser.setWindowSize(originalWindow.width, originalWindow.height);
    }
    report.completedAt = new Date().toISOString();
    report.passed = report.checks.filter(
      (check) => check.status === "passed",
    ).length;
    report.failed = report.checks.filter(
      (check) => check.status === "failed",
    ).length;
    report.notProven = report.checks.filter(
      (check) => check.status === "not-proven",
    ).length;
    report.result =
      report.failed === 0 && report.checks.length > 0 ? "passed" : "failed";
    writeReport();
  });

  let originalWindow = null;
  let originalTheme = null;

  it("keeps status and accent text at 4.5:1 in every theme", async () => {
    originalWindow = await browser.getWindowSize();
    originalTheme = await browser.execute(
      () => document.getElementById("themeSelect").value,
    );
    const measured = [];
    for (const selection of THEMES) {
      await setControl("themeSelect", selection);
      await waitFor(
        (wanted) => {
          const theme = document.documentElement.dataset.theme;
          return wanted === "system"
            ? theme === "dark" || theme === "light"
            : theme === wanted;
        },
        `theme ${selection} was not applied`,
        5_000,
        selection,
      );
      await waitFor(
        transitionsSettled,
        "theme transitions did not settle",
        5_000,
      );
      const resolved = await browser.execute(
        () => document.documentElement.dataset.theme,
      );
      const results = await browser.execute(measureTextTokens, TEXT_TOKENS);
      measured.push({ selection, resolved, results });
    }
    await setControl("themeSelect", originalTheme);

    const flat = measured.flatMap((entry) =>
      entry.results.map((result) => ({ theme: entry.resolved, ...result })),
    );

    await scenario("text-tokens-contrast-4_5", [1], async () => {
      for (const entry of measured) {
        if (entry.selection === "system") {
          assert.ok(
            ["dark", "light"].includes(entry.resolved),
            `system theme resolved to ${entry.resolved}`,
          );
        } else {
          assert.equal(
            entry.resolved,
            entry.selection,
            `theme ${entry.selection} did not apply`,
          );
        }
      }
      for (const entry of flat) {
        assert.ok(
          entry.raw !== "",
          `${entry.theme} ${entry.prop} is undefined`,
        );
        assert.ok(
          entry.ratio >= 4.5,
          `${entry.theme} ${entry.token} text ${entry.color} on ${entry.background} is ${entry.ratio.toFixed(2)}:1`,
        );
      }
      return {
        measurements: flat.map((entry) => ({
          theme: entry.theme,
          token: entry.token,
          raw: entry.raw,
          color: entry.color,
          background: entry.background,
          ratio: Number(entry.ratio.toFixed(2)),
        })),
      };
    });

    await scenario("dark-theme-text-values-unchanged", [2], async () => {
      const dark = measured.find((entry) => entry.selection === "dark");
      assert.ok(dark, "dark theme was not measured");
      // Danger text is #fa8888 in dark (U9): the old #ef4444 failed AA on the
      // tinted dark surfaces. Purple's danger token is #fa8888 too, but no scenario
      // pins purple's exact color; the 4.5:1 check above covers it.
      const expectedColors = {
        success: "rgb(34, 197, 94)",
        warning: "rgb(245, 158, 11)",
        danger: "rgb(250, 136, 136)",
        accent: "rgb(103, 232, 249)",
      };
      for (const result of dark.results) {
        assert.equal(
          result.color,
          expectedColors[result.token],
          `dark ${result.token} text changed`,
        );
      }
      return { colors: dark.results.map((result) => result.color) };
    });

    await scenario("sample-composites-translucent-ancestors", [3], async () => {
      for (const entry of flat) {
        assert.ok(
          entry.layers.length >= 2,
          `${entry.theme} ${entry.token}: only ${entry.layers.length} background layer(s)`,
        );
        assert.ok(
          entry.layers.some((layer) => layer.alpha > 0 && layer.alpha < 1),
          `${entry.theme} ${entry.token}: no translucent ancestor was composited`,
        );
      }
      return { layersPerSample: flat.map((entry) => entry.layers.length) };
    });

    await scenario("sample-is-rendered", [4], async () => {
      for (const entry of flat) {
        assert.notEqual(
          entry.display,
          "none",
          `${entry.token} sample is hidden`,
        );
        assert.ok(
          entry.width > 0 && entry.height > 0,
          `${entry.theme} ${entry.token} sample has no size`,
        );
      }
      return { samples: flat.length };
    });

    await scenario("fill-tokens-kept-on-fills-and-icons", [5], async () => {
      const queue = readCss("07-queue.css");
      const overlays = readCss("05-overlays.css");
      const main = readCss("03-main.css");
      const base = readCss("01-base.css");
      assert.equal(
        countMatches(
          queue,
          /\.queue-completed \.queue-item-title \{\s*color: var\(--success-text\)/g,
        ),
        1,
        "completed queue title does not use the text token",
      );
      assert.equal(
        countMatches(
          queue,
          /\.queue-completed \.queue-item-status \{\s*background: var\(--success\)/g,
        ),
        1,
        "completed queue status dot lost its fill token",
      );
      assert.equal(
        countMatches(
          overlays,
          /\.toast-warning \.toast-icon \{\s*color: var\(--warning\)/g,
        ),
        1,
        "warning toast icon lost its fill token",
      );
      assert.equal(
        countMatches(
          main,
          /\.progress-complete-icon \{[^}]*color: var\(--success\)/g,
        ),
        1,
        "progress icon lost its fill token",
      );
      assert.equal(
        countMatches(base, /--accent-text:/g),
        3,
        "accent-text is not defined in the dark, purple, and light themes",
      );
      assert.ok(
        countMatches(base, /--success-text:/g) >= 3,
        "success-text is not defined per theme",
      );
      return {
        queueTextToken: true,
        fillTokensKept: true,
      };
    });
  });

  it("keeps the modal inside the minimum window and scrolls its message", async () => {
    const window900 = await applyMinimumWindow();
    const resized = window900.resized;
    modalSnapshot = resized ? await measureLongModal() : null;
    shortModalSnapshot = null;

    await scenario("window-resized-900x560-modal", [9], async () => {
      if (!resized) {
        return {
          notProven: true,
          resized: false,
          outer: window900.outer,
          inner: window900.inner,
          reason: "the platform did not apply a 900x560 window",
        };
      }
      return { resized: true, outer: window900.outer, inner: window900.inner };
    });

    const reasonNotResized = "the platform did not apply a 900x560 window";

    await scenario("modal-buttons-in-viewport", [6], async () => {
      if (!modalSnapshot)
        return { notProven: true, resized: false, reason: reasonNotResized };
      assert.equal(
        modalSnapshot.messageLength,
        4000,
        "message is not 4000 characters",
      );
      assert.ok(modalSnapshot.buttons.length >= 2, "modal buttons are missing");
      const offending = modalSnapshot.buttons.filter(
        (button) => !insideViewport(button, modalSnapshot.viewport),
      );
      assert.equal(
        offending.length,
        0,
        "a modal button is outside the viewport",
      );
      for (const button of modalSnapshot.afterScroll.buttons) {
        assert.ok(
          insideViewport(button, modalSnapshot.viewport),
          "a modal button left the viewport after the message scrolled",
        );
      }
      return {
        viewport: modalSnapshot.viewport,
        buttons: modalSnapshot.buttons.map((button) => button.label),
      };
    });

    await scenario("modal-box-within-viewport", [7], async () => {
      if (!modalSnapshot)
        return { notProven: true, resized: false, reason: reasonNotResized };
      const height = modalSnapshot.box.bottom - modalSnapshot.box.top;
      assert.ok(
        height <= modalSnapshot.viewport.height,
        `modal box is ${height}px in a ${modalSnapshot.viewport.height}px viewport`,
      );
      assert.ok(
        insideViewport(modalSnapshot.box, modalSnapshot.viewport),
        "modal box is outside the viewport",
      );
      return {
        boxHeight: height,
        viewportHeight: modalSnapshot.viewport.height,
      };
    });

    await scenario("modal-message-scrolls", [8], async () => {
      if (!modalSnapshot)
        return { notProven: true, resized: false, reason: reasonNotResized };
      const { message } = modalSnapshot;
      assert.ok(
        message.scrollHeight > message.clientHeight,
        `message does not overflow (${message.scrollHeight} <= ${message.clientHeight})`,
      );
      assert.ok(
        ["auto", "scroll"].includes(message.overflowY),
        `message overflow-y is ${message.overflowY}`,
      );
      assert.ok(
        modalSnapshot.afterScroll.scrollTop > 0,
        "message did not scroll after scrollTop was set to its end",
      );
      return {
        scrollHeight: message.scrollHeight,
        clientHeight: message.clientHeight,
        scrollTop: modalSnapshot.afterScroll.scrollTop,
      };
    });

    shortModalSnapshot = resized ? await measureShortModal() : null;

    await scenario("modal-short-message-visible", [10], async () => {
      if (!shortModalSnapshot)
        return { notProven: true, resized: false, reason: reasonNotResized };
      const { message, title, box, viewport } = shortModalSnapshot;
      assert.ok(
        message.scrollHeight <= message.clientHeight + 1,
        `short message overflows (${message.scrollHeight} > ${message.clientHeight})`,
      );
      assert.equal(message.text, "Short note.", "short message text changed");
      assert.ok(
        insideViewport(title, viewport),
        "short modal heading is outside the viewport",
      );
      assert.ok(
        insideViewport(box, viewport),
        "short modal box is outside the viewport",
      );
      return { heading: title.text, boxTop: box.top };
    });
  });

  it("keeps the empty queue textarea free of scrollbars and resize grip", async () => {
    queueSnapshot = await measureQueue("");

    await scenario("queue-empty-no-scrollbar", [11], async () => {
      assert.equal(
        queueSnapshot.placeholderShown,
        true,
        "placeholder is not shown",
      );
      assert.ok(
        queueSnapshot.scrollHeight <= queueSnapshot.clientHeight,
        `queue textarea scrolls (${queueSnapshot.scrollHeight} > ${queueSnapshot.clientHeight})`,
      );
      // offsetWidth and clientWidth are each rounded to whole pixels while
      // borders can be fractional at a scaled display, so up to 1px is rounding.
      // A real scrollbar gutter is several pixels wide.
      assert.ok(
        queueSnapshot.verticalScrollbarPx < 1,
        `vertical scrollbar gutter ${queueSnapshot.verticalScrollbarPx}px`,
      );
      assert.ok(
        queueSnapshot.horizontalScrollbarPx < 1,
        `horizontal scrollbar gutter ${queueSnapshot.horizontalScrollbarPx}px`,
      );
      return {
        scrollHeight: queueSnapshot.scrollHeight,
        clientHeight: queueSnapshot.clientHeight,
      };
    });

    await scenario("queue-resize-none", [12], async () => {
      assert.equal(
        queueSnapshot.resize,
        "none",
        `resize is ${queueSnapshot.resize}`,
      );
      return { resize: queueSnapshot.resize };
    });

    await scenario("queue-overflow-scrolls-content", [13], async () => {
      const lines = Array.from(
        { length: 6 },
        (_, index) => `https://example.com/v/${index}`,
      ).join("\n");
      const filled = await measureQueue(lines);
      assert.equal(
        filled.overflowY,
        "auto",
        `overflow-y is ${filled.overflowY}`,
      );
      assert.ok(
        filled.scrollHeight > filled.clientHeight,
        "six lines did not overflow the textarea",
      );
      const scrolled = await browser.execute(() => {
        const area = document.getElementById("queueUrlInput");
        area.scrollTop = area.scrollHeight;
        return area.scrollTop;
      });
      assert.ok(scrolled > 0, "textarea content cannot be scrolled to its end");
      await measureQueue("");
      return {
        scrollHeight: filled.scrollHeight,
        clientHeight: filled.clientHeight,
      };
    });

    await scenario("queue-typing-keeps-value", [14], async () => {
      const typed = await measureQueue("https://example.com/a");
      assert.equal(typed.value, "https://example.com/a", "typed value changed");
      assert.equal(typed.height, "64px", `filled height is ${typed.height}`);
      await measureQueue("");
      return { height: typed.height };
    });
  });

  it("keeps long URLs clear of the in-field buttons", async () => {
    const longUrl = `https://www.youtube.com/watch?v=${"A".repeat(260)}`;
    const valueState = await measureUrl(longUrl);
    const emptyState = await measureUrl("");
    const textEnd = (snap) =>
      snap.inputRight - snap.borderRight - snap.paddingRight;
    const need = (snap) => snap.actionsWidthWorst + snap.rightOffset;
    const byId = (list, id) => list.find((button) => button.id === id);

    await scenario("url-padding-clears-actions-group", [15], async () => {
      assert.ok(
        byId(valueState.natural, "clearUrl").visible,
        "clear button is not shown for a non-empty URL",
      );
      assert.ok(
        byId(emptyState.natural, "pasteUrl").visible,
        "paste button is not shown for an empty URL",
      );
      const needed = Math.max(need(valueState), need(emptyState));
      assert.ok(
        valueState.paddingRight >= needed,
        `padding-right ${valueState.paddingRight}px < actions ${needed}px`,
      );
      return {
        paddingRight: valueState.paddingRight,
        neededPx: needed,
        actionsWithValue: valueState.actionsWidthWorst,
        actionsEmpty: emptyState.actionsWidthWorst,
      };
    });

    await scenario("url-padding-clears-each-button", [16], async () => {
      const worstButtons = [
        ...valueState.worst.map((button) => ({ state: "value", ...button })),
        ...emptyState.worst.map((button) => ({ state: "empty", ...button })),
      ].filter((button) => button.visible);
      assert.ok(
        worstButtons.some((button) => button.id === "clearUrl"),
        "clear button is missing from the worst case",
      );
      for (const button of worstButtons) {
        const boundary = textEnd(
          button.state === "value" ? valueState : emptyState,
        );
        assert.ok(
          button.left >= boundary,
          `${button.state}: ${button.id} starts at ${button.left}px, inside the text area ending ${boundary}px`,
        );
      }
      return {
        buttons: worstButtons.map((button) => `${button.state}:${button.id}`),
      };
    });

    await scenario("url-padding-clears-natural-buttons", [17], async () => {
      const visible = [
        ...valueState.natural.map((button) => ({ state: "value", ...button })),
        ...emptyState.natural.map((button) => ({ state: "empty", ...button })),
      ].filter((button) => button.visible);
      assert.ok(
        visible.length >= 2,
        "fewer than two in-field buttons are visible",
      );
      for (const button of visible) {
        const boundary = textEnd(
          button.state === "value" ? valueState : emptyState,
        );
        assert.ok(
          button.left >= boundary,
          `${button.state}: ${button.id} starts at ${button.left}px, inside the text area`,
        );
      }
      return {
        previewDisplay: byId(valueState.natural, "previewBtn").visible
          ? "shown"
          : "hidden",
        visibleButtons: visible.map((button) => `${button.state}:${button.id}`),
      };
    });

    await measureUrl("");
  });

  it("keeps toasts clear of the dock toolbar and Download at the minimum window", async () => {
    const window900 = await applyMinimumWindow();
    const resized = window900.resized;
    toastSnapshot = resized ? await measureToast() : null;
    const notResized = {
      notProven: true,
      resized: false,
      reason: "the platform did not apply a 900x560 window",
    };

    await scenario("window-resized-900x560-toast", [21], async () => {
      if (!resized) return notResized;
      return { resized: true, outer: window900.outer, inner: window900.inner };
    });

    await scenario(
      "toast-clear-of-dock-toolbar-and-download",
      [18],
      async () => {
        if (!toastSnapshot) return notResized;
        assert.ok(
          toastSnapshot.dockExpanded,
          "dock is collapsed, so the toolbar is not shown",
        );
        assert.ok(toastSnapshot.toolbarVisible, "queue toolbar is not visible");
        assert.ok(
          toastSnapshot.downloadVisible,
          "Download button is not visible",
        );
        assert.equal(
          toastSnapshot.toasts.length,
          2,
          "both probe toasts must be shown",
        );
        for (const toast of toastSnapshot.toasts) {
          assert.equal(
            overlaps(toast.rect, toastSnapshot.toolbar),
            false,
            `${toast.type} toast overlaps the dock toolbar`,
          );
          assert.equal(
            overlaps(toast.rect, toastSnapshot.download),
            false,
            `${toast.type} toast overlaps the Download button`,
          );
        }
        return {
          toasts: toastSnapshot.toasts,
          toolbar: toastSnapshot.toolbar,
          download: toastSnapshot.download,
        };
      },
    );

    await scenario("toast-inside-viewport", [19], async () => {
      if (!toastSnapshot) return notResized;
      for (const toast of toastSnapshot.toasts) {
        assert.ok(
          insideViewport(toast.rect, toastSnapshot.viewport),
          `${toast.type} toast is outside the viewport`,
        );
      }
      return { viewport: toastSnapshot.viewport };
    });

    await scenario("toast-containers-do-not-stack", [20], async () => {
      if (!toastSnapshot) return notResized;
      const [first, second] = toastSnapshot.toasts;
      assert.ok(first && second, "both probe toasts are needed");
      assert.equal(
        overlaps(first.rect, second.rect),
        false,
        "polite and assertive toasts occupy the same space",
      );
      return {
        politeTop: toastSnapshot.politeTop,
        assertiveBottom: toastSnapshot.assertiveBottom,
      };
    });
  });
});
