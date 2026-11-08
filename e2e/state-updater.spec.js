import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "./helpers/app-bridge.js";
import { readListFile } from "./helpers/persisted.js";
import {
  captureUpdaterStatuses,
  clickManualCheck,
  setUpdateChannel,
  startUpdaterFixture,
} from "./helpers/updater-engine-fixture.js";

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

async function engineInvoke(command, args) {
  return browser.executeAsync(
    (name, payload, done) => {
      window.__TAURI__.core.invoke(name, payload).then(
        (data) => done({ ok: true, data: data ?? null }),
        (error) => done({ error: String(error) }),
      );
    },
    command,
    args,
  );
}

async function engineProbe() {
  const result = await engineInvoke("e2e_updater_probe");
  assert.ok(result.ok, JSON.stringify(result));
  return result.data;
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

  it("preserves a newer refused-field edit across save and settings reads", async () => {
    assert.ok(DATA_DIR, "ROSI_E2E_DATA_DIR is not set");
    const original = await api("getSettings");
    const settingsFile = path.join(DATA_DIR, "settings.json");
    const invalidPath = path.join(DATA_DIR, "missing-ffmpeg", "ffmpeg");
    const editedDuringSave = path.join(
      DATA_DIR,
      "newer-missing-ffmpeg",
      "ffmpeg",
    );
    const desiredTheme = original.theme === "dark" ? "light" : "dark";

    await browser.execute(
      (invalidFfmpegPath, theme) => {
        window.auditOriginalSettingsSave = window.api.saveSettings;
        window.auditOriginalSettingsRead = window.api.getSettings;
        window.auditInvalidSettingsSaveHeld = false;
        window.auditSettingsReadHeld = false;
        window.auditHoldSettingsRead = false;
        window.auditSettingsSaveSnapshot = null;
        window.auditSettingsSaveResponse = null;
        window.api.saveSettings = async (settings) => {
          const snapshot = JSON.parse(JSON.stringify(settings));
          const response = await window.auditOriginalSettingsSave(snapshot);
          if (snapshot.ffmpegPath === invalidFfmpegPath) {
            window.auditSettingsSaveSnapshot = snapshot;
            window.auditSettingsSaveResponse = response;
            window.auditInvalidSettingsSaveHeld = true;
            await new Promise((resolve) => {
              window.auditReleaseInvalidSettingsSave = resolve;
            });
          }
          return response;
        };
        window.api.getSettings = async (...args) => {
          const settings = await window.auditOriginalSettingsRead(...args);
          if (window.auditHoldSettingsRead) {
            window.auditSettingsReadHeld = true;
            await new Promise((resolve) => {
              window.auditReleaseSettingsRead = resolve;
            });
          }
          return settings;
        };

        const ffmpegInput = document.getElementById("ffmpegPathInput");
        ffmpegInput.value = invalidFfmpegPath;
        ffmpegInput.dispatchEvent(new Event("input", { bubbles: true }));
        ffmpegInput.dispatchEvent(new Event("change", { bubbles: true }));
        const themeSelect = document.getElementById("themeSelect");
        themeSelect.value = theme;
        themeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      },
      invalidPath,
      desiredTheme,
    );

    try {
      await browser.waitUntil(
        () => browser.execute(() => window.auditInvalidSettingsSaveHeld),
        {
          timeout: 10_000,
          timeoutMsg: "invalid FFmpeg save response was not held",
        },
      );
      await browser.execute((nextPath) => {
        const ffmpegInput = document.getElementById("ffmpegPathInput");
        ffmpegInput.value = nextPath;
        ffmpegInput.dispatchEvent(new Event("input", { bubbles: true }));
      }, editedDuringSave);
      await browser.execute(() => {
        window.auditHoldSettingsRead = true;
        window.auditReleaseInvalidSettingsSave();
      });
      await browser.waitUntil(
        () => browser.execute(() => window.auditSettingsReadHeld),
        {
          timeout: 10_000,
          timeoutMsg: "rejection handler did not wait for getSettings",
        },
      );

      await browser.execute(() => {
        const ffmpegInput = document.getElementById("ffmpegPathInput");
        ffmpegInput.value = "ffmpeg";
        ffmpegInput.dispatchEvent(new Event("input", { bubbles: true }));
        ffmpegInput.dispatchEvent(new Event("change", { bubbles: true }));
        window.auditHoldSettingsRead = false;
        window.auditReleaseSettingsRead();
      });

      await browser.waitUntil(
        () => {
          try {
            const stored = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
            return (
              stored.ffmpegPath === "ffmpeg" && stored.theme === desiredTheme
            );
          } catch {
            return false;
          }
        },
        {
          timeout: 10_000,
          interval: 100,
          timeoutMsg: "newer settings were not persisted after rejection",
        },
      );

      const result = await browser.execute(() => ({
        response: window.auditSettingsSaveResponse,
        submittedPath: window.auditSettingsSaveSnapshot?.ffmpegPath,
        visiblePath: document.getElementById("ffmpegPathInput").value,
        visibleTheme: document.getElementById("themeSelect").value,
      }));
      const stored = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      result.storedPath = stored.ffmpegPath;
      result.storedTheme = stored.theme;
      assert.equal(result.response.error.code, "VALIDATION_ERROR");
      assert.deepEqual(JSON.parse(result.response.error.details), [
        "ffmpegPath",
      ]);
      assert.equal(result.submittedPath, invalidPath);
      assert.equal(result.visiblePath, "ffmpeg");
      assert.equal(result.storedPath, "ffmpeg");
      assert.equal(result.visibleTheme, desiredTheme);
      assert.equal(result.storedTheme, desiredTheme);
      record("settings-rejection-preserves-newer-field", {
        rejectedPath: result.submittedPath,
        editedDuringSave,
        visiblePath: result.visiblePath,
        storedPath: result.storedPath,
        visibleTheme: result.visibleTheme,
        storedTheme: result.storedTheme,
        rejectedFields: JSON.parse(result.response.error.details),
      });
    } finally {
      await browser.execute(() => {
        window.auditReleaseInvalidSettingsSave?.();
        window.auditReleaseSettingsRead?.();
        if (window.auditOriginalSettingsSave) {
          window.api.saveSettings = window.auditOriginalSettingsSave;
        }
        if (window.auditOriginalSettingsRead) {
          window.api.getSettings = window.auditOriginalSettingsRead;
        }
      });
      const restored = await api("saveSettings", original);
      assert.equal(restored.ok, true, restored.error?.message);
      await reloadRenderer();
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
          return readListFile(queueFile).length === 0;
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
      persistedCount: readListFile(queueFile).length,
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
    const platformOs =
      process.platform === "darwin"
        ? "darwin"
        : process.platform === "linux"
          ? "linux"
          : "windows";
    const betaTarget = "darwin-beta-aarch64-app";
    const stableTarget = `${platformOs}-aarch64`;
    let priorBackup = null;
    // Released in finally too, so a failed step never leaves the held B
    // response open (the server could not close and the engine stays busy).
    let releaseB = () => {};
    await reloadRenderer();
    // The channel change rechecks in the background; set it before the feed.
    await setUpdateChannel("beta");
    await browser.pause(1_500);
    const fixture = await startUpdaterFixture({
      betaTarget,
      disableCompact: true,
    });
    await captureUpdaterStatuses("auditGenerationStatuses");
    const feedRequests = () =>
      fixture.server.requests.filter((request) =>
        request.path.startsWith("/latest-"),
      ).length;
    const artifactRequests = () =>
      fixture.server.requests.filter((request) =>
        request.path.startsWith("/artifacts/"),
      ).length;
    const statusesNow = () =>
      browser.execute(() => window.auditGenerationStatuses.slice());
    const latestAvailable = async (version) =>
      (await statusesNow())
        .filter(
          (event) => event.status === "available" && event.version === version,
        )
        .at(-1);
    const waitForAvailable = (version, after = 0) =>
      browser.waitUntil(
        async () =>
          (await statusesNow()).filter(
            (event) =>
              event.status === "available" && event.version === version,
          ).length > after,
        {
          timeout: 20_000,
          interval: 100,
          timeoutMsg: `update ${version} was not offered`,
        },
      );

    try {
      priorBackup = fs.existsSync(backupPath)
        ? fs.readFileSync(backupPath)
        : null;
      const probeBefore = await engineProbe();

      // Generation A is offered and downloaded, then superseded by B.
      fixture.server.publish({
        target: betaTarget,
        version: "9.0.0-beta.1",
        payload: Buffer.from("generation A payload"),
        fileName: "ROSI-A.bin",
      });
      await clickManualCheck();
      await waitForAvailable("9.0.0-beta.1");
      const candidateA = await latestAvailable("9.0.0-beta.1");
      await dismissModal("Update Available", "Later");
      const downloadA = await engineInvoke("download_update", {
        candidateId: candidateA.candidateId,
      });
      assert.equal(downloadA.data?.success, true, JSON.stringify(downloadA));
      await dismissModal("Update Ready", "Later");

      // Generation B downloads behind a held response.
      const gateB = new Promise((resolve) => {
        releaseB = resolve;
      });
      fixture.server.publish({
        target: betaTarget,
        version: "9.0.0-beta.2",
        payload: Buffer.from("generation B payload"),
        fileName: "ROSI-B.bin",
        gate: gateB,
      });
      await clickManualCheck();
      await waitForAvailable("9.0.0-beta.2");
      const candidateB = await latestAvailable("9.0.0-beta.2");
      await dismissModal("Update Available", "Later");
      await browser.execute((id) => {
        window.auditDownloadBResult = undefined;
        window.__TAURI__.core
          .invoke("download_update", { candidateId: id })
          .then((data) => {
            window.auditDownloadBResult = data;
          });
      }, candidateB.candidateId);
      await browser.waitUntil(() => artifactRequests() >= 2, {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: "B download did not start",
      });

      // While B downloads: a second download is single-flight, and a check is refused.
      const feedBeforeBlocked = feedRequests();
      const second = await engineInvoke("download_update", {
        candidateId: candidateB.candidateId,
      });
      assert.equal(
        second.data?.error,
        "A download is already in progress.",
        JSON.stringify(second),
      );
      const blockedCheck = await engineInvoke("check_for_updates");
      assert.equal(blockedCheck.data, null, JSON.stringify(blockedCheck));
      assert.equal(
        feedRequests(),
        feedBeforeBlocked,
        "a check during download requested a feed",
      );

      // Channel change and cancel while B is in flight; B settles after the cancel.
      fixture.server.publish({
        target: stableTarget,
        route: platformOs,
        version: "9.0.0",
        payload: Buffer.from("generation C payload"),
        fileName: "ROSI-C.bin",
      });
      await setUpdateChannel("stable");
      await engineInvoke("cancel_update_download");
      await dismissModal("Download Cancelled", "OK");
      // Compared in the page: WebDriver returns an undefined value as null.
      assert.equal(
        await browser.execute(() => window.auditDownloadBResult === undefined),
        true,
        "cancelled download resolved before it settled",
      );
      releaseB();
      await browser.waitUntil(
        () => browser.execute(() => window.auditDownloadBResult !== undefined),
        { timeout: 20_000, interval: 100, timeoutMsg: "B did not settle" },
      );
      assert.deepEqual(
        await browser.execute(() => window.auditDownloadBResult),
        { success: false, cancelled: true, error: null },
      );
      assert.ok(
        !(await statusesNow()).some(
          (event) =>
            event.status === "downloaded" &&
            event.candidateId === candidateB.candidateId,
        ),
        "the cancelled candidate was reported as downloaded",
      );

      // Generation C (stable target) is offered; install before download is refused.
      await waitForAvailable("9.0.0");
      await dismissModal("Update Available", "Later");
      const countBeforeC = (await statusesNow()).filter(
        (event) => event.status === "available" && event.version === "9.0.0",
      ).length;
      await clickManualCheck();
      await waitForAvailable("9.0.0", countBeforeC);
      const candidateC = await latestAvailable("9.0.0");
      assert.equal(candidateC.isBeta, false);
      await dismissModal("Update Available", "Later");
      const installProbeBefore = await engineProbe();
      await engineInvoke("install_update", {
        candidateId: candidateC.candidateId,
      });
      await dismissModal("Update Error", "OK");
      assert.equal(
        (await engineProbe()).installs - installProbeBefore.installs,
        0,
        "candidate was installed without its downloaded bytes",
      );

      // Download C, then fault the queue backup so the install's restart is refused.
      const downloadC = await engineInvoke("download_update", {
        candidateId: candidateC.candidateId,
      });
      assert.equal(downloadC.data?.success, true, JSON.stringify(downloadC));
      await dismissModal("Update Ready", "Later");

      await engineInvoke("clear_queue");
      fs.rmSync(backupPath, { recursive: true, force: true });
      fs.mkdirSync(backupPath);
      const queued = await engineInvoke("add_to_queue", {
        urls: ["https://93.184.216.34/updater-install-backup-fault"],
        options: null,
      });
      // add_to_queue answers with the IpcResult wrapper ({ ok, data }).
      assert.equal(queued.data?.data?.added, 1, JSON.stringify(queued));
      const queue = await engineInvoke("get_queue");
      const latestQueueId = queue.data.at(-1)?.id;
      assert.ok(latestQueueId);
      await browser.waitUntil(
        () => {
          try {
            return readListFile(queueFile).some(
              (item) => item.id === latestQueueId,
            );
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

      const probeBeforeRefusal = await engineProbe();
      await engineInvoke("install_update", {
        candidateId: candidateC.candidateId,
      });
      await dismissModal("Update Error", "OK");
      const afterRefusal = await engineProbe();
      // The flush refuses before the install, so no install is recorded.
      assert.equal(afterRefusal.installs - probeBeforeRefusal.installs, 0);
      assert.equal(afterRefusal.restarts - probeBeforeRefusal.restarts, 0);
      assert.ok(
        readListFile(queueFile).some((item) => item.id === latestQueueId),
        "refused restart dropped the queued item",
      );

      // The retry installs the kept bytes once, then restarts.
      fs.rmSync(backupPath, { recursive: true, force: true });
      if (priorBackup) fs.writeFileSync(backupPath, priorBackup);
      const retry = await engineInvoke("install_update", {
        candidateId: candidateC.candidateId,
      });
      assert.ok(retry.ok, JSON.stringify(retry));
      await browser.pause(800);
      const afterRetry = await engineProbe();
      // Measured from the refusal: the refused flush recorded no install.
      assert.equal(afterRetry.installs - afterRefusal.installs, 1);
      assert.equal(afterRetry.restarts - afterRefusal.restarts, 1);
      record("updater-generation-retry", {
        feedTargets: fixture.server.requests
          .map((request) => request.path)
          .filter((item) => item.startsWith("/latest-")),
        staleDownloadResult: { cancelled: true },
        singleflightRefused: second.data.error,
        refusedInstallBytesKept: true,
        retryRestarts: afterRetry.restarts - afterRefusal.restarts,
        installsAfterRefusal: afterRefusal.installs - probeBefore.installs,
      });
    } finally {
      releaseB();
      fs.rmSync(backupPath, { recursive: true, force: true });
      if (priorBackup) fs.writeFileSync(backupPath, priorBackup);
      await browser.execute(() => {
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
      await fixture.close();
      await engineInvoke("clear_queue");
      await browser.waitUntil(
        () => {
          try {
            return (
              readListFile(queueFile).length === 0 &&
              Array.isArray(readListFile(backupPath))
            );
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

  it("falls back from the 5.1 compact macOS target to the legacy feed", async () => {
    // A fresh renderer drops updater state left by the previous scenario.
    await reloadRenderer();
    // The channel change rechecks in the background. Set it before the feed is
    // configured and let that recheck finish, so the manual check is the only
    // feed attempt that is asserted.
    await setUpdateChannel("beta");
    await browser.pause(1_500);
    const fixture = await startUpdaterFixture({
      compactTarget: "darwin-beta-aarch64-app-zst",
      betaTarget: "darwin-beta-aarch64-app",
      disableCompact: false,
    });
    try {
      // The compact feed is missing; only the legacy feed publishes an update.
      fixture.server.respond("darwin-beta-aarch64-app-zst", 404);
      fixture.server.publish({
        target: "darwin-beta-aarch64-app",
        version: "9.0.0-beta.9",
        payload: Buffer.from("controlled legacy payload"),
        fileName: "legacy-app.tar.gz",
      });
      await captureUpdaterStatuses("auditCompactStatuses");
      await clickManualCheck();
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            window.auditCompactStatuses.some((event) =>
              ["available", "not-available", "error"].includes(event.status),
            ),
          ),
        {
          timeout: 15_000,
          timeoutMsg: "compact fallback check did not settle",
        },
      );
      const statuses = await browser.execute(() =>
        window.auditCompactStatuses.slice(),
      );
      // A channel change rechecks in the background, so the manual check can
      // overlap it, and each check makes its own feed attempts. Every attempt
      // must be the compact feed (404) followed by the legacy feed.
      const feeds = fixture.server.requests
        .map((request) => request.path)
        .filter((item) => item.startsWith("/latest-"));
      const attempts = [];
      for (let index = 0; index < feeds.length; index += 2) {
        attempts.push(feeds.slice(index, index + 2));
      }
      assert.ok(attempts.length >= 1, "no compact fallback attempt was made");
      for (const attempt of attempts) {
        assert.deepEqual(
          attempt,
          [
            "/latest-darwin-beta-aarch64-app-zst.json",
            "/latest-darwin-beta-aarch64-app.json",
          ],
          `compact fallback feed requests were ${JSON.stringify(feeds)}`,
        );
      }
      assert.equal(feeds.length, attempts.length * 2, "unpaired feed request");
      const available = statuses.find((event) => event.status === "available");
      assert.ok(
        available,
        `compact fallback did not emit available: ${JSON.stringify(statuses)}`,
      );
      assert.equal(available.version, "9.0.0-beta.9");
      assert.equal(available.isBeta, true);
      const log = fs.readFileSync(
        path.join(DATA_DIR, "logs", "rosi.log"),
        "utf8",
      );
      assert.ok(
        log.includes(
          "updater: darwin-beta-aarch64-app-zst check failed, falling back to darwin-beta-aarch64-app target",
        ),
        "compact fallback was not logged",
      );
      await dismissModal("Update Available", "Later");
      record("updater-compact-target-fallback", {
        feedTargets: feeds.map((item) =>
          item.replace(/^\/latest-|\.json$/g, ""),
        ),
        compactAttemptThrew: true,
        legacyAttemptReturned: true,
        availableVersion: available.version,
        controlledBoundary:
          "local signed update server (e2e_configure_updater)",
        nativeCompactFeedExercised: true,
      });
    } finally {
      await fixture.close();
      await reloadRenderer();
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
            const onDisk = readListFile(queueFile);
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
      const primary = readListFile(queueFile);
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
            return (
              readListFile(queueFile).length === 0 &&
              Array.isArray(readListFile(backupPath))
            );
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

  it("renders the Rust defaults when settings.json is corrupt at startup", async () => {
    const settingsFile = path.join(DATA_DIR, "settings.json");
    const original = fs.readFileSync(settingsFile);
    try {
      const seeded = JSON.parse(original.toString("utf8"));
      fs.writeFileSync(
        settingsFile,
        '{"theme":"purple","B3_DAMAGED_SETTINGS":',
      );
      // A renderer reload runs startup again: get_settings reads the damaged
      // file from disk and answers with the Rust defaults.
      await reloadRenderer();

      const defaults = (await api("getDefaultSettings")).data;
      const loaded = await api("getSettings");
      const rendered = await browser.execute((controls) => {
        const read = (control) => {
          const element = document.getElementById(control.id);
          if (
            !(element instanceof HTMLInputElement) &&
            !(element instanceof HTMLSelectElement)
          )
            return null;
          return control.kind === "checked" ? element.checked : element.value;
        };
        return Object.fromEntries(
          controls.map((control) => [control.id, read(control)]),
        );
      }, SIDEBAR_CONTROLS);

      const expectedFor = (control, source) => {
        const value = source[control.key];
        return control.id === "browserChoice"
          ? String(value).toLowerCase()
          : value;
      };
      const differsFromSeed = SIDEBAR_CONTROLS.filter(
        (control) => seeded[control.key] !== defaults[control.key],
      ).map((control) => control.key);
      assert.ok(
        differsFromSeed.length > 0,
        "seeded settings must differ from the defaults for this check to prove anything",
      );
      for (const control of SIDEBAR_CONTROLS) {
        const expected = expectedFor(control, defaults);
        assert.equal(
          rendered[control.id],
          expected,
          `sidebar ${control.id} shows ${JSON.stringify(rendered[control.id])}; get_default_settings ${control.key}=${JSON.stringify(defaults[control.key])}`,
        );
        assert.equal(
          expectedFor(control, loaded),
          expected,
          `get_settings ${control.key} differs from get_default_settings`,
        );
      }

      // The recovery notice is recorded, not shown: WebDriver cannot dismiss a
      // native alert (e2e/native-notices.failure-modes.md). get_settings reports
      // it once per process, so it is found anywhere in the record.
      const notices = await engineInvoke("e2e_native_notices");
      assert.ok(notices.ok, JSON.stringify(notices));
      const recovery = notices.data.find(
        (notice) => notice.title === "ROSI Profile Recovery",
      );
      assert.ok(recovery, JSON.stringify(notices.data));
      assert.equal(recovery.kind, "warning");

      record("settings-corrupt-defaults", {
        settingsFile: "settings.json",
        recoveryNotice: recovery.message,
        defaultsSource: "get_default_settings",
        controlsCompared: SIDEBAR_CONTROLS.map((control) => control.id),
        seededKeysDiffering: differsFromSeed,
      });
    } finally {
      fs.writeFileSync(settingsFile, original);
      await reloadRenderer();
    }
  });

  it("keeps backend values the renderer did not change across a save", async () => {
    assert.ok(DATA_DIR, "ROSI_E2E_DATA_DIR is not set");
    const settingsFile = path.join(DATA_DIR, "settings.json");
    const original = fs.readFileSync(settingsFile);
    const before = await api("getSettings");
    const desiredNotifications = !before.notifications;
    const addedPreset = {
      id: "e2e-backend-preset",
      name: "E2E Backend Preset",
      profile: "best-video",
    };

    try {
      // The renderer keeps its loaded copy. The new preset exists only on disk.
      const stored = JSON.parse(original.toString("utf8"));
      stored.downloadPresets = [...(stored.downloadPresets ?? []), addedPreset];
      fs.writeFileSync(settingsFile, JSON.stringify(stored, null, 2));

      await browser.execute(() => {
        window.auditPatchOriginalSave = window.api.saveSettings;
        window.auditPatchKeys = [];
        window.api.saveSettings = async (patch) => {
          const copy = JSON.parse(JSON.stringify(patch));
          window.auditPatchKeys.push(Object.keys(copy));
          return window.auditPatchOriginalSave(copy);
        };
      });
      await browser.execute((value) => {
        const toggle = document.getElementById("notificationsToggle");
        toggle.checked = value;
        toggle.dispatchEvent(new Event("change", { bubbles: true }));
      }, desiredNotifications);
      await waitForStoredSetting(
        "notifications",
        desiredNotifications,
        "unrelated notifications change was not saved",
      );

      const sentKeys = await browser.execute(() => window.auditPatchKeys);
      const persisted = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      const presetIds = persisted.downloadPresets.map((preset) => preset.id);
      const rendererPresetIds = (await api("getSettings")).downloadPresets.map(
        (preset) => preset.id,
      );
      assert.ok(sentKeys.length > 0, "no settings save reached the backend");
      for (const keys of sentKeys) {
        assert.deepEqual(keys, ["notifications"], "save sent unchanged keys");
      }
      assert.ok(
        presetIds.includes(addedPreset.id),
        "backend preset was overwritten by the renderer's stale copy",
      );
      assert.ok(rendererPresetIds.includes(addedPreset.id));
      assert.equal(persisted.notifications, desiredNotifications);
      record("settings-patch-preserves-backend-values", {
        addedPresetId: addedPreset.id,
        changedKey: "notifications",
        sentKeysPerSave: sentKeys,
        storedNotifications: persisted.notifications,
        storedPresetIds: presetIds,
        rendererPresetIds,
      });
    } finally {
      await browser.execute(() => {
        if (window.auditPatchOriginalSave) {
          window.api.saveSettings = window.auditPatchOriginalSave;
        }
      });
      fs.writeFileSync(settingsFile, original);
      await reloadRenderer();
    }
  });
});

// Sidebar controls and the settings key each one renders. Every value is
// compared with `get_default_settings` at run time, not with a fixed table.
const SIDEBAR_CONTROLS = [
  ["consoleToggle", "showConsoleOutput", "checked"],
  ["keepOriginalToggle", "keepOriginalAfterConvert", "checked"],
  ["hookBrowserToggle", "hookBrowser", "checked"],
  ["browserChoice", "browserChoice", "value"],
  ["convertToggle", "convertEnabled", "checked"],
  ["convertFormat", "convertFormat", "value"],
  ["gpuAccelerationToggle", "gpuAcceleration", "checked"],
  ["gpuType", "gpuType", "value"],
  ["ffmpegPathInput", "ffmpegPath", "value"],
  ["upstreamProxyInput", "upstreamProxy", "value"],
  ["animateBackgroundToggle", "animateBackground", "checked"],
  ["themeSelect", "theme", "value"],
  ["flatUiToggle", "flatUi", "checked"],
  ["askDownloadLocationToggle", "askDownloadLocation", "checked"],
  ["notificationsToggle", "notifications", "checked"],
  ["taskbarProgressToggle", "showTaskbarProgress", "checked"],
  ["checkUpdatesOnStartupToggle", "checkUpdatesOnStartup", "checked"],
  ["updateChannelSelect", "updateChannel", "value"],
  ["embedMetadataToggle", "embedMetadata", "checked"],
  ["embedThumbnailToggle", "embedThumbnail", "checked"],
  ["sponsorblockToggle", "sponsorblockRemove", "checked"],
  ["writeSubtitlesToggle", "writeSubtitles", "checked"],
  ["subtitleLangsInput", "subtitleLangs", "value"],
].map(([id, key, kind]) => ({ id, key, kind }));
