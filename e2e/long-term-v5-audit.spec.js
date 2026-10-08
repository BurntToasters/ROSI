import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "./helpers/app-bridge.js";

const mode = process.env.ROSI_LONG_TERM_MODE;
const directory = process.env.ROSI_LONG_TERM_ARTIFACTS;
const settingsPath = path.join(process.env.ROSI_E2E_DATA_DIR, "settings.json");
const queuePath = path.join(
  process.env.ROSI_E2E_DATA_DIR,
  "download-queue.json",
);

describe("long-term V5 observational audit", () => {
  it("records compatibility and persistence behavior in the real application", async () => {
    await waitForAppReady();
    const observation = { mode, startedAt: new Date().toISOString() };
    if (
      mode === "future-settings" ||
      mode === "corrupt-settings" ||
      mode === "control"
    ) {
      const originalBytes = fs.readFileSync(settingsPath);
      observation.loadedSettings = await api("getSettings");
      observation.save = await api("saveSettings", { theme: "light" });
      observation.savedSettings = JSON.parse(
        fs.readFileSync(settingsPath, "utf8"),
      );
      const files = fs.readdirSync(path.dirname(settingsPath));
      observation.profileFiles = files;
      if (mode === "future-settings") {
        observation.invariantPassed =
          (observation.save?.ok === false &&
            fs.readFileSync(settingsPath).equals(originalBytes)) ||
          (observation.savedSettings.settingsVersion === 8 &&
            observation.savedSettings.futureAuditField?.retained === true);
      } else if (mode === "corrupt-settings") {
        observation.invariantPassed =
          observation.save?.ok === false ||
          files.some(
            (name) =>
              name !== "settings.json" &&
              name.includes("settings") &&
              fs
                .statSync(path.join(path.dirname(settingsPath), name))
                .isFile() &&
              fs
                .readFileSync(
                  path.join(path.dirname(settingsPath), name),
                  "utf8",
                )
                .includes("LONG_TERM_DAMAGED_SETTINGS"),
          );
      } else {
        observation.invariantPassed =
          observation.save?.ok === true &&
          observation.savedSettings.theme === "light";
      }
    } else if (mode === "unreadable-settings") {
      observation.save = await api("saveSettings", { theme: "light" });
      observation.invariantPassed =
        observation.save?.ok === false &&
        fs.statSync(settingsPath).isDirectory();
    } else if (
      mode === "migration-source-corrupt" ||
      mode === "migration-old-marker"
    ) {
      observation.marker = JSON.parse(
        fs.readFileSync(
          path.join(process.env.ROSI_E2E_DATA_DIR, "legacy-v4-import.json"),
        ),
      );
      observation.invariantPassed = (
        observation.marker.retryFiles || []
      ).includes("download-queue.json");
    } else if (mode === "migration-marker-failure") {
      observation.settings = await api("getSettings");
      observation.queue = await api("getQueue");
      observation.invariantPassed =
        observation.settings.firstLaunch === true &&
        observation.queue.length === 0 &&
        fs
          .statSync(
            path.join(process.env.ROSI_E2E_DATA_DIR, "legacy-v4-import.json"),
          )
          .isDirectory();
    } else if (mode === "migration-failure" || mode === "migration-retry") {
      observation.queue = await api("getQueue");
      observation.marker = JSON.parse(
        fs.readFileSync(
          path.join(process.env.ROSI_E2E_DATA_DIR, "legacy-v4-import.json"),
          "utf8",
        ),
      );
      observation.settingsCommitted = fs.existsSync(settingsPath);
      observation.invariantPassed =
        mode === "migration-failure"
          ? observation.marker.outcome !== "imported" ||
            observation.queue.some((item) => item.id === "legacy-audit-item")
          : observation.queue.some((item) => item.id === "legacy-audit-item") &&
            JSON.parse(
              fs.readFileSync(
                path.join(process.env.ROSI_E2E_DATA_DIR, "download-stats.json"),
              ),
            ).totalDownloads === 42;
    } else if (mode === "queue-normal") {
      observation.add = await api(
        "addToQueue",
        Array.from(
          { length: 500 },
          (_, index) => `https://audit.invalid/short.mp4?item=${index}`,
        ),
      );
      observation.queueCount = (await api("getQueue")).length;
      await browser.waitUntil(
        () =>
          fs.existsSync(queuePath) &&
          JSON.parse(fs.readFileSync(queuePath)).length === 500,
        { timeout: 15000 },
      );
      observation.invariantPassed =
        observation.add?.ok === true &&
        observation.add.data.added === 500 &&
        observation.queueCount === 500;
    } else if (mode === "queue-budget") {
      observation.controlAdd = await api("addToQueue", [
        "https://audit.invalid/retained.mp4",
      ]);
      observation.add = JSON.parse(
        await browser.executeAsync((done) => {
          const urls = Array.from(
            { length: 499 },
            (_, index) =>
              `https://audit.invalid/video.mp4?item=${index}&padding=${"x".repeat(35000)}`,
          );
          window.api.addToQueue(urls).then(
            (value) => done(JSON.stringify(value)),
            (error) => done(JSON.stringify({ error: String(error) })),
          );
        }),
      );
      observation.queueCount = await browser.executeAsync((done) => {
        window.api.getQueue().then((queue) => done(queue.length));
      });
      await browser.waitUntil(
        () =>
          observation.add?.ok === false ||
          (fs.existsSync(queuePath) &&
            JSON.parse(fs.readFileSync(queuePath)).length ===
              observation.queueCount),
        {
          timeout: 15000,
          interval: 100,
          timeoutMsg: "Oversize queue was not persisted",
        },
      );
      observation.primaryBytes = fs.existsSync(queuePath)
        ? fs.statSync(queuePath).size
        : 0;
      observation.invariantPassed =
        observation.controlAdd?.ok === true &&
        ((observation.add?.ok === false && observation.queueCount === 1) ||
          observation.primaryBytes <= 32 * 1024 * 1024);
    } else if (
      mode === "stats-reset-failure" ||
      mode === "stats-reset-control"
    ) {
      if (mode === "stats-reset-failure")
        fs.mkdirSync(
          path.join(process.env.ROSI_E2E_DATA_DIR, "download-stats.json"),
        );
      observation.backend = await api("resetStats");
      await browser.execute(() =>
        document.getElementById("viewStatsBtn").click(),
      );
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            Array.from(document.querySelectorAll("#modal-buttons button")).some(
              (button) => button.textContent.includes("Reset Stats"),
            ),
          ),
        { timeout: 10000 },
      );
      await browser.execute(() => {
        Array.from(document.querySelectorAll("#modal-buttons button"))
          .find((button) => button.textContent.includes("Reset Stats"))
          .click();
      });
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            [...document.querySelectorAll(".toast-container")].some((element) =>
              /Statistics reset\.|Could not reset statistics/.test(
                element.textContent,
              ),
            ),
          ),
        { timeout: 10000 },
      );
      observation.toast = await browser.execute(() =>
        [...document.querySelectorAll(".toast-container")]
          .map((element) => element.textContent)
          .join(" "),
      );
      observation.invariantPassed =
        mode === "stats-reset-control"
          ? observation.backend?.ok === true &&
            observation.toast.includes("Statistics reset.")
          : observation.backend?.ok === false &&
            !observation.toast.includes("Statistics reset.") &&
            observation.toast.includes("Could not reset statistics");
    } else if (mode === "queue-reload") {
      observation.queueCount = await browser.executeAsync((done) => {
        window.api.getQueue().then((queue) => done(queue.length));
      });
      observation.invariantPassed =
        observation.queueCount ===
        Number(process.env.ROSI_LONG_TERM_EXPECTED_QUEUE_COUNT);
    }
    if (mode === "stats-reset-failure")
      await browser.saveScreenshot(path.join(directory, "reset-result.png"));
    observation.display = await browser.execute(() => {
      const card = document.querySelector(".download-card");
      return {
        visibilityState: document.visibilityState,
        cardOpacity: card ? getComputedStyle(card).opacity : null,
        cardAnimations: card
          ? card.getAnimations().map((animation) => ({
              playState: animation.playState,
              currentTime: animation.currentTime,
            }))
          : [],
      };
    });
    observation.finishedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(directory, "observation.json"),
      JSON.stringify(observation, null, 2) + "\n",
    );
    // Observational completion is deliberately separate from acceptance.
    // The runner fails after retaining every independently completed case.
  });
});
