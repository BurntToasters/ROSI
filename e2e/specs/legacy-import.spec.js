import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../helpers/app-bridge.js";
import { snapshotDir } from "../helpers/legacy-v4.js";

const env = process.env;
const CASE = env.ROSI_E2E_LEGACY_CASE;
const SEED = JSON.parse(env.ROSI_E2E_LEGACY_V4 || "{}");
const DATA_DIR = env.ROSI_E2E_DATA_DIR;
const MEDIA = env.ROSI_E2E_MEDIA_URL;
const FIXTURES = JSON.parse(env.ROSI_E2E_FIXTURES || "{}");
const MARKER = path.join(DATA_DIR, "legacy-v4-import.json");

const results = [];

const real = (value) => fs.realpathSync.native(value);

function readMarker() {
  assert.ok(fs.existsSync(MARKER), `import marker missing: ${MARKER}`);
  return JSON.parse(fs.readFileSync(MARKER, "utf8"));
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

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
  return (listing ?? "")
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.includes(needle) &&
        !line.includes("ps -Ao") &&
        !line.includes("Get-CimInstance"),
    );
}

async function wizardActive() {
  return browser.execute(
    () =>
      document.getElementById("setup-wizard")?.classList.contains("active") ??
      false,
  );
}

describe("ROSI 4 data import", () => {
  before(async () => {
    assert.ok(SEED.dir, "ROSI_E2E_LEGACY_V4 is not set");
    await waitForAppReady();
  });

  after(() => {
    if (env.ROSI_E2E_RESULTS) {
      fs.writeFileSync(
        env.ROSI_E2E_RESULTS,
        `${JSON.stringify(results, null, 2)}\n`,
      );
    }
  });

  it("imports ROSI 4 settings, queue, stats, and activity on first launch", async function () {
    if (CASE !== "import") this.skip();

    const marker = readMarker();
    assert.equal(marker.outcome, "imported", JSON.stringify(marker));
    assert.equal(real(marker.source), real(SEED.dir));
    assert.deepEqual([...marker.imported].sort(), [
      "download-activity.json",
      "download-queue.backup.json",
      "download-stats.json",
      "settings.json",
    ]);
    assert.deepEqual(
      marker.skipped.map((entry) => entry.file),
      ["download-queue.json"],
    );

    const settings = await api("getSettings");
    for (const [key, want] of Object.entries(SEED.expected.settings)) {
      const got = settings[key];
      if (key === "downloadFolder") {
        assert.equal(real(got), real(want), "settings.downloadFolder");
      } else {
        assert.deepEqual(got, want, `settings.${key}`);
      }
    }
    assert.deepEqual(
      settings.downloadPresets.map((preset) => preset.name),
      SEED.expected.presets,
    );
    assert.equal(await wizardActive(), false, "first-run wizard reappeared");

    const queue = await api("getQueue");
    assert.deepEqual(
      queue.map((item) => ({ id: item.id, status: item.status })),
      SEED.expected.queue,
    );
    await browser.pause(2000);
    assert.equal(
      (await api("getQueue")).some((item) => item.status === "downloading"),
      false,
      "an imported queue item started downloading",
    );
    assert.deepEqual(processesMatching("rosi-v4-pending"), []);

    const stats = await api("getStats");
    for (const [key, want] of Object.entries(SEED.expected.stats)) {
      assert.equal(stats[key], want, `stats.${key}`);
    }
    const activity = (await api("getDownloadActivity")).data;
    assert.deepEqual(
      activity.map((entry) => entry.id),
      SEED.expected.activityIds,
    );

    // The imported download folder must be the one the UI downloads into.
    const url = `${MEDIA}/clip-one.mp4`;
    await browser.execute((value) => {
      const input = document.getElementById("url");
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, url);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => !document.getElementById("downloadBtn")?.disabled,
        ),
      { timeout: 10_000, timeoutMsg: "download button stayed disabled" },
    );
    await browser.execute(() =>
      document.getElementById("downloadBtn")?.click(),
    );
    let entry = null;
    await browser.waitUntil(
      async () => {
        const list = (await api("getDownloadActivity")).data ?? [];
        entry = list.find((item) => item.url === url) ?? null;
        return Boolean(entry);
      },
      { timeout: 120_000, interval: 500, timeoutMsg: "download never ended" },
    );
    assert.equal(entry.outcome, "success", entry.error ?? entry.statusMessage);
    assert.equal(
      real(path.dirname(entry.outputPath)),
      real(SEED.downloadFolder),
      "download did not use the imported folder",
    );
    assert.equal(sha256File(entry.outputPath), FIXTURES["clip-one.mp4"]);

    assert.deepEqual(snapshotDir(SEED.dir), SEED.snapshot, "ROSI 4 changed");

    results.push({
      name: "legacy-v4-import",
      status: "passed",
      covers: [
        "wrong-source-dir",
        "unvalidated-values",
        "corrupt-file",
        "resumes-downloads",
        "mutates-v4",
        "wizard-again",
        "folder-unused",
        "data-dropped",
        "leaks-real-profile",
      ],
      imported: marker.imported,
      skipped: marker.skipped.map((item) => item.file),
      queue: queue.length,
      totalDownloads: stats.totalDownloads,
      activity: activity.length,
      download: path.basename(entry.outputPath),
    });
  });

  it("skips the import when ROSI 4 settings are corrupt", async function () {
    if (CASE !== "corrupt-settings") this.skip();

    const marker = readMarker();
    assert.equal(marker.outcome, "skipped", JSON.stringify(marker));
    assert.deepEqual(marker.imported, []);
    assert.equal(real(marker.source), real(SEED.dir));

    const settings = await api("getSettings");
    assert.equal(settings.theme, "system");
    assert.equal(settings.firstLaunch, true);
    assert.equal(await wizardActive(), true, "wizard hidden without settings");
    const stats = await api("getStats");
    assert.equal(stats.totalDownloads, 0, "stats imported without settings");
    assert.deepEqual(await api("getQueue"), []);
    for (const name of [
      "download-stats.json",
      "download-queue.json",
      "download-queue.backup.json",
      "download-activity.json",
    ]) {
      assert.equal(fs.existsSync(path.join(DATA_DIR, name)), false, name);
    }
    assert.deepEqual(snapshotDir(SEED.dir), SEED.snapshot, "ROSI 4 changed");

    results.push({
      name: "legacy-v4-corrupt-settings",
      status: "passed",
      covers: ["corrupt-settings", "mutates-v4"],
      reason: marker.reason,
    });
  });
});
