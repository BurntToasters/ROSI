import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";
import { e2eBinaryPath, REPO_ROOT } from "../../helpers/profile.js";

// Readiness hint next to Download, folder feedback, long content, and the
// queue live-region markup. Failure modes: ui-polish/failure-modes.md rows 5a to 5f,
// 11a, 15a, and D6.

const MEDIA = process.env.ROSI_E2E_MEDIA_URL;
const CLIP_BASE = MEDIA || "https://example.test";
// The E2E app only accepts download folders inside its profile (its home), so folder
// fixtures live under the profile's downloads folder, not the repository.
const DOWNLOADS = process.env.ROSI_E2E_DOWNLOADS;
const FOLDERS = DOWNLOADS ? path.join(DOWNLOADS, "rosi-readiness") : null;

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish-readiness",
  `${stamp}-${process.pid}`,
);
const screenshotDir = path.join(artifactDir, "screenshots");
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-readiness",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  runtime: { node: process.version },
  source: null,
  binary: null,
  checks: [],
  screenshots: [],
};

// Copied from ui-polish.spec.js on purpose: that spec belongs to another worker.
const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

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
  fs.mkdirSync(screenshotDir, { recursive: true });
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  const temporaryPath = `${reportPath}.tmp`;
  fs.writeFileSync(temporaryPath, contents);
  fs.renameSync(temporaryPath, reportPath);
  fs.writeFileSync(
    `${reportPath}.sha256`,
    `${sha256(contents)}  report.json\n`,
  );
}

async function scenario(name, body) {
  try {
    const details = await body();
    report.checks.push({ name, status: "passed", ...details });
    writeReport();
  } catch (error) {
    report.checks.push({
      name,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    });
    writeReport();
    throw error;
  }
}

async function clickById(id) {
  await browser.execute((target) => {
    const element = document.getElementById(target);
    if (!element) throw new Error(`missing element ${target}`);
    element.click();
  }, id);
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

async function setUrl(value) {
  await browser.execute((next) => {
    const url = document.getElementById("url");
    url.value = next;
    url.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function waitFor(
  predicate,
  message,
  timeout = 10_000,
  argument = undefined,
) {
  await browser.waitUntil(async () => browser.execute(predicate, argument), {
    timeout,
    interval: 100,
    timeoutMsg: message,
  });
}

/**
 * Reload the page and wait until its controls and bridge are installed.
 * Uses a deferred location.reload, like the other reloading specs. WebDriver
 * refresh left the next script waiting for the full 30 s script timeout.
 */
async function reloadApp() {
  await browser.execute(() => {
    window.__ROSI_E2E__.ready = false;
    window.setTimeout(() => window.location.reload(), 50);
  });
  // Waits for the new document: the old page still has the bridge until it unloads.
  await waitForAppReady();
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          document.readyState === "complete" &&
          typeof window.api?.resolveDownloadOptions === "function" &&
          typeof window.api?.addToQueue === "function" &&
          Boolean(document.getElementById("profileCustomBtn")) &&
          Boolean(document.getElementById("downloadBtn")),
      ),
    {
      timeout: 60_000,
      timeoutMsg: "reloaded page never rendered the main window controls",
    },
  );
}

/** Save folder-related settings through the API, then reload so the renderer reads them. */
async function setFolderSettings(settings) {
  const saved = await api("saveSettings", {
    downloadMode: "compatible",
    advancedOptions: false,
    bestQuality: false,
    audioOnly: false,
    showConsoleOutput: true,
    ...settings,
  });
  assert.equal(saved.ok, true, saved.error?.message);
  await reloadApp();
}

async function readHint() {
  return browser.execute(() => {
    const hint = document.getElementById("downloadReadiness");
    return {
      text: hint?.textContent.trim() ?? "",
      hidden: hint?.hidden ?? true,
      tone: hint?.dataset.tone ?? null,
      describedBy:
        document
          .getElementById("downloadBtn")
          ?.getAttribute("aria-describedby") ?? null,
    };
  });
}

async function waitForSummaryState(state, timeout = 10_000) {
  try {
    await waitFor(
      (want) =>
        document.getElementById("downloadOutputSummary")?.dataset.state ===
        want,
      `effective options never reached ${state}`,
      timeout,
      state,
    );
  } catch (error) {
    const seen = await browser.execute(() => ({
      summary:
        document.getElementById("downloadOutputSummary")?.dataset.state ?? null,
      text:
        document.getElementById("downloadOutputSummary")?.textContent.trim() ??
        "",
      save:
        document.getElementById("settingsSaveFeedback")?.dataset.state ?? null,
      ask:
        document.getElementById("askDownloadLocationToggle")?.checked ?? null,
      folder:
        document.getElementById("downloadFolderSummary")?.textContent.trim() ??
        "",
    }));
    throw new Error(`${error.message}; saw ${JSON.stringify(seen)}`);
  }
}

/** Record calls to the download bridge and refuse to start a real download. */
async function stubDownloadVideo() {
  await browser.execute(() => {
    window.__uiReadinessDownloadCalls = [];
    window.__uiReadinessOriginalDownloadVideo = window.api.downloadVideo;
    window.api.downloadVideo = async (options) => {
      window.__uiReadinessDownloadCalls.push(
        JSON.parse(JSON.stringify(options)),
      );
      return {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Download start stubbed by the readiness scenario",
        },
      };
    };
  });
}

async function downloadCalls() {
  return browser.execute(() => window.__uiReadinessDownloadCalls?.length ?? 0);
}

async function restoreDownloadVideo() {
  await browser.execute(() => {
    if (window.__uiReadinessOriginalDownloadVideo) {
      window.api.downloadVideo = window.__uiReadinessOriginalDownloadVideo;
    }
    delete window.__uiReadinessOriginalDownloadVideo;
  });
}

/** Replace the folder picker. Mode "cancel" returns null, "fail" throws, "path" returns the fixture. */
async function setPicker(mode, fixturePath = "") {
  await browser.execute(
    (nextMode, nextPath) => {
      if (!window.__uiReadinessPicker) {
        const state = {
          original: window.api.selectDownloadLocation,
          calls: 0,
          mode: "cancel",
          fixturePath: "",
        };
        window.__uiReadinessPicker = state;
        window.api.selectDownloadLocation = async () => {
          state.calls += 1;
          if (state.mode === "fail") throw new Error("stub picker failure");
          if (state.mode === "cancel") return null;
          return state.fixturePath;
        };
      }
      window.__uiReadinessPicker.mode = nextMode;
      window.__uiReadinessPicker.fixturePath = nextPath;
    },
    mode,
    fixturePath,
  );
}

async function pickerCalls() {
  return browser.execute(() => window.__uiReadinessPicker?.calls ?? 0);
}

async function restorePicker() {
  await browser.execute(() => {
    if (window.__uiReadinessPicker) {
      window.api.selectDownloadLocation = window.__uiReadinessPicker.original;
      delete window.__uiReadinessPicker;
    }
  });
}

/** The folder the backend stored, so a pick that only changed the UI fails here. */
async function persistedFolder() {
  const result = await api("getSettings");
  const settings = result?.data ?? result;
  return settings?.downloadFolder ?? "";
}

async function folderFeedback() {
  return browser.execute(() => {
    const feedback = document.getElementById("downloadFolderFeedback");
    return {
      text: feedback?.textContent.trim() ?? "",
      hidden: feedback?.hidden ?? true,
    };
  });
}

async function saveScreenshotFor(name, theme) {
  const destination = path.join(screenshotDir, name);
  await browser.saveScreenshot(destination);
  report.screenshots.push({
    path: path.relative(artifactDir, destination).replaceAll(path.sep, "/"),
    sha256: sha256(fs.readFileSync(destination)),
    theme,
  });
}

/**
 * Find overflow inside the given regions. Clipped boxes (overflow other than
 * visible) truncate by design, so they must stay inside their region's box.
 * Unclipped boxes must not have content that spills past their own box.
 */
async function measureRegions(selectors) {
  return browser.execute((targets) => {
    const violations = [];
    const docOverflow =
      document.documentElement.scrollWidth - window.innerWidth;
    if (docOverflow > 1) {
      violations.push({
        selector: "document",
        reason: `scrolls ${docOverflow}px wide`,
      });
    }
    const checked = [];
    for (const selector of targets) {
      const region = document.querySelector(selector);
      if (!region || region.getClientRects().length === 0) {
        violations.push({ selector, reason: "region not rendered" });
        continue;
      }
      const regionRect = region.getBoundingClientRect();
      if (regionRect.right > window.innerWidth + 1) {
        violations.push({
          selector,
          reason: "region extends past the viewport",
        });
      }
      const nodes = [region, ...region.querySelectorAll("*")];
      for (const node of nodes) {
        if (node.getClientRects().length === 0) continue;
        const style = getComputedStyle(node);
        checked.push(selector);
        if (style.overflowX === "visible") {
          if (node.scrollWidth > node.clientWidth + 1) {
            violations.push({
              selector,
              tag: node.tagName.toLowerCase(),
              className: String(node.className),
              reason: `content spills ${node.scrollWidth - node.clientWidth}px past its box`,
            });
          }
        } else {
          const box = node.getBoundingClientRect();
          if (box.right > regionRect.right + 1) {
            violations.push({
              selector,
              tag: node.tagName.toLowerCase(),
              className: String(node.className),
              reason: "clipped box extends past its region",
            });
          }
        }
      }
    }
    return {
      violations,
      nodesChecked: checked.length,
      documentOverflowPx: Math.max(0, docOverflow),
    };
  }, selectors);
}

describe("ROSI UI readiness, folder feedback, and long content", () => {
  let originalWindowSize = null;

  before(async () => {
    fs.mkdirSync(screenshotDir, { recursive: true });
    assert.ok(DOWNLOADS, "ROSI_E2E_DOWNLOADS is required for folder fixtures");
    fs.mkdirSync(FOLDERS, { recursive: true });
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
    if (originalWindowSize) {
      await browser.setWindowSize(
        originalWindowSize.width,
        originalWindowSize.height,
      );
    }
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

  it("uses the Downloads folder without a picker when the folder is empty and ask-each-time is off", async () =>
    scenario("missing-folder-ask-off-uses-default", async () => {
      await setFolderSettings({
        askDownloadLocation: false,
        downloadFolder: "",
      });
      await setUrl(`${CLIP_BASE}/readiness-default-folder.mp4`);
      await waitForSummaryState("resolved");
      const before = await readHint();
      assert.match(before.text, /Downloads folder/);
      assert.equal(before.hidden, false, "default-folder hint is hidden");
      assert.equal(before.tone, "info");
      assert.match(before.describedBy ?? "", /downloadReadiness/);

      await stubDownloadVideo();
      try {
        await clickById("downloadBtn");
        await waitFor(
          () => (window.__uiReadinessDownloadCalls?.length ?? 0) === 1,
          "download request was not sent",
          10_000,
        );
        const request = await browser.execute(
          () => window.__uiReadinessDownloadCalls[0],
        );
        assert.equal(
          Object.prototype.hasOwnProperty.call(request, "outputPath"),
          false,
          "an empty folder must not send an outputPath from the renderer",
        );
        assert.equal(await pickerCalls(), 0, "Download opened a folder picker");
      } finally {
        await restoreDownloadVideo();
      }
      return { hintTone: before.tone, sentOutputPath: false };
    }));

  it("explains that a folder is asked for each download and keeps the blocker-free flow", async () =>
    scenario("ask-each-time-hint", async () => {
      await setFolderSettings({
        askDownloadLocation: true,
        downloadFolder: "",
      });
      await setControl("askDownloadLocationToggle", true);
      await setUrl(`${CLIP_BASE}/readiness-ask-each-time.mp4`);
      await waitForSummaryState("destination");
      const hint = await readHint();
      assert.match(hint.text, /ROSI will ask where to save this download/);
      assert.equal(hint.hidden, false);
      assert.equal(hint.tone, "info");

      await setPicker("cancel");
      await stubDownloadVideo();
      try {
        await clickById("downloadBtn");
        await waitFor(
          () => window.__uiReadinessPicker?.calls >= 1,
          "ask-each-time did not open the folder picker",
          10_000,
        );
        await waitFor(
          () =>
            document
              .getElementById("output")
              ?.textContent.includes("No save location selected"),
          "cancelled per-download picker did not report the cancel",
          10_000,
        );
        assert.equal(
          await downloadCalls(),
          0,
          "download started without a folder",
        );
      } finally {
        await restoreDownloadVideo();
        await restorePicker();
      }
      return { hintTone: hint.tone };
    }));

  it("names a blocking format choice next to Download and does not start", async () =>
    scenario("formats-blocker-next-to-download", async () => {
      await setFolderSettings({
        askDownloadLocation: false,
        downloadFolder: "",
      });
      await clickById("profileCustomBtn");
      await waitFor(
        () =>
          document
            .getElementById("profileCustomBtn")
            ?.getAttribute("aria-pressed") === "true",
        "custom profile was not selected",
        5_000,
      );
      await setUrl(`${CLIP_BASE}/readiness-formats.mp4`);
      await waitFor(
        () =>
          /video or audio format/.test(
            document.getElementById("downloadReadiness")?.textContent ?? "",
          ),
        "format blocker was not shown next to Download",
        10_000,
      );
      const hint = await readHint();
      assert.equal(hint.tone, "blocked");
      assert.match(hint.text, /Check available formats/);

      await stubDownloadVideo();
      try {
        await clickById("downloadBtn");
        await browser.pause(300);
        assert.equal(
          await downloadCalls(),
          0,
          "a blocked download reached the bridge",
        );
      } finally {
        await restoreDownloadVideo();
      }
      await clickById("profileCompatibleBtn");
      return { blocker: "formats", tone: hint.tone };
    }));

  it("keeps the failed effective-options reason and next action next to Download", async () =>
    scenario("resolve-failure-hint-next-to-download", async () => {
      await setFolderSettings({
        askDownloadLocation: false,
        downloadFolder: "",
      });
      await browser.execute(() => {
        window.__uiReadinessResolveOriginal = window.api.resolveDownloadOptions;
        window.api.resolveDownloadOptions = async () => ({
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "Format lookup stub failed",
          },
        });
      });
      try {
        await setUrl(`${CLIP_BASE}/readiness-resolve-failed.mp4?case=failed`);
        await waitForSummaryState("error");
        const failed = await readHint();
        assert.equal(failed.tone, "error");
        assert.match(failed.text, /Format lookup stub failed/);
        assert.match(failed.text, /still checks these options/);
      } finally {
        await browser.execute(() => {
          window.api.resolveDownloadOptions =
            window.__uiReadinessResolveOriginal;
          delete window.__uiReadinessResolveOriginal;
        });
      }
      await setUrl(`${CLIP_BASE}/readiness-resolve-recovered.mp4?case=ok`);
      await waitForSummaryState("resolved");
      const recovered = await readHint();
      assert.match(
        recovered.text,
        /Downloads folder/,
        "hint did not clear after recovery",
      );
      return { recoveredTone: recovered.tone };
    }));

  it("explains turning ask-each-time off with no folder, including a cancelled pick", async () =>
    scenario("ask-off-cancelled-folder-feedback", async () => {
      await setFolderSettings({
        askDownloadLocation: true,
        downloadFolder: "",
      });
      const fixture = path.join(FOLDERS, "switched-folder");
      fs.mkdirSync(fixture, { recursive: true });
      await setPicker("cancel");
      try {
        await setControl("askDownloadLocationToggle", false);
        await waitFor(
          () =>
            document.getElementById("downloadFolderFeedback")?.hidden === false,
          "turning ask-each-time off with no folder showed no feedback",
          10_000,
        );
        const cancelled = await folderFeedback();
        assert.equal(
          cancelled.text,
          "No folder was chosen. Choose a folder or ask ROSI before each download.",
        );
        const toggled = await browser.execute(
          () => document.getElementById("askDownloadLocationToggle").checked,
        );
        assert.equal(
          toggled,
          false,
          "a cancelled pick turned ask-each-time back on",
        );

        await setControl("askDownloadLocationToggle", true);
        await setPicker("path", fixture);
        await setControl("askDownloadLocationToggle", false);
        await waitFor(
          (expected) =>
            document
              .getElementById("downloadFolderSummary")
              ?.textContent.includes(expected),
          "folder chosen after switching ask-each-time off was not saved",
          10_000,
          path.basename(fixture),
        );
        assert.equal((await folderFeedback()).hidden, true);
        await browser.waitUntil(
          async () =>
            path.basename(await persistedFolder()) === path.basename(fixture),
          { timeout: 10_000, timeoutMsg: "chosen folder was not saved" },
        );
        return { cancelledText: cancelled.text };
      } finally {
        await restorePicker();
      }
    }));

  it("explains a cancelled or failed Change folder pick and keeps the stale path out", async () =>
    scenario("change-folder-cancelled-and-failed", async () => {
      await setFolderSettings({
        askDownloadLocation: false,
        downloadFolder: "",
      });
      const fixture = path.join(FOLDERS, "picked-folder");
      fs.mkdirSync(fixture, { recursive: true });
      await setPicker("cancel");
      try {
        const beforeText = await browser.execute(() =>
          document.getElementById("downloadFolderSummary")?.textContent.trim(),
        );
        await clickById("changeDownloadFolderBtn");
        await waitFor(
          () => !document.getElementById("downloadFolderFeedback")?.hidden,
          "cancelled pick showed no feedback",
          10_000,
        );
        const cancelled = await folderFeedback();
        assert.equal(
          cancelled.text,
          "No folder was chosen. Choose a folder or ask ROSI before each download.",
        );

        await setPicker("fail");
        await clickById("changeDownloadFolderBtn");
        await waitFor(
          () =>
            document
              .getElementById("downloadFolderFeedback")
              ?.textContent.includes("could not open the folder picker"),
          "failed pick did not explain the failure",
          10_000,
        );
        const failed = await folderFeedback();
        assert.equal(
          failed.text,
          "ROSI could not open the folder picker. Try again or ask before each download.",
        );
        const afterText = await browser.execute(() =>
          document.getElementById("downloadFolderSummary")?.textContent.trim(),
        );
        assert.equal(
          afterText,
          beforeText,
          "a failed pick changed the shown folder",
        );

        await setControl("askDownloadLocationToggle", true);
        await waitFor(
          () =>
            document.getElementById("downloadFolderFeedback")?.hidden === true,
          "switching ask-each-time on did not clear the folder feedback",
          5_000,
        );
        await setPicker("cancel");
        await clickById("changeDownloadFolderBtn");
        await waitFor(
          () => window.__uiReadinessPicker?.calls >= 1,
          "picker was not called",
          5_000,
        );
        await browser.pause(200);
        const askOnCancel = await folderFeedback();
        assert.equal(
          askOnCancel.hidden,
          true,
          "cancel explained while ask-each-time is on",
        );

        await setPicker("path", fixture);
        await clickById("changeDownloadFolderBtn");
        await waitFor(
          (expected) =>
            document
              .getElementById("downloadFolderSummary")
              ?.textContent.includes(expected),
          "chosen folder was not shown",
          10_000,
          path.basename(fixture),
        );
        assert.equal((await folderFeedback()).hidden, true);
        await browser.waitUntil(
          async () =>
            path.basename(await persistedFolder()) === path.basename(fixture),
          { timeout: 10_000, timeoutMsg: "chosen folder was not saved" },
        );
        return {
          cancelled: cancelled.text,
          failed: failed.text,
          askOnCancelHidden: askOnCancel.hidden,
        };
      } finally {
        await restorePicker();
      }
    }));

  it("keeps long URLs, paths, titles, and errors inside their regions at 900x560", async () =>
    scenario("long-content-no-horizontal-overflow", async () => {
      originalWindowSize = await browser.getWindowSize();
      // Two 200-character folder names: one name may not exceed 255 bytes, and the
      // path only needs to exist as a setting (validation walks up to a real parent).
      const longFolder = path.join(FOLDERS, "p".repeat(200), "q".repeat(200));
      const longUrl = `${CLIP_BASE}/${"u".repeat(380)}.mp4`;
      assert.ok(
        longFolder.length >= 400,
        `folder path is ${longFolder.length} characters`,
      );
      assert.ok(longUrl.length >= 400, `URL is ${longUrl.length} characters`);

      await browser.setWindowSize(900, 560);
      await setFolderSettings({
        askDownloadLocation: false,
        downloadFolder: longFolder,
      });
      await setPicker("path", longFolder);
      try {
        await setControl("askDownloadLocationToggle", false);
        await clickById("changeDownloadFolderBtn");
        await waitFor(
          (expected) =>
            document.getElementById("downloadFolderSummary")?.title ===
            expected,
          "long folder was not chosen",
          10_000,
          longFolder,
        );
      } finally {
        await restorePicker();
      }
      await setControl("consoleToggle", true);
      await browser.pause(250);

      await clickById("dockTabQueue");
      assert.equal((await api("clearQueue")).ok, true);
      assert.equal((await api("addToQueue", [longUrl])).ok, true);
      await waitFor(
        () => document.querySelectorAll("#queueList .queue-item").length >= 1,
        "long queue item did not render",
        10_000,
      );

      await clickById("dockTabActivity");
      await waitFor(
        () => document.getElementById("download-history")?.hidden === false,
        "activity panel did not open",
        5_000,
      );
      await browser.execute(
        (outputPath, longTitle, longError) => {
          window.__TAURI__.event.emit("download-activity-update", [
            {
              id: "ui-readiness-long-content",
              owner: "manual",
              outcome: "failed",
              statusMessage: longError,
              url: longTitle,
              request: { url: longTitle, outputPath },
              filename: longTitle,
              outputPath,
              outputPaths: [outputPath],
              error: longError,
              startedAt: Date.now() - 2000,
              completedAt: Date.now(),
            },
          ]);
          window.__TAURI__.event.emit("progress", `${"c".repeat(400)}`);
        },
        path.join(longFolder, `${"o".repeat(200)}.mkv`),
        `https://example.test/${"t".repeat(380)}`,
        "E".repeat(400),
      );
      await waitFor(
        () =>
          [...document.querySelectorAll("#history-list .history-item")].some(
            (row) =>
              row.querySelector(".history-error")?.textContent.length >= 400,
          ),
        "long activity entry did not render",
        10_000,
      );
      await waitFor(
        () =>
          document
            .getElementById("output")
            ?.textContent.includes("c".repeat(400)),
        "long console line did not render",
        10_000,
      );

      await browser.execute((longError) => {
        window.__uiReadinessResolveOriginal = window.api.resolveDownloadOptions;
        window.api.resolveDownloadOptions = async () => ({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: longError },
        });
      }, "R".repeat(400));
      try {
        await setUrl(`${CLIP_BASE}/readiness-long-error.mp4?case=long-error`);
        await waitForSummaryState("error");
      } finally {
        await browser.execute(() => {
          window.api.resolveDownloadOptions =
            window.__uiReadinessResolveOriginal;
          delete window.__uiReadinessResolveOriginal;
        });
      }

      // A region is measured only while it is rendered, so the activity panel is
      // measured on its own tab and the queue on its tab.
      const onActivity = await measureRegions([
        "#download-history",
        ".download-destination",
        "#downloadOutputSummary",
        "#downloadReadiness",
      ]);
      // The console is its own dock tab; #output is measured only while it is shown.
      await clickById("dockTabConsole");
      await waitFor(
        () => document.getElementById("output")?.getClientRects().length > 0,
        "console panel did not open",
        5_000,
      );
      const onConsole = await measureRegions(["#output"]);
      await clickById("dockTabQueue");
      await waitFor(
        () => !document.getElementById("queueSection")?.hidden,
        "queue panel did not open",
        5_000,
      );
      // #queueStatusMessage is :empty (display none) here, so it has no box to measure.
      const onQueue = await measureRegions(["#queueSection"]);
      const measured = {
        violations: [
          ...onActivity.violations,
          ...onConsole.violations,
          ...onQueue.violations,
        ],
        nodesChecked:
          onActivity.nodesChecked +
          onConsole.nodesChecked +
          onQueue.nodesChecked,
        documentOverflowPx: Math.max(
          onActivity.documentOverflowPx,
          onConsole.documentOverflowPx,
          onQueue.documentOverflowPx,
        ),
      };
      assert.equal(
        measured.violations.length,
        0,
        `layout overflow: ${JSON.stringify(measured.violations.slice(0, 8))}`,
      );
      assert.equal(
        measured.documentOverflowPx,
        0,
        "document scrolls horizontally",
      );
      const theme = await browser.execute(
        () => document.documentElement.dataset.theme ?? "default",
      );
      await saveScreenshotFor("long-content-900x560.png", theme);
      return {
        viewport: "900x560",
        nodesChecked: measured.nodesChecked,
        folderPathLength: longFolder.length,
        urlLength: longUrl.length,
      };
    }));

  it("keeps the queue live region announced from the markup", async () =>
    scenario("queue-status-live-region-markup", async () => {
      const indexHtml = fs.readFileSync(
        path.join(REPO_ROOT, "src", "index.html"),
        "utf8",
      );
      const tag =
        indexHtml.match(/<p\b[^>]*\bid="queueStatusMessage"[^>]*>/)?.[0] ?? "";
      assert.match(tag, /\brole="status"/, "markup lacks role=status");
      assert.match(
        tag,
        /\baria-live="polite"/,
        "markup lacks aria-live=polite",
      );
      assert.match(
        tag,
        /\baria-atomic="true"/,
        "markup lacks aria-atomic=true",
      );

      const live = await browser.execute(() => {
        const element = document.getElementById("queueStatusMessage");
        return {
          tagName: element?.tagName ?? null,
          role: element?.getAttribute("role") ?? null,
          ariaLive: element?.getAttribute("aria-live") ?? null,
          ariaAtomic: element?.getAttribute("aria-atomic") ?? null,
        };
      });
      assert.equal(live.tagName, "P");
      assert.equal(live.role, "status");
      assert.equal(live.ariaLive, "polite");
      assert.equal(live.ariaAtomic, "true");

      const engineSource = fs.readFileSync(
        path.join(REPO_ROOT, "src", "rosiEngine.ts"),
        "utf8",
      );
      assert.doesNotMatch(
        engineSource,
        /queueStatusMessage\.setAttribute/,
        "rosiEngine.ts still sets live-region attributes at runtime",
      );
      return { markupTag: tag.length > 0, live };
    }));
});
