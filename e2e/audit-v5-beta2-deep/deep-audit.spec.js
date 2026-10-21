// Observational probes for the V5 beta 2 deep audit. Failure modes are in
// failure-modes.md (written first). Each run executes one mode, chosen by the
// runner, and writes observation.json. `invariantPassed: false` is a
// reproduced product defect, not a probe error.
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../helpers/app-bridge.js";

const mode = process.env.ROSI_DEEP_MODE;
const directory = process.env.ROSI_DEEP_ARTIFACTS;
const dataDir = process.env.ROSI_E2E_DATA_DIR;
const downloads = process.env.ROSI_DEEP_DOWNLOADS;
const home = process.env.HOME;
const logPath = path.join(dataDir, "logs", "rosi.log");
const settingsPath = path.join(dataDir, "settings.json");
const queuePath = path.join(dataDir, "download-queue.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readLog() {
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
}

function readBytes(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

async function waitForLog(patterns, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const log = readLog();
    const hit = patterns.find((pattern) => pattern.test(log));
    if (hit) return { matched: String(hit), elapsedMs: Date.now() - started };
    await sleep(200);
  }
  return { matched: null, elapsedMs: Date.now() - started };
}

/** Request a close through the real window close path and judge the outcome. */
async function requestCloseAndObserve(timeoutMs = 15_000) {
  const logBefore = readLog().length;
  await browser.execute(() => {
    void window.__TAURI__.window.getCurrentWindow().close();
  });
  const outcome = await waitForLog(
    [
      /Main window closed\./,
      /Close cancelled because durable state could not be confirmed/,
      /Timed out waiting for renderer settings flush/,
    ],
    timeoutMs,
  );
  // Let a late close finish so the log tells the whole story.
  await sleep(2000);
  const tail = readLog().slice(logBefore);
  const closed = /Main window closed\./.test(tail);
  if (closed) globalThis.rosiMainWindowClosed = true;
  return {
    closed,
    firstOutcome: outcome.matched,
    elapsedMs: outcome.elapsedMs,
    logTail: tail.split("\n").filter(Boolean).slice(-25),
  };
}

async function closeNewerQueue(observation) {
  const before = readBytes(queuePath);
  observation.close = await requestCloseAndObserve();
  const after = readBytes(queuePath);
  observation.queueBytesUnchanged = Boolean(
    before && after && before.equals(after),
  );
  observation.invariantPassed =
    observation.close.closed === true && observation.queueBytesUnchanged;
}

async function closeNewerSettings(observation) {
  const before = readBytes(settingsPath);
  observation.close = await requestCloseAndObserve();
  const after = readBytes(settingsPath);
  observation.settingsBytesUnchanged = Boolean(
    before && after && before.equals(after),
  );
  observation.invariantPassed =
    observation.close.closed === true && observation.settingsBytesUnchanged;
}

async function closeInvalidFolder(observation) {
  const outside = process.env.ROSI_DEEP_OUTSIDE_FOLDER;
  observation.outsideFolder = outside;
  observation.home = home;
  observation.outsideIsOutsideHome = !path
    .resolve(outside)
    .startsWith(`${path.resolve(home)}${path.sep}`);
  if (!observation.outsideIsOutsideHome) {
    throw new Error(
      "Probe setup error: the replacement folder is inside HOME.",
    );
  }
  const settingsBefore = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  observation.folderBefore = settingsBefore.downloadFolder;
  // Simulate the native picker returning a folder outside the allowed bases.
  await browser.execute((folder) => {
    window.api.selectDownloadLocation = async () => folder;
    document.getElementById("changeDownloadFolderBtn").click();
  }, outside);
  await sleep(1500);
  observation.uiFolderSummary = await browser.execute(
    () => document.getElementById("downloadFolderSummary")?.title ?? null,
  );
  observation.folderOnDiskAfterPick = JSON.parse(
    fs.readFileSync(settingsPath, "utf8"),
  ).downloadFolder;

  // An unrelated toggle must still be saved.
  const notificationsBefore = settingsBefore.notifications;
  await browser.execute((checked) => {
    const toggle = document.getElementById("notificationsToggle");
    toggle.checked = checked;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
  }, !notificationsBefore);
  await sleep(1500);
  observation.unrelatedToggleSaved =
    JSON.parse(fs.readFileSync(settingsPath, "utf8")).notifications ===
    !notificationsBefore;
  observation.visibleModal = await browser.execute(() => {
    const modal = document.getElementById("app-modal");
    return modal?.classList.contains("active")
      ? (document.getElementById("modal-message")?.textContent ?? "")
      : null;
  });

  observation.close = await requestCloseAndObserve();
  observation.invariantPassed =
    observation.uiFolderSummary !== outside &&
    observation.unrelatedToggleSaved === true &&
    observation.close.closed === true;
}

async function waitForQueueIdle(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const queue = await api("getQueue");
    if (
      !queue.some((item) => ["pending", "downloading"].includes(item.status))
    ) {
      return queue;
    }
    await sleep(250);
  }
  return api("getQueue");
}

async function waitForManualDone(url, sinceMs, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const activity = await api("getDownloadActivity");
    const entry = activity?.data?.find(
      (item) =>
        item.owner === "manual" &&
        item.url === url &&
        item.completedAt >= sinceMs,
    );
    if (entry) return entry;
    await sleep(250);
  }
  return null;
}

async function queueOwnerRace(observation) {
  const conflict = "Download session already active with a different owner.";
  observation.rounds = [];
  for (let round = 1; round <= 6; round += 1) {
    const urls = [1, 2, 3].map(
      (index) => `https://127.0.0.1:9/rosi-race-q${index}.mp4?round=${round}`,
    );
    const manualUrl = `https://127.0.0.1:9/rosi-race-manual.mp4?round=${round}`;
    const added = await api("addToQueue", urls);
    const startedAt = Date.now();
    // Alternate which request is sent first so both race orders are covered.
    const manualFirst = round % 2 === 0;
    const results = await browser.executeAsync(
      (manual, outputPath, manualFirstOrder, done) => {
        const queue = () => window.api.startQueue();
        const download = () =>
          window.api.downloadVideo({ url: manual, outputPath });
        const started = manualFirstOrder
          ? [download(), queue()]
          : [queue(), download()];
        Promise.allSettled(
          manualFirstOrder ? [started[1], started[0]] : started,
        ).then((settled) =>
          done(
            JSON.stringify(
              settled.map((entry) =>
                entry.status === "fulfilled"
                  ? {
                      ok: entry.value?.ok === true,
                      error: entry.value?.error?.message ?? null,
                    }
                  : { ok: false, error: String(entry.reason) },
              ),
            ),
          ),
        );
      },
      manualUrl,
      downloads,
      manualFirst,
    );
    const [queueStart, manualStart] = JSON.parse(results);
    const queue = await waitForQueueIdle(60_000);
    const manual = manualStart.ok
      ? await waitForManualDone(manualUrl, startedAt, 60_000)
      : null;
    const roundItems = queue.filter((item) => urls.includes(item.url));
    const conflicts = roundItems.filter((item) => item.error === conflict);
    observation.rounds.push({
      round,
      manualFirst,
      added,
      queueStart,
      manualStart,
      bothAccepted: queueStart.ok && manualStart.ok,
      itemErrors: roundItems.map((item) => ({
        status: item.status,
        error: item.error ?? null,
      })),
      ownerConflicts: conflicts.length,
      manualOutcome: manual?.outcome ?? null,
    });
    await api("clearQueue");
    await sleep(500);
  }
  observation.roundsJudged = observation.rounds.filter(
    (round) => round.bothAccepted,
  ).length;
  observation.totalOwnerConflicts = observation.rounds.reduce(
    (sum, round) => sum + round.ownerConflicts,
    0,
  );
  observation.judgeable = observation.roundsJudged > 0;
  observation.invariantPassed = observation.totalOwnerConflicts === 0;
}

async function stagingSweepLeak(observation) {
  const seeded = JSON.parse(process.env.ROSI_DEEP_SEEDED);
  observation.seeded = seeded;
  observation.sweepLog = await waitForLog(
    [/Recovered staged file from an interrupted session/],
    30_000,
  );
  await sleep(3000);
  const entries = fs.readdirSync(downloads).sort();
  observation.downloadFolderEntries = entries;
  observation.recoveredBookkeeping = entries.filter(
    (name) => name.startsWith(".rosi-path-") && name.includes("(recovered)"),
  );
  observation.recoveredMedia = entries.filter(
    (name) => name.startsWith("interrupted") && name.includes("(recovered)"),
  );
  const stage = path.join(downloads, seeded.stage);
  observation.stageRemains = fs.existsSync(stage);
  observation.nestedConvertRemains = fs.existsSync(
    path.join(stage, seeded.nested),
  );
  observation.sweepLogLines = readLog()
    .split("\n")
    .filter((line) => /staging|staged|Recovered/i.test(line))
    .slice(-20);
  observation.invariantPassed =
    observation.recoveredMedia.length === 1 &&
    observation.recoveredBookkeeping.length === 0 &&
    !observation.stageRemains &&
    !observation.nestedConvertRemains;
}

async function proxyPoolExhaustion(observation) {
  const manifest = process.env.ROSI_DEEP_HLS_URL;
  const windowMs = Number(process.env.ROSI_DEEP_WINDOW_MS || 120_000);
  observation.manifest = manifest;
  observation.windowMs = windowMs;
  const startedAt = Date.now();
  observation.start = await api("downloadVideo", {
    url: manifest,
    outputPath: downloads,
  });
  let entry = null;
  while (Date.now() - startedAt < windowMs) {
    const activity = await api("getDownloadActivity");
    entry = activity?.data?.find(
      (item) => item.url === manifest && item.completedAt >= startedAt,
    );
    if (entry) break;
    await sleep(500);
  }
  observation.completedWithinWindow = Boolean(entry);
  observation.elapsedMs = Date.now() - startedAt;
  if (!entry) {
    await api("cancelDownload");
    await sleep(3000);
  }
  observation.outcome = entry?.outcome ?? null;
  observation.outputPath = entry?.outputPath ?? null;
  observation.consoleTail = await browser.execute(() =>
    (document.getElementById("output")?.textContent ?? "")
      .split("\n")
      .slice(-40),
  );
  // The runner adds the origin request log and judges the timing invariant.
  observation.invariantPassed = null;
}

const probes = {
  "close-newer-queue": closeNewerQueue,
  "close-newer-settings": closeNewerSettings,
  "close-invalid-folder": closeInvalidFolder,
  "queue-owner-race": queueOwnerRace,
  "staging-sweep-leak": stagingSweepLeak,
  "proxy-pool-exhaustion": proxyPoolExhaustion,
};

describe("V5 beta 2 deep audit probes", () => {
  it(`observes ${mode}`, async () => {
    const probe = probes[mode];
    if (!probe) throw new Error(`Unknown deep audit mode: ${mode}`);
    await waitForAppReady();
    const observation = { mode, startedAt: new Date().toISOString() };
    try {
      await probe(observation);
    } catch (error) {
      observation.probeError =
        error instanceof Error ? error.message : String(error);
      observation.invariantPassed = observation.invariantPassed ?? false;
    }
    observation.finishedAt = new Date().toISOString();
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "observation.json"),
      `${JSON.stringify(observation, null, 2)}\n`,
    );
  });
});
