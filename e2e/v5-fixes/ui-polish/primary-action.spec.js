import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";
import { processesMatching } from "../../helpers/host.js";
import { activityFor, waitFor } from "../../helpers/ui.js";
import { REPO_ROOT } from "../../helpers/profile.js";

// Failure modes are numbered in primary-action.failure-modes.md. Each check
// lists the rows it covers.

const MEDIA = process.env.ROSI_E2E_MEDIA_URL;

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-primary-action-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-primary-action",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  runtime: { node: process.version },
  source: null,
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

async function scenario(name, failureModes, body) {
  try {
    const details = await body();
    report.checks.push({
      name,
      status: "passed",
      failureModes,
      invariantPassed: true,
      ...details,
    });
    writeReport();
  } catch (error) {
    report.checks.push({
      name,
      status: "failed",
      failureModes,
      invariantPassed: false,
      reason: error instanceof Error ? error.message : String(error),
    });
    writeReport();
    throw error;
  }
}

// Resolves after two animation frames, so every microtask and frame callback
// queued by the last action has run.
async function nextFrames() {
  await browser.executeAsync((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => done(true)));
  });
}

// Wraps bridge methods so the page counts their calls. Each call passes
// through. restoreStubs() puts the real methods back.
async function countBridgeCalls(...names) {
  await browser.execute((methods) => {
    const bridge = window.__ROSI_E2E__.api;
    const watch = (window.__primaryWatch ??= { original: {}, count: {} });
    for (const name of methods) {
      if (!(name in watch.original)) watch.original[name] = bridge[name];
      watch.count[name] = 0;
      bridge[name] = (...args) => {
        watch.count[name] += 1;
        return watch.original[name].apply(bridge, args);
      };
    }
  }, names);
}

function watchedCallCount(name) {
  return browser.execute(
    (method) => window.__primaryWatch?.count[method] ?? 0,
    name,
  );
}

// Counts every write to the readiness hint. A queue refusal rewrites the hint
// text each time, even when the text is the same.
async function watchHintWrites() {
  await browser.execute(() => {
    window.__primaryHintObserver?.disconnect();
    window.__primaryHintWrites = 0;
    const hint = document.getElementById("downloadReadiness");
    const observer = new MutationObserver((records) => {
      window.__primaryHintWrites += records.length;
    });
    observer.observe(hint, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    window.__primaryHintObserver = observer;
  });
}

async function waitForHintWrite(message) {
  await waitFor(() => window.__primaryHintWrites >= 1, message, 10_000);
}

async function waitForActivity(predicate, message, timeout = 120_000) {
  let match = null;
  await browser.waitUntil(
    async () => {
      match = (await api("getDownloadActivity")).data.find(predicate) ?? null;
      return Boolean(match);
    },
    { timeout, interval: 500, timeoutMsg: message },
  );
  return match;
}

async function waitForQueueStatus(url, status, message, timeout = 60_000) {
  await browser.waitUntil(
    async () =>
      (await api("getQueue")).some(
        (item) => item.url === url && item.status === status,
      ),
    { timeout, interval: 250, timeoutMsg: message },
  );
}

async function resetQueue() {
  await api("cancelQueue");
  assert.equal((await api("clearQueue")).ok, true);
}

// Reads the Download button as the user sees it. Text only, so the result is ASCII.
async function readDownloadButton() {
  return browser.execute(() => {
    const button = document.getElementById("downloadBtn");
    return {
      text: button?.textContent.trim() ?? null,
      disabled: button?.disabled ?? null,
      loading: button?.classList.contains("loading") ?? false,
    };
  });
}

// The readiness hint can hold non-ASCII text, which the WebDriver bridge rejects.
async function readHint() {
  return browser.execute(() => {
    const hint = document.getElementById("downloadReadiness");
    return {
      text: (hint?.textContent ?? "").trim().replace(/[^\x20-\x7e]/g, "?"),
      hidden: hint?.hidden ?? true,
      tone: hint?.dataset.tone ?? null,
    };
  });
}

// The console can hold non-ASCII text, so the check runs in the page.
function consoleContains(needle) {
  return browser.execute(
    (text) =>
      (document.getElementById("output")?.textContent ?? "").includes(text),
    needle,
  );
}

function stubCallCount() {
  return browser.execute(() => window.__primaryDownloadCalls ?? 0);
}

async function progressBarVisible() {
  return browser.execute(
    () =>
      document
        .getElementById("progress-container")
        ?.classList.contains("visible") === true,
  );
}

async function waitForButtonReady(
  message = "Download button never became ready",
) {
  await waitFor(
    () => {
      const button = document.getElementById("downloadBtn");
      return (
        Boolean(button) &&
        !button.disabled &&
        !button.classList.contains("loading")
      );
    },
    message,
    15_000,
  );
}

// Types the link into the URL field the way a user does, then presses the button.
async function startUiDownload(url) {
  const input = await browser.$("#url");
  await input.setValue(url);
  await waitForButtonReady();
  await (await browser.$("#downloadBtn")).click();
}

async function setUrl(url) {
  const input = await browser.$("#url");
  await input.setValue(url);
  await waitForButtonReady();
}

async function stubOpenFileLocation(response) {
  await browser.execute((result) => {
    window.__primaryOpened = [];
    if (!window.__primaryOriginalOpen) {
      window.__primaryOriginalOpen = window.__ROSI_E2E__.api.openFileLocation;
    }
    window.__ROSI_E2E__.api.openFileLocation = async (filePath) => {
      window.__primaryOpened.push(filePath);
      return result;
    };
  }, response);
}

// The stub refuses the request, so a click that is not gated shows up as a call
// without starting a real download.
async function stubDownloadVideo() {
  await browser.execute(() => {
    window.__primaryDownloadCalls = 0;
    if (!window.__primaryOriginalDownload) {
      window.__primaryOriginalDownload = window.__ROSI_E2E__.api.downloadVideo;
    }
    window.__ROSI_E2E__.api.downloadVideo = async () => {
      window.__primaryDownloadCalls += 1;
      return {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Primary action stub refused the request.",
        },
      };
    };
  });
}

async function restoreStubs() {
  await browser.execute(() => {
    if (window.__primaryOriginalOpen) {
      window.__ROSI_E2E__.api.openFileLocation = window.__primaryOriginalOpen;
    }
    if (window.__primaryOriginalDownload) {
      window.__ROSI_E2E__.api.downloadVideo = window.__primaryOriginalDownload;
    }
    delete window.__primaryOriginalOpen;
    delete window.__primaryOriginalDownload;
    if (window.__primaryWatch) {
      Object.assign(window.__ROSI_E2E__.api, window.__primaryWatch.original);
      delete window.__primaryWatch;
    }
    window.__primaryHintObserver?.disconnect();
    delete window.__primaryHintObserver;
    if (window.__primaryUnsubscribe) window.__primaryUnsubscribe();
    delete window.__primaryUnsubscribe;
    // Clipboard overrides are own properties; deleting them restores the prototype.
    delete navigator.clipboard.writeText;
    delete document.execCommand;
    document
      .querySelectorAll("body > textarea")
      .forEach((node) => node.remove());
  });
}

async function clearToasts() {
  await browser.execute(() => {
    document.querySelectorAll(".toast").forEach((node) => node.remove());
  });
}

function lastToast() {
  return browser.execute(() => {
    const text =
      [...document.querySelectorAll(".toast .toast-message")].pop()
        ?.textContent ?? "";
    return text.trim().replace(/[^\x20-\x7e]/g, "?");
  });
}

async function waitForLastToast(matches, message) {
  let text = null;
  await browser.waitUntil(
    async () => {
      text = await lastToast();
      return matches(text ?? "");
    },
    {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: `${message}: last toast was ${JSON.stringify(text)}`,
    },
  );
  return text;
}

async function selectActivityRow(id, action) {
  await browser.execute(() =>
    window.__ROSI_E2E__.modules.dock.selectTab("activity"),
  );
  await waitFor(
    ([target, name]) =>
      [...document.querySelectorAll(".history-item")].some(
        (row) =>
          row.dataset.activityId === target &&
          Boolean(row.querySelector(`[data-activity-action="${name}"]`)),
      ),
    `activity row has no ${action} action`,
    15_000,
    [id, action],
  );
}

describe("ROSI primary action: Enter, queue refusal, result state, copy source", () => {
  before(async () => {
    await waitForAppReady();
    report.source = sourceIdentity();
    writeReport();
  });

  beforeEach(async () => {
    await resetQueue();
  });

  afterEach(async () => {
    await restoreStubs().catch(() => {});
  });

  after(async () => {
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

  it("keeps a running manual download running when Enter is pressed in the URL field", async function () {
    this.timeout(240_000);
    await scenario(
      "primary-action-enter-keeps-download",
      [1, 2, 22],
      async () => {
        const url = `${MEDIA}/slow.mp4?primary-action=enter`;
        await startUiDownload(url);
        await waitFor(
          () =>
            document
              .getElementById("downloadBtn")
              ?.classList.contains("loading") === true,
          "Download did not enter its running state",
          15_000,
        );
        await browser.waitUntil(
          async () => processesMatching("slow.mp4").length > 0,
          {
            timeout: 30_000,
            interval: 250,
            timeoutMsg: "yt-dlp never started for the manual download",
          },
        );

        await countBridgeCalls("cancelDownload", "downloadVideo");
        await (await browser.$("#url")).click();
        await browser.keys("Enter");
        // Enter is handled in the same task, so a wrong Cancel or a second
        // start would already have called the bridge; the frames flush the rest.
        await nextFrames();
        assert.equal(
          await watchedCallCount("cancelDownload"),
          0,
          "Enter called cancelDownload",
        );
        assert.equal(
          await watchedCallCount("downloadVideo"),
          0,
          "Enter started another download",
        );

        const during = await readDownloadButton();
        const cancelledDuringRun = (await activityFor(url)).some(
          (entry) => entry.outcome === "cancelled",
        );
        assert.equal(
          cancelledDuringRun,
          false,
          "Enter cancelled the running download",
        );
        assert.equal(
          during.loading,
          true,
          "Enter changed the running Download control",
        );
        // The run must stay alive after Enter. Activity is written only when a run
        // ends, so the yt-dlp process and the loading state are the signals here.
        const stillRunning = processesMatching("slow.mp4").length > 0;
        const stillLoading = (await readDownloadButton()).loading === true;
        const cancelledLater = (await activityFor(url)).some(
          (entry) => entry.outcome === "cancelled",
        );
        assert.equal(stillRunning, true, "Enter stopped yt-dlp");
        assert.equal(stillLoading, true, "Enter ended the loading state");
        assert.equal(
          cancelledLater,
          false,
          "Enter cancelled the running download",
        );

        // Stop the run through the Cancel control the user would click. The slow
        // fixture needs about 8.5 minutes to finish, so this check does not wait
        // for completion.
        await (await browser.$("#downloadBtn")).click();
        const stopped = await waitForActivity(
          (entry) => entry.url === url,
          "cancelled download never reached the activity log",
          60_000,
        );
        assert.equal(
          stopped.outcome,
          "cancelled",
          `Cancel control ended the run as ${stopped.outcome}`,
        );
        await browser.waitUntil(
          async () => processesMatching("slow.mp4").length === 0,
          {
            timeout: 30_000,
            interval: 250,
            timeoutMsg: "yt-dlp survived the Cancel control",
          },
        );
        assert.equal(
          (await activityFor(url)).length,
          1,
          "Enter started a second download",
        );
        return {
          runningAfterEnter: stillRunning,
          outcome: stopped.outcome,
          completionProven: false,
        };
      },
    );
  });

  it("refuses Download, Enter, and Download again during a queue run without touching the console", async function () {
    this.timeout(240_000);
    await scenario(
      "primary-action-queue-refusal",
      [3, 5, 6, 7, 8, 9, 10],
      async () => {
        const seed = `${MEDIA}/clip-one.mp4?primary-action=queue-seed`;
        const slow = `${MEDIA}/slow.mp4?primary-action=queue`;
        const single = `${MEDIA}/clip-two.mp4?primary-action=queue-single`;
        const batchA = `${MEDIA}/clip-one.mp4?primary-action=queue-batch-a`;
        const batchB = `${MEDIA}/clip-three.mp4?primary-action=queue-batch-b`;
        const sentinel = "primary-action-console-sentinel";

        // A finished download gives the activity row for the replay check.
        const seeded = await api("downloadVideo", { url: seed });
        assert.equal(seeded.ok, true, "seed download did not start");
        const seedEntry = await waitForActivity(
          (entry) => entry.url === seed && entry.outcome === "success",
          "seed download did not complete",
        );
        await selectActivityRow(seedEntry.id, "replay");

        assert.equal((await api("addToQueue", [slow])).data.added, 1);
        assert.equal((await api("startQueue")).ok, true);
        await waitForQueueStatus(
          slow,
          "downloading",
          "slow item never started",
        );
        await waitFor(
          () =>
            Boolean(document.querySelector(".queue-item.queue-downloading")),
          "queue row never showed as downloading",
          60_000,
        );
        await waitFor(
          () =>
            document
              .getElementById("progress-container")
              ?.classList.contains("visible") === true,
          "queue progress bar never showed",
          60_000,
        );

        await stubDownloadVideo();
        await setUrl(single);
        await browser.execute((text) => {
          document.getElementById("output").textContent = text;
        }, sentinel);

        // Download click during the queue run.
        await (await browser.$("#downloadBtn")).click();
        await waitFor(
          () => {
            const hint = document.getElementById("downloadReadiness");
            return (
              hint instanceof HTMLElement &&
              !hint.hidden &&
              /queue/i.test(hint.textContent)
            );
          },
          "refusal reason never reached #downloadReadiness",
          10_000,
        );
        const refused = await readHint();
        assert.equal(refused.tone, "blocked", "refusal tone is not blocked");
        assert.equal(
          await stubCallCount(),
          0,
          "Download sent a request during a queue run",
        );
        assert.equal(
          await consoleContains(sentinel),
          true,
          "Download changed the console during a queue run",
        );
        assert.equal(
          await progressBarVisible(),
          true,
          "Download reset the queue progress bar",
        );

        // Enter with the same link goes through the same gate.
        await (await browser.$("#url")).click();
        await watchHintWrites();
        await browser.keys("Enter");
        await waitForHintWrite("Enter was not refused with the queue reason");
        assert.equal(
          await stubCallCount(),
          0,
          "Enter sent a download request during a queue run",
        );

        // Download again from the activity row goes through the same gate.
        await browser.execute((id) => {
          const row = [...document.querySelectorAll(".history-item")].find(
            (candidate) => candidate.dataset.activityId === id,
          );
          const replay = row?.querySelector('[data-activity-action="replay"]');
          if (!replay) throw new Error("seed row has no Download again action");
          replay.click();
        }, seedEntry.id);
        await waitForHintWrite("Download again was not refused");
        assert.equal(
          await stubCallCount(),
          0,
          "Download again sent a request during a queue run",
        );
        assert.equal(
          await consoleContains(sentinel),
          true,
          "Download again cleared the console during a queue run",
        );
        assert.equal(
          (await activityFor(seed)).length,
          1,
          "Download again added an activity entry during a queue run",
        );

        // The reason clears on its own, so it cannot go stale after the queue ends.
        await waitFor(
          () =>
            !(
              document.getElementById("downloadReadiness")?.textContent ?? ""
            ).includes("A queue download is running"),
          "refusal reason stayed in #downloadReadiness",
          12_000,
        );

        // Several links pasted during the run are a queue add, not a refusal.
        await setUrl(`${batchA} ${batchB}`);
        await waitFor(
          () =>
            document
              .getElementById("downloadBtn")
              ?.textContent.includes("Add 2 to Queue") === true,
          "two links did not switch the button to Add to Queue",
          10_000,
        );
        await (await browser.$("#downloadBtn")).click();
        await browser.waitUntil(
          async () => {
            const urls = (await api("getQueue")).map((item) => item.url);
            return urls.includes(batchA) && urls.includes(batchB);
          },
          {
            timeout: 20_000,
            interval: 250,
            timeoutMsg: "pasted links were not added to the running queue",
          },
        );
        assert.equal(
          await stubCallCount(),
          0,
          "a multi-link paste started a manual download",
        );

        // Once the queue stops, Download starts a download again.
        assert.equal((await api("cancelQueue")).ok, true);
        await waitForQueueStatus(
          slow,
          "cancelled",
          "cancel did not stop the running item",
          60_000,
        );
        await waitFor(
          () => !document.querySelector(".queue-item.queue-downloading"),
          "queue row still showed as downloading after cancel",
          20_000,
        );
        await setUrl(single);
        await (await browser.$("#downloadBtn")).click();
        await browser.waitUntil(async () => (await stubCallCount()) === 1, {
          timeout: 10_000,
          interval: 200,
          timeoutMsg: "Download stayed blocked after the queue stopped",
        });
        return {
          refusal: refused.text,
          queueAddedLinks: 2,
          replayRefused: true,
        };
      },
    );
  });

  it("opens the folder from the result button and keeps the result when the button loses focus", async function () {
    this.timeout(180_000);
    await scenario("primary-action-result-open", [12, 14, 15], async () => {
      const url = `${MEDIA}/clip-one.mp4?primary-action=open`;
      await stubOpenFileLocation({ ok: true, data: { opened: true } });
      await startUiDownload(url);
      const entry = await waitForActivity(
        (item) => item.url === url && item.outcome === "success",
        "result download did not complete",
      );
      assert.ok(entry.outputPath, "completed download has no output path");
      await waitFor(
        () =>
          document
            .getElementById("downloadBtn")
            ?.textContent.includes("Open File Location") === true,
        "result button did not offer Open File Location",
        10_000,
      );

      // Focus the URL field and leave it: that blur runs a readiness sync.
      await (await browser.$("#url")).click();
      await browser.execute(() => document.activeElement?.blur());
      // The blur handler runs in the same task; the frames flush the rest.
      await nextFrames();
      const afterBlur = await readDownloadButton();
      assert.equal(
        afterBlur.text,
        "Open File Location",
        "blur relabeled the result button",
      );

      await (await browser.$("#downloadBtn")).click();
      await browser.waitUntil(
        async () =>
          browser.execute(() => (window.__primaryOpened ?? []).length >= 1),
        {
          timeout: 10_000,
          interval: 200,
          timeoutMsg: "result button did not call openFileLocation",
        },
      );
      const openedMatches = await browser.execute(
        (expected) =>
          (window.__primaryOpened ?? []).length === 1 &&
          window.__primaryOpened[0] === expected,
        entry.outputPath,
      );
      assert.equal(openedMatches, true, "result button opened the wrong path");

      // Typing a new link is the one thing that ends the result state early.
      const next = `${MEDIA}/clip-three.mp4?primary-action=open-next`;
      await (await browser.$("#url")).setValue(next);
      await waitFor(
        () =>
          document.getElementById("downloadBtn")?.textContent.trim() ===
          "Download",
        "typing a new link did not return the button to Download",
        10_000,
      );
      return {
        openedPathMatches: openedMatches,
        labelAfterBlur: afterBlur.text,
      };
    });
  });

  it("reports a refused open and returns the result button to Download after it expires", async function () {
    this.timeout(180_000);
    await scenario("primary-action-result-open-failure", [11, 17], async () => {
      const url = `${MEDIA}/clip-two.mp4?primary-action=open-fail`;
      await stubOpenFileLocation({
        ok: false,
        error: { code: "NOT_AVAILABLE", message: "Primary action refusal." },
      });
      await startUiDownload(url);
      await waitForActivity(
        (item) => item.url === url && item.outcome === "success",
        "failed-open download did not complete",
      );
      await waitFor(
        () =>
          document
            .getElementById("downloadBtn")
            ?.textContent.includes("Open File Location") === true,
        "result button did not offer Open File Location",
        10_000,
      );

      await clearToasts();
      await (await browser.$("#downloadBtn")).click();
      const toast = await waitForLastToast(
        (text) => text.includes("Primary action refusal."),
        "a refused open showed no message",
      );
      const openCalls = await browser.execute(
        () => (window.__primaryOpened ?? []).length,
      );
      assert.equal(openCalls, 1, "the refused open was not attempted once");

      // After the result expires, the same button starts a download.
      await browser.waitUntil(
        async () => (await readDownloadButton()).text === "Download",
        {
          timeout: 12_000,
          interval: 250,
          timeoutMsg: "result did not expire back to Download",
        },
      );
      await stubDownloadVideo();
      await (await browser.$("#downloadBtn")).click();
      await browser.waitUntil(async () => (await stubCallCount()) === 1, {
        timeout: 10_000,
        interval: 200,
        timeoutMsg: "expired result button did not start a download",
      });
      const openAfterExpiry = await browser.execute(
        () => (window.__primaryOpened ?? []).length,
      );
      assert.equal(
        openAfterExpiry,
        1,
        "expired result button opened the folder instead of downloading",
      );
      return { refusalToast: toast };
    });
  });

  it("shows Download complete without starting a download when there is no path to open", async function () {
    this.timeout(180_000);
    await scenario("primary-action-result-no-path", [13], async () => {
      const url = `${MEDIA}/clip-three.mp4?primary-action=no-path`;
      await browser.execute(() => {
        window.__primaryCompletions = [];
        if (window.__primaryUnsubscribe) window.__primaryUnsubscribe();
        window.__primaryUnsubscribe =
          window.__ROSI_E2E__.api.onDownloadComplete((completion) => {
            window.__primaryCompletions.push(completion);
          });
      });
      await startUiDownload(url);
      await waitForActivity(
        (item) => item.url === url && item.outcome === "success",
        "no-path download did not complete",
      );
      await waitFor(
        () =>
          document
            .getElementById("downloadBtn")
            ?.textContent.includes("Open File Location") === true,
        "result button did not offer Open File Location",
        10_000,
      );

      // Re-emit the completion the renderer just handled, without an output path.
      // The renderer then shows the no-path result state. The stub goes in only
      // now, so the real download above was not refused.
      await stubDownloadVideo();
      await browser.waitUntil(
        async () =>
          browser.execute(() => window.__primaryCompletions.length >= 1),
        {
          timeout: 10_000,
          interval: 200,
          timeoutMsg: "no completion captured",
        },
      );
      await browser.execute(() => {
        const real = window.__primaryCompletions.at(-1);
        void window.__TAURI__.event.emit("download-complete", {
          ...real,
          outputPath: null,
          outputPaths: null,
        });
      });
      await waitFor(
        () =>
          document.getElementById("downloadBtn")?.textContent.trim() ===
          "Download complete",
        "no-path completion did not show Download complete",
        10_000,
      );
      const noPath = await readDownloadButton();
      assert.equal(
        noPath.disabled,
        true,
        "Download complete is still clickable",
      );

      await browser.execute(() => {
        document.getElementById("downloadBtn")?.click();
      });
      // A disabled button dispatches no click, so nothing can start; the frames
      // flush any handler that was queued anyway.
      await nextFrames();
      assert.equal(
        await stubCallCount(),
        0,
        "Download complete started a new download",
      );

      await browser.waitUntil(
        async () => (await readDownloadButton()).text === "Download",
        {
          timeout: 8_000,
          interval: 250,
          timeoutMsg: "Download complete did not clear back to Download",
        },
      );
      return { labelBeforeClear: noPath.text, disabled: noPath.disabled };
    });
  });

  it("copies the source link with the native clipboard, the fallback, and reports a failed copy", async function () {
    this.timeout(180_000);
    await scenario(
      "primary-action-copy-source",
      [18, 19, 20, 21, 23],
      async () => {
        const url = `${MEDIA}/clip-one.mp4?primary-action=copy`;
        const started = await api("downloadVideo", { url });
        assert.equal(started.ok, true, "copy seed download did not start");
        const entry = await waitForActivity(
          (item) => item.url === url && item.outcome === "success",
          "copy seed download did not complete",
        );
        await selectActivityRow(entry.id, "copy");
        const copySelector = `.history-item[data-activity-id="${entry.id}"] [data-activity-action="copy"]`;
        const isCopyResult = (text) =>
          text === "Source link copied." ||
          text === "Could not copy the source link.";

        // Normal route. A focused page uses the real clipboard. Background runs
        // (the Windows default) never focus the page, so the real write is refused
        // there; those runs record the writeText call for this click only.
        const pageFocused = await browser.execute(() => document.hasFocus());
        const clipboardRoute = pageFocused ? "real" : "recorded-unfocused";
        let normal = null;
        let normalWrites = null;
        await clearToasts();
        try {
          if (clipboardRoute === "recorded-unfocused") {
            const installed = await browser.execute(() => {
              const clipboard = navigator.clipboard;
              if (!clipboard) return false;
              window.__primaryWrites = [];
              clipboard.writeText = (text) => {
                window.__primaryWrites.push(String(text));
                return Promise.resolve();
              };
              return true;
            });
            assert.ok(installed, "page has no navigator.clipboard to record");
          }
          await (await browser.$(copySelector)).click();
          normal = await waitForLastToast(
            isCopyResult,
            "copy showed no result",
          );
          assert.equal(
            normal,
            "Source link copied.",
            "normal copy reported a failure",
          );
          if (clipboardRoute === "recorded-unfocused") {
            normalWrites = await browser.execute(() => window.__primaryWrites);
            assert.deepEqual(
              normalWrites,
              [url],
              `Copy passed ${JSON.stringify(normalWrites)} to writeText, expected only the source URL`,
            );
          }
        } finally {
          if (clipboardRoute === "recorded-unfocused") {
            await browser.execute(() => {
              delete navigator.clipboard.writeText;
              delete window.__primaryWrites;
            });
          }
        }

        // Clipboard API refused: the textarea fallback must still copy. Background
        // runs record execCommand('copy') and report it as successful, so the
        // fallback logic is checked without the OS clipboard. Focused runs use the
        // real execCommand.
        await browser.execute((recorded) => {
          window.__primaryCopied = [];
          navigator.clipboard.writeText = () =>
            Promise.reject(
              new DOMException("Clipboard refused.", "NotAllowedError"),
            );
          document.execCommand = function (command, ...rest) {
            if (command === "copy") {
              window.__primaryCopied.push(
                document.querySelector("body > textarea")?.value ?? null,
              );
              if (recorded) return true;
            }
            return Document.prototype.execCommand.call(
              document,
              command,
              ...rest,
            );
          };
        }, clipboardRoute === "recorded-unfocused");
        await clearToasts();
        await (await browser.$(copySelector)).click();
        const fallback = await waitForLastToast(
          isCopyResult,
          "fallback copy showed no result",
        );
        assert.equal(
          fallback,
          "Source link copied.",
          "the fallback copy was reported as a failure",
        );
        const copiedUrl = await browser.execute(
          (expected) => (window.__primaryCopied ?? []).includes(expected),
          url,
        );
        assert.equal(
          copiedUrl,
          true,
          "the fallback did not copy the source URL",
        );
        const leftover = await browser.execute(
          () => document.querySelectorAll("body > textarea").length,
        );
        assert.equal(leftover, 0, "the fallback left its textarea in the page");
        const focusKept = await browser.execute((id) => {
          const active = document.activeElement;
          return (
            active?.dataset.activityAction === "copy" &&
            active.closest(".history-item")?.dataset.activityId === id
          );
        }, entry.id);
        assert.equal(
          focusKept,
          true,
          "focus did not return to the Copy source button",
        );

        // Both routes refused: the user must hear that the copy failed.
        await browser.execute(() => {
          document.execCommand = () => false;
        });
        await clearToasts();
        await (await browser.$(copySelector)).click();
        const refused = await waitForLastToast(
          isCopyResult,
          "refused copy showed no result",
        );
        assert.equal(
          refused,
          "Could not copy the source link.",
          "a refused copy was reported as success",
        );
        return {
          normal,
          fallbackCopied: copiedUrl,
          focusKept,
          clipboardRoute,
          pageFocused,
          normalWrites,
        };
      },
    );
  });
});
