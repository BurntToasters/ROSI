import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";
import { processesMatching, waitForNoProcess } from "../../helpers/host.js";
import { activityFor, waitFor } from "../../helpers/ui.js";
import { REPO_ROOT } from "../../helpers/profile.js";

// Failure modes are numbered in manual-lifecycle.failure-modes.md. Each check
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
  `${stamp}-manual-lifecycle-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-manual-lifecycle",
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

// Wraps api.downloadVideo so the start waits on a gate before the backend sees
// it, and counts each cancel with the number of replies seen so far. The
// original methods are kept so restoreApi() can put them back.
async function installStartGate() {
  await browser.execute(() => {
    const api = window.__ROSI_E2E__.api;
    if (!window.__manualLifecycle) {
      window.__manualLifecycle = {
        originalDownload: api.downloadVideo,
        originalCancel: api.cancelDownload,
      };
    }
    const state = window.__manualLifecycle;
    state.starts = 0;
    state.replies = 0;
    state.cancels = [];
    let openGate = () => {};
    const promise = new Promise((resolve) => {
      openGate = resolve;
    });
    state.gate = { open: () => openGate() };
    api.downloadVideo = async (...args) => {
      state.starts += 1;
      await promise;
      const result = await state.originalDownload.apply(api, args);
      state.replies += 1;
      return result;
    };
    api.cancelDownload = (...args) => {
      state.cancels.push({ repliesBefore: state.replies });
      return state.originalCancel.apply(api, args);
    };
  });
}

// Counts cancels without holding the start. Used by the cancel-after-reply case.
async function installCancelCounter() {
  await browser.execute(() => {
    const api = window.__ROSI_E2E__.api;
    if (!window.__manualLifecycle) {
      window.__manualLifecycle = {
        originalDownload: api.downloadVideo,
        originalCancel: api.cancelDownload,
      };
    }
    const state = window.__manualLifecycle;
    state.cancels = [];
    state.replies = 0;
    api.cancelDownload = (...args) => {
      state.cancels.push({ repliesBefore: state.replies });
      return state.originalCancel.apply(api, args);
    };
  });
}

// Records every transition of #progress-container into the visible state. A
// re-open after a cancel shows up here even when the bar is hidden again later.
async function watchProgressReopens() {
  await browser.execute(() => {
    window.__progressWatch?.observer.disconnect();
    const container = document.getElementById("progress-container");
    const watch = { reopened: 0, observer: null };
    watch.observer = new MutationObserver((records) => {
      for (const record of records) {
        const nowVisible = record.target.classList.contains("visible");
        const wasVisible = (record.oldValue ?? "")
          .split(/\s+/)
          .includes("visible");
        if (nowVisible && !wasVisible) watch.reopened += 1;
      }
    });
    watch.observer.observe(container, {
      attributes: true,
      attributeFilter: ["class"],
      attributeOldValue: true,
    });
    window.__progressWatch = watch;
  });
}

async function progressReopens() {
  return browser.execute(() => window.__progressWatch?.reopened ?? -1);
}

async function resetProgressReopens() {
  await browser.execute(() => {
    if (window.__progressWatch) window.__progressWatch.reopened = 0;
  });
}

// Opens the gate, puts the original methods back, and drops the state. Opening
// the gate first means a failed check cannot leave the renderer waiting forever.
async function restoreApi() {
  await browser.execute(() => {
    window.__progressWatch?.observer.disconnect();
    delete window.__progressWatch;
    const state = window.__manualLifecycle;
    if (!state) return;
    state.gate?.open();
    const api = window.__ROSI_E2E__.api;
    api.downloadVideo = state.originalDownload;
    api.cancelDownload = state.originalCancel;
    delete window.__manualLifecycle;
  });
}

async function cancelCount() {
  return browser.execute(() => window.__manualLifecycle?.cancels.length ?? 0);
}

// Stops a manual download the user can still cancel, then waits until its
// process is gone and the Download button is ready again. The needle names
// this case's session; the button is only pressed while it is loading.
async function stopRunningManualDownload(needle) {
  const loading = (await readDownloadButton()).loading;
  if (loading) {
    await (await browser.$("#downloadBtn")).click().catch(() => {});
  }
  await browser.waitUntil(
    async () =>
      processesMatching(needle).length === 0 &&
      !(await readDownloadButton()).loading,
    {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: `manual download ${needle} did not stop during cleanup`,
    },
  );
}

// Waits until no slow.mp4 download process runs and the button is not loading.
async function waitForIdleManualDownloads() {
  await browser.waitUntil(
    async () =>
      processesMatching("slow.mp4").length === 0 &&
      !(await readDownloadButton()).loading,
    {
      timeout: 90_000,
      interval: 250,
      timeoutMsg: "a previous manual download is still running",
    },
  );
}

async function waitForFinishedActivity(url, message, timeout = 120_000) {
  let entries = [];
  await browser.waitUntil(
    async () => {
      entries = await activityFor(url);
      return entries.length > 0;
    },
    { timeout, interval: 500, timeoutMsg: message },
  );
  return entries;
}

describe("ROSI manual download lifecycle: cancel timing and progress", () => {
  before(async () => {
    await waitForAppReady();
    report.source = sourceIdentity();
    writeReport();
  });

  beforeEach(async () => {
    await resetQueue();
    // A case starts only when no manual download is still running.
    await waitForIdleManualDownloads();
  });

  afterEach(async () => {
    // Fallback for every case: open a closed gate, restore the bridge, and
    // stop any manual download still running before the next case starts.
    await browser
      .execute(() => window.__manualLifecycle?.gate?.open())
      .catch(() => {});
    await restoreApi().catch(() => {});
    if ((await readDownloadButton()).loading) {
      await (await browser.$("#downloadBtn")).click().catch(() => {});
    }
    await waitForIdleManualDownloads();
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

  it("keeps the UI idle and stops the started session when Cancel lands before the start reply", async function () {
    this.timeout(240_000);
    await scenario(
      "manual-lifecycle-cancel-before-reply",
      [1, 2, 3, 4, 5, 6, 7],
      async () => {
        const needle = "manual-lifecycle=cancel-before-reply";
        const url = `${MEDIA}/slow.mp4?${needle}`;
        await installStartGate();

        await startUiDownload(url);
        await waitFor(
          () => (window.__manualLifecycle?.starts ?? 0) === 1,
          "download start never reached the gate",
          15_000,
        );
        await waitFor(
          () =>
            document
              .getElementById("downloadBtn")
              ?.classList.contains("loading") === true,
          "Download did not enter its running state",
          15_000,
        );

        // Cancel while the start reply is still pending (the gate is closed).
        await (await browser.$("#downloadBtn")).click();
        await waitFor(
          () =>
            !document
              .getElementById("downloadBtn")
              ?.classList.contains("loading"),
          "Cancel before the reply left the Download button loading",
          5_000,
        );
        assert.equal(
          await progressBarVisible(),
          false,
          "Cancel before the reply left the progress bar visible",
        );
        assert.equal(
          await cancelCount(),
          0,
          "Cancel reached the backend before the start reply",
        );

        // Opening the gate starts the session and lets the reply land. The
        // renderer must stop that session exactly once, after the reply.
        await browser.execute(() => window.__manualLifecycle.gate.open());
        await waitFor(
          () => (window.__manualLifecycle?.cancels.length ?? 0) === 1,
          "cancel was never sent after the start reply",
          10_000,
        );
        const cancels = await browser.execute(
          () => window.__manualLifecycle.cancels,
        );
        assert.equal(
          cancels[0].repliesBefore,
          1,
          "cancel was sent before the start reply",
        );

        // Hold for two seconds: the late reply and any progress must not
        // flip the button or re-open the bar.
        await browser.pause(2000);
        const after = await readDownloadButton();
        assert.equal(
          after.loading,
          false,
          "the late start reply turned the Download button back to loading",
        );
        assert.equal(
          await progressBarVisible(),
          false,
          "the late start reply or its progress re-opened the progress bar",
        );
        assert.equal(await cancelCount(), 1, "cancel was sent more than once");

        const entries = await waitForFinishedActivity(
          url,
          "cancelled download never reached the activity log",
          90_000,
        );
        assert.ok(
          entries.some((entry) => entry.outcome === "cancelled"),
          `cancelled start ended as ${entries.map((entry) => entry.outcome).join(", ")}`,
        );
        assert.equal(
          entries.filter((entry) => entry.outcome === "success").length,
          0,
          "a cancelled start completed as a success",
        );
        await waitForNoProcess(
          needle,
          "yt-dlp survived the cancel sent after the start reply",
          { timeout: 30_000, interval: 250 },
        );
        return {
          repliesBeforeCancel: cancels[0].repliesBefore,
          cancelsSent: cancels.length,
          outcome: "cancelled",
        };
      },
    );
  });

  it("stops the cancelled session when Download is pressed again before its start reply", async function () {
    this.timeout(240_000);
    await scenario("manual-lifecycle-cancel-then-restart", [8], async () => {
      // Distinct URLs: the first session's process must be told apart from the
      // second download, which may start once the stale stop frees the slot.
      const firstNeedle = "manual-lifecycle=cancel-then-restart-first";
      const secondNeedle = "manual-lifecycle=cancel-then-restart-second";
      const firstUrl = `${MEDIA}/slow.mp4?${firstNeedle}`;
      const secondUrl = `${MEDIA}/slow.mp4?${secondNeedle}`;
      try {
        await installStartGate();

        // Operation N: start, then cancel while its reply is still pending.
        await startUiDownload(firstUrl);
        await waitFor(
          () => (window.__manualLifecycle?.starts ?? 0) === 1,
          "first download start never reached the gate",
          15_000,
        );
        await waitFor(
          () =>
            document
              .getElementById("downloadBtn")
              ?.classList.contains("loading") === true,
          "first download did not enter its running state",
          15_000,
        );
        await (await browser.$("#downloadBtn")).click();
        await waitFor(
          () =>
            !document
              .getElementById("downloadBtn")
              ?.classList.contains("loading"),
          "Cancel before the reply left the Download button loading",
          5_000,
        );
        assert.equal(
          await cancelCount(),
          0,
          "Cancel was sent before the reply",
        );

        // Operation N+1: a different URL, pressed while N's reply is pending.
        await waitForButtonReady("Download button not ready after Cancel");
        await (await browser.$("#url")).setValue(secondUrl);
        await waitForButtonReady(
          "Download button not ready for the second URL",
        );
        await (await browser.$("#downloadBtn")).click();
        await waitFor(
          () => (window.__manualLifecycle?.starts ?? 0) === 2,
          "the second download never reached the start gate",
          15_000,
        );
        // Both starts were issued in order behind the gate. Opening it lets N's
        // start reach the backend first, then N+1's, and both replies land.
        await browser.execute(() => window.__manualLifecycle.gate.open());
        await waitFor(
          () => (window.__manualLifecycle?.cancels.length ?? 0) === 1,
          "the stale start reply never stopped its session",
          15_000,
        );
        assert.equal(
          await cancelCount(),
          1,
          "the stale session was stopped more than once",
        );

        // N's session must end as cancelled and its process must be gone.
        // Without the stop it runs for minutes.
        const firstEntries = await waitForFinishedActivity(
          firstUrl,
          "the cancelled first session never ended, so its stale start was not stopped",
          90_000,
        );
        assert.ok(
          firstEntries.some((entry) => entry.outcome === "cancelled"),
          `stale session ended as ${firstEntries.map((entry) => entry.outcome).join(", ")}`,
        );
        await waitForNoProcess(
          firstNeedle,
          "the stale first session survived the stop",
          { timeout: 30_000, interval: 250 },
        );

        // N+1 may start now that the slot is free, or be refused as already in
        // progress if its reply came first. Either outcome is accepted and recorded.
        let secondOutcome = null;
        await browser.waitUntil(
          async () => {
            const loading = (await readDownloadButton()).loading;
            if (processesMatching(secondNeedle).length > 0) {
              secondOutcome = "started";
            } else if (!loading) {
              secondOutcome = "refused";
            }
            return secondOutcome !== null;
          },
          {
            timeout: 30_000,
            interval: 250,
            timeoutMsg: "the second download neither started nor was refused",
          },
        );
        return {
          stopsSent: 1,
          firstOutcome: "cancelled",
          secondOutcome,
        };
      } finally {
        // Every case leaves a clean state: open the gate if it is still closed,
        // stop the second download if it runs, and wait until it is gone.
        await browser
          .execute(() => window.__manualLifecycle?.gate?.open())
          .catch(() => {});
        await restoreApi().catch(() => {});
        await stopRunningManualDownload(secondNeedle);
      }
    });
  });

  it("does not re-open the progress bar while a cancelled download winds down", async function () {
    this.timeout(180_000);
    await scenario(
      "manual-lifecycle-cancel-after-reply-progress",
      [10, 11],
      async () => {
        const needle = "manual-lifecycle=cancel-after-reply";
        const url = `${MEDIA}/slow.mp4?${needle}`;
        await installCancelCounter();
        await watchProgressReopens();

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
          async () => processesMatching(needle).length > 0,
          {
            timeout: 30_000,
            interval: 250,
            timeoutMsg: "yt-dlp never started for the manual download",
          },
        );
        // Progress from the live session has shown the bar, so the cancel
        // below has real events in flight to race with.
        await waitFor(
          () =>
            document
              .getElementById("progress-container")
              ?.classList.contains("visible") === true,
          "the live download never showed its progress bar",
          30_000,
        );

        await resetProgressReopens();
        await (await browser.$("#downloadBtn")).click();
        await waitFor(
          () =>
            !document
              .getElementById("downloadBtn")
              ?.classList.contains("loading"),
          "Cancel left the Download button loading",
          5_000,
        );
        assert.equal(
          await progressBarVisible(),
          false,
          "Cancel left the progress bar visible",
        );
        assert.equal(await cancelCount(), 1, "Cancel sent no single stop");

        await waitForNoProcess(needle, "yt-dlp survived the Cancel control", {
          timeout: 60_000,
          interval: 100,
        });
        // Let any progress the stopped session still emits reach the renderer.
        await browser.pause(1000);
        assert.equal(
          await progressReopens(),
          0,
          "late progress from the cancelled session re-opened the bar",
        );
        assert.equal(
          await progressBarVisible(),
          false,
          "late progress from the cancelled session left the bar visible",
        );
        const entries = await waitForFinishedActivity(
          url,
          "cancelled download never reached the activity log",
          60_000,
        );
        assert.ok(
          entries.some((entry) => entry.outcome === "cancelled"),
          `Cancel ended the run as ${entries.map((entry) => entry.outcome).join(", ")}`,
        );
        return { reopens: 0, outcome: "cancelled" };
      },
    );
  });

  it("clears the progress details text when a download completes", async function () {
    this.timeout(180_000);
    await scenario(
      "manual-lifecycle-complete-clears-details",
      [15],
      async () => {
        // A 256 KiB clip finishes within seconds; its completion writes "Complete!"
        // with empty details, which must replace any speed or ETA text.
        const url = `${MEDIA}/clip-one.mp4?manual-lifecycle=complete`;
        await startUiDownload(url);
        await waitFor(
          () => {
            const status = document.getElementById("progress-status");
            return (
              (status?.textContent ?? "").includes("Complete") &&
              document
                .getElementById("progress-container")
                ?.classList.contains("visible") === true
            );
          },
          "the completed download never showed its Complete status",
          120_000,
        );
        const details = await browser.execute(() =>
          (document.getElementById("progress-details")?.textContent ?? "")
            .trim()
            .replace(/[^\x20-\x7e]/g, "?"),
        );
        assert.equal(
          details,
          "",
          `Complete status kept stale progress details: ${JSON.stringify(details)}`,
        );
        const entries = await waitForFinishedActivity(
          url,
          "completed download never reached the activity log",
          60_000,
        );
        assert.ok(
          entries.some((entry) => entry.outcome === "success"),
          `completed download ended as ${entries.map((entry) => entry.outcome).join(", ")}`,
        );
        return { details: "", outcome: "success" };
      },
    );
  });
});
