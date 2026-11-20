import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import {
  api,
  clickById,
  clickModalButton,
  setControl,
  waitFor,
  waitForAppReady,
  waitForBackendSetting,
  waitForModal,
} from "../../helpers/ui.js";
import { REPO_ROOT } from "../../helpers/profile.js";

const MEDIA = process.env.ROSI_E2E_MEDIA_URL;

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-settings-reset-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-settings-reset",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  runtime: { node: process.version },
  source: null,
  checks: [],
};

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

// Source identity for this report: HEAD, a hash of the tracked diff, and the
// hash of each untracked file. Enough to tell which working tree produced it.
function sourceIdentity() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  const diff = execFileSync("git", ["diff", "HEAD", "--binary"], {
    cwd: REPO_ROOT,
    maxBuffer: 256 * 1024 * 1024,
  });
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  return {
    head,
    workingTree:
      diff.length === 0 && untracked.length === 0 ? "clean" : "dirty",
    dirtyPatchSha256: sha256(diff),
    untrackedFiles: untracked.map((file) => ({
      path: file,
      sha256: sha256(fs.readFileSync(path.join(REPO_ROOT, file))),
    })),
  };
}

function writeReport() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  const temporaryPath = `${reportPath}.tmp`;
  fs.writeFileSync(temporaryPath, contents);
  fs.renameSync(temporaryPath, reportPath);
  fs.writeFileSync(
    `${reportPath}.sha256`,
    `${sha256(contents)}  report.json\n`,
  );
}

// One check per E2E case. `failureModes` names the rows of
// settings-reset.failure-modes.md that the case exercises.
async function scenario(name, failureModes, body) {
  try {
    const details = await body();
    report.checks.push({
      name,
      failureModes,
      status: "passed",
      invariantPassed: true,
      ...details,
    });
    writeReport();
  } catch (error) {
    report.checks.push({
      name,
      failureModes,
      status: "failed",
      invariantPassed: false,
      reason: error instanceof Error ? error.message : String(error),
    });
    writeReport();
    throw error;
  }
}

async function setSidebarOpen(open) {
  const isOpen = await browser.execute(
    () =>
      document.getElementById("sidebar")?.classList.contains("open") === true,
  );
  if (isOpen !== open) {
    await clickById(open ? "settingsBtn" : "closeSidebar");
    await waitFor(
      (want) =>
        document.getElementById("sidebar")?.classList.contains("open") === want,
      `settings did not ${open ? "open" : "close"}`,
      10_000,
      open,
    );
  }
  if (open) {
    // A hidden page runs no animation frames, so finish the slide there.
    const visibility = await browser.execute(() => document.visibilityState);
    if (visibility !== "visible") {
      await browser.execute(() => {
        document
          .getElementById("sidebar")
          ?.getAnimations()
          .forEach((animation) => animation.finish());
      });
    }
    await waitFor(
      () => {
        const sidebar = document.getElementById("sidebar");
        if (!sidebar) return false;
        const rect = sidebar.getBoundingClientRect();
        const restingLeft = parseFloat(getComputedStyle(sidebar).left);
        return Math.abs(rect.left - restingLeft) < 1;
      },
      "settings sidebar did not finish opening",
      10_000,
    );
  }
}

// Opens the section's Reset prompt through its header button.
async function openSectionReset(section) {
  await browser.execute((name) => {
    const button = document.querySelector(`[data-reset-section="${name}"]`);
    if (!button) throw new Error(`missing reset button for ${name}`);
    button.click();
  }, section);
  await waitForModal(true);
}

// Records every set_update_channel command the renderer sends to Rust, through
// the E2E IPC seam (window.__ROSI_E2E_IPC_STUBS__, read by call() in
// src/commands.ts). The entry passes each call through to the real invoke, so
// the backend still saves the value. The seam does not depend on the Tauri
// transport, which differs by platform (custom-protocol fetch, or the native
// postMessage that the app CSP leaves in use on macOS).
async function installChannelCallLog() {
  await browser.execute(() => {
    const log = window.__settingsResetLog ?? { channels: [] };
    window.__settingsResetLog = log;
    if (!window.__ROSI_E2E_IPC_STUBS__) window.__ROSI_E2E_IPC_STUBS__ = {};
    window.__ROSI_E2E_IPC_STUBS__.set_update_channel = (args, next) => {
      log.channels.push(args?.channel ?? null);
      return next();
    };
  });
}

// Reads the registry back: the entry must be a function, not just assigned.
async function channelCallLogInstalled() {
  return browser.execute(
    () =>
      typeof window.__ROSI_E2E_IPC_STUBS__?.set_update_channel === "function",
  );
}

// Removes only this observer's key, and the registry only when it is then empty,
// so a stub that another spec registered is left in place.
async function uninstallChannelCallLog() {
  await browser.execute(() => {
    delete window.__settingsResetLog;
    const registry = window.__ROSI_E2E_IPC_STUBS__;
    if (!registry) return;
    delete registry.set_update_channel;
    if (Object.keys(registry).length === 0)
      delete window.__ROSI_E2E_IPC_STUBS__;
  });
}

// Runs body with the observer installed and always removes it afterwards. An
// observer whose registry entry does not read back fails the case instead of
// recording nothing.
async function withChannelCallLog(body) {
  try {
    await installChannelCallLog();
    assert.equal(
      await channelCallLogInstalled(),
      true,
      "the set_update_channel entry is not in the IPC stub registry",
    );
    return await body();
  } finally {
    await uninstallChannelCallLog();
  }
}

// An uninstalled observer throws here instead of reporting an empty record.
async function clearChannelCalls() {
  await browser.execute(() => {
    const log = window.__settingsResetLog;
    if (!log)
      throw new Error("the set_update_channel observer is not installed");
    log.channels.length = 0;
  });
}

async function readChannelCalls() {
  return browser.execute(() => {
    const log = window.__settingsResetLog;
    if (!log)
      throw new Error("the set_update_channel observer is not installed");
    return [...log.channels];
  });
}

// The Windows select offers only Firefox; other platforms restore the default.
function expectedBrowserChoice(defaults) {
  return process.platform === "win32"
    ? "firefox"
    : defaults.browserChoice.toLowerCase();
}

// Records toast messages as they are added, so a toast that the renderer caps
// out of the container is still counted.
async function installToastLog() {
  await browser.execute(() => {
    window.__settingsResetToastObserver?.disconnect();
    const messages = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const found = node.matches(".toast-message")
            ? [node]
            : [...node.querySelectorAll(".toast-message")];
          for (const element of found) {
            messages.push(element.textContent.trim());
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__settingsResetToastObserver = observer;
    window.__settingsResetToasts = messages;
  });
}

const RANGE_TOAST = "Enter a playlist range";

async function rangeToastCount() {
  return browser.execute(
    (prefix) =>
      window.__settingsResetToasts.filter((message) =>
        message.startsWith(prefix),
      ).length,
    RANGE_TOAST,
  );
}

// True when no toast is still animating in or out.
function toastsSettled() {
  return [...document.querySelectorAll(".toast")].every(
    (toast) => toast.getAnimations().length === 0,
  );
}

// Wraps one bridge method so the page counts how often its call settled. The
// renderer handler runs after the wrapper's promise, so a later WebDriver call
// sees whatever toast that handler showed. The call itself passes through.
async function watchBridgeCalls(name) {
  await browser.execute((method) => {
    const bridge = window.__ROSI_E2E__.api;
    const watch = (window.__settingsResetWatch ??= {
      original: {},
      settled: {},
    });
    if (!(method in watch.original)) watch.original[method] = bridge[method];
    watch.settled[method] = 0;
    bridge[method] = (...args) =>
      Promise.resolve(watch.original[method].apply(bridge, args)).finally(
        () => {
          watch.settled[method] += 1;
        },
      );
  }, name);
}

async function unwatchBridgeCalls() {
  await browser.execute(() => {
    const watch = window.__settingsResetWatch;
    if (!watch) return;
    Object.assign(window.__ROSI_E2E__.api, watch.original);
    window.__settingsResetWatch = undefined;
  });
}

async function waitForSettledBridgeCall(name) {
  await waitFor(
    (method) => window.__settingsResetWatch?.settled[method] >= 1,
    `${name} did not settle`,
    10_000,
    name,
  );
}

async function setPlaylistRange(start, end) {
  await browser.execute(
    (from, to) => {
      const radio = document.querySelector(
        'input[name="playlist-scope"][value="range"]',
      );
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
      for (const [id, value] of [
        ["playlistRangeStart", from],
        ["playlistRangeEnd", to],
      ]) {
        const input = document.getElementById(id);
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    start,
    end,
  );
}

async function readSettingsSections() {
  return browser.execute(() =>
    [...document.querySelectorAll(".settings-section")].map((section) => {
      const header = section.querySelector(".settings-section-header");
      const body = section.querySelector(".settings-section-body");
      return {
        title: section
          .querySelector(".settings-section-title")
          ?.textContent.trim(),
        collapsed: section.classList.contains("collapsed"),
        searchHidden: section.classList.contains("search-hidden"),
        headerExpanded: header?.getAttribute("aria-expanded") ?? null,
        bodyHidden: body?.getAttribute("aria-hidden") ?? null,
        bodyInert: body?.inert === true,
      };
    }),
  );
}

describe("ROSI settings reset, playlist toasts, and settings search", () => {
  before(async () => {
    await waitForAppReady();
    report.source = sourceIdentity();
    writeReport();
  });

  after(async () => {
    report.completedAt = new Date().toISOString();
    report.passed = report.checks.filter(
      (check) => check.status === "passed",
    ).length;
    report.failed = report.checks.filter(
      (check) => check.status === "failed",
    ).length;
    report.result =
      report.failed === 0 && report.checks.length > 0 ? "passed" : "failed";
    writeReport();
  });

  it("keeps the browser select on a visible choice after Reset Browser", async () =>
    scenario("reset-browser-keeps-visible-choice", [4, 5, 28], async () => {
      const defaults = (await api("getDefaultSettings")).data;
      const expected = expectedBrowserChoice(defaults);
      await setSidebarOpen(true);
      await setControl("hookBrowserToggle", true);
      await waitForBackendSetting(
        "hookBrowser",
        true,
        "cookie toggle did not save before the reset",
      );

      // Cancel must leave the section untouched.
      await openSectionReset("browser");
      await clickModalButton("Cancel");
      await waitForModal(false);
      assert.equal(
        await browser.execute(
          () => document.getElementById("hookBrowserToggle").checked,
        ),
        true,
        "cancelled Reset Browser changed the cookie toggle",
      );

      await openSectionReset("browser");
      await clickModalButton("Reset section");
      await waitForModal(false);
      await waitFor(
        (want) => {
          const select = document.getElementById("browserChoice");
          return (
            select.value === want &&
            document.getElementById("hookBrowserToggle").checked === false
          );
        },
        "Reset Browser did not show the default browser choice",
        10_000,
        expected,
      );
      const select = await browser.execute(() => {
        const element = document.getElementById("browserChoice");
        return {
          value: element.value,
          options: [...element.options].map((option) => option.value),
        };
      });
      assert.equal(select.value, expected, "browser select is blank or wrong");
      if (process.platform === "win32") {
        assert.deepEqual(
          select.options,
          ["firefox"],
          "Windows browser select lost its Firefox-only options",
        );
      }
      await waitForBackendSetting(
        "browserChoice",
        expected,
        "backend browser choice was not saved as the visible choice",
      );
      return { browserChoice: expected, options: select.options };
    }));

  it("sends the reset channel to the updater after Reset Application", async () =>
    scenario("reset-application-calls-set-update-channel", [1, 2, 6, 30], () =>
      withChannelCallLog(async () => {
        const defaults = (await api("getDefaultSettings")).data;
        const defaultChannel = defaults.updateChannel;
        assert.notEqual(
          defaultChannel,
          "beta",
          "defaults must differ from beta for this check",
        );
        await setSidebarOpen(true);
        await setControl("updateChannelSelect", "beta");
        await waitForBackendSetting(
          "updateChannel",
          "beta",
          "beta channel did not save",
        );
        // The observer must see the known beta call before the checks below
        // can mean anything; an empty record is a failure, not a pass.
        await browser.waitUntil(
          async () => (await readChannelCalls()).includes("beta"),
          {
            timeout: 10_000,
            interval: 150,
            timeoutMsg:
              "the set_update_channel observer did not see the beta call",
          },
        );
        await clearChannelCalls();

        // A section that does not own the channel must not send it.
        await openSectionReset("browser");
        await clickModalButton("Reset section");
        await waitForModal(false);
        await waitForBackendSetting(
          "browserChoice",
          expectedBrowserChoice(defaults),
          "Reset Browser did not save",
        );
        assert.deepEqual(
          await readChannelCalls(),
          [],
          "Reset Browser sent a channel change",
        );
        assert.equal(
          (await api("getSettings")).updateChannel,
          "beta",
          "Reset Browser changed the channel",
        );

        // Application owns the channel: reset sends the default and saves it.
        await clearChannelCalls();
        await openSectionReset("application");
        await clickModalButton("Reset section");
        await waitForModal(false);
        await browser.waitUntil(
          async () => (await readChannelCalls()).includes(defaultChannel),
          {
            timeout: 10_000,
            interval: 150,
            timeoutMsg: `Reset Application did not send ${defaultChannel} to the updater`,
          },
        );
        await waitForBackendSetting(
          "updateChannel",
          defaultChannel,
          "backend channel was not saved as the default",
        );
        assert.equal(
          await browser.execute(
            () => document.getElementById("updateChannelSelect").value,
          ),
          defaultChannel,
          "update channel select does not show the reset value",
        );
        return {
          updaterCalls: await readChannelCalls(),
          backendChannel: defaultChannel,
        };
      }),
    ));

  it("shows the reset-all prompt with ROSI copy and an icon", async () =>
    scenario("reset-all-prompt-copy", [21, 22, 5], async () => {
      await setSidebarOpen(true);
      await clickById("resetSettings");
      await waitForModal(true);
      const prompt = await browser.execute(() => ({
        message: document.getElementById("modal-message").textContent.trim(),
        buttons: [...document.querySelectorAll("#modal-buttons button")].map(
          (button) => ({
            text: button.textContent.trim(),
            hasIcon: Boolean(button.querySelector("svg")),
          }),
        ),
      }));
      assert.match(prompt.message, /ROSI will restart\./);
      assert.doesNotMatch(prompt.message, /Rosi/);
      const confirm = prompt.buttons.find(
        (button) => button.text === "Reset & Restart",
      );
      assert.ok(confirm, "reset-all confirm button has no plain label");
      assert.equal(confirm.hasIcon, true, "reset-all button has no icon");
      assert.ok(
        prompt.buttons.every((button) => !button.text.includes("⟳")),
        "a text glyph is still in a prompt button",
      );
      await clickModalButton("Cancel");
      await waitForModal(false);
      return { confirmLabel: confirm.text };
    }));

  it("toasts an invalid playlist range once per Download and never on refresh", async () =>
    scenario("invalid-playlist-range-toasts", [8, 9, 10, 11], async () => {
      assert.ok(MEDIA, "ROSI_E2E_MEDIA_URL is not set");
      const playlistUrl = `${MEDIA}/list.html`;
      await setSidebarOpen(false);
      await browser.execute((value) => {
        const input = document.getElementById("url");
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, playlistUrl);
      await waitFor(
        () =>
          !document
            .getElementById("playlistScope")
            .classList.contains("hidden"),
        "playlist choices never appeared",
        60_000,
      );
      await installToastLog();

      // A summary refresh with an invalid range must not toast.
      await setPlaylistRange(3, 2);
      // The inline message comes from the same validation that would toast.
      await waitFor(
        () =>
          document.getElementById("playlistScopeError").textContent.length > 0,
        "invalid range did not reach the inline message",
        10_000,
      );
      assert.equal(
        await rangeToastCount(),
        0,
        "a summary refresh showed a playlist range toast",
      );
      const inline = await browser.execute(
        () => document.getElementById("playlistScopeError").textContent,
      );
      assert.ok(inline.length > 0, "invalid range has no inline message");

      // Download reports exactly once for one click.
      await clickById("downloadBtn");
      await waitFor(
        (prefix) =>
          window.__settingsResetToasts.filter((message) =>
            message.startsWith(prefix),
          ).length >= 1,
        "Download did not report the invalid playlist range",
        15_000,
        RANGE_TOAST,
      );
      // A repeat would come from the same click handler; wait until the toast
      // has finished animating in before counting.
      await waitFor(toastsSettled, "toasts did not settle", 10_000);
      assert.equal(
        await rangeToastCount(),
        1,
        "one Download click did not show exactly one playlist toast",
      );
      const downloading = await browser.execute(() =>
        document.getElementById("downloadBtn").classList.contains("loading"),
      );
      assert.equal(downloading, false, "an invalid range started a download");

      // Add to queue reports exactly once and queues nothing.
      const queueBefore = (await api("getQueue")).length;
      await browser.execute((value) => {
        const input = document.getElementById("queueUrlInput");
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, playlistUrl);
      await clickById("addToQueueBtn");
      await waitFor(
        (prefix) =>
          window.__settingsResetToasts.filter((message) =>
            message.startsWith(prefix),
          ).length >= 2,
        "Add to queue did not report the invalid playlist range",
        15_000,
        RANGE_TOAST,
      );
      await waitFor(toastsSettled, "toasts did not settle", 10_000);
      assert.equal(
        await rangeToastCount(),
        2,
        "one Add to queue click did not show exactly one playlist toast",
      );
      assert.equal(
        (await api("getQueue")).length,
        queueBefore,
        "an invalid range queued an item",
      );

      // Leave the scope as the next case expects it.
      await browser.execute(() => {
        const radio = document.querySelector(
          'input[name="playlist-scope"][value="current"]',
        );
        radio.checked = true;
        radio.dispatchEvent(new Event("change", { bubbles: true }));
        window.__settingsResetToastObserver?.disconnect();
      });
      return { rangeToasts: 2, queueBefore };
    }));

  it("shows no transfer toast when the export or import dialog is cancelled", async () =>
    scenario("cancelled-transfer-shows-no-toast", [24, 25], async () => {
      const dataDir = process.env.ROSI_E2E_DATA_DIR;
      assert.ok(dataDir, "ROSI_E2E_DATA_DIR is not set");
      // The E2E build reads one dialog answer from the data directory per dialog.
      const seam = path.join(dataDir, "e2e-settings-dialog.json");
      const answerCancel = () =>
        fs.writeFileSync(seam, JSON.stringify({ cancel: true }));
      const waitForAnswerConsumed = () =>
        browser.waitUntil(() => !fs.existsSync(seam), {
          timeout: 10_000,
          interval: 100,
          timeoutMsg: "the cancel answer was not consumed",
        });
      const transferToasts = () =>
        browser.execute(() =>
          window.__settingsResetToasts.filter((message) =>
            /export|import|unexpected/i.test(message),
          ),
        );

      await setSidebarOpen(true);
      await installToastLog();

      try {
        await watchBridgeCalls("exportSettings");
        await watchBridgeCalls("importSettings");

        answerCancel();
        await clickById("exportSettingsBtn");
        await waitForAnswerConsumed();
        await waitForSettledBridgeCall("exportSettings");
        assert.deepEqual(
          await transferToasts(),
          [],
          "a cancelled export showed a toast",
        );

        answerCancel();
        await clickById("importSettingsBtn");
        await waitForModal(true);
        await clickModalButton("Import");
        await waitForModal(false);
        await waitForAnswerConsumed();
        await waitForSettledBridgeCall("importSettings");
        assert.deepEqual(
          await transferToasts(),
          [],
          "a cancelled import showed a toast",
        );
      } finally {
        await unwatchBridgeCalls();
      }
      return { cancelledTransferToasts: 0, seamConsumed: !fs.existsSync(seam) };
    }));

  it("clears aria-hidden on a search-expanded section and restores the prior state", async () =>
    scenario(
      "settings-search-expand-and-restore",
      [17, 18, 19, 20],
      async () => {
        await setSidebarOpen(true);
        // Collapse Enhancements so the search has a collapsed section to expand.
        await browser.execute(() =>
          document.getElementById("settingsSectionHeaderEnhancements").click(),
        );
        await waitFor(
          () =>
            document
              .querySelector("#settingsSectionHeaderEnhancements")
              .closest(".settings-section")
              .classList.contains("collapsed"),
          "Enhancements did not collapse",
        );
        const before = await readSettingsSections();
        const enhancementsIndex = before.findIndex(
          (section) => section.title === "Enhancements",
        );
        assert.ok(enhancementsIndex >= 0, "Enhancements section is missing");
        assert.equal(before[enhancementsIndex].collapsed, true);

        await browser.execute(() => {
          const input = document.getElementById("settingsSearch");
          input.value = "Embed metadata";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await waitFor(
          () =>
            !document
              .querySelector("#settingsSectionHeaderEnhancements")
              .closest(".settings-section")
              .classList.contains("collapsed"),
          "search did not expand the matching section",
        );
        const during = await readSettingsSections();
        assert.equal(during[enhancementsIndex].searchHidden, false);
        for (const section of during.filter((item) => !item.searchHidden)) {
          assert.equal(
            section.collapsed,
            false,
            `${section.title} stayed collapsed`,
          );
          assert.equal(
            section.headerExpanded,
            "true",
            `${section.title} header`,
          );
          assert.notEqual(
            section.bodyHidden,
            "true",
            `${section.title} body is aria-hidden while expanded`,
          );
          assert.equal(
            section.bodyInert,
            false,
            `${section.title} body is inert`,
          );
        }

        await browser.execute(() => {
          const input = document.getElementById("settingsSearch");
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        const after = await readSettingsSections();
        after.forEach((section, index) => {
          const prior = before[index];
          assert.equal(
            section.searchHidden,
            false,
            `${section.title} still hidden`,
          );
          assert.equal(
            section.collapsed,
            prior.collapsed,
            `${section.title} did not return to its prior collapse state`,
          );
          assert.equal(section.headerExpanded, String(!prior.collapsed));
          assert.equal(section.bodyHidden, String(prior.collapsed));
          assert.equal(section.bodyInert, prior.collapsed);
        });
        return {
          sections: after.length,
          enhancementsCollapsedAfterClear: after[enhancementsIndex].collapsed,
        };
      },
    ));
});
