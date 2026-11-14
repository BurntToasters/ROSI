import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";
import { REPO_ROOT } from "../../helpers/profile.js";

// Must match E2E_DIALOG_ANSWER_FILE in src-tauri/src/settings.rs. The app
// reads and removes this file instead of opening a native file dialog.
const DATA_DIR = process.env.ROSI_E2E_DATA_DIR;
const SEAM_FILE = path.join(DATA_DIR ?? "", "e2e-settings-dialog.json");

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-settings-transfer-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-settings-transfer",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  runtime: { node: process.version },
  source: null,
  checks: [],
};

// Shared between the ordered cases: the notification value the round trip
// starts from, and the value it switches to.
const observed = {};
let transferDir = null;

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

// Records one report check per failure-mode group. Returns false on failure
// instead of throwing, so every group in a case is recorded.
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
    return true;
  } catch (error) {
    report.checks.push({
      name,
      failureModes,
      status: "failed",
      invariantPassed: false,
      reason: error instanceof Error ? error.message : String(error),
    });
    writeReport();
    return false;
  }
}

function finish(results) {
  if (results.includes(false)) {
    throw new Error("settings transfer checks failed; see report.json");
  }
}

// The seam refuses to queue an answer over an unconsumed one, so a leftover
// answer from an earlier step fails the case instead of answering it.
function queueDialogAnswer(answer) {
  assert.equal(
    fs.existsSync(SEAM_FILE),
    false,
    "a previous E2E dialog answer was never consumed",
  );
  fs.writeFileSync(
    SEAM_FILE,
    typeof answer === "string" ? answer : JSON.stringify(answer),
  );
}

function clearDialogAnswer() {
  fs.rmSync(SEAM_FILE, { force: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listFiles(dir) {
  return fs.readdirSync(dir).sort();
}

async function waitForBackendSetting(key, value, message) {
  await browser.waitUntil(
    async () => (await api("getSettings"))[key] === value,
    { timeout: 15_000, interval: 150, timeoutMsg: message },
  );
}

// Changes a sidebar toggle the way a user does: set the state, then fire change.
async function setToggle(id, checked) {
  await browser.execute(
    (control, value) => {
      const element = document.getElementById(control);
      if (!element) throw new Error(`missing control ${control}`);
      element.checked = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    },
    id,
    checked,
  );
}

async function readToggle(id) {
  return browser.execute((control) => {
    const element = document.getElementById(control);
    if (!element) throw new Error(`missing control ${control}`);
    return element.checked;
  }, id);
}

// Puts notifications back to the seeded value through its own control and
// waits for it to persist. The final case runs this before it reads the
// profile. The after hook runs it too, but only after every check is recorded.
async function restoreSeededNotification() {
  if ((await api("getSettings")).notifications === observed.seeded) return;
  await setToggle("notificationsToggle", observed.seeded);
  await waitForBackendSetting(
    "notifications",
    observed.seeded,
    "the profile setting could not be restored",
  );
}

// The export and import buttons are reached with a DOM click, not WebDriver
// pointer input, so the settings panel does not have to be scrolled into view.
async function clickControl(id) {
  await browser.execute((control) => {
    const element = document.getElementById(control);
    if (!element) throw new Error(`missing control ${control}`);
    element.click();
  }, id);
}

async function modalState() {
  return browser.execute(() => {
    const modal = document.getElementById("app-modal");
    return {
      active: Boolean(modal?.classList.contains("active")),
      title: document.getElementById("modal-title")?.textContent.trim() ?? null,
      buttons: [...document.querySelectorAll("#modal-buttons button")].map(
        (button) => button.textContent.trim(),
      ),
    };
  });
}

async function clickModalButton(label) {
  await browser.execute((text) => {
    const button = [...document.querySelectorAll("#modal-buttons button")].find(
      (candidate) => candidate.textContent.trim() === text,
    );
    if (!button) throw new Error(`modal has no ${text} button`);
    button.click();
  }, label);
}

// Counts settings-imported events the page receives, through the same
// subscription the renderer uses.
async function watchSettingsImported() {
  await browser.execute(() => {
    window.__settingsTransferStop?.();
    window.__settingsTransferImports = 0;
    window.__settingsTransferStop = window.__ROSI_E2E__.api.onSettingsImported(
      () => {
        window.__settingsTransferImports += 1;
      },
    );
  });
}

async function stopWatchingSettingsImported() {
  return browser.execute(() => {
    window.__settingsTransferStop?.();
    delete window.__settingsTransferStop;
    const count = window.__settingsTransferImports ?? 0;
    delete window.__settingsTransferImports;
    return count;
  });
}

describe("ROSI settings export and import through the dialog seam", () => {
  before(async () => {
    assert.ok(DATA_DIR, "ROSI_E2E_DATA_DIR is not set");
    await waitForAppReady();
    report.source = sourceIdentity();
    transferDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "rosi-settings-transfer-"),
    );
    clearDialogAnswer();
    writeReport();
  });

  after(async () => {
    try {
      // A failed round trip must not leave the profile changed for later specs.
      if (observed.seeded !== undefined) {
        await restoreSeededNotification();
      }
    } finally {
      clearDialogAnswer();
      if (transferDir) {
        fs.rmSync(transferDir, { recursive: true, force: true });
      }
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
    }
  });

  it("round-trips a changed setting through the export and import seam", async () => {
    const current = await api("getSettings");
    observed.seeded = current.notifications;
    observed.changed = !current.notifications;
    const exportFile = path.join(transferDir, "roundtrip.json");

    // The change and the export click run in one page task. The export must
    // flush the pending change, which the debounced save has not written yet.
    queueDialogAnswer({ path: exportFile });
    await browser.execute(
      (control, value, exportId) => {
        const toggle = document.getElementById(control);
        toggle.checked = value;
        toggle.dispatchEvent(new Event("change", { bubbles: true }));
        document.getElementById(exportId).click();
      },
      "notificationsToggle",
      observed.changed,
      "exportSettingsBtn",
    );
    await browser.waitUntil(
      () => {
        try {
          readJson(exportFile);
          return true;
        } catch {
          return false;
        }
      },
      {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: "export did not write the chosen path",
      },
    );
    const exportedBytes = fs.readFileSync(exportFile);
    observed.export = {
      seamAfterExport: fs.existsSync(SEAM_FILE),
      exportedNotifications: readJson(exportFile).notifications,
      exportSha256: sha256(exportedBytes),
    };

    // Change the setting back through its own control and let it persist.
    await setToggle("notificationsToggle", observed.seeded);
    await waitForBackendSetting(
      "notifications",
      observed.seeded,
      "reverting the setting did not persist",
    );
    observed.beforeImport = {
      backendNotifications: (await api("getSettings")).notifications,
      sidebarNotifications: await readToggle("notificationsToggle"),
    };

    // The import button opens a confirm modal. The seam answer must wait for
    // the confirm click, so nothing is imported before it.
    queueDialogAnswer({ path: exportFile });
    await clickControl("importSettingsBtn");
    await browser.waitUntil(
      async () => {
        const state = await modalState();
        return state.active && state.title === "Import Settings";
      },
      {
        timeout: 10_000,
        interval: 100,
        timeoutMsg: "import confirm modal did not open",
      },
    );
    observed.importModal = {
      beforeConfirm: await modalState(),
      backendNotificationsBeforeConfirm: (await api("getSettings"))
        .notifications,
      seamBeforeConfirm: fs.existsSync(SEAM_FILE),
    };
    await clickModalButton("Import");
    await waitForBackendSetting(
      "notifications",
      observed.changed,
      "import did not restore the exported notifications value",
    );
    await browser.waitUntil(
      async () =>
        (await readToggle("notificationsToggle")) === observed.changed,
      {
        timeout: 10_000,
        interval: 100,
        timeoutMsg: "sidebar did not show the imported notifications value",
      },
    );
    await browser.waitUntil(async () => !(await modalState()).active, {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: "import modal did not close",
    });
    observed.afterImport = {
      seamAfterImport: fs.existsSync(SEAM_FILE),
      backendNotifications: (await api("getSettings")).notifications,
      sidebarNotifications: await readToggle("notificationsToggle"),
    };

    const results = [
      await scenario(
        "settings-export-flushes-pending-change",
        [13, 15, 16],
        async () => {
          assert.equal(
            observed.export.exportedNotifications,
            observed.changed,
            "the export did not include the change made just before it",
          );
          assert.equal(
            observed.export.seamAfterExport,
            false,
            "the export answer was not consumed by the export",
          );
          return {
            exportedNotifications: observed.export.exportedNotifications,
            exportSha256: observed.export.exportSha256,
          };
        },
      ),
      await scenario(
        "settings-import-restores-sidebar",
        [13, 15, 17],
        async () => {
          assert.equal(
            observed.afterImport.backendNotifications,
            observed.changed,
            "get_settings does not show the imported value",
          );
          assert.equal(
            observed.afterImport.sidebarNotifications,
            observed.changed,
            "the sidebar does not show the imported value",
          );
          assert.equal(
            observed.afterImport.seamAfterImport,
            false,
            "the import answer was not consumed by the import",
          );
          return {
            restoredNotifications: observed.afterImport.backendNotifications,
            sidebarNotifications: observed.afterImport.sidebarNotifications,
          };
        },
      ),
      await scenario("settings-round-trip-values-distinct", [18], async () => {
        assert.notEqual(observed.seeded, observed.changed);
        assert.equal(
          observed.beforeImport.backendNotifications,
          observed.seeded,
          "the revert did not persist before the import",
        );
        assert.equal(
          observed.afterImport.backendNotifications,
          observed.changed,
        );
        return {
          seeded: observed.seeded,
          changed: observed.changed,
          beforeImport: observed.beforeImport,
        };
      }),
      await scenario(
        "settings-import-confirm-gates-import",
        [19, 15],
        async () => {
          assert.equal(observed.importModal.beforeConfirm.active, true);
          assert.equal(
            observed.importModal.beforeConfirm.title,
            "Import Settings",
          );
          assert.ok(
            observed.importModal.beforeConfirm.buttons.includes("Import") &&
              observed.importModal.beforeConfirm.buttons.includes("Cancel"),
            `unexpected modal buttons ${JSON.stringify(observed.importModal.beforeConfirm.buttons)}`,
          );
          assert.equal(
            observed.importModal.backendNotificationsBeforeConfirm,
            observed.seeded,
            "settings changed before the import was confirmed",
          );
          assert.equal(
            observed.importModal.seamBeforeConfirm,
            true,
            "the import ran before the confirm click",
          );
          return { modalButtons: observed.importModal.beforeConfirm.buttons };
        },
      ),
    ];
    finish(results);
  });

  it("returns ok with exported false when the export dialog is cancelled", async () => {
    const filesBefore = listFiles(transferDir);
    queueDialogAnswer({ cancel: true });
    const result = await api("exportSettings");
    const results = [
      await scenario(
        "cancelled-export-returns-ok-false",
        [6, 7, 13],
        async () => {
          assert.equal(result.ok, true, JSON.stringify(result));
          assert.equal(result.data?.exported, false, JSON.stringify(result));
          assert.equal(
            fs.existsSync(SEAM_FILE),
            false,
            "the cancel answer was not consumed",
          );
          assert.deepEqual(
            listFiles(transferDir),
            filesBefore,
            "a cancelled export wrote a file",
          );
          return {
            envelope: { ok: result.ok, exported: result.data.exported },
          };
        },
      ),
    ];
    finish(results);
  });

  it("returns ok with imported false and changes nothing when the import dialog is cancelled", async () => {
    const before = await api("getSettings");
    await watchSettingsImported();
    queueDialogAnswer({ cancel: true });
    const result = await api("importSettings");
    const events = await stopWatchingSettingsImported();
    const after = await api("getSettings");
    const results = [
      await scenario("cancelled-import-leaves-settings", [8, 13], async () => {
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.data?.imported, false, JSON.stringify(result));
        assert.equal(
          fs.existsSync(SEAM_FILE),
          false,
          "the cancel answer was not consumed",
        );
        assert.deepEqual(after, before, "a cancelled import changed settings");
        assert.equal(events, 0, "a cancelled import announced settings");
        return {
          envelope: { ok: result.ok, imported: result.data.imported },
          settingsEvents: events,
        };
      }),
    ];
    finish(results);
  });

  it("keeps real export and import failures as errors", async () => {
    // A regular file used as a directory makes the export's write impossible.
    const blocker = path.join(transferDir, "not-a-directory");
    fs.writeFileSync(blocker, "blocker");
    queueDialogAnswer({ path: path.join(blocker, "settings.json") });
    const exportResult = await api("exportSettings");
    const exportAnswerConsumed = fs.existsSync(SEAM_FILE) === false;

    const arrayFile = path.join(transferDir, "array.json");
    fs.writeFileSync(arrayFile, "[]");
    const before = await api("getSettings");
    await watchSettingsImported();
    queueDialogAnswer({ path: arrayFile });
    const importResult = await api("importSettings");
    const events = await stopWatchingSettingsImported();
    const after = await api("getSettings");

    const results = [
      await scenario("real-failures-still-error", [9, 10], async () => {
        assert.equal(exportResult.ok, false, JSON.stringify(exportResult));
        assert.equal(
          exportResult.error?.code,
          "INTERNAL_ERROR",
          JSON.stringify(exportResult),
        );
        assert.equal(exportAnswerConsumed, true);
        assert.equal(importResult.ok, false, JSON.stringify(importResult));
        assert.equal(
          importResult.error?.code,
          "INTERNAL_ERROR",
          JSON.stringify(importResult),
        );
        assert.deepEqual(after, before, "a failed import changed settings");
        assert.equal(events, 0, "a failed import announced settings");
        return {
          exportError: exportResult.error?.code,
          importError: importResult.error?.code,
        };
      }),
    ];
    finish(results);
  });

  it("answers a malformed dialog answer with an error without opening a dialog", async () => {
    const filesBefore = listFiles(transferDir);
    const outcomes = [];
    for (const answer of [
      "not json",
      '{"cancel": true, "path": "/tmp/x.json"}',
    ]) {
      queueDialogAnswer(answer);
      const started = Date.now();
      const result = await api("exportSettings");
      outcomes.push({
        ok: result.ok,
        code: result.error?.code ?? null,
        elapsedMs: Date.now() - started,
        consumed: fs.existsSync(SEAM_FILE) === false,
      });
    }
    const results = [
      await scenario("malformed-seam-answer-errors", [13, 14], async () => {
        for (const outcome of outcomes) {
          assert.equal(outcome.ok, false, JSON.stringify(outcomes));
          assert.equal(
            outcome.code,
            "INTERNAL_ERROR",
            JSON.stringify(outcomes),
          );
          assert.equal(
            outcome.consumed,
            true,
            "a malformed answer was left queued",
          );
          assert.ok(
            outcome.elapsedMs < 10_000,
            `export waited ${outcome.elapsedMs} ms; a native dialog may have opened`,
          );
        }
        assert.deepEqual(listFiles(transferDir), filesBefore);
        return { outcomes };
      }),
    ];
    finish(results);
  });

  it("keeps Firefox as the Windows browser default and on import", async () => {
    const defaults = await api("getDefaultSettings");
    const loaded = await api("getSettings");
    const expected = process.platform === "win32" ? "firefox" : "chrome";
    const results = [
      await scenario("windows-default-browser", [1, 2], async () => {
        assert.equal(defaults.ok, true, JSON.stringify(defaults));
        assert.equal(defaults.data?.browserChoice, expected);
        if (process.platform === "win32") {
          assert.equal(loaded.browserChoice, "firefox");
        }
        return {
          platform: process.platform,
          expectedBrowserChoice: expected,
          defaultBrowserChoice: defaults.data?.browserChoice ?? null,
          loadedBrowserChoice: loaded.browserChoice,
        };
      }),
    ];

    // An imported file that names Chrome. On Windows it must load as Firefox;
    // elsewhere Chrome is still a valid choice and must survive the import.
    const beforeFile = path.join(transferDir, "browser-before.json");
    const chromeFile = path.join(transferDir, "browser-chrome.json");
    queueDialogAnswer({ path: beforeFile });
    const exported = await api("exportSettings");
    assert.equal(exported.ok, true, JSON.stringify(exported));
    assert.equal(exported.data?.exported, true, JSON.stringify(exported));
    fs.writeFileSync(
      chromeFile,
      JSON.stringify({ ...readJson(beforeFile), browserChoice: "chrome" }),
    );
    let imported;
    let loadedAfterImport;
    try {
      queueDialogAnswer({ path: chromeFile });
      imported = await api("importSettings");
      loadedAfterImport = await api("getSettings");
    } finally {
      clearDialogAnswer();
      queueDialogAnswer({ path: beforeFile });
      const restored = await api("importSettings");
      assert.equal(restored.ok, true, JSON.stringify(restored));
    }
    const importExpected = process.platform === "win32" ? "firefox" : "chrome";
    results.push(
      await scenario("windows-import-coerces-browser", [3], async () => {
        assert.equal(imported.ok, true, JSON.stringify(imported));
        assert.equal(imported.data?.imported, true, JSON.stringify(imported));
        assert.equal(loadedAfterImport.browserChoice, importExpected);
        return {
          importedBrowserChoice: "chrome",
          loadedBrowserChoice: loadedAfterImport.browserChoice,
          expectedBrowserChoice: importExpected,
        };
      }),
    );
    finish(results);
  });

  it("leaves the profile setting it changed as it found it", async () => {
    const results = [
      await scenario("profile-setting-restored", [20], async () => {
        // The earlier cases end on the changed value, so restore it here,
        // before the check reads the profile.
        await restoreSeededNotification();
        const backend = (await api("getSettings")).notifications;
        const sidebar = await readToggle("notificationsToggle");
        assert.equal(
          backend,
          observed.seeded,
          "notifications was not restored",
        );
        assert.equal(
          sidebar,
          observed.seeded,
          "sidebar notifications was not restored",
        );
        assert.equal(
          fs.existsSync(SEAM_FILE),
          false,
          "a dialog answer is still queued",
        );
        return { notifications: backend };
      }),
    ];
    finish(results);
  });
});
