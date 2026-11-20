import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/ui.js";

const mode = process.env.ROSI_PERSISTENCE_MODE;
const directory = process.env.ROSI_PERSISTENCE_ARTIFACTS;
const dataDir = process.env.ROSI_E2E_DATA_DIR;
const queuePath = path.join(dataDir, "download-queue.json");
const backupPath = path.join(dataDir, "download-queue.backup.json");
const statsPath = path.join(dataDir, "download-stats.json");
const activityPath = path.join(dataDir, "download-activity.json");
const settingsPath = path.join(dataDir, "settings.json");
const logPath = path.join(dataDir, "logs", "rosi.log");

function readLog() {
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
}

function countMatches(text, needle) {
  return text.split(needle).length - 1;
}
const itemA = "https://persistence.invalid/a.mp4";
const itemB = "https://persistence.invalid/b.mp4";
const itemC = "https://persistence.invalid/c.mp4";

const readBytes = (file) => fs.readFileSync(file);
const isDirectory = (file) =>
  fs.existsSync(file) && fs.statSync(file).isDirectory();
const recoveryCopies = (stem) =>
  fs
    .readdirSync(dataDir)
    .filter((name) => name.startsWith(`${stem}.recovery-`));

/**
 * Call a bridge method and report failures as data instead of throwing. `ok`
 * is the IPC envelope result (`value.ok`), so a refused command reads as false.
 */
async function attempt(method, ...args) {
  try {
    const value = await api(method, ...args);
    return { ok: value?.ok === true, value };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Wait for a disk or log condition. Resolves true when it held and false on
 * timeout, so the caller's invariant records the failure with its evidence.
 */
async function waitForCondition(check, message, timeout = 5_000) {
  try {
    await browser.waitUntil(check, {
      timeout,
      interval: 100,
      timeoutMsg: message,
    });
    return true;
  } catch {
    return false;
  }
}

/** Queue saves are debounced (about 300 ms); wait until the URL reaches disk. */
function waitForPersistedUrl(url) {
  return waitForCondition(
    () => fs.existsSync(queuePath) && readBytes(queuePath).includes(url),
    `queue file never contained ${url}`,
  );
}

const PERSIST_FAILURE_LINE = "Failed to persist queue revision";

describe("v5 persistence acceptance (findings 2, 3, 15, 16)", () => {
  it(`records the ${mode} invariant in the real application`, async () => {
    await waitForAppReady();
    const observation = { mode, startedAt: new Date().toISOString() };

    if (mode === "stats-damaged") {
      const damaged = readBytes(statsPath);
      observation.reset = await attempt("resetStats");
      observation.recovery = recoveryCopies("download-stats");
      const preserved =
        observation.recovery.length === 1 &&
        readBytes(path.join(dataDir, observation.recovery[0])).equals(damaged);
      observation.secondReset = await attempt("resetStats");
      observation.recoveryAfterSecondSave =
        recoveryCopies("download-stats").length;
      observation.invariantPassed =
        observation.reset.ok === true &&
        preserved &&
        JSON.parse(readBytes(statsPath)).schemaVersion === 1 &&
        observation.secondReset.ok === true &&
        observation.recoveryAfterSecondSave === 1;
    } else if (mode === "stats-unreadable") {
      observation.reset = await attempt("resetStats");
      observation.invariantPassed =
        observation.reset.ok === false && isDirectory(statsPath);
    } else if (mode === "stats-newer-schema") {
      const before = readBytes(statsPath);
      observation.reset = await attempt("resetStats");
      observation.invariantPassed =
        observation.reset.ok === false && readBytes(statsPath).equals(before);
    } else if (mode === "stats-legacy-object") {
      const stats = await api("getStats");
      observation.stats = stats;
      observation.invariantPassed = stats.totalDownloads === 7;
    } else if (mode === "activity-damaged") {
      const damaged = readBytes(activityPath);
      observation.clear = await attempt("clearDownloadActivity");
      observation.recovery = recoveryCopies("download-activity");
      observation.invariantPassed =
        observation.clear.ok === true &&
        observation.recovery.length === 1 &&
        readBytes(path.join(dataDir, observation.recovery[0])).equals(
          damaged,
        ) &&
        JSON.parse(readBytes(activityPath)).schemaVersion === 1;
    } else if (mode === "activity-unreadable") {
      observation.clear = await attempt("clearDownloadActivity");
      observation.invariantPassed =
        observation.clear.ok === false && isDirectory(activityPath);
    } else if (mode === "activity-newer-schema") {
      const before = readBytes(activityPath);
      observation.clear = await attempt("clearDownloadActivity");
      observation.invariantPassed =
        observation.clear.ok === false &&
        readBytes(activityPath).equals(before);
    } else if (mode === "activity-legacy-array") {
      const activity = await api("getDownloadActivity");
      observation.activityCount = activity.data.length;
      observation.invariantPassed = activity.data.length === 1;
    } else if (mode === "queue-legacy-array") {
      const before = await api("getQueue");
      observation.beforeCount = before.length;
      observation.add = await attempt("addToQueue", [itemB]);
      const after = await api("getQueue");
      observation.afterUrls = after.map((item) => item.url);
      observation.invariantPassed =
        before.length === 1 &&
        after.length === 2 &&
        after[0].url === itemA &&
        (await waitForPersistedUrl(itemB)) &&
        JSON.parse(readBytes(queuePath)).schemaVersion === 1;
    } else if (mode === "queue-backup-previous") {
      observation.firstAdd = await attempt("addToQueue", [itemB]);
      await waitForPersistedUrl(itemB);
      const firstGeneration = readBytes(queuePath);
      observation.secondAdd = await attempt("addToQueue", [itemC]);
      await waitForPersistedUrl(itemC);
      // The backup is written just after the primary; wait for that write
      // instead of racing it.
      await waitForCondition(
        () =>
          fs.existsSync(backupPath) && readBytes(backupPath).includes(itemB),
        "backup file never contained the first generation",
      );
      const backup = JSON.parse(readBytes(backupPath));
      observation.backupUrls = (
        Array.isArray(backup) ? backup : backup.items
      ).map((item) => item.url);
      observation.primaryUrls = JSON.parse(readBytes(queuePath)).items.map(
        (item) => item.url,
      );
      observation.invariantPassed =
        firstGeneration.includes(itemB) &&
        observation.backupUrls.includes(itemB) &&
        !observation.backupUrls.includes(itemC) &&
        observation.primaryUrls.includes(itemC) &&
        (await api("getQueue")).some((item) => item.url === itemC);
    } else if (mode === "queue-damaged-primary") {
      const backup = readBytes(backupPath);
      observation.loaded = (await api("getQueue")).map((item) => item.url);
      observation.add = await attempt("addToQueue", [itemC]);
      await waitForPersistedUrl(itemC);
      observation.recovery = recoveryCopies("download-queue");
      observation.invariantPassed =
        observation.loaded.includes(itemA) &&
        observation.recovery.length === 1 &&
        readBytes(backupPath).equals(backup);
    } else if (mode === "queue-newer-schema") {
      const before = readBytes(queuePath);
      observation.add = await attempt("addToQueue", [itemB]);
      // Each refused save logs one persist failure, so the count shows the
      // writer got past each add before the notice count is read.
      const refusedAfterFirst = await waitForCondition(
        () => countMatches(readLog(), PERSIST_FAILURE_LINE) >= 1,
        "first add never reached a refused queue save",
      );
      const firstCount = countMatches(readLog(), PERSIST_FAILURE_LINE);
      observation.secondAdd = await attempt("addToQueue", [itemC]);
      const refusedAfterSecond = await waitForCondition(
        () => countMatches(readLog(), PERSIST_FAILURE_LINE) > firstCount,
        "second add never reached a refused queue save",
      );
      const log = readLog();
      observation.userNotices = countMatches(
        log,
        "Told the user that a newer ROSI version owns Download queue",
      );
      observation.invariantPassed =
        refusedAfterFirst &&
        refusedAfterSecond &&
        readBytes(queuePath).equals(before) &&
        observation.userNotices === 1;
    } else if (mode === "settings-unreadable") {
      observation.save = await attempt("saveSettings", { theme: "light" });
      observation.loaded = await api("getSettings");
      observation.invariantPassed =
        observation.save.ok === false &&
        isDirectory(settingsPath) &&
        typeof observation.loaded.theme === "string";
    } else {
      throw new Error(`Unknown persistence mode: ${mode}`);
    }

    observation.finishedAt = new Date().toISOString();
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "observation.json"),
      `${JSON.stringify(observation, null, 2)}\n`,
    );
    if (observation.invariantPassed !== true) {
      throw new Error(`Invariant failed for ${mode}`);
    }
  });
});
