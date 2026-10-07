import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "./helpers/app-bridge.js";

const DATA_DIR = process.env.ROSI_E2E_DATA_DIR;
const RESULT_PATH = process.env.ROSI_STATE_REPAIR_RESULTS;
const MEDIA_URL = process.env.ROSI_E2E_MEDIA_URL;
const observations = [];

function record(name, details) {
  observations.push({ name, status: "passed", ...details });
  if (RESULT_PATH) {
    fs.writeFileSync(RESULT_PATH, `${JSON.stringify(observations, null, 2)}\n`);
  }
}

async function reloadRenderer() {
  await browser.execute(() => {
    window.__ROSI_E2E__.ready = false;
    window.setTimeout(() => window.location.reload(), 50);
  });
  await waitForAppReady();
}

async function waitForStoredSetting(key, value, timeoutMsg) {
  const settingsFile = path.join(DATA_DIR, "settings.json");
  await browser.waitUntil(
    () => {
      try {
        return JSON.parse(fs.readFileSync(settingsFile, "utf8"))[key] === value;
      } catch {
        return false;
      }
    },
    { timeout: 10_000, interval: 100, timeoutMsg },
  );
}

async function clickDownload(url) {
  await browser.execute((target) => {
    const input = document.getElementById("url");
    const button = document.getElementById("downloadBtn");
    input.value = target;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (button._originalClick) button.onclick = button._originalClick;
    button.click();
  }, url);
}

async function dismissModal(titleText, buttonText) {
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
  await browser.execute((label) => {
    const button = [...document.querySelectorAll("#modal-buttons button")].find(
      (candidate) => candidate.textContent.trim() === label,
    );
    if (!button) throw new Error(`modal button ${label} was not found`);
    button.click();
  }, buttonText);
}

describe("state and updater repair E2E", () => {
  before(waitForAppReady);

  it("keeps a newer settings revision after an older response returns", async () => {
    const initial = await api("getSettings");
    const desiredTheme = initial.theme === "dark" ? "light" : "dark";

    await browser.execute(() => {
      window.auditOriginalSave = window.api.saveSettings;
      window.auditSaveCalls = [];
      window.auditSaveHeld = false;
      let heldFirstResponse = false;
      window.api.saveSettings = async (snapshot) => {
        const copy = JSON.parse(JSON.stringify(snapshot));
        const response = await window.auditOriginalSave(copy);
        window.auditSaveCalls.push(copy);
        if (!heldFirstResponse) {
          heldFirstResponse = true;
          window.auditSaveHeld = true;
          await new Promise((resolve) => {
            window.auditReleaseSave = resolve;
          });
        }
        return response;
      };
      const notifications = document.getElementById("notificationsToggle");
      notifications.checked = !notifications.checked;
      notifications.dispatchEvent(new Event("change", { bubbles: true }));
    });

    try {
      await browser.waitUntil(
        () => browser.execute(() => Boolean(window.auditSaveHeld)),
        { timeout: 10_000, timeoutMsg: "first settings response was not held" },
      );
      await browser.execute((theme) => {
        const control = document.getElementById("themeSelect");
        control.value = theme;
        control.dispatchEvent(new Event("change", { bubbles: true }));
        window.auditReleaseSave();
      }, desiredTheme);
      await browser.waitUntil(
        () => browser.execute(() => window.auditSaveCalls.length >= 2),
        {
          timeout: 10_000,
          timeoutMsg: "newer settings revision was not saved",
        },
      );
      await browser.waitUntil(
        async () => (await api("getSettings")).theme === desiredTheme,
        {
          timeout: 10_000,
          interval: 100,
          timeoutMsg: "latest theme did not persist",
        },
      );
      const saved = await api("getSettings");
      const state = await browser.execute(() => ({
        visibleTheme: document.getElementById("themeSelect").value,
        saveThemes: window.auditSaveCalls.map((snapshot) => snapshot.theme),
      }));
      assert.equal(state.visibleTheme, desiredTheme);
      assert.equal(saved.theme, desiredTheme);
      record("settings-response-revision", {
        initialTheme: initial.theme,
        desiredTheme,
        visibleTheme: state.visibleTheme,
        persistedTheme: saved.theme,
        submittedThemes: state.saveThemes,
      });
    } finally {
      await browser.execute((settings) => {
        if (window.auditReleaseSave) window.auditReleaseSave();
        if (window.auditOriginalSave)
          window.api.saveSettings = window.auditOriginalSave;
        const theme = document.getElementById("themeSelect");
        theme.value = settings.theme;
        theme.dispatchEvent(new Event("change", { bubbles: true }));
        const notifications = document.getElementById("notificationsToggle");
        notifications.checked = settings.notifications;
        notifications.dispatchEvent(new Event("change", { bubbles: true }));
      }, initial);
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
  });

  it("waits for settings changed during an immediate close flush", async () => {
    assert.ok(DATA_DIR, "ROSI_E2E_DATA_DIR is not set");
    const original = await api("getSettings");
    const desiredTheme = original.theme === "dark" ? "light" : "dark";
    const settingsFile = path.join(DATA_DIR, "settings.json");

    await browser.execute(() => {
      window.auditOriginalSaveSettings = window.api.saveSettings;
      window.auditOriginalNotifySettingsFlushed =
        window.api.notifySettingsFlushed;
      window.auditLifecycleSaveCalls = [];
      window.auditLifecycleAckGenerations = [];
      window.auditSaveAStarted = false;
      window.auditSaveBStarted = false;
      window.api.saveSettings = async (settings) => {
        const snapshot = JSON.parse(JSON.stringify(settings));
        window.auditLifecycleSaveCalls.push(snapshot);
        if (window.auditLifecycleSaveCalls.length === 1) {
          const result = await window.auditOriginalSaveSettings(snapshot);
          window.auditSaveAStarted = true;
          await new Promise((resolve) => {
            window.auditReleaseSaveA = resolve;
          });
          return result;
        }
        if (window.auditLifecycleSaveCalls.length === 2) {
          window.auditSaveBStarted = true;
          await new Promise((resolve) => {
            window.auditReleaseSaveB = resolve;
          });
        }
        return window.auditOriginalSaveSettings(snapshot);
      };
      window.api.notifySettingsFlushed = async (generation) => {
        window.auditLifecycleAckGenerations.push(generation);
        return window.__TAURI__.core.invoke("e2e_cancel_close_request", {
          generation,
        });
      };
      void window.__TAURI__.window.getCurrentWindow().close();
    });

    try {
      await browser.waitUntil(
        () => browser.execute(() => window.auditSaveAStarted),
        { timeout: 10_000, timeoutMsg: "immediate close save A did not start" },
      );
      await browser.execute((theme) => {
        const control = document.getElementById("themeSelect");
        control.value = theme;
        control.dispatchEvent(new Event("change", { bubbles: true }));
      }, desiredTheme);
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.equal(
        await browser.execute(() => window.auditLifecycleSaveCalls.length),
        1,
        "save B should remain queued behind the held save A",
      );
      assert.equal(
        await browser.execute(() => window.auditLifecycleAckGenerations.length),
        0,
        "close acknowledged while save A was still pending",
      );

      await browser.execute(() => window.auditReleaseSaveA?.());
      await browser.waitUntil(
        () => browser.execute(() => window.auditSaveBStarted),
        { timeout: 10_000, timeoutMsg: "latest revision save B did not start" },
      );
      assert.equal(
        JSON.parse(fs.readFileSync(settingsFile, "utf8")).theme,
        original.theme,
        "save B should still be blocked before writing its snapshot",
      );
      assert.equal(
        await browser.execute(() => window.auditLifecycleAckGenerations.length),
        0,
        "close acknowledgement ran before latest settings were durable",
      );

      await browser.execute(() => window.auditReleaseSaveB?.());
      await browser.waitUntil(
        () =>
          browser.execute(
            () => window.auditLifecycleAckGenerations.length === 1,
          ),
        {
          timeout: 10_000,
          timeoutMsg:
            "close did not acknowledge after latest settings were saved",
        },
      );
      const persisted = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      assert.equal(persisted.theme, desiredTheme);
      record("settings-lifecycle-latest-revision", {
        initialTheme: original.theme,
        desiredTheme,
        saveRevisions: await browser.execute(() =>
          window.auditLifecycleSaveCalls.map((snapshot) => snapshot.theme),
        ),
        acknowledgementCount: 1,
        persistedTheme: persisted.theme,
      });
    } finally {
      await browser.execute(() => {
        window.auditReleaseSaveA?.();
        window.auditReleaseSaveB?.();
        window.api.saveSettings = window.auditOriginalSaveSettings;
        window.api.notifySettingsFlushed =
          window.auditOriginalNotifySettingsFlushed;
      });
      const restored = await api("saveSettings", original);
      assert.equal(restored.ok, true, restored.error?.message);
      await reloadRenderer();
    }
  });

  it("keeps wizard and Deno settings attached across successive saves", async () => {
    assert.ok(DATA_DIR, "ROSI_E2E_DATA_DIR is not set");
    const original = await api("getSettings");
    const seeded = await api("saveSettings", {
      ...original,
      firstLaunch: true,
      denoReminderDismissed: false,
    });
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    await reloadRenderer();

    try {
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            document
              .getElementById("setup-wizard")
              ?.classList.contains("active"),
          ),
        { timeout: 10_000, timeoutMsg: "setup wizard did not open" },
      );
      await browser.execute(() => {
        window.api.checkDenoInstalled = async () => false;
        document.getElementById("wizard-skip").click();
      });
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const modal = document.getElementById("app-modal");
            return (
              modal?.classList.contains("active") &&
              document.getElementById("modal-title")?.textContent ===
                "Deno Required for Full YouTube Functionality"
            );
          }),
        {
          timeout: 10_000,
          timeoutMsg: "Deno reminder did not follow wizard save",
        },
      );

      const nextNotifications = !original.notifications;
      await browser.execute((checked) => {
        const toggle = document.getElementById("notificationsToggle");
        toggle.checked = checked;
        toggle.dispatchEvent(new Event("change", { bubbles: true }));
      }, nextNotifications);
      await waitForStoredSetting(
        "notifications",
        nextNotifications,
        "intervening settings mutation was not saved",
      );

      await browser.execute(() => {
        [...document.querySelectorAll("#modal-buttons button")]
          .find((button) => button.textContent.includes("No, don't remind me"))
          ?.click();
      });
      await waitForStoredSetting(
        "denoReminderDismissed",
        true,
        "Deno reminder mutation was lost after the intervening save",
      );
      record("settings-captured-wizard-deno", {
        notifications: nextNotifications,
        denoReminderDismissed: true,
      });
    } finally {
      const saved = await api("saveSettings", original);
      assert.equal(saved.ok, true, saved.error?.message);
      await reloadRenderer();
    }
  });

  it("describes Compatible output as a preference with a fallback", async () => {
    const contract = await browser.execute(() => {
      const button = document.getElementById("profileCompatibleBtn");
      return {
        label: button?.textContent?.trim() ?? "",
        title: button?.getAttribute("title") ?? "",
        summary:
          document.getElementById("downloadOutputSummary")?.textContent ?? "",
      };
    });
    assert.equal(contract.label, "Compatible");
    assert.match(contract.title, /prefer|when available/i);
    assert.match(contract.title, /fallback|otherwise|may use/i);
    assert.doesNotMatch(contract.title, /one mp4 file that plays everywhere/i);
    assert.match(contract.summary, /prefer mp4 when available/i);
    assert.match(contract.summary, /otherwise|fallback|best available/i);
    assert.doesNotMatch(
      contract.summary,
      /one mp4 file that plays everywhere/i,
    );
    record("compatible-profile-wording", contract);
  });

  it("renders only backend-provided image data and clears remote thumbnails", async () => {
    const previousInfo = {
      title: "Remote thumbnail control",
      uploader: null,
      durationSeconds: null,
      thumbnail: "https://thumbnail.invalid/pixel.jpg",
      ext: "mp4",
      viewCount: null,
      isPlaylist: false,
      playlistCount: null,
      webpageUrl: "https://video.invalid/remote-thumb",
    };
    const safeInfo = {
      ...previousInfo,
      title: "Bounded thumbnail fixture",
      thumbnail:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cRbkAAAAASUVORK5CYII=",
      webpageUrl: "https://video.invalid/data-thumb",
    };
    const oversizedInfo = {
      ...safeInfo,
      title: "Oversized thumbnail fixture",
      thumbnail: null,
      webpageUrl: "https://video.invalid/oversized-thumb",
    };

    await browser.execute(
      (responses) => {
        window.auditOriginalGetVideoInfo = window.api.getVideoInfo;
        window.auditPreviewCalls = [];
        window.api.getVideoInfo = async (url) => {
          window.auditPreviewCalls.push(url);
          const data = url.endsWith("remote-thumb")
            ? responses.remote
            : url.endsWith("data-thumb")
              ? responses.safe
              : {
                  ...responses.oversized,
                  thumbnail: `data:image/png;base64,${"A".repeat(2_796_208)}`,
                };
          return { ok: true, data };
        };
        const url = document.getElementById("url");
        url.value = "https://video.invalid/remote-thumb";
        url.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("previewBtn").click();
      },
      { remote: previousInfo, safe: safeInfo, oversized: oversizedInfo },
    );

    const requestPreview = async (url, expectedTitle) => {
      await browser.execute((target) => {
        const input = document.getElementById("url");
        input.value = target;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, url);
      await browser.waitUntil(
        () =>
          browser.execute(
            () => !document.getElementById("previewBtn")?.disabled,
          ),
        {
          timeout: 5_000,
          timeoutMsg: `preview button was not enabled for ${url}`,
        },
      );
      await browser.execute(() =>
        document.getElementById("previewBtn").click(),
      );
      await browser.waitUntil(
        () =>
          browser.execute(
            (target) => window.auditPreviewCalls.includes(target),
            url,
          ),
        {
          timeout: 5_000,
          timeoutMsg: `preview IPC was not called for ${url}`,
        },
      );
      await browser.waitUntil(
        () =>
          browser.execute(
            (title) =>
              document.getElementById("preview-title")?.textContent === title,
            expectedTitle,
          ),
        {
          timeout: 10_000,
          timeoutMsg: `preview result did not render for ${url}`,
        },
      );
    };

    try {
      await requestPreview(
        "https://video.invalid/remote-thumb",
        "Remote thumbnail control",
      );
      const remoteSrc = await browser.execute(() =>
        document.getElementById("preview-thumb").getAttribute("src"),
      );
      assert.ok(!remoteSrc || remoteSrc.startsWith("data:image/"));

      await requestPreview(
        "https://video.invalid/data-thumb",
        "Bounded thumbnail fixture",
      );
      const safeSrc = await browser.execute(() =>
        document.getElementById("preview-thumb").getAttribute("src"),
      );
      assert.match(safeSrc ?? "", /^data:image\/(?:png|jpeg|webp);base64,/);

      await requestPreview(
        "https://video.invalid/oversized-thumb",
        "Oversized thumbnail fixture",
      );
      const oversizedSrc = await browser.execute(() =>
        document.getElementById("preview-thumb").getAttribute("src"),
      );
      assert.equal(oversizedSrc, null);
      record("guarded-preview-thumbnail", { remoteSrc, safeSrc, oversizedSrc });
    } finally {
      await browser.execute(() => {
        if (window.auditOriginalGetVideoInfo) {
          window.api.getVideoInfo = window.auditOriginalGetVideoInfo;
        }
        document.getElementById("url").value = "";
        document
          .getElementById("url")
          .dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
  });

  it("persists an empty queue after rapid queue mutation", async () => {
    assert.ok(DATA_DIR, "ROSI_E2E_DATA_DIR is not set");
    await api("clearQueue");
    const added = await api("addToQueue", [
      "https://93.184.216.34/first",
      "https://93.184.216.34/second",
      "https://93.184.216.34/third",
    ]);
    assert.equal(added.ok, true, JSON.stringify(added));
    const queued = await api("getQueue");
    assert.equal(queued.length, 3);
    await api("clearQueue");

    const queueFile = path.join(DATA_DIR, "download-queue.json");
    await browser.waitUntil(
      () => {
        try {
          const contents = JSON.parse(fs.readFileSync(queueFile, "utf8"));
          return Array.isArray(contents) && contents.length === 0;
        } catch {
          return false;
        }
      },
      {
        timeout: 10_000,
        interval: 100,
        timeoutMsg: "latest empty queue was not persisted",
      },
    );
    record("queue-latest-snapshot", {
      itemCountBeforeClear: queued.length,
      persistedCount: JSON.parse(fs.readFileSync(queueFile, "utf8")).length,
    });
  });

  it("ignores stale session events and prior result timers", async () => {
    assert.ok(MEDIA_URL, "ROSI_E2E_MEDIA_URL is not set");
    const firstUrl = `${MEDIA_URL}/clip-one.mp4?state-session=first`;
    const slowUrl = `${MEDIA_URL}/slow.mp4?state-session=second`;

    await browser.execute(() => {
      window.auditOriginalDownloadVideo = window.api.downloadVideo;
      window.auditOriginalOpenFileLocation = window.api.openFileLocation;
      window.auditStartedSessionIds = [];
      window.auditStaleEventsDuringPendingStart = false;
      window.api.downloadVideo = async (options) => {
        const result = await window.auditOriginalDownloadVideo(options);
        if (result?.ok === true) {
          window.auditStartedSessionIds.push(result.data.sessionId ?? null);
          if (window.auditStartedSessionIds.length === 2) {
            await window.__TAURI__.core.invoke(
              "e2e_emit_stale_download_events",
              { currentSessionId: result.data.sessionId },
            );
            window.auditStaleEventsDuringPendingStart = true;
          }
        }
        return result;
      };
    });

    try {
      await clickDownload(firstUrl);
      await browser.waitUntil(
        () => browser.execute(() => window.auditStartedSessionIds.length >= 1),
        {
          timeout: 10_000,
          timeoutMsg: "first download did not return a session ID",
        },
      );
      const firstSessionId = await browser.execute(
        () => window.auditStartedSessionIds[0],
      );
      assert.equal(typeof firstSessionId, "number");
      let firstCompletion;
      await browser.waitUntil(
        async () => {
          const activity = await api("getDownloadActivity");
          firstCompletion = activity.data.find(
            (entry) =>
              entry.sessionId === firstSessionId && entry.outcome === "success",
          );
          return Boolean(firstCompletion);
        },
        {
          timeout: 60_000,
          interval: 200,
          timeoutMsg: "first download did not complete",
        },
      );
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const button = document.getElementById("downloadBtn");
            return (
              !button.classList.contains("loading") &&
              /Open File Location|Download complete/.test(button.textContent)
            );
          }),
        {
          timeout: 10_000,
          timeoutMsg: "first completion result was not shown",
        },
      );
      assert.ok(
        firstCompletion.outputPath,
        "structured completion omitted its output path",
      );
      await browser.execute(() => {
        window.auditOpenedFilePath = null;
        window.api.openFileLocation = async (filePath) => {
          window.auditOpenedFilePath = filePath;
          return { ok: true, data: { opened: true } };
        };
        document.getElementById("downloadBtn").click();
      });
      await browser.waitUntil(
        () => browser.execute(() => Boolean(window.auditOpenedFilePath)),
        {
          timeout: 10_000,
          timeoutMsg: "structured result did not open its output path",
        },
      );
      const openedFilePath = await browser.execute(
        () => window.auditOpenedFilePath,
      );
      assert.equal(openedFilePath, firstCompletion.outputPath);

      await clickDownload(slowUrl);
      await browser.waitUntil(
        () => browser.execute(() => window.auditStartedSessionIds.length >= 2),
        {
          timeout: 10_000,
          timeoutMsg: "second download did not return a session ID",
        },
      );
      const secondSessionId = await browser.execute(
        () => window.auditStartedSessionIds[1],
      );
      assert.equal(typeof secondSessionId, "number");
      assert.ok(secondSessionId > firstSessionId);
      assert.equal(
        await browser.execute(() => window.auditStaleEventsDuringPendingStart),
        true,
      );
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            document
              .getElementById("downloadBtn")
              ?.classList.contains("loading"),
          ),
        { timeout: 10_000, timeoutMsg: "second download never became active" },
      );

      await browser.executeAsync((currentSessionId, done) => {
        window.__TAURI__.core
          .invoke("e2e_emit_stale_download_events", { currentSessionId })
          .then(
            () => setTimeout(done, 100),
            (error) => done(String(error)),
          );
      }, secondSessionId);
      await new Promise((resolve) => setTimeout(resolve, 8500));

      const activeUi = await browser.execute(() => ({
        loading: document
          .getElementById("downloadBtn")
          ?.classList.contains("loading"),
        progressVisible: document
          .getElementById("progress-container")
          ?.classList.contains("visible"),
        buttonText: document.getElementById("downloadBtn")?.textContent?.trim(),
      }));
      assert.equal(
        activeUi.loading,
        true,
        "stale completion or timer cleared the new job",
      );
      assert.equal(
        activeUi.progressVisible,
        true,
        "stale timer hid current progress",
      );
      assert.doesNotMatch(activeUi.buttonText ?? "", /stale/i);

      await api("cancelDownload");
      let secondCompletion;
      await browser.waitUntil(
        async () => {
          const activity = await api("getDownloadActivity");
          secondCompletion = activity.data.find(
            (entry) =>
              entry.sessionId === secondSessionId &&
              entry.outcome === "cancelled",
          );
          return Boolean(secondCompletion);
        },
        {
          timeout: 30_000,
          interval: 200,
          timeoutMsg: "second download cancellation was not recorded",
        },
      );
      const activity = await api("getDownloadActivity");
      assert.ok(
        activity.data.some(
          (entry) =>
            entry.sessionId === firstSessionId && entry.outcome === "success",
        ),
        "first completion disappeared from Activity",
      );
      record("download-session-isolation", {
        firstSessionId,
        firstOutputPath: firstCompletion.outputPath ?? null,
        openedFilePath,
        secondSessionId,
        secondOutcome: secondCompletion.outcome,
        activeUi,
        activityEntries: activity.data.filter((entry) =>
          [firstSessionId, secondSessionId].includes(entry.sessionId),
        ).length,
      });
    } finally {
      await api("cancelDownload");
      await browser.execute(() => {
        if (window.auditOriginalDownloadVideo) {
          window.api.downloadVideo = window.auditOriginalDownloadVideo;
        }
        if (window.auditOriginalOpenFileLocation) {
          window.api.openFileLocation = window.auditOriginalOpenFileLocation;
        }
      });
    }
  });

  it("fences updater generations and retries a refused install with retained bytes", async () => {
    assert.ok(DATA_DIR, "ROSI_E2E_DATA_DIR is not set");
    const queueFile = path.join(DATA_DIR, "download-queue.json");
    const backupPath = path.join(DATA_DIR, "download-queue.backup.json");
    let priorBackup = null;

    await browser.execute(() => {
      window.auditOriginalE2eUpdaterAdapter =
        window.__ROSI_E2E__?.updaterAdapter;
      window.auditUpdateChannel = "beta";
      window.auditFeedRecords = [];
      window.auditDownloadCalls = [];
      window.auditActiveTransfers = 0;
      window.auditAttachedBytes = [];
      window.auditDownloadReleases = {};
      window.auditClosedResources = [];
      window.auditInstallCalls = [];
      window.auditRestartCalls = 0;
      window.auditUpdaterStatuses = [];
      window.auditCheckResults = [];
      window.auditInvokeCommands = [];
      const makeUpdate = (rid, version, target) => ({
        rid,
        currentVersion: "5.0.0-beta.2",
        version,
        date: null,
        body: `Controlled ${version}`,
        rawJson: {},
        target,
        available: true,
        downloadedBytes: undefined,
        async close() {
          window.auditClosedResources.push(this.rid);
          if (this.downloadedBytes) {
            await this.downloadedBytes.close();
            this.downloadedBytes = undefined;
          }
        },
        async download(onEvent) {
          window.auditDownloadCalls.push(this.rid);
          window.auditActiveTransfers += 1;
          try {
            const bytesRid = 8000 + (this.rid - 7000);
            const attachBytes = () => {
              window.auditAttachedBytes.push(bytesRid);
              this.downloadedBytes = {
                rid: bytesRid,
                async close() {
                  window.auditClosedResources.push(bytesRid);
                },
              };
              onEvent({ event: "Started", data: { contentLength: 1024 } });
              onEvent({ event: "Progress", data: { chunkLength: 1024 } });
            };
            if (this.rid === 7001 || this.rid === 7002) {
              await new Promise((resolve) => {
                window.auditDownloadReleases[this.rid] = () => {
                  attachBytes();
                  resolve();
                };
              });
            } else {
              attachBytes();
            }
          } finally {
            window.auditActiveTransfers -= 1;
          }
        },
        async install() {
          const bytesRid = this.downloadedBytes?.rid;
          window.auditInstallCalls.push({
            updateRid: this.rid,
            bytesRid,
          });
          await window.__TAURI__.core.invoke("e2e_updater_install_probe");
          this.downloadedBytes = undefined;
        },
      });
      window.auditOriginalCheckForUpdates = window.api.checkForUpdates;
      window.api.checkForUpdates = async (...args) => {
        const result = await window.auditOriginalCheckForUpdates(...args);
        window.auditCheckResults.push(result);
        return result;
      };
      window.auditUpdaterStatusCleanup = window.api.onUpdaterStatus((event) =>
        window.auditUpdaterStatuses.push(event),
      );
      window.__ROSI_E2E__.updaterAdapter = {
        invoke: async (command, args = {}) => {
          window.auditInvokeCommands.push(command);
          if (command === "get_settings") {
            return { updateChannel: window.auditUpdateChannel };
          }
          if (command === "is_packaged") return true;
          if (command === "is_flatpak") return false;
          if (command === "get_beta_updater_target") {
            return "darwin-beta-e2e-app";
          }
          if (command === "restart_app") {
            window.auditRestartCalls += 1;
            return undefined;
          }
          return window.__TAURI__.core.invoke(command, args);
        },
        check: async (target) => {
          const rid = 7000 + window.auditFeedRecords.length + 1;
          const version = `5.0.0-beta.${window.auditFeedRecords.length + 3}`;
          window.auditFeedRecords.push({
            rid,
            version,
            target: target ?? null,
          });
          return makeUpdate(rid, version, target);
        },
      };
      window.auditUpdaterAdapterInstalled =
        typeof window.__ROSI_E2E__.updaterAdapter?.check === "function" &&
        typeof window.__ROSI_E2E__.updaterAdapter?.invoke === "function";
    });

    const resolveDownload = async (rid, promiseName) => {
      await browser.execute((updateRid) => {
        window.auditDownloadReleases[updateRid]?.();
      }, rid);
      return browser.executeAsync((name, done) => {
        window[name].then(
          (result) => done({ result }),
          (error) => done({ error: String(error) }),
        );
      }, promiseName);
    };

    const checkForAvailableUpdate = async () => {
      const before = await browser.execute(() => ({
        checks: window.auditCheckResults.length,
        feeds: window.auditFeedRecords.length,
        statuses: window.auditUpdaterStatuses.length,
      }));
      await browser.execute(() =>
        document.getElementById("checkUpdateBtn").click(),
      );
      await browser.waitUntil(
        () =>
          browser.execute(
            (count) => window.auditCheckResults.length > count,
            before.checks,
          ),
        {
          timeout: 10_000,
          timeoutMsg: "manual updater check did not settle",
        },
      );
      const outcome = await browser.execute(
        (counts) => ({
          result: window.auditCheckResults.at(-1),
          feed: window.auditFeedRecords.slice(counts.feeds),
          statuses: window.auditUpdaterStatuses.slice(counts.statuses),
          updaterAdapterInstalled: window.auditUpdaterAdapterInstalled,
          invokeCommands: window.auditInvokeCommands.slice(),
        }),
        before,
      );
      assert.equal(
        outcome.result,
        null,
        `controlled updater check returned ${JSON.stringify(outcome)}`,
      );
      assert.ok(
        outcome.feed.length > 0,
        `controlled feed was not called: ${JSON.stringify(outcome)}`,
      );
      assert.equal(
        outcome.statuses.at(-1)?.status,
        "available",
        `controlled updater check did not emit available: ${JSON.stringify(outcome)}`,
      );
      await dismissModal("Update Available", "Later");
      return outcome.feed.at(-1);
    };

    try {
      const prior = fs.existsSync(backupPath)
        ? fs.readFileSync(backupPath)
        : null;
      priorBackup = prior;

      const firstIdentity = await checkForAvailableUpdate();
      assert.equal(firstIdentity.target, "darwin-beta-e2e-app");

      await browser.execute(() => {
        window.auditFirstDownload = window.api.downloadUpdate();
      });
      await browser.waitUntil(
        () => browser.execute(() => window.auditDownloadCalls.length === 1),
        { timeout: 10_000, timeoutMsg: "first updater download did not start" },
      );
      await api("checkForUpdates");
      assert.equal(
        await browser.execute(() => window.auditFeedRecords.length),
        1,
        "a check started a second feed request during download",
      );
      const firstDownloadResult = await resolveDownload(
        firstIdentity.rid,
        "auditFirstDownload",
      );
      assert.deepEqual(firstDownloadResult, { result: { success: true } });
      await dismissModal("Update Ready", "Later");

      const staleIdentity = await checkForAvailableUpdate();
      await browser.execute(() => {
        window.auditStaleDownload = window.api.downloadUpdate();
      });
      await browser.waitUntil(
        () => browser.execute(() => window.auditDownloadCalls.length === 2),
        {
          timeout: 10_000,
          timeoutMsg: "replacement updater download did not start",
        },
      );
      await browser.execute(() => window.api.cancelUpdateDownload());
      await dismissModal("Download Cancelled", "OK");
      const feedCountBeforeSettlement = await browser.execute(
        () => window.auditFeedRecords.length,
      );
      await browser.execute(() => {
        window.auditUpdateChannel = "stable";
      });

      const beforeSettlement = await browser.execute(
        (rid) => ({
          activeTransfers: window.auditActiveTransfers,
          downloadCalls: window.auditDownloadCalls.length,
          updateClosed: window.auditClosedResources.includes(rid),
          bytesAttached: window.auditAttachedBytes.includes(
            8000 + (rid - 7000),
          ),
        }),
        staleIdentity.rid,
      );
      assert.equal(beforeSettlement.activeTransfers, 1);
      assert.equal(beforeSettlement.downloadCalls, 2);
      assert.equal(beforeSettlement.updateClosed, false);
      assert.equal(beforeSettlement.bytesAttached, false);

      const blockedFeedCheck = await api("checkForUpdates");
      const blockedDownloadRetry = await api("downloadUpdate");
      const afterBlockedRequests = await browser.execute(
        (rid) => ({
          feedCount: window.auditFeedRecords.length,
          downloadCalls: window.auditDownloadCalls.length,
          updateClosed: window.auditClosedResources.includes(rid),
          activeTransfers: window.auditActiveTransfers,
        }),
        staleIdentity.rid,
      );
      assert.equal(blockedFeedCheck, null);
      assert.equal(
        blockedDownloadRetry.error,
        "A download is already in progress.",
      );
      assert.equal(afterBlockedRequests.feedCount, feedCountBeforeSettlement);
      assert.equal(afterBlockedRequests.downloadCalls, 2);
      assert.equal(afterBlockedRequests.updateClosed, false);
      assert.equal(afterBlockedRequests.activeTransfers, 1);

      const staleDownloadResult = await resolveDownload(
        staleIdentity.rid,
        "auditStaleDownload",
      );
      assert.deepEqual(staleDownloadResult, { result: { cancelled: true } });
      const staleBytesRid = 8000 + (staleIdentity.rid - 7000);
      await browser.waitUntil(
        () =>
          browser.execute(
            (resources) =>
              window.auditActiveTransfers === 0 &&
              window.auditClosedResources.includes(resources.updateRid) &&
              window.auditClosedResources.includes(resources.bytesRid),
            { updateRid: staleIdentity.rid, bytesRid: staleBytesRid },
          ),
        {
          timeout: 10_000,
          timeoutMsg:
            "settled stale download did not release its update and byte resources",
        },
      );
      const afterSettlement = await browser.execute(
        (resources) => ({
          activeTransfers: window.auditActiveTransfers,
          updateClosed: window.auditClosedResources.includes(
            resources.updateRid,
          ),
          bytesClosed: window.auditClosedResources.includes(resources.bytesRid),
        }),
        {
          updateRid: staleIdentity.rid,
          bytesRid: staleBytesRid,
        },
      );
      assert.deepEqual(afterSettlement, {
        activeTransfers: 0,
        updateClosed: true,
        bytesClosed: true,
      });

      const currentIdentity = await checkForAvailableUpdate();
      assert.equal(currentIdentity.target, null);

      await api("installUpdate");
      await dismissModal("Update Error", "OK");
      assert.equal(
        await browser.execute(() => window.auditInstallCalls.length),
        0,
        "replacement update was installable without its own downloaded bytes",
      );

      await api("downloadUpdate");
      const currentBytesRid = 8000 + (currentIdentity.rid - 7000);
      await api("clearQueue");
      fs.rmSync(backupPath, { recursive: true, force: true });
      fs.mkdirSync(backupPath);
      const queued = await api("addToQueue", [
        "https://93.184.216.34/updater-install-backup-fault",
      ]);
      assert.equal(queued.ok, true, JSON.stringify(queued));
      const queue = await api("getQueue");
      const latestQueueId = queue.at(-1)?.id;
      assert.ok(latestQueueId);
      await browser.waitUntil(
        () => {
          try {
            const onDisk = JSON.parse(fs.readFileSync(queueFile, "utf8"));
            return onDisk.some((item) => item.id === latestQueueId);
          } catch {
            return false;
          }
        },
        {
          timeout: 10_000,
          interval: 100,
          timeoutMsg:
            "faulted profile queue item did not reach the primary file",
        },
      );

      await browser.execute(() => {
        const restart = [
          ...document.querySelectorAll("#modal-buttons button"),
        ].find((button) => button.textContent.trim() === "Restart Now");
        if (!restart)
          throw new Error("Update Ready modal has no Restart Now action");
        restart.click();
      });
      await dismissModal("Update Error", "OK");
      const firstInstall = await browser.execute(
        () => window.auditInstallCalls[0],
      );
      assert.equal(firstInstall.updateRid, currentIdentity.rid);
      assert.equal(firstInstall.bytesRid, currentBytesRid);
      assert.equal(await browser.execute(() => window.auditRestartCalls), 0);
      const stillRunning = await api("getQueue");
      assert.ok(stillRunning.some((item) => item.id === latestQueueId));
      assert.ok(
        JSON.parse(fs.readFileSync(queueFile, "utf8")).some(
          (item) => item.id === latestQueueId,
        ),
      );

      fs.rmSync(backupPath, { recursive: true, force: true });
      if (priorBackup) fs.writeFileSync(backupPath, priorBackup);
      await api("installUpdate");
      const installCalls = await browser.execute(() =>
        window.auditInstallCalls.slice(),
      );
      assert.equal(installCalls.length, 2);
      assert.deepEqual(installCalls[1], installCalls[0]);
      assert.equal(await browser.execute(() => window.auditRestartCalls), 1);
      record("updater-generation-retry", {
        feedTargets: await browser.execute(() =>
          window.auditFeedRecords.map((item) => item.target),
        ),
        activeDownloadCheckSuppressed: true,
        cancelledIdentityRetainedUntilSettlement:
          !beforeSettlement.updateClosed,
        singleflightRetainedUntilSettlement:
          blockedDownloadRetry.error === "A download is already in progress.",
        staleDownloadResult,
        staleUpdateReleasedAfterSettlement: afterSettlement.updateClosed,
        staleBytesReleased: staleBytesRid,
        stableTargetCheckedAfterSettlement: currentIdentity.target === null,
        refusedInstallBytesRid: firstInstall.bytesRid,
        retryInstallBytesRid: installCalls[1].bytesRid,
        restartCalls: 1,
        controlledUpdaterBoundary: "VITE_ROSI_E2E adapter",
        sdkByteResourcesExercised: false,
        nativeInstallPreflightExercised: true,
        signedInstallationExercised: false,
      });
    } finally {
      fs.rmSync(backupPath, { recursive: true, force: true });
      if (priorBackup) fs.writeFileSync(backupPath, priorBackup);
      await browser.execute(() => {
        window.auditUpdaterStatusCleanup?.();
        if (window.auditOriginalCheckForUpdates) {
          window.api.checkForUpdates = window.auditOriginalCheckForUpdates;
        }
        if (window.__ROSI_E2E__) {
          if (window.auditOriginalE2eUpdaterAdapter) {
            window.__ROSI_E2E__.updaterAdapter =
              window.auditOriginalE2eUpdaterAdapter;
          } else {
            delete window.__ROSI_E2E__.updaterAdapter;
          }
        }
        if (
          document.getElementById("app-modal")?.classList.contains("active")
        ) {
          const close = [
            ...document.querySelectorAll("#modal-buttons button"),
          ].find((button) =>
            ["Later", "OK"].includes(button.textContent.trim()),
          );
          close?.click();
        }
      });
      await api("clearQueue");
      await browser.waitUntil(
        () => {
          try {
            const primary = JSON.parse(fs.readFileSync(queueFile, "utf8"));
            const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
            return primary.length === 0 && backup.length === 0;
          } catch {
            return false;
          }
        },
        {
          timeout: 10_000,
          interval: 100,
          timeoutMsg: "updater retry test queue did not clean up",
        },
      );
    }
  });

  it("refuses close and restart when the actual queue backup path is blocked", async () => {
    assert.ok(DATA_DIR, "ROSI_E2E_DATA_DIR is not set");
    const queueFile = path.join(DATA_DIR, "download-queue.json");
    const backupPath = path.join(DATA_DIR, "download-queue.backup.json");
    await api("clearQueue");
    const priorBackup = fs.existsSync(backupPath)
      ? fs.readFileSync(backupPath)
      : null;

    try {
      fs.rmSync(backupPath, { recursive: true, force: true });
      fs.mkdirSync(backupPath);
      const added = await api("addToQueue", [
        "https://93.184.216.34/queue-disk-fault",
      ]);
      assert.equal(added.ok, true, JSON.stringify(added));
      const queued = await api("getQueue");
      assert.equal(queued.length, 1);
      const latestId = queued[0].id;

      await browser.waitUntil(
        () => {
          try {
            const onDisk = JSON.parse(fs.readFileSync(queueFile, "utf8"));
            return onDisk.length === 1 && onDisk[0].id === latestId;
          } catch {
            return false;
          }
        },
        {
          timeout: 10_000,
          interval: 100,
          timeoutMsg: "latest queue state was not written",
        },
      );

      await browser.execute(() => {
        void window.__TAURI__.window.getCurrentWindow().close();
      });
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const modal = document.getElementById("app-modal");
            return (
              modal?.classList.contains("active") &&
              document.getElementById("modal-title")?.textContent ===
                "ROSI Could Not Close Safely"
            );
          }),
        {
          timeout: 10_000,
          timeoutMsg: "close did not report backup write failure",
        },
      );

      const closeMessage = await browser.execute(
        () => document.getElementById("modal-message")?.textContent ?? "",
      );
      assert.match(closeMessage, /backup/i);
      await assert.rejects(() => api("restartApp"), /backup|queue|durably/i);
      const stillRunning = await api("getQueue");
      assert.equal(stillRunning[0].id, latestId);
      const primary = JSON.parse(fs.readFileSync(queueFile, "utf8"));
      assert.equal(primary[0].id, latestId);
      record("queue-flush-backup-failure", {
        primaryCount: primary.length,
        retainedId: latestId,
        closeMessage,
        restartRefused: true,
      });
    } finally {
      fs.rmSync(backupPath, { recursive: true, force: true });
      if (priorBackup) fs.writeFileSync(backupPath, priorBackup);
      await browser.execute(() => {
        const ok = [...document.querySelectorAll("#modal-buttons button")].find(
          (button) => button.textContent.trim() === "OK",
        );
        ok?.click();
      });
      await api("clearQueue");
      await browser.waitUntil(
        () => {
          try {
            const queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
            const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
            return queue.length === 0 && backup.length === 0;
          } catch {
            return false;
          }
        },
        {
          timeout: 10_000,
          interval: 100,
          timeoutMsg: "queue cleanup did not persist",
        },
      );
    }
  });

  it("keeps the app open when a renderer close flush outlives its deadline", async () => {
    assert.ok(DATA_DIR, "ROSI_E2E_DATA_DIR is not set");
    const logFile = path.join(DATA_DIR, "logs", "rosi.log");
    await browser.execute(() => {
      window.auditOriginalSaveSettings = window.api.saveSettings;
      window.auditSaveRelease = null;
      window.api.saveSettings = async (settings) => {
        await new Promise((resolve) => {
          window.auditSaveRelease = resolve;
        });
        return window.auditOriginalSaveSettings(settings);
      };
      void window.__TAURI__.window.getCurrentWindow().close();
    });

    try {
      await browser.waitUntil(
        () =>
          browser.execute(() => typeof window.auditSaveRelease === "function"),
        {
          timeout: 10_000,
          timeoutMsg: "close did not start the held settings flush",
        },
      );
      await browser.waitUntil(
        () => {
          const log = fs.existsSync(logFile)
            ? fs.readFileSync(logFile, "utf8")
            : "";
          return log.includes(
            "Timed out waiting for renderer settings flush; leaving the app open.",
          );
        },
        {
          timeout: 10_000,
          interval: 100,
          timeoutMsg: "close timeout did not cancel the attempt",
        },
      );

      await browser.execute(() => window.auditSaveRelease?.());
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const modal = document.getElementById("app-modal");
            return (
              modal?.classList.contains("active") &&
              document.getElementById("modal-title")?.textContent ===
                "ROSI Could Not Close Safely"
            );
          }),
        {
          timeout: 10_000,
          timeoutMsg: "expired close acknowledgement was not rejected",
        },
      );
      await api("getSettings");
      const log = fs.readFileSync(logFile, "utf8");
      assert.doesNotMatch(
        log,
        /Settings and download queue flushed; closing main window\./,
      );
      record("close-pending-timeout", {
        appRemainedOpen: true,
        staleAckRejected: true,
      });
    } finally {
      await browser.execute(() => {
        window.api.saveSettings = window.auditOriginalSaveSettings;
        const ok = [...document.querySelectorAll("#modal-buttons button")].find(
          (button) => button.textContent.trim() === "OK",
        );
        ok?.click();
      });
    }
  });
});
