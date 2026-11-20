import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { activityFor, api, waitForAppReady } from "../../helpers/ui.js";
import {
  deterministicBytes,
  sha256,
  startMediaServer,
} from "../../helpers/media-server.js";

// Acceptance for downloader Wave 1 A2: each cancel ends only the session its
// owner holds. The runner (run.mjs) plants nothing here; this spec runs its own
// media server and reads the download folder from ROSI_E2E_DOWNLOADS.
//
// Case (b), queue cancel and clear while a manual download runs, is a guard:
// the queue cannot start while a manual session holds the slot, so the
// pre-fix code only reaches that state through a race that IPC cannot order.
// See failure-modes.md, rows C4 and C5.
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} must be set by e2e/v5-fixes/downloader/run.mjs; run the runner, not this spec alone`,
    );
  }
  return value;
}
const directory = requiredEnv("ROSI_V5_FIX_ARTIFACTS");
const downloads = requiredEnv("ROSI_E2E_DOWNLOADS");
const report = { suite: "cancel-ownership", checks: [] };
const writeReport = () =>
  fs.writeFileSync(
    path.join(directory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
const record = (name, details) => {
  report.checks.push({ name, ...details });
  writeReport();
};

// A 2 MiB body trickled at 16 KiB per 250 ms takes about 32 seconds, which
// leaves room to cancel while it is in flight.
const SLOW_BYTES = 2 * 1024 * 1024;
const FAST_BYTES = 256 * 1024;

// Window for watching that a manual Cancel leaves the queue item alone. A
// correct build changes nothing, so there is no state to wait on; the loop ends
// early the moment the item leaves "downloading". Twelve samples at 250 ms.
const CANCEL_OBSERVATION_SAMPLES = 12;
const CANCEL_OBSERVATION_INTERVAL_MS = 250;

const queueStatus = async (url) =>
  (await api("getQueue")).find((item) => item.url === url)?.status ?? null;

async function waitForRequest(server, requestPath, message) {
  await browser.waitUntil(
    () => server.requests.some((request) => request.path === requestPath),
    { timeout: 60_000, interval: 200, timeoutMsg: message },
  );
}

async function waitForOutcome(url, outcome, timeout, message) {
  await browser.waitUntil(
    async () =>
      (await activityFor(url)).some((entry) => entry.outcome === outcome),
    { timeout, interval: 250, timeoutMsg: message },
  );
  return (await activityFor(url)).find((entry) => entry.outcome === outcome);
}

// Records a check whether or not its body throws, so the report names the
// failing case. The first failure is rethrown after the record is written.
async function check(name, body) {
  try {
    const details = await body();
    record(name, { invariantPassed: true, ...details });
  } catch (error) {
    record(name, {
      invariantPassed: false,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

describe("V5 fix A2: cancel ownership", () => {
  let server;
  let queueBytes;
  let manualBytes;
  let clipBytes;

  before(async () => {
    queueBytes = deterministicBytes(SLOW_BYTES, "cancel-ownership:queue");
    manualBytes = deterministicBytes(SLOW_BYTES, "cancel-ownership:manual");
    clipBytes = deterministicBytes(FAST_BYTES, "cancel-ownership:clip");
    server = await startMediaServer({
      "/queue-item.mp4": { body: queueBytes, slow: true },
      "/manual-item.mp4": { body: manualBytes, slow: true },
      "/manual-b.mp4": { body: manualBytes, slow: true },
      "/clip.mp4": { body: clipBytes },
    });
    await waitForAppReady();
  });

  after(async () => {
    await server?.close();
  });

  it("(a) manual Cancel leaves a running queue item downloading to completion", async () => {
    const url = `${server.baseUrl}/queue-item.mp4`;
    await check("manual cancel does not end a queue item", async () => {
      assert.equal((await api("addToQueue", [url])).ok, true);
      assert.equal((await api("startQueue")).ok, true);
      await browser.waitUntil(
        async () => (await queueStatus(url)) === "downloading",
        {
          timeout: 60_000,
          interval: 200,
          timeoutMsg: "queue item never started",
        },
      );
      await waitForRequest(
        server,
        "/queue-item.mp4",
        "yt-dlp never requested the queue item",
      );
      // cancel_download names no session. Before the owner filter it ended
      // whichever session was current, so it would end this queue item.
      await api("cancelDownload");
      const statuses = [];
      for (let sample = 0; sample < CANCEL_OBSERVATION_SAMPLES; sample += 1) {
        statuses.push(await queueStatus(url));
        if (statuses.at(-1) !== "downloading") break;
        await browser.pause(CANCEL_OBSERVATION_INTERVAL_MS);
      }
      assert.deepEqual(
        [...new Set(statuses)],
        ["downloading"],
        `queue item left downloading after manual Cancel: ${statuses.join(",")}`,
      );
      await browser.waitUntil(
        async () => (await queueStatus(url)) === "completed",
        {
          timeout: 120_000,
          interval: 500,
          timeoutMsg: "queue item did not complete after manual Cancel",
        },
      );
      const [entry] = await activityFor(url);
      assert.ok(entry, "queue item has no activity entry");
      assert.equal(entry.outcome, "success", JSON.stringify(entry));
      assert.ok(entry.outputPath, "completion is missing outputPath");
      const delivered = fs.readFileSync(entry.outputPath);
      assert.equal(sha256(delivered), sha256(queueBytes));
      return {
        statusesAfterCancel: [...new Set(statuses)],
        outcome: entry.outcome,
        deliveredSha256: sha256(delivered),
      };
    });
  });

  it("(a2) manual Cancel still cancels a running manual download", async () => {
    const url = `${server.baseUrl}/manual-item.mp4`;
    await check("manual cancel ends a manual download", async () => {
      // The queue drains on its own after (a); wait until a manual start is
      // accepted again.
      // C2b: nothing for this URL may exist before the manual start.
      assert.equal(
        (await activityFor(url)).length,
        0,
        "manual URL already has activity before the manual start",
      );
      // C2a: the IPC reply is { ok, data }; the started payload is in data.
      let started = null;
      await browser.waitUntil(
        async () => {
          const response = await api("downloadVideo", {
            url,
            outputPath: downloads,
            convertEnabled: false,
            hookBrowser: false,
            gpuAcceleration: false,
          });
          if (response.ok === true) started = response.data;
          return response.ok === true;
        },
        {
          timeout: 60_000,
          interval: 500,
          timeoutMsg: "manual download was never accepted",
        },
      );
      assert.equal(started?.started, true);
      assert.equal(typeof started?.sessionId, "number");
      await waitForRequest(
        server,
        "/manual-item.mp4",
        "yt-dlp never requested the manual download",
      );
      await api("cancelDownload");
      const entry = await waitForOutcome(
        url,
        "cancelled",
        60_000,
        "manual download was not cancelled by manual Cancel",
      );
      return { outcome: entry.outcome, sessionId: started.sessionId };
    });
  });

  it("(b) queue cancel and clear leave a running manual download alone", async () => {
    const manualUrl = `${server.baseUrl}/manual-b.mp4`;
    const pendingUrl = `${server.baseUrl}/clip.mp4?cancel-ownership=pending`;
    await check(
      "queue cancel and clear do not end a manual download",
      async () => {
        const response = await api("downloadVideo", {
          url: manualUrl,
          outputPath: downloads,
          convertEnabled: false,
          hookBrowser: false,
          gpuAcceleration: false,
        });
        assert.equal(response.ok, true, JSON.stringify(response));
        await waitForRequest(
          server,
          "/manual-b.mp4",
          "yt-dlp never requested the manual download",
        );
        assert.equal((await api("addToQueue", [pendingUrl])).ok, true);
        assert.equal((await api("cancelQueue")).ok, true);
        assert.equal((await api("clearQueue")).ok, true);
        // Both queue calls returned while the manual download was still running.
        const duringQueueCalls = await activityFor(manualUrl);
        assert.equal(
          duringQueueCalls.length,
          0,
          "manual download finished before the queue calls ran",
        );
        const entry = await waitForOutcome(
          manualUrl,
          "success",
          120_000,
          "manual download did not complete after queue cancel and clear",
        );
        assert.ok(entry.outputPath, "completion is missing outputPath");
        assert.equal(
          sha256(fs.readFileSync(entry.outputPath)),
          sha256(manualBytes),
        );
        return {
          outcome: entry.outcome,
          queueAfterClear: await api("getQueue"),
        };
      },
    );
  });
});
