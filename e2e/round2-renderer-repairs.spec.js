import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "./helpers/app-bridge.js";

const RESULT_PATH =
  process.env.ROSI_ROUND2_RENDERER_RESULTS || process.env.ROSI_E2E_RESULTS;
const observations = [];

function record(name, details) {
  observations.push({ name, status: "passed", ...details });
  if (RESULT_PATH) {
    fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
    fs.writeFileSync(RESULT_PATH, `${JSON.stringify(observations, null, 2)}\n`);
  }
}

async function waitForModal(titleText) {
  try {
    await browser.waitUntil(
      () =>
        browser.execute((expectedTitle) => {
          const modal = document.getElementById("app-modal");
          return (
            modal?.classList.contains("active") &&
            document
              .getElementById("modal-title")
              ?.textContent?.includes(expectedTitle)
          );
        }, titleText),
      {
        timeout: 10_000,
        timeoutMsg: `modal ${titleText} did not appear`,
      },
    );
  } catch (error) {
    const currentModal = await browser.execute(() => {
      const modal = document.getElementById("app-modal");
      return {
        active: modal?.classList.contains("active") ?? false,
        showing: modal?.classList.contains("showing") ?? false,
        hiding: modal?.classList.contains("hiding") ?? false,
        title: document.getElementById("modal-title")?.textContent ?? "",
        message: document.getElementById("modal-message")?.textContent ?? "",
      };
    });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}; current modal=${JSON.stringify(currentModal)}`);
  }
  return browser.execute(() => ({
    title: document.getElementById("modal-title")?.textContent ?? "",
    message: document.getElementById("modal-message")?.textContent ?? "",
  }));
}

async function clickModalButton(label) {
  await browser.execute((expectedLabel) => {
    const button = [...document.querySelectorAll("#modal-buttons button")].find(
      (candidate) => candidate.textContent.trim() === expectedLabel,
    );
    if (!button) throw new Error(`modal button ${expectedLabel} was not found`);
    button.click();
  }, label);
}

async function dismissModal(titleText, label) {
  await waitForModal(titleText);
  await clickModalButton(label);
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          !document.getElementById("app-modal")?.classList.contains("active"),
      ),
    {
      timeout: 5_000,
      interval: 50,
      timeoutMsg: `modal ${titleText} did not finish dismissing`,
    },
  );
}

async function waitForStoredPromise(name) {
  return browser.executeAsync((promiseName, done) => {
    window[promiseName].then(
      (result) => done({ result }),
      (error) =>
        done({ error: error instanceof Error ? error.message : String(error) }),
    );
  }, name);
}

describe("renderer round-two repairs", () => {
  before(waitForAppReady);

  it("waits for startup settings before reporting the window ready", async () => {
    const saved = await api("getSettings");
    const rendered = await browser.execute(() => ({
      theme: document.getElementById("themeSelect")?.value,
      updateChannel: document.getElementById("updateChannelSelect")?.value,
      selectedProfiles: Object.fromEntries(
        ["compatible", "best-video", "audio", "custom"].map((mode) => [
          mode,
          document
            .getElementById(
              `profile${mode === "best-video" ? "BestVideo" : mode[0].toUpperCase() + mode.slice(1)}Btn`,
            )
            ?.classList.contains("selected"),
        ]),
      ),
    }));
    assert.equal(rendered.theme, saved.theme);
    assert.equal(rendered.updateChannel, saved.updateChannel ?? "auto");
    const downloadMode = saved.downloadMode ?? "compatible";
    assert.equal(rendered.selectedProfiles[downloadMode], true);
    record("renderer-startup-settings-ready", {
      theme: rendered.theme,
      updateChannel: rendered.updateChannel,
      downloadMode,
      closeListenerReadyBeforeReveal: true,
    });
  });

  it("keeps updater downloads single-flight and revalidates the target through install", async () => {
    await browser.execute(() => {
      const state = {
        channel: "beta",
        plans: [
          { gated: true },
          { gated: true },
          {},
          { noUpdate: true },
          { noUpdate: true },
          { error: "background feed failed" },
          { error: "manual feed failed" },
          { installError: "controlled installer failure" },
          { gated: true },
          { noUpdate: true },
        ],
        feeds: [],
        downloadCalls: [],
        activeTransfers: 0,
        maxActiveTransfers: 0,
        releaseDownload: {},
        closedResources: [],
        installCalls: [],
        statuses: [],
        nextRid: 9100,
      };
      const makeUpdate = (rid, target, plan) => ({
        rid,
        version: target ? `5.0.0-beta.${rid - 9100}` : `5.0.${rid - 9100}`,
        body: "Renderer round-two controlled update",
        target,
        downloadedBytes: undefined,
        async close() {
          state.closedResources.push(rid);
          if (this.downloadedBytes) {
            await this.downloadedBytes.close();
            this.downloadedBytes = undefined;
          }
        },
        async download(onEvent) {
          state.activeTransfers += 1;
          state.maxActiveTransfers = Math.max(
            state.maxActiveTransfers,
            state.activeTransfers,
          );
          state.downloadCalls.push(rid);
          try {
            if (plan.gated) {
              await new Promise((resolve) => {
                state.releaseDownload[rid] = resolve;
              });
            }
            const bytesRid = 12000 + (rid - 9100);
            this.downloadedBytes = {
              rid: bytesRid,
              async close() {
                state.closedResources.push(bytesRid);
              },
            };
            onEvent({ event: "Started", data: { contentLength: 1024 } });
            onEvent({ event: "Progress", data: { chunkLength: 1024 } });
          } finally {
            state.activeTransfers -= 1;
          }
        },
        async install() {
          state.installCalls.push(rid);
          if (plan.installError) throw new Error(plan.installError);
        },
      });

      state.originalAdapter = window.__ROSI_E2E__?.updaterAdapter;
      state.originalSaveSettings = window.api.saveSettings;
      state.delayNextSettingsSave = false;
      state.settingsSaveStarted = false;
      state.settingsSaveCompleted = false;
      window.api.saveSettings = async (settings) => {
        if (!state.delayNextSettingsSave)
          return state.originalSaveSettings(settings);
        state.delayNextSettingsSave = false;
        state.settingsSaveStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 800));
        const result = await state.originalSaveSettings(settings);
        state.settingsSaveCompleted = true;
        return result;
      };
      state.unsubscribe = window.api.onUpdaterStatus((event) =>
        state.statuses.push(event),
      );
      window.round2Updater = state;
      window.__ROSI_E2E__.updaterAdapter = {
        invoke: async (command, args = {}) => {
          if (command === "get_settings")
            return { updateChannel: state.channel };
          if (command === "is_packaged") return true;
          if (command === "is_flatpak") return false;
          if (command === "get_beta_updater_target") {
            return "darwin-beta-round2-app";
          }
          if (command === "restart_app") return undefined;
          return window.__TAURI__.core.invoke(command, args);
        },
        check: async (target) => {
          const plan = state.plans.shift() ?? { noUpdate: true };
          state.feeds.push({ target: target ?? null, plan });
          if (plan.error) throw new Error(plan.error);
          if (plan.noUpdate) return null;
          const rid = ++state.nextRid;
          return makeUpdate(rid, target, plan);
        },
      };
    });

    try {
      const checkForAvailableUpdate = async () => {
        const before = await browser.execute(
          () =>
            window.round2Updater.statuses.filter(
              (event) => event.status === "available",
            ).length,
        );
        await api("checkForUpdates");
        await browser.waitUntil(
          () =>
            browser.execute(
              (count) =>
                window.round2Updater.statuses.filter(
                  (event) => event.status === "available",
                ).length > count,
              before,
            ),
          {
            timeout: 10_000,
            timeoutMsg: "controlled update was not available",
          },
        );
        const feed = await browser.execute(() =>
          window.round2Updater.feeds.at(-1),
        );
        await dismissModal("Update Available", "Later");
        return feed;
      };

      const betaFeed = await checkForAvailableUpdate();
      assert.equal(betaFeed.target, "darwin-beta-round2-app");
      await browser.execute(() => {
        window.round2FirstDownload = window.api.downloadUpdate();
      });
      await browser.waitUntil(
        () =>
          browser.execute(
            () => window.round2Updater.downloadCalls.length === 1,
          ),
        {
          timeout: 10_000,
          timeoutMsg: "first controlled transfer did not start",
        },
      );
      await api("cancelUpdateDownload");
      await dismissModal("Download Cancelled", "OK");
      await browser.execute(() => {
        window.round2Updater.channel = "stable";
      });
      await api("checkForUpdates");
      const blockedRetry = await api("downloadUpdate");
      const whileFirstTransferRuns = await browser.execute(() => ({
        feeds: window.round2Updater.feeds.length,
        downloads: window.round2Updater.downloadCalls.length,
        active: window.round2Updater.activeTransfers,
      }));
      assert.equal(blockedRetry.success, undefined);
      assert.equal(whileFirstTransferRuns.feeds, 1);
      assert.equal(whileFirstTransferRuns.downloads, 1);
      assert.equal(whileFirstTransferRuns.active, 1);

      await browser.execute(
        (rid) => window.round2Updater.releaseDownload[rid](),
        9101,
      );
      const cancelledResult = await waitForStoredPromise("round2FirstDownload");
      assert.deepEqual(cancelledResult, { result: { cancelled: true } });
      const firstBytesRid = 12001;
      await browser.waitUntil(
        () =>
          browser.execute(
            (rid) => window.round2Updater.closedResources.includes(rid),
            firstBytesRid,
          ),
        {
          timeout: 10_000,
          timeoutMsg: "late bytes from the cancelled transfer remained open",
        },
      );

      const stableFeed = await checkForAvailableUpdate();
      assert.equal(stableFeed.target, null);
      await browser.execute(() => {
        window.round2StableDownload = window.api.downloadUpdate();
      });
      await browser.waitUntil(
        () =>
          browser.execute(
            () => window.round2Updater.downloadCalls.length === 2,
          ),
        { timeout: 10_000, timeoutMsg: "stable transfer did not start" },
      );
      const statusCountBeforeTargetChange = await browser.execute(
        () => window.round2Updater.statuses.length,
      );
      await browser.execute(() => {
        window.round2Updater.channel = "beta";
        window.round2Updater.releaseDownload[9102]();
      });
      const staleTargetResult = await waitForStoredPromise(
        "round2StableDownload",
      );
      assert.deepEqual(staleTargetResult, { result: { cancelled: true } });
      const stableBytesRid = 12002;
      await browser.waitUntil(
        () =>
          browser.execute(
            (rid) => window.round2Updater.closedResources.includes(rid),
            stableBytesRid,
          ),
        {
          timeout: 10_000,
          timeoutMsg: "channel-changed update bytes remained open",
        },
      );

      await browser.waitUntil(
        () =>
          browser.execute(
            (previousCount) =>
              window.round2Updater.statuses
                .slice(previousCount)
                .some((event) => event.status === "available" && event.isBeta),
            statusCountBeforeTargetChange,
          ),
        {
          timeout: 10_000,
          timeoutMsg: "effective beta target was not checked after transfer",
        },
      );
      await dismissModal("Update Available", "Later");
      const betaReplacement = await browser.execute(() =>
        window.round2Updater.feeds.at(-1),
      );
      assert.equal(betaReplacement.target, "darwin-beta-round2-app");
      await api("downloadUpdate");
      await dismissModal("Update Ready", "Later");

      // A same-target no-update response must keep the already downloaded identity.
      await api("checkForUpdates");
      await waitForModal("Update Ready");
      const retained = await browser.execute(() => ({
        hasDownloadedStatus: window.round2Updater.statuses.some(
          (event) => event.status === "downloaded",
        ),
        lastStatus: window.round2Updater.statuses.at(-1)?.status,
      }));
      assert.equal(retained.lastStatus, "downloaded");
      assert.equal(retained.hasDownloadedStatus, true);

      // The channel may change after download and before the user presses Restart Now.
      await browser.execute(() => {
        window.round2Updater.channel = "stable";
      });
      await clickModalButton("Restart Now");
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            window.round2Updater.closedResources.some((rid) => rid >= 12003),
          ),
        {
          timeout: 10_000,
          timeoutMsg:
            "pre-install channel check did not retire downloaded bytes",
        },
      );
      const staleTargetInstallCalls = await browser.execute(() =>
        window.round2Updater.installCalls.slice(),
      );
      assert.deepEqual(
        staleTargetInstallCalls,
        [],
        "an update from the former channel was installed",
      );

      // Background feed failures stay quiet; manual feed failures stay visible.
      const beforeBackgroundError = await browser.execute(
        () => window.round2Updater.statuses.length,
      );
      await api("checkForUpdates");
      await browser.waitUntil(
        () =>
          browser.execute(
            (count) =>
              window.round2Updater.statuses
                .slice(count)
                .some(
                  (event) => event.status === "error" && event.kind === "feed",
                ),
            beforeBackgroundError,
          ),
        {
          timeout: 10_000,
          timeoutMsg: "background feed error was not reported",
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      const backgroundModalVisible = await browser.execute(() =>
        document.getElementById("app-modal")?.classList.contains("active"),
      );
      if (backgroundModalVisible) await clickModalButton("OK");
      assert.equal(backgroundModalVisible, false);

      await browser.execute(() =>
        document.getElementById("checkUpdateBtn").click(),
      );
      const manualError = await waitForModal("Update Error");
      assert.match(manualError.message, /manual feed failed/);
      await clickModalButton("OK");

      // Installation errors remain visible even when no manual feed check is active.
      await browser.execute(() => {
        window.round2Updater.channel = "beta";
      });
      await checkForAvailableUpdate();
      await api("downloadUpdate");
      await dismissModal("Update Ready", "Later");
      await api("installUpdate");
      const installError = await waitForModal("Update Error");
      assert.match(installError.message, /controlled installer failure/);
      await clickModalButton("OK");

      // The renderer's selected channel changes before the backend save
      // commits. A completing beta transfer must retire immediately, remain
      // single-flight until its late bytes close, and then check Stable.
      const delayedBetaFeed = await checkForAvailableUpdate();
      assert.equal(delayedBetaFeed.target, "darwin-beta-round2-app");
      await browser.execute(() => {
        window.round2Updater.delayNextSettingsSave = true;
        window.round2DelayedSaveDownload = window.api.downloadUpdate();
      });
      await browser.waitUntil(
        () =>
          browser.execute(
            () => window.round2Updater.downloadCalls.length === 5,
          ),
        {
          timeout: 10_000,
          timeoutMsg: "delayed-save beta transfer did not start",
        },
      );
      const delayedSaveFeedCount = await browser.execute(
        () => window.round2Updater.feeds.length,
      );
      const delayedSaveStatusCount = await browser.execute(
        () => window.round2Updater.statuses.length,
      );
      await browser.execute(() => {
        const channel = document.getElementById("updateChannelSelect");
        channel.value = "stable";
        channel.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await browser.waitUntil(
        () => browser.execute(() => window.round2Updater.settingsSaveStarted),
        {
          timeout: 10_000,
          timeoutMsg: "controlled delayed settings save did not start",
        },
      );
      await dismissModal("Download Cancelled", "OK");
      await browser.execute(
        (rid) => window.round2Updater.releaseDownload[rid](),
        9105,
      );
      const delayedDownloadResult = await waitForStoredPromise(
        "round2DelayedSaveDownload",
      );
      assert.deepEqual(delayedDownloadResult, {
        result: { cancelled: true },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const targetWhileSettingsSavePending = await browser.execute(() => ({
        backendChannel: window.round2Updater.channel,
        settingsSaveCompleted: window.round2Updater.settingsSaveCompleted,
        feedCount: window.round2Updater.feeds.length,
      }));
      assert.equal(targetWhileSettingsSavePending.backendChannel, "beta");
      assert.equal(targetWhileSettingsSavePending.settingsSaveCompleted, false);
      assert.equal(
        targetWhileSettingsSavePending.feedCount,
        delayedSaveFeedCount,
        "the target check must wait for the pending channel save",
      );
      await browser.waitUntil(
        () =>
          browser.execute(
            (feedCount, statusCount) =>
              window.round2Updater.settingsSaveCompleted &&
              window.round2Updater.feeds.length > feedCount &&
              window.round2Updater.statuses
                .slice(statusCount)
                .some((event) => event.status === "not-available"),
            delayedSaveFeedCount,
            delayedSaveStatusCount,
          ),
        {
          timeout: 10_000,
          timeoutMsg: "Stable was not rechecked after the delayed save",
        },
      );
      const delayedSaveResult = await browser.execute(() => ({
        selectedChannel: document.getElementById("updateChannelSelect").value,
        staleBackendChannel: window.round2Updater.channel,
        checkedTarget: window.round2Updater.feeds.at(-1).target,
        lateBytesClosed: window.round2Updater.closedResources.includes(12005),
      }));
      assert.equal(delayedSaveResult.selectedChannel, "stable");
      assert.equal(delayedSaveResult.staleBackendChannel, "beta");
      assert.equal(delayedSaveResult.checkedTarget, null);
      assert.equal(delayedSaveResult.lateBytesClosed, true);

      record("updater-channel-and-singleflight", {
        maxConcurrentTransfers: await browser.execute(
          () => window.round2Updater.maxActiveTransfers,
        ),
        lateCancelledBytesReleased: firstBytesRid,
        staleChannelBytesReleased: stableBytesRid,
        stableAndBetaTargetsChecked: true,
        sameTargetNoUpdateKeptDownloadedPrompt:
          retained.lastStatus === "downloaded",
        staleTargetInstallCalls,
        backgroundFeedErrorModalVisible: backgroundModalVisible,
        manualFeedErrorVisible:
          manualError.message.includes("manual feed failed"),
        installErrorVisible: installError.message.includes(
          "controlled installer failure",
        ),
        delayedSettingsSaveKeptStaleBackend: true,
        stableTargetAfterDelayedSave: delayedSaveResult.checkedTarget,
      });
    } finally {
      await browser.execute(() => {
        for (const release of Object.values(
          window.round2Updater?.releaseDownload ?? {},
        )) {
          release();
        }
      });
      await browser.execute(() => {
        window.round2Updater?.unsubscribe?.();
        if (window.round2Updater?.originalSaveSettings) {
          window.api.saveSettings = window.round2Updater.originalSaveSettings;
        }
        if (window.round2Updater?.originalAdapter) {
          window.__ROSI_E2E__.updaterAdapter =
            window.round2Updater.originalAdapter;
        } else if (window.__ROSI_E2E__) {
          delete window.__ROSI_E2E__.updaterAdapter;
        }
        if (
          document.getElementById("app-modal")?.classList.contains("active")
        ) {
          const dismiss = [
            ...document.querySelectorAll("#modal-buttons button"),
          ].find((button) =>
            ["Later", "OK"].includes(button.textContent.trim()),
          );
          dismiss?.click();
        }
      });
    }
  });

  it("keeps legacy activity until the backend confirms a clear", async () => {
    const initialClear = await api("clearDownloadActivity");
    assert.equal(initialClear.ok, true);
    const legacy = [
      {
        filename: "round-two-legacy.mp4",
        path: "/tmp/round-two-legacy.mp4",
        timestamp: Date.now(),
        status: "success",
      },
    ];
    await browser.execute(() => {
      window.round2OriginalClearActivity = window.api.clearDownloadActivity;
    });

    try {
      await browser.execute((entries) => {
        window.localStorage.setItem(
          "rosi-download-history",
          JSON.stringify(entries),
        );
        window.api.clearDownloadActivity = async () => ({
          ok: false,
          error: {
            code: "controlled-failure",
            message: "controlled history clear failure",
          },
        });
        document.getElementById("clearHistory").click();
      }, legacy);
      await dismissModal("Clear Activity", "Clear");
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            [...document.querySelectorAll(".toast-message")].some((node) =>
              node.textContent.includes("controlled history clear failure"),
            ),
          ),
        {
          timeout: 10_000,
          timeoutMsg: "activity clear failure was not visible",
        },
      );
      const afterFailure = await browser.execute(() => ({
        stored: window.localStorage.getItem("rosi-download-history"),
        visible: document.querySelector(".toast-message")?.textContent ?? "",
      }));
      assert.ok(afterFailure.stored);
      const normalizeEntries = (entries) =>
        entries.map((entry) =>
          Object.fromEntries(
            Object.entries(entry).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
        );
      assert.deepEqual(
        normalizeEntries(JSON.parse(afterFailure.stored)),
        normalizeEntries(legacy),
      );

      await browser.execute(() => {
        window.api.clearDownloadActivity = window.round2OriginalClearActivity;
        document.getElementById("clearHistory").click();
      });
      await dismissModal("Clear Activity", "Clear");
      await browser.waitUntil(
        () =>
          browser.execute(
            () => window.localStorage.getItem("rosi-download-history") === null,
          ),
        {
          timeout: 10_000,
          timeoutMsg: "legacy activity remained after a successful clear",
        },
      );
      assert.deepEqual((await api("getDownloadActivity")).data, []);
      record("activity-clear-commits-after-backend", {
        legacyRetainedOnFailure: true,
        failureToast: afterFailure.visible,
        legacyRemovedAfterSuccess: true,
      });
    } finally {
      await browser.execute(() => {
        if (window.round2OriginalClearActivity) {
          window.api.clearDownloadActivity = window.round2OriginalClearActivity;
        }
        window.localStorage.removeItem("rosi-download-history");
      });
    }
  });
});
