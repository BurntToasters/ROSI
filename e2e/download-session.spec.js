import { readListFile } from "./helpers/persisted.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "./helpers/app-bridge.js";
const directory = process.env.ROSI_AUDIT4_ARTIFACTS;
const observations = [];
function record(name, details) {
  observations.push({ name, ...details });
  fs.writeFileSync(
    path.join(directory, "native-observations.json"),
    JSON.stringify(observations, null, 2) + "\n",
  );
}
describe("audit four native repair acceptance", () => {
  before(async () => {
    await waitForAppReady();
  });
  it("retains artwork source despite Keep original being disabled", async () => {
    const url = process.env.ROSI_AUDIT4_MEDIA + "/covered.mp4";
    const settings = await api("getSettings");
    const response = await api("downloadVideo", {
      url,
      outputPath: settings.downloadFolder,
      convertEnabled: true,
      convertFormat: "mp3",
      keepOriginal: false,
      hookBrowser: false,
      gpuAcceleration: false,
    });
    assert.equal(response.ok, true, JSON.stringify(response));
    let completion;
    await browser.waitUntil(
      async () => {
        const activity = await api("getDownloadActivity");
        completion = activity.data.find((item) => item.url === url);
        return Boolean(completion);
      },
      { timeout: 45000, interval: 100 },
    );
    const outputs = completion.outputPaths ?? [];
    const source = outputs.find((p) => p.endsWith(".mp4"));
    const converted = outputs.find((p) => p.endsWith(".mp3"));
    record("artwork-source-retained", { completion, source, converted });
    assert.equal(completion.outcome, "success");
    assert.ok(source);
    assert.ok(converted);
    const probe = spawnSync(
      process.env.ROSI_AUDIT4_FFPROBE,
      ["-v", "error", "-show_streams", "-of", "json", source],
      { encoding: "utf8" },
    );
    assert.equal(probe.status, 0, probe.stderr);
    assert.ok(
      JSON.parse(probe.stdout).streams.some(
        (s) => s.disposition?.attached_pic === 1,
      ),
    );
    await browser.saveScreenshot(path.join(directory, "artwork-retention.png"));
  });
  it("shutdown drains a newly claimed queue item before final flush", async () => {
    const url = process.env.ROSI_AUDIT4_MEDIA + "/covered.mp4?queue-drain";
    assert.equal((await api("addToQueue", [url])).ok, true);
    assert.equal((await api("startQueue")).ok, true);
    const shutdown = await browser.executeAsync((done) => {
      window.__TAURI__.core.invoke("e2e_updater_install_probe").then(
        () => done({ ok: true }),
        (error) => done({ error: String(error) }),
      );
    });
    assert.equal(shutdown.ok, true, JSON.stringify(shutdown));
    const queue = await api("getQueue");
    const persisted = readListFile(
      path.join(process.env.ROSI_E2E_DATA_DIR, "download-queue.json"),
    );
    record("shutdown-queue-drained", { queue, persisted });
    assert.ok(queue.every((item) => item.status !== "downloading"));
    assert.deepEqual(persisted, queue);
  });
});
