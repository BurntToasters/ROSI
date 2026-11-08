import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";
import { REPO_ROOT } from "../../helpers/profile.js";

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
  `${stamp}-focus-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-focus",
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

async function selectDock(tab) {
  await browser.execute(
    (name) => window.__ROSI_E2E__.modules.dock.selectTab(name),
    tab,
  );
}

async function waitForQueueItemStatus(url, status, message, timeout = 60_000) {
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

// Records each change to the activity live region and each job-progress tick
// the page receives, so the flow can check announcements against ticks.
function installActivityProbe() {
  const region = document.getElementById("activity-live-status");
  if (!region) throw new Error("activity live region is missing");
  window.__uiPolishFocusProbe?.stop();
  const probe = {
    announcements: [],
    ticks: 0,
    observer: null,
    unsubscribe: null,
    stop() {
      probe.observer?.disconnect();
      probe.unsubscribe?.();
    },
  };
  probe.observer = new MutationObserver(() => {
    probe.announcements.push(region.textContent.trim());
  });
  probe.observer.observe(region, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  probe.unsubscribe = window.api.onJobProgress(() => {
    probe.ticks += 1;
  });
  window.__uiPolishFocusProbe = probe;
}

function activitySnapshot() {
  return browser.execute(() => {
    const probe = window.__uiPolishFocusProbe;
    const focused = document.activeElement;
    return {
      announcements: [...probe.announcements],
      ticks: probe.ticks,
      focus: {
        rowId: focused?.closest(".history-item")?.dataset.activityId ?? null,
        action: focused?.dataset?.activityAction ?? null,
      },
      liveText:
        document.getElementById("activity-live-status")?.textContent.trim() ??
        null,
    };
  });
}

async function runActivityFlow(observed) {
  await selectDock("activity");
  await browser.execute(installActivityProbe);

  // A finished download becomes a real activity entry, so the row survives the
  // later re-renders that come from the backend.
  const seedUrl = `${MEDIA}/clip-one.mp4?ui-polish-focus=seed`;
  assert.equal((await api("addToQueue", [seedUrl])).data.added, 1);
  assert.equal((await api("startQueue")).ok, true);
  await waitForQueueItemStatus(
    seedUrl,
    "completed",
    "seed download did not complete",
  );
  const seed = (await api("getDownloadActivity")).data.find(
    (entry) => entry.url === seedUrl,
  );
  assert.ok(seed, "seed download is missing from the activity log");
  observed.seedId = seed.id;
  await waitFor(
    (id) =>
      [...document.querySelectorAll(".history-item")].some(
        (row) => row.dataset.activityId === id,
      ),
    "seed activity row did not render",
    8_000,
    seed.id,
  );
  observed.afterSeed = await activitySnapshot();

  await browser.execute((id) => {
    const row = [...document.querySelectorAll(".history-item")].find(
      (candidate) => candidate.dataset.activityId === id,
    );
    const copy = row?.querySelector('[data-activity-action="copy"]');
    if (!copy) throw new Error("seed row has no copy action");
    copy.focus();
  }, seed.id);
  observed.focused = await activitySnapshot();

  // Progress ticks from a running item must not touch the activity list.
  const slowUrl = `${MEDIA}/slow.mp4?ui-polish-focus=progress`;
  assert.equal((await api("addToQueue", [slowUrl])).data.added, 1);
  assert.equal((await api("startQueue")).ok, true);
  await waitFor(
    () => window.__uiPolishFocusProbe.ticks >= 3,
    "job-progress ticks did not reach the page",
    60_000,
  );
  observed.duringProgress = await activitySnapshot();

  // Cancelling the run records a new activity entry, which must be announced once.
  assert.equal((await api("cancelQueue")).ok, true);
  await waitFor(
    () => window.__uiPolishFocusProbe.announcements.length >= 2,
    "cancelled activity entry was not announced",
    20_000,
  );
  await browser.pause(500);
  observed.afterCancel = await activitySnapshot();

  // A re-sent update with no new entry is a re-render only.
  const latest = (await api("getDownloadActivity")).data;
  await browser.execute((list) => {
    window.__TAURI__.event.emit("download-activity-update", list);
  }, latest);
  await browser.pause(300);
  observed.afterResend = await activitySnapshot();
}

describe("ROSI UI polish focus and row errors", () => {
  before(async () => {
    await waitForAppReady();
    report.source = sourceIdentity();
    writeReport();
  });

  beforeEach(async () => {
    await resetQueue();
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

  it("keeps activity focus across updates and announces each new entry once", async () => {
    const observed = {};
    let flowError = null;
    try {
      await runActivityFlow(observed);
    } catch (error) {
      flowError = error;
    } finally {
      await browser
        .execute(() => {
          window.__uiPolishFocusProbe?.stop();
          delete window.__uiPolishFocusProbe;
        })
        .catch(() => {});
      await api("cancelQueue").catch(() => {});
      await api("clearQueue").catch(() => {});
    }

    let failed = false;
    try {
      await scenario("activity-focus-retained-on-update", async () => {
        const expected = { rowId: observed.seedId, action: "copy" };
        for (const stage of [
          "focused",
          "duringProgress",
          "afterCancel",
          "afterResend",
        ]) {
          assert.deepEqual(
            observed[stage]?.focus,
            expected,
            `focus left the row action at ${stage}`,
          );
        }
        return { focusedRow: observed.seedId, stages: 4 };
      });
    } catch {
      failed = true;
    }
    try {
      await scenario("activity-announces-new-entries-once", async () => {
        assert.ok(observed.afterSeed, "the seed download was never observed");
        assert.equal(
          observed.afterSeed.announcements.length,
          1,
          "a new entry was not announced exactly once",
        );
        assert.ok(
          observed.duringProgress.ticks >= 3,
          "too few progress ticks to test against",
        );
        assert.equal(
          observed.duringProgress.announcements.length,
          1,
          "progress ticks changed the live region",
        );
        assert.equal(
          observed.afterCancel.announcements.length,
          2,
          "the cancelled entry was not announced exactly once",
        );
        assert.notEqual(
          observed.afterCancel.liveText,
          observed.afterSeed.liveText,
          "the live region did not change for the new entry",
        );
        assert.equal(
          observed.afterResend.announcements.length,
          2,
          "a re-sent update without a new entry was announced",
        );
        return {
          announcementsAfterSeed: observed.afterSeed.announcements.length,
          progressTicks: observed.duringProgress.ticks,
          announcementsAfterCancel: observed.afterCancel.announcements.length,
        };
      });
    } catch {
      failed = true;
    }
    if (flowError) throw flowError;
    if (failed) throw new Error("activity focus or announcement checks failed");
  });

  it("shows a refused remove of a downloading item inline on its row", async () => {
    await scenario("queue-row-remove-error-inline", async () => {
      const slow = `${MEDIA}/slow.mp4?ui-polish-focus=remove`;
      const pendingB = `${MEDIA}/clip-two.mp4?ui-polish-focus=remove-b`;
      const pendingC = `${MEDIA}/clip-three.mp4?ui-polish-focus=remove-c`;
      assert.equal(
        (await api("addToQueue", [slow, pendingB, pendingC])).data.added,
        3,
      );
      const queue = await api("getQueue");
      const idFor = (url) => queue.find((item) => item.url === url).id;
      const slowId = idFor(slow);
      const bId = idFor(pendingB);
      const cId = idFor(pendingC);
      await waitFor(
        (ids) =>
          ids.every((id) =>
            [...document.querySelectorAll(".queue-item")].some(
              (row) => row.dataset.queueId === id,
            ),
          ),
        "queue rows did not render",
        8_000,
        [slowId, bId, cId],
      );
      // The Remove button the user sees while the item is still pending.
      await browser.execute((id) => {
        const row = [...document.querySelectorAll(".queue-item")].find(
          (candidate) => candidate.dataset.queueId === id,
        );
        const remove = row?.querySelector(
          '[data-queue-action="queue-item-remove"]',
        );
        if (!remove) throw new Error("pending row has no Remove control");
        window.__uiPolishStaleRemove = remove;
      }, slowId);

      assert.equal((await api("startQueue")).ok, true);
      await waitFor(
        (id) =>
          [...document.querySelectorAll(".queue-item")]
            .find((row) => row.dataset.queueId === id)
            ?.classList.contains("queue-downloading") === true,
        "active item did not show as downloading",
        60_000,
        slowId,
      );
      // The renderer has replaced that row, so the click runs the handler of the
      // control the user pressed, with the id it was rendered with, against the
      // item the backend is now downloading.
      await browser.execute(() => window.__uiPolishStaleRemove.click());
      await waitFor(
        (id) =>
          Boolean(
            [...document.querySelectorAll(".queue-item")]
              .find((row) => row.dataset.queueId === id)
              ?.querySelector(".queue-item-error"),
          ),
        "refusal was not shown on the row",
        10_000,
        slowId,
      );

      const activeRow = await browser.execute((id) => {
        const row = [...document.querySelectorAll(".queue-item")].find(
          (candidate) => candidate.dataset.queueId === id,
        );
        return {
          status: row.querySelector(".queue-item-meta")?.textContent.trim(),
          refusal: row.querySelector(".queue-item-error")?.textContent.trim(),
          hasRemove: Boolean(
            row.querySelector('[data-queue-action="queue-item-remove"]'),
          ),
        };
      }, slowId);
      assert.match(activeRow.status ?? "", /downloading/i);
      assert.match(activeRow.refusal ?? "", /actively downloading/i);
      assert.equal(
        activeRow.hasRemove,
        false,
        "a downloading row offers Remove",
      );

      // The control that was clicked is enabled again and not busy.
      await waitFor(
        () =>
          !window.__uiPolishStaleRemove.disabled &&
          !window.__uiPolishStaleRemove.hasAttribute("aria-busy"),
        "clicked control stayed disabled after the refusal",
      );

      // The pending rows keep every action they had, and show no error.
      const others = await browser.execute(
        (ids) =>
          ids.map((id) => {
            const row = [...document.querySelectorAll(".queue-item")].find(
              (candidate) => candidate.dataset.queueId === id,
            );
            const enabled = (action) => {
              const button = row.querySelector(
                `[data-queue-action="${action}"]`,
              );
              return button ? !button.disabled : null;
            };
            return {
              hasRefusal: Boolean(row.querySelector(".queue-item-error")),
              up: enabled("queue-item-move-up"),
              down: enabled("queue-item-move-down"),
              remove: enabled("queue-item-remove"),
            };
          }),
        [bId, cId],
      );
      assert.deepEqual(others[0], {
        hasRefusal: false,
        up: false,
        down: true,
        remove: true,
      });
      assert.deepEqual(others[1], {
        hasRefusal: false,
        up: true,
        down: false,
        remove: true,
      });

      // Once the item leaves Downloading the inline message no longer applies.
      assert.equal((await api("cancelQueue")).ok, true);
      await waitFor(
        (id) =>
          [...document.querySelectorAll(".queue-item")]
            .find((row) => row.dataset.queueId === id)
            ?.classList.contains("queue-cancelled") === true,
        "cancelled item did not render as cancelled",
        20_000,
        slowId,
      );
      const finished = await browser.execute((id) => {
        const row = [...document.querySelectorAll(".queue-item")].find(
          (candidate) => candidate.dataset.queueId === id,
        );
        return {
          hasRefusal: Boolean(row.querySelector(".queue-item-error")),
          requeue: Boolean(
            row.querySelector('[data-queue-action="queue-item-retry"]'),
          ),
        };
      }, slowId);
      assert.deepEqual(finished, { hasRefusal: false, requeue: true });
      return {
        refusal: activeRow.refusal,
        otherRowsEnabled: true,
      };
    });
  });

  it("shows a refused open-location on the completed row inline", async () => {
    await scenario("queue-open-location-error-inline", async () => {
      const url = `${MEDIA}/clip-one.mp4?ui-polish-focus=open`;
      assert.equal((await api("addToQueue", [url])).data.added, 1);
      const id = (await api("getQueue")).find((item) => item.url === url).id;
      assert.equal((await api("startQueue")).ok, true);
      await waitForQueueItemStatus(
        url,
        "completed",
        "open-location item did not complete",
      );
      await waitFor(
        (target) => {
          const row = [...document.querySelectorAll(".queue-item")].find(
            (candidate) => candidate.dataset.queueId === target,
          );
          return Boolean(
            row?.classList.contains("queue-completed") &&
            row.querySelector('[data-queue-action="queue-item-open"]'),
          );
        },
        "completed row has no Open folder control",
        10_000,
        id,
      );

      // Refuse the native call so the row path runs without a file manager.
      await browser.execute(() => {
        window.__uiPolishOriginalOpen = window.api.openFileLocation;
        window.api.openFileLocation = async () => ({
          ok: false,
          error: { code: "NOT_AVAILABLE", message: "Test location refusal." },
        });
      });
      try {
        await browser.execute((target) => {
          const row = [...document.querySelectorAll(".queue-item")].find(
            (candidate) => candidate.dataset.queueId === target,
          );
          row.querySelector('[data-queue-action="queue-item-open"]').click();
        }, id);
        await waitFor(
          (target) =>
            [...document.querySelectorAll(".queue-item")]
              .find((row) => row.dataset.queueId === target)
              ?.querySelector(".queue-item-error")
              ?.textContent.includes("Test location refusal.") === true,
          "open-location refusal was not shown on the row",
          10_000,
          id,
        );
      } finally {
        await browser.execute(() => {
          if (window.__uiPolishOriginalOpen) {
            window.api.openFileLocation = window.__uiPolishOriginalOpen;
            delete window.__uiPolishOriginalOpen;
          }
        });
      }

      const row = await browser.execute((target) => {
        const element = [...document.querySelectorAll(".queue-item")].find(
          (candidate) => candidate.dataset.queueId === target,
        );
        const open = element.querySelector(
          '[data-queue-action="queue-item-open"]',
        );
        const remove = element.querySelector(
          '[data-queue-action="queue-item-remove"]',
        );
        return {
          openEnabled:
            Boolean(open) && !open.disabled && !open.hasAttribute("aria-busy"),
          removeEnabled: Boolean(remove) && !remove.disabled,
        };
      }, id);
      assert.deepEqual(row, { openEnabled: true, removeEnabled: true });
      return { openEnabled: row.openEnabled, removeEnabled: row.removeEnabled };
    });
  });
});
