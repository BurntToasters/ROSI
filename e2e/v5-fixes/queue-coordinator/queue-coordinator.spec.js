import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";

const env = process.env;
const MEDIA = env.ROSI_E2E_MEDIA_URL;
const DOWNLOADS = env.ROSI_E2E_DOWNLOADS;
const DATA_DIR = env.ROSI_E2E_DATA_DIR;
const TERMINAL = ["completed", "failed", "cancelled"];

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
  return (listing || "")
    .split("\n")
    .filter((line) => line.includes(needle) && !line.includes("powershell"));
}

async function waitForNoProcess(needle, timeoutMsg) {
  await browser.waitUntil(async () => processesMatching(needle).length === 0, {
    timeout: 15_000,
    interval: 250,
    timeoutMsg: `${timeoutMsg}: ${processesMatching(needle).join(" | ")}`,
  });
}

async function activityFor(url) {
  const activity = (await api("getDownloadActivity")).data;
  return activity.filter((entry) => entry.url === url);
}

async function waitForItemStatus(url, status, timeoutMsg, timeout = 60_000) {
  await browser.waitUntil(
    async () =>
      (await api("getQueue")).some(
        (item) => item.url === url && item.status === status,
      ),
    { timeout, interval: 250, timeoutMsg },
  );
}

async function waitForAllTerminal(timeoutMsg) {
  await browser.waitUntil(
    async () =>
      (await api("getQueue")).every((item) => TERMINAL.includes(item.status)),
    { timeout: 180_000, interval: 500, timeoutMsg },
  );
}

describe("queue and session coordinator behaviour", () => {
  before(async () => {
    await waitForAppReady();
  });

  beforeEach(async () => {
    await api("cancelQueue");
    await api("clearQueue");
  });

  it("runs queued items one at a time with exactly one outcome each", async () => {
    const urls = [
      `${MEDIA}/clip-two.mp4?coord=seq`,
      `${MEDIA}/clip-three.mp4?coord=seq`,
      `${MEDIA}/clip-one.mp4?coord=seq`,
    ];
    const added = await api("addToQueue", urls);
    assert.equal(added.data.added, 3);
    assert.equal((await api("startQueue")).ok, true);
    await waitForAllTerminal("sequential queue did not finish");

    const queue = await api("getQueue");
    for (const item of queue) {
      assert.equal(item.status, "completed", item.error ?? item.url);
    }
    const completedAt = [];
    for (const url of urls) {
      const entries = await activityFor(url);
      assert.equal(
        entries.length,
        1,
        `${url} recorded ${entries.length} times`,
      );
      assert.equal(entries[0].outcome, "success");
      completedAt.push(entries[0].completedAt);
    }
    assert.deepEqual(
      completedAt,
      [...completedAt].sort((a, b) => a - b),
      "items did not finish in queue order",
    );
  });

  it("skips a duplicate of a URL that is already downloading", async () => {
    const slow = `${MEDIA}/slow.mp4?coord=dup`;
    assert.equal((await api("addToQueue", [slow])).data.added, 1);
    assert.equal((await api("startQueue")).ok, true);
    await waitForItemStatus(slow, "downloading", "item never started");
    const again = await api("addToQueue", [slow]);
    assert.equal(again.data.added, 0);
    assert.equal(again.data.skipped, 1);
    await api("cancelQueue");
    await waitForNoProcess("coord=dup", "duplicate test process survived");
  });

  it("refuses manual downloads and queue starts while the other owner runs", async () => {
    const slow = `${MEDIA}/slow.mp4?coord=admit`;
    const next = `${MEDIA}/clip-three.mp4?coord=admit`;
    assert.equal((await api("addToQueue", [slow, next])).data.added, 2);
    assert.equal((await api("startQueue")).ok, true);
    await waitForItemStatus(slow, "downloading", "queue item never started");

    const manual = await api("downloadVideo", {
      url: `${MEDIA}/clip-one.mp4?coord=manual`,
      outputPath: DOWNLOADS,
    });
    assert.equal(manual.ok, false, "manual download ran during a queue run");
    assert.match(
      manual.error.message,
      /queue download is already in progress/i,
    );

    const restart = await api("startQueue");
    assert.equal(restart.ok, false, "second queue start was accepted");
    assert.match(restart.error.message, /already running/i);

    await api("cancelQueue");
    await waitForAllTerminal("admission queue did not settle");
    await waitForNoProcess("coord=admit", "admission test process survived");
  });

  it("cancels a running item, retries it, and records one outcome per attempt", async () => {
    const slow = `${MEDIA}/slow.mp4?coord=retry`;
    assert.equal((await api("addToQueue", [slow])).data.added, 1);
    assert.equal((await api("startQueue")).ok, true);
    await waitForItemStatus(slow, "downloading", "queue item never started");
    await browser.pause(1000);
    assert.equal((await api("cancelQueue")).ok, true);
    await waitForItemStatus(slow, "cancelled", "cancel did not land");
    await waitForNoProcess("coord=retry", "cancelled yt-dlp survived");
    await browser.pause(500);
    let entries = await activityFor(slow);
    assert.equal(entries.length, 1, "cancelled item recorded more than once");
    assert.equal(entries[0].outcome, "cancelled");

    const item = (await api("getQueue")).find((entry) => entry.url === slow);
    assert.equal((await api("retryQueueItem", item.id)).ok, true);
    assert.equal((await api("startQueue")).ok, true);
    await waitForItemStatus(slow, "downloading", "retried item never started");
    await browser.pause(1000);
    assert.equal((await api("cancelQueue")).ok, true);
    await waitForItemStatus(
      slow,
      "cancelled",
      "retried attempt did not cancel",
    );
    await waitForNoProcess("coord=retry", "retried yt-dlp survived");
    await browser.pause(500);
    entries = await activityFor(slow);
    assert.equal(entries.length, 2, JSON.stringify(entries));
    assert.deepEqual(
      entries.map((entry) => entry.outcome),
      ["cancelled", "cancelled"],
      "each attempt must record exactly one outcome",
    );
    assert.equal(
      (await api("getQueue")).find((entry) => entry.url === slow).status,
      "cancelled",
    );
  });

  it("rejects reorder and removal of the active item while the run continues", async () => {
    const slow = `${MEDIA}/slow.mp4?coord=mutate`;
    const second = `${MEDIA}/clip-two.mp4?coord=mutate`;
    const third = `${MEDIA}/clip-three.mp4?coord=mutate`;
    assert.equal(
      (await api("addToQueue", [slow, second, third])).data.added,
      3,
    );
    assert.equal((await api("startQueue")).ok, true);
    await waitForItemStatus(slow, "downloading", "queue item never started");

    let queue = await api("getQueue");
    const active = queue.find((item) => item.url === slow);
    const pendingLast = queue.find((item) => item.url === third);

    const moved = await api("reorderQueueItem", {
      id: pendingLast.id,
      direction: "up",
    });
    assert.equal(moved.ok, true, moved.error?.message);

    const reorderActive = await api("reorderQueueItem", {
      id: active.id,
      direction: "down",
    });
    assert.equal(reorderActive.ok, false, "active item was reordered");

    const removeActive = await api("removeFromQueue", active.id);
    assert.equal(removeActive.ok, false, "active item was removed");
    assert.match(removeActive.error.message, /actively downloading/i);

    await api("cancelQueue");
    await waitForAllTerminal("mutation queue did not settle");
    await waitForNoProcess("coord=mutate", "mutation test process survived");
    queue = await api("getQueue");
    assert.equal(
      queue.filter((item) => item.url === second).length,
      1,
      "pending item was lost",
    );
  });

  it("clears a running queue without recording an outcome for removed items", async () => {
    const slow = `${MEDIA}/slow.mp4?coord=clear`;
    const next = `${MEDIA}/clip-three.mp4?coord=clear`;
    assert.equal((await api("addToQueue", [slow, next])).data.added, 2);
    assert.equal((await api("startQueue")).ok, true);
    await waitForItemStatus(slow, "downloading", "queue item never started");
    await browser.pause(1000);
    assert.equal((await api("clearQueue")).ok, true);
    assert.deepEqual(await api("getQueue"), []);
    await waitForNoProcess("coord=clear", "cleared queue yt-dlp survived");
    await browser.pause(1000);
    const slowEntries = await activityFor(slow);
    assert.equal(slowEntries.length, 1, "running item recorded more than once");
    assert.equal(slowEntries[0].outcome, "cancelled");
    assert.equal(
      (await activityFor(next)).length,
      0,
      "removed item was recorded",
    );
  });

  it("keeps the persisted queue equal to the live queue after a run", async () => {
    const urls = [
      `${MEDIA}/clip-two.mp4?coord=persist`,
      `${MEDIA}/clip-one.mp4?coord=persist`,
    ];
    assert.equal((await api("addToQueue", urls)).data.added, 2);
    assert.equal((await api("startQueue")).ok, true);
    await waitForAllTerminal("persisted run did not finish");
    const live = (await api("getQueue")).map((item) => [item.url, item.status]);
    const queuePath = path.join(DATA_DIR, "download-queue.json");
    await browser.waitUntil(
      () => {
        if (!fs.existsSync(queuePath)) return false;
        const raw = JSON.parse(fs.readFileSync(queuePath, "utf8"));
        const list = Array.isArray(raw) ? raw : (raw.items ?? raw.queue ?? []);
        const onDisk = list.map((item) => [item.url, item.status]);
        return JSON.stringify(onDisk) === JSON.stringify(live);
      },
      {
        timeout: 15_000,
        interval: 250,
        timeoutMsg: "persisted queue lags the live queue",
      },
    );
  });

  it("publishes strictly increasing revisions and never renders a stale snapshot", async () => {
    // Records every revision the renderer's queue-update listener receives.
    await browser.execute(() => {
      window.__rosiQueueRevisions = [];
      window.__rosiQueueUnsubscribe = window.api.onQueueUpdate((snapshot) => {
        window.__rosiQueueRevisions.push(snapshot.revision);
      });
    });
    try {
      const urls = [
        `${MEDIA}/clip-two.mp4?coord=revision`,
        `${MEDIA}/clip-one.mp4?coord=revision`,
      ];
      assert.equal((await api("addToQueue", urls)).data.added, 2);
      assert.equal((await api("startQueue")).ok, true);
      await waitForAllTerminal("revision run did not finish");

      const revisions = await browser.execute(() =>
        window.__rosiQueueRevisions.slice(),
      );
      assert.ok(
        revisions.length >= 3,
        `expected several snapshots, received ${revisions.length}`,
      );
      for (let index = 1; index < revisions.length; index += 1) {
        assert.ok(
          revisions[index] > revisions[index - 1],
          `revision ${revisions[index]} did not follow ${revisions[index - 1]}`,
        );
      }

      const rowCount = () =>
        browser.execute(
          () => document.querySelectorAll("#queueList .queue-item").length,
        );
      const rendered = await rowCount();
      assert.equal(rendered, 2, "the finished run did not render both rows");

      // Revision 0 is older than every snapshot the coordinator publishes. The
      // probe sends it as a real queue-update with an empty queue.
      await browser.execute(() =>
        window.__TAURI__.core.invoke("e2e_emit_stale_download_events", {
          currentSessionId: 2,
          staleQueueSnapshot: true,
        }),
      );
      await browser.waitUntil(
        () => browser.execute(() => window.__rosiQueueRevisions.includes(0)),
        {
          timeout: 10_000,
          interval: 250,
          timeoutMsg: "the stale snapshot never reached the renderer",
        },
      );
      await browser.pause(1000);
      assert.equal(
        await rowCount(),
        rendered,
        "a stale queue snapshot replaced the rendered queue",
      );
      assert.equal((await api("getQueue")).length, 2);
    } finally {
      await browser.execute(() => {
        window.__rosiQueueUnsubscribe?.();
        delete window.__rosiQueueUnsubscribe;
        delete window.__rosiQueueRevisions;
      });
    }
  });
});
