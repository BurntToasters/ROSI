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
  restoreBridge,
  setControl,
  stubBridge,
  waitFor,
  waitForAppReady,
  waitForBackendSetting,
  waitForModal,
} from "../../helpers/ui.js";
import { REPO_ROOT } from "../../helpers/profile.js";

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-settings-feedback-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-settings-feedback",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  runtime: { node: process.version },
  source: null,
  checks: [],
};

const PRESET_NAME = "Settings Feedback Preset";
const FAIL_SAVE = {
  ok: false,
  error: {
    code: "INTERNAL_ERROR",
    message: "settings feedback refused the save",
  },
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
// settings-feedback.failure-modes.md that the case exercises.
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

// Records each toast as it is added, with its type, so a toast the renderer
// caps out of the container is still counted.
async function installToastLog() {
  await browser.execute(() => {
    window.__settingsFeedbackToastObserver?.disconnect();
    const toasts = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const found = node.matches(".toast-message")
            ? [node]
            : [...node.querySelectorAll(".toast-message")];
          for (const element of found) {
            const toast = element.closest(".toast");
            const type =
              [...(toast?.classList ?? [])]
                .find((name) =>
                  /^toast-(info|success|warning|error)$/.test(name),
                )
                ?.replace("toast-", "") ?? null;
            toasts.push({ text: element.textContent.trim(), type });
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__settingsFeedbackToastObserver = observer;
    window.__settingsFeedbackToasts = toasts;
  });
}

async function toastEntries() {
  return browser.execute(() => [...(window.__settingsFeedbackToasts ?? [])]);
}

// Counts renderer calls to resetStats. The wrapper passes every call through,
// so a confirmed reset still reaches the backend.
async function installResetStatsCounter() {
  await browser.execute(() => {
    const bridge = window.__ROSI_E2E__.api;
    if (!window.__settingsFeedbackStats) {
      window.__settingsFeedbackStats = {
        original: bridge.resetStats,
        calls: 0,
      };
    }
    const state = window.__settingsFeedbackStats;
    state.calls = 0;
    bridge.resetStats = (...args) => {
      state.calls += 1;
      return state.original.apply(bridge, args);
    };
  });
}

async function resetStatsCalls() {
  return browser.execute(() => window.__settingsFeedbackStats?.calls ?? -1);
}

async function restoreResetStatsCounter() {
  await browser.execute(() => {
    const state = window.__settingsFeedbackStats;
    if (!state) return;
    window.__ROSI_E2E__.api.resetStats = state.original;
    delete window.__settingsFeedbackStats;
  });
}

async function modalButtons() {
  return browser.execute(() =>
    [...document.querySelectorAll("#modal-buttons button")].map((button) =>
      button.textContent.trim(),
    ),
  );
}

async function modalMessage() {
  return browser.execute(
    () => document.getElementById("modal-message")?.textContent.trim() ?? "",
  );
}

async function savedPresetNames() {
  const settings = await api("getSettings");
  return (settings.downloadPresets ?? []).map((preset) => preset.name);
}

// The renderer's view of the select: true when an option carries this name.
async function presetOptionNamed(name) {
  return browser.execute(
    (wanted) =>
      [...document.getElementById("downloadPresetSelect").options].some(
        (option) => option.textContent.trim() === wanted,
      ),
    name,
  );
}

async function presetStatusText() {
  return browser.execute(
    () => document.getElementById("presetStatus")?.textContent.trim() ?? "",
  );
}

async function savePreset(name) {
  await browser.execute((value) => {
    const input = document.getElementById("presetNameInput");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, name);
  await clickById("savePresetBtn");
}

async function selectPresetNamed(name) {
  await browser.execute((wanted) => {
    const select = document.getElementById("downloadPresetSelect");
    const option = [...select.options].find(
      (candidate) => candidate.textContent.trim() === wanted,
    );
    if (!option) throw new Error(`no preset option ${wanted}`);
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, name);
}

describe("ROSI settings feedback: channel disclosure, Interface reset, confirms", () => {
  before(async () => {
    await waitForAppReady();
    report.source = sourceIdentity();
    await installToastLog();
    writeReport();
  });

  after(async () => {
    await restoreBridge();
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

  it("keeps the update channel label and chevron, and tracks aria-expanded", async () =>
    scenario("update-channel-disclosure-keeps-chevron", [1, 2, 3], async () => {
      await setSidebarOpen(true);
      await browser.execute(() => {
        window.__settingsFeedbackChevron = document.querySelector(
          "#showUpdateChannelBtn .settings-link-chevron",
        );
      });
      assert.equal(
        await browser.execute(
          () => window.__settingsFeedbackChevron instanceof Element,
        ),
        true,
        "channel button has no chevron icon before the first toggle",
      );
      const snapshot = () =>
        browser.execute(() => {
          const button = document.getElementById("showUpdateChannelBtn");
          return {
            text: button.textContent.trim(),
            expanded: button.getAttribute("aria-expanded"),
            panelVisible: document
              .getElementById("updateChannelContainer")
              .classList.contains("visible"),
            chevronIsSameNode:
              button.querySelector(".settings-link-chevron") ===
              window.__settingsFeedbackChevron,
          };
        });

      const started = await snapshot();
      assert.equal(started.text, "Channel", "label changed before any toggle");
      assert.equal(started.expanded, "false");
      assert.equal(started.panelVisible, false);

      for (const expectOpen of [true, false]) {
        await clickById("showUpdateChannelBtn");
        await waitFor(
          (want) =>
            document
              .getElementById("updateChannelContainer")
              .classList.contains("visible") === want,
          `update channel panel did not ${expectOpen ? "open" : "close"}`,
          5_000,
          expectOpen,
        );
        const state = await snapshot();
        assert.equal(state.text, "Channel", "toggle changed the button label");
        assert.equal(
          state.expanded,
          String(expectOpen),
          `aria-expanded did not match the panel after opening=${expectOpen}`,
        );
        assert.equal(state.panelVisible, expectOpen);
        assert.equal(
          state.chevronIsSameNode,
          true,
          "toggle replaced the chevron icon",
        );
      }
      return { label: "Channel", chevron: "same node after two toggles" };
    }));

  it("keeps Flat UI on when the Interface section resets", async () =>
    scenario("interface-reset-keeps-flat-ui", [4], async () => {
      const originalFlatUi = (await api("getSettings")).flatUi === true;
      await setSidebarOpen(true);
      await setControl("flatUiToggle", true);
      await waitForBackendSetting(
        "flatUi",
        true,
        "Flat UI did not save before the Interface reset",
      );

      const successesBefore = (await toastEntries()).filter(
        (entry) => entry.type === "success",
      ).length;
      await openSectionReset("interface");
      await clickModalButton("Reset Section");
      await waitForModal(false);
      await browser.waitUntil(
        async () =>
          (await toastEntries()).filter((entry) => entry.type === "success")
            .length > successesBefore,
        {
          timeout: 15_000,
          interval: 150,
          timeoutMsg: "Interface reset did not finish",
        },
      );

      assert.equal(
        (await api("getSettings")).flatUi,
        true,
        "Interface reset turned Flat UI off",
      );
      assert.equal(
        await browser.execute(
          () => document.getElementById("flatUiToggle").checked,
        ),
        true,
        "Flat UI toggle changed after Interface reset",
      );

      await setControl("flatUiToggle", originalFlatUi);
      await waitForBackendSetting(
        "flatUi",
        originalFlatUi,
        "Flat UI was not restored",
      );
      return { flatUiAfterInterfaceReset: true };
    }));

  it("asks before Reset Stats and resets only when confirmed", async () =>
    scenario("reset-stats-asks-first", [6, 7, 8], async () => {
      await installResetStatsCounter();
      try {
        const totalsBefore = (await api("getStats")).totalDownloads;
        await clickById("viewStatsBtn");
        await waitForModal("Download Statistics");
        await clickModalButton("Reset Stats");
        await waitForModal("Reset Statistics?", {
          timeoutMsg: "Reset Stats did not ask for confirmation",
        });
        assert.equal(
          await resetStatsCalls(),
          0,
          "Reset Stats reset the statistics before confirmation",
        );
        assert.deepEqual(await modalButtons(), ["Cancel", "Reset Stats"]);
        assert.match(
          await modalMessage(),
          /Reset all download statistics to zero\? This cannot be undone\./,
        );

        await clickModalButton("Cancel");
        await waitForModal(false);
        assert.equal(
          await resetStatsCalls(),
          0,
          "Cancel on Reset Stats still reset the statistics",
        );
        assert.equal(
          (await api("getStats")).totalDownloads,
          totalsBefore,
          "Cancel on Reset Stats changed the stored totals",
        );

        await clickById("viewStatsBtn");
        await waitForModal("Download Statistics");
        await clickModalButton("Reset Stats");
        await waitForModal("Reset Statistics?", {
          timeoutMsg: "second Reset Stats did not ask for confirmation",
        });
        await clickModalButton("Reset Stats");
        await waitForModal(false);
        // The renderer reports the reset once the backend answers; check that
        // report first, then read the backend totals.
        await browser.waitUntil(
          async () =>
            (await toastEntries()).some(
              (entry) =>
                entry.type === "info" && entry.text === "Statistics reset.",
            ),
          {
            timeout: 10_000,
            interval: 150,
            timeoutMsg: "confirmed Reset Stats was not reported",
          },
        );
        assert.equal(
          await resetStatsCalls(),
          1,
          "confirmed Reset Stats did not call the backend once",
        );
        assert.equal(
          (await api("getStats")).totalDownloads,
          0,
          "confirmed Reset Stats did not clear the totals",
        );
        return { cancelledCalls: 0, confirmedCalls: 1 };
      } finally {
        await restoreResetStatsCounter();
      }
    }));

  it("asks before deleting a preset and keeps the preset on failure", async () =>
    scenario("preset-confirm-and-rollback", [9, 10, 11, 12, 13], async () => {
      // A save the backend refuses must not leave the unsaved preset in memory.
      await stubBridge("saveSettings", FAIL_SAVE);
      try {
        await savePreset(PRESET_NAME);
        await browser.waitUntil(
          async () =>
            (await presetStatusText()) === "Could not save the preset.",
          {
            timeout: 15_000,
            interval: 150,
            timeoutMsg: "refused preset save was not reported",
          },
        );
      } finally {
        await restoreBridge();
      }
      assert.equal(
        await presetOptionNamed(PRESET_NAME),
        false,
        "a refused save left the preset in the select",
      );
      assert.equal(
        (await savedPresetNames()).includes(PRESET_NAME),
        false,
        "a refused save stored the preset",
      );

      await savePreset(PRESET_NAME);
      // The renderer re-renders the select before it reports the save, so wait
      // for that report and the option before reading the backend.
      await browser.waitUntil(
        async () =>
          (await presetStatusText()) === `Saved ${PRESET_NAME}.` &&
          (await presetOptionNamed(PRESET_NAME)),
        {
          timeout: 15_000,
          interval: 150,
          timeoutMsg: "preset save was not reported in the select",
        },
      );
      assert.equal(
        (await savedPresetNames()).includes(PRESET_NAME),
        true,
        "a reported save is missing from the backend",
      );
      await selectPresetNamed(PRESET_NAME);
      await waitFor(
        () => !document.getElementById("deletePresetBtn").disabled,
        "Delete preset stayed disabled with a preset selected",
        5_000,
      );

      await clickById("deletePresetBtn");
      await waitForModal("Delete Preset?");
      assert.match(await modalMessage(), /"Settings Feedback Preset"/);
      assert.deepEqual(await modalButtons(), ["Cancel", "Delete"]);
      await clickModalButton("Cancel");
      await waitForModal(false);
      assert.equal(
        (await savedPresetNames()).includes(PRESET_NAME),
        true,
        "Cancel on preset Delete removed the preset",
      );
      assert.equal(
        await presetOptionNamed(PRESET_NAME),
        true,
        "Cancel on preset Delete removed the select option",
      );

      // A refused delete keeps the preset and its selection.
      await stubBridge("saveSettings", FAIL_SAVE);
      try {
        await clickById("deletePresetBtn");
        await waitForModal("Delete Preset?");
        await clickModalButton("Delete");
        await waitForModal(false);
        await browser.waitUntil(
          async () =>
            (await presetStatusText()) === "Could not delete the preset.",
          {
            timeout: 15_000,
            interval: 150,
            timeoutMsg: "refused preset delete was not reported",
          },
        );
      } finally {
        await restoreBridge();
      }
      assert.equal(
        await presetOptionNamed(PRESET_NAME),
        true,
        "a refused delete dropped the preset from the select",
      );
      assert.equal(
        await browser.execute(
          (wanted) =>
            document
              .getElementById("downloadPresetSelect")
              .selectedOptions[0]?.textContent.trim() === wanted,
          PRESET_NAME,
        ),
        true,
        "a refused delete cleared the preset selection",
      );
      assert.equal(
        (await savedPresetNames()).includes(PRESET_NAME),
        true,
        "a refused delete removed the preset",
      );

      await clickById("deletePresetBtn");
      await waitForModal("Delete Preset?");
      await clickModalButton("Delete");
      await waitForModal(false);
      // Wait for the renderer to drop the option and report the delete first.
      await browser.waitUntil(
        async () =>
          (await presetStatusText()) === `Deleted ${PRESET_NAME}.` &&
          !(await presetOptionNamed(PRESET_NAME)),
        {
          timeout: 15_000,
          interval: 150,
          timeoutMsg: "confirmed preset Delete was not reported in the select",
        },
      );
      assert.equal(
        (await savedPresetNames()).includes(PRESET_NAME),
        false,
        "a reported delete is still in the backend",
      );
      return {
        refusedSaveRolledBack: true,
        refusedDeleteKept: true,
        confirmedDeleteRemoved: true,
      };
    }));
});
