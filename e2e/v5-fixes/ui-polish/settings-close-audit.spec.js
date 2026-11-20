// Settings save drain, close save error toast, and setup wizard skip/finish
// races. Rows match e2e/v5-fixes/ui-polish/settings-close-audit.failure-modes.md.
//
// Backend answers are replaced only through the E2E-only IPC stub registry
// (window.__ROSI_E2E_IPC_STUBS__, read by call() in src/commands.ts). Every stub
// is removed in a finally block, and the stored settings are restored through
// the real API. The renderer modules are read through window.__ROSI_E2E__.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import {
  api,
  clickModalButton,
  reloadRenderer,
  waitFor,
  waitForAppReady,
  waitForModal,
} from "../../helpers/ui.js";
import { REPO_ROOT } from "../../helpers/profile.js";

const STUB_KEYS = [
  "save_settings",
  "notify_settings_flushed",
  "log_error",
  "get_default_settings",
];

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-settings-close-audit-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-settings-close-audit",
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
// settings-close-audit.failure-modes.md that the case exercises.
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

// Installs the four stubs and the page-side record. Each stub answers from
// window.__closeAudit mode fields, or passes through to the real command.
async function installStubs() {
  await browser.execute(() => {
    const state = {
      saveMode: "pass",
      defaultsMode: "pass",
      saveCalls: 0,
      defaultsCalls: 0,
      heldSaves: [],
      heldDefaults: [],
      logs: [],
      notifyCalls: [],
      notifyResults: [],
      cancelOnNotify: false,
      generations: [],
      toasts: [],
      cancelResults: [],
    };
    window.__closeAudit = state;
    if (!window.__ROSI_E2E_IPC_STUBS__) window.__ROSI_E2E_IPC_STUBS__ = {};
    const stubs = window.__ROSI_E2E_IPC_STUBS__;
    stubs.save_settings = (args, next) => {
      state.saveCalls += 1;
      if (state.saveMode === "throw") {
        return Promise.reject(new Error("E2E save threw"));
      }
      if (state.saveMode === "ioError") {
        return Promise.resolve({
          ok: false,
          error: { code: "IO_ERROR", message: "E2E disk full" },
        });
      }
      if (state.saveMode === "newer") {
        return Promise.resolve({
          ok: false,
          error: { code: "NEWER_VERSION", message: "E2E newer file" },
        });
      }
      if (state.saveMode === "hold") {
        return new Promise((resolve) => {
          state.heldSaves.push(() => resolve(next()));
        });
      }
      return next();
    };
    stubs.get_default_settings = (args, next) => {
      state.defaultsCalls += 1;
      if (state.defaultsMode === "fail") {
        return Promise.resolve({
          ok: false,
          error: { code: "IO_ERROR", message: "E2E defaults refused" },
        });
      }
      if (state.defaultsMode === "hold") {
        return new Promise((resolve) => {
          state.heldDefaults.push(() => resolve(next()));
        });
      }
      return next();
    };
    stubs.log_error = (args, next) => {
      state.logs.push(String(args?.message ?? ""));
      return next();
    };
    stubs.notify_settings_flushed = (args) => {
      const generation = args?.generation;
      state.notifyCalls.push(generation);
      // Retires the close request the way the real acknowledgement would, but
      // keeps the window open for the rest of the run.
      const retired = state.cancelOnNotify
        ? window.__TAURI__.core.invoke("e2e_cancel_close_request", {
            generation,
          })
        : Promise.resolve();
      return retired.then(
        (value) => {
          state.notifyResults.push({ ok: true });
          return value;
        },
        (error) => {
          state.notifyResults.push({ ok: false, error: String(error) });
          throw error;
        },
      );
    };
  });
}

// Removes only this spec's keys and the registry only when it is then empty.
// The read-back proves the registry is clean before the next case.
async function uninstallStubs() {
  const left = await browser.execute((keys) => {
    window.__closeAudit?.unlisten?.();
    window.__closeAudit?.observer?.disconnect();
    delete window.__closeAudit;
    const registry = window.__ROSI_E2E_IPC_STUBS__;
    if (!registry) return [];
    keys.forEach((key) => delete registry[key]);
    const remaining = keys.filter((key) => key in registry);
    if (Object.keys(registry).length === 0)
      delete window.__ROSI_E2E_IPC_STUBS__;
    return remaining;
  }, STUB_KEYS);
  assert.deepEqual(left, [], "a stub key survived the uninstall");
}

async function withStubs(body) {
  try {
    await installStubs();
    return await body();
  } finally {
    await uninstallStubs();
  }
}

// Sets a field on the page-side record.
async function setAuditMode(field, value) {
  await browser.execute(
    (name, next) => {
      window.__closeAudit[name] = next;
    },
    field,
    value,
  );
}

async function auditValue(field) {
  return browser.execute((name) => window.__closeAudit[name], field);
}

// Runs persistSettings({ immediate: true }) in the page and reports the result,
// the stored error code, and the settings panel feedback state.
async function persistNow() {
  return browser.executeAsync((done) => {
    const { settings } = window.__ROSI_E2E__.modules;
    settings.persistSettings({ immediate: true }).then((saved) =>
      done({
        saved,
        code: settings.settingsStore.lastSettingsSaveErrorCode,
        feedback:
          document.getElementById("settingsSaveFeedback")?.dataset.state ??
          null,
      }),
    );
  });
}

async function setErrorCode(code) {
  await browser.execute((value) => {
    window.__ROSI_E2E__.modules.settings.settingsStore.lastSettingsSaveErrorCode =
      value;
  }, code);
}

// Listens for the backend's close request and records each failure toast. When
// the failure toast shows, the close request is cancelled at once through the
// E2E seam. The cancel only succeeds before the backend flush timeout, so a
// successful cancel proves the toast came first.
async function watchClose() {
  await browser.executeAsync((done) => {
    const state = window.__closeAudit;
    state.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const found = node.matches(".toast-message")
            ? [node]
            : [...node.querySelectorAll(".toast-message")];
          for (const element of found) {
            const text = element.textContent.trim();
            state.toasts.push(text);
            if (/could not be saved/i.test(text)) {
              const generation = state.generations.at(-1);
              window.__TAURI__.core
                .invoke("e2e_cancel_close_request", { generation })
                .then(
                  () => state.cancelResults.push({ ok: true }),
                  (error) =>
                    state.cancelResults.push({
                      ok: false,
                      error: String(error),
                    }),
                );
            }
          }
        }
      }
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
    window.__TAURI__.event
      .listen("prepare-for-close", (event) => {
        state.generations.push(event.payload);
      })
      .then((unlisten) => {
        state.unlisten = unlisten;
        done(true);
      });
  });
}

async function stopWatchingClose() {
  await browser.execute(() => {
    const state = window.__closeAudit;
    state.unlisten?.();
    state.unlisten = null;
    state.observer?.disconnect();
    state.observer = null;
  });
}

async function resetCloseRecord() {
  await browser.execute(() => {
    const state = window.__closeAudit;
    state.generations.length = 0;
    state.toasts.length = 0;
    state.cancelResults.length = 0;
    state.notifyCalls.length = 0;
    state.notifyResults.length = 0;
  });
}

async function requestClose() {
  await browser.execute(() => {
    void window.__TAURI__.window.getCurrentWindow().close();
  });
}

async function wizardState() {
  return browser.execute(() => {
    const next = document.getElementById("wizard-next");
    const back = document.getElementById("wizard-back");
    const skip = document.getElementById("wizard-skip");
    const error = document.getElementById("wizard-error");
    return {
      active: document
        .getElementById("setup-wizard")
        .classList.contains("active"),
      step: Number(
        document
          .querySelector("#setup-wizard .wizard-progress")
          .getAttribute("aria-valuenow"),
      ),
      total: document.querySelectorAll("#setup-wizard .wizard-step").length,
      nextDisabled: next.disabled,
      backDisabled: back.disabled,
      skipDisabled: skip.disabled,
      errorText: error.hidden ? "" : error.textContent.trim(),
    };
  });
}

// Seeds firstLaunch, reloads, and waits for the wizard. The stored settings
// are restored and the page reloaded when the body ends.
async function withWizard(body) {
  const original = await api("getSettings");
  const seeded = await api("saveSettings", { ...original, firstLaunch: true });
  assert.equal(seeded.ok, true, seeded.error?.message);
  try {
    await reloadRenderer();
    await waitFor(
      () =>
        document.getElementById("setup-wizard")?.classList.contains("active"),
      "setup wizard did not open",
    );
    return await withStubs(body);
  } finally {
    const restored = await api("saveSettings", original);
    assert.equal(restored.ok, true, restored.error?.message);
    await reloadRenderer();
  }
}

async function clickNext() {
  await browser.execute(() => document.getElementById("wizard-next").click());
}

// Advances to the last step, waiting for each step before the next click.
async function advanceToLastStep() {
  const { total } = await wizardState();
  for (let step = 1; step < total; step += 1) {
    await clickNext();
    await waitFor(
      (want) =>
        Number(
          document
            .querySelector("#setup-wizard .wizard-progress")
            .getAttribute("aria-valuenow"),
        ) === want,
      `wizard did not reach step ${step + 1}`,
      5_000,
      step + 1,
    );
  }
}

async function chooseWizardTheme(value) {
  await browser.execute((theme) => {
    const radio = document.querySelector(
      `input[name="wizard-theme"][value="${theme}"]`,
    );
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

// Escape in the wizard opens the skip prompt; the button then starts a skip.
async function skipThroughPrompt() {
  await browser.execute(() => {
    document.getElementById("setup-wizard").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await waitForModal(true);
  await clickModalButton("Skip setup");
  await waitForModal(false);
}

async function waitForWizardClosed() {
  await waitFor(
    () =>
      !document.getElementById("setup-wizard")?.classList.contains("active"),
    "setup wizard did not close",
  );
}

describe("ROSI settings drain, close save error, and wizard skip", () => {
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

  it("reports a failed drain from the save that failed, not an earlier code", async () =>
    scenario("drain-ignores-stale-error-code", [1, 2, 3, 4, 5, 17], async () =>
      withStubs(async () => {
        // A thrown save with a stale NEWER_VERSION code must still fail.
        await setErrorCode("NEWER_VERSION");
        await setAuditMode("saveMode", "throw");
        const thrown = await persistNow();
        assert.equal(thrown.saved, false, "a thrown save reported success");
        assert.equal(thrown.code, null, "a thrown save kept a stale code");
        assert.equal(thrown.feedback, "error", "no save error is shown");
        const logs = await auditValue("logs");
        assert.ok(
          logs.some((line) => /settings save/i.test(line)),
          `the thrown save was not logged: ${JSON.stringify(logs)}`,
        );

        // A refusal with a new code replaces the old code.
        await setErrorCode("NEWER_VERSION");
        await setAuditMode("saveMode", "ioError");
        const refused = await persistNow();
        assert.equal(refused.saved, false);
        assert.equal(refused.code, "IO_ERROR");

        // A real newer-version refusal still counts as preserved.
        await setAuditMode("saveMode", "newer");
        const preserved = await persistNow();
        assert.equal(preserved.saved, true, "NEWER_VERSION is not preserved");
        assert.equal(preserved.code, "NEWER_VERSION");

        // A later success clears the code.
        await setAuditMode("saveMode", "pass");
        const passed = await persistNow();
        assert.equal(passed.saved, true);
        assert.equal(passed.code, null);
        return {
          thrown,
          refused,
          preserved,
          passed,
          loggedLines: logs.length,
        };
      }),
    ));

  it("shows the save error at close at once and keeps the close handshake", async () =>
    scenario(
      "close-save-failure-toast-and-handshake",
      [6, 7, 8, 9, 10, 17],
      async () =>
        withStubs(async () => {
          await watchClose();

          // Failed final save: a toast, no acknowledgement.
          await setAuditMode("saveMode", "ioError");
          await requestClose();
          await browser.waitUntil(
            async () => (await auditValue("cancelResults")).length === 1,
            {
              timeout: 10_000,
              interval: 100,
              timeoutMsg: "no close save error toast appeared",
            },
          );
          const failed = await browser.execute(() => ({
            cancel: window.__closeAudit.cancelResults[0],
            toasts: [...window.__closeAudit.toasts],
            notifyCalls: [...window.__closeAudit.notifyCalls],
            generations: [...window.__closeAudit.generations],
          }));
          assert.equal(
            failed.cancel.ok,
            true,
            `the toast came after the backend timeout: ${failed.cancel.error}`,
          );
          assert.ok(
            failed.toasts.some((text) => /E2E disk full/.test(text)),
            `the toast has no backend detail: ${JSON.stringify(failed.toasts)}`,
          );
          assert.deepEqual(
            failed.notifyCalls,
            [],
            "a failed save still acknowledged the close",
          );

          // Successful final save: one acknowledgement, no failure toast.
          await resetCloseRecord();
          await setAuditMode("saveMode", "pass");
          await setAuditMode("cancelOnNotify", true);
          await requestClose();
          await browser.waitUntil(
            async () => (await auditValue("notifyResults")).length === 1,
            {
              timeout: 10_000,
              interval: 100,
              timeoutMsg: "a successful save did not acknowledge the close",
            },
          );
          const passed = await browser.execute(() => ({
            notifyCalls: [...window.__closeAudit.notifyCalls],
            notifyResults: [...window.__closeAudit.notifyResults],
            generations: [...window.__closeAudit.generations],
            toasts: [...window.__closeAudit.toasts],
          }));
          assert.equal(passed.notifyCalls.length, 1);
          assert.equal(passed.notifyCalls[0], passed.generations[0]);
          assert.equal(passed.notifyResults[0].ok, true);
          assert.ok(
            !passed.toasts.some((text) => /could not be saved/i.test(text)),
            "a successful save showed a failure toast",
          );

          // A newer ROSI settings file keeps closing, with no failure toast.
          await resetCloseRecord();
          await setAuditMode("saveMode", "newer");
          await requestClose();
          await browser.waitUntil(
            async () => (await auditValue("notifyResults")).length === 1,
            {
              timeout: 10_000,
              interval: 100,
              timeoutMsg: "a newer-version file blocked the close",
            },
          );
          const newer = await browser.execute(() => ({
            notifyCalls: [...window.__closeAudit.notifyCalls],
            generations: [...window.__closeAudit.generations],
            toasts: [...window.__closeAudit.toasts],
          }));
          assert.equal(newer.notifyCalls.length, 1);
          assert.equal(newer.notifyCalls[0], newer.generations[0]);
          assert.ok(
            !newer.toasts.some((text) => /could not be saved/i.test(text)),
            "a newer-version file showed a close failure toast",
          );
          await stopWatchingClose();
          return {
            failedToasts: failed.toasts,
            failedGenerations: failed.generations,
            acknowledgedGeneration: passed.notifyCalls[0],
            newerAcknowledgedGeneration: newer.notifyCalls[0],
          };
        }),
    ));

  it("blocks Finish while a skip saves and keeps the skipped defaults", async () =>
    scenario("wizard-skip-blocks-finish", [11, 12, 16, 17], async () => {
      const defaults = (await api("getDefaultSettings")).data;
      assert.notEqual(
        defaults.theme,
        "dark",
        "the default theme must differ from dark for this check",
      );
      return withWizard(async () => {
        await chooseWizardTheme("dark");
        await advanceToLastStep();
        await setAuditMode("defaultsMode", "hold");
        await setAuditMode("saveMode", "hold");
        await skipThroughPrompt();
        await browser.waitUntil(
          async () => (await auditValue("defaultsCalls")) === 1,
          {
            timeout: 10_000,
            interval: 100,
            timeoutMsg: "the skip never requested the defaults",
          },
        );

        const during = await wizardState();
        assert.equal(during.nextDisabled, true, "Finish stayed enabled");
        assert.equal(during.backDisabled, true, "Back stayed enabled");
        assert.equal(during.skipDisabled, true, "Skip stayed enabled");
        await clickNext();
        assert.equal(
          await auditValue("saveCalls"),
          0,
          "Finish saved while the skip was loading defaults",
        );

        await browser.execute(() => {
          window.__closeAudit.heldDefaults.forEach((release) => release());
        });
        await browser.waitUntil(
          async () => (await auditValue("heldSaves")).length === 1,
          {
            timeout: 10_000,
            interval: 100,
            timeoutMsg: "the skip never reached its save",
          },
        );
        await clickNext();
        assert.equal(
          await auditValue("saveCalls"),
          1,
          "Finish started a second save during the skip",
        );
        await setAuditMode("saveMode", "pass");
        await browser.execute(() => {
          window.__closeAudit.heldSaves.forEach((release) => release());
        });
        await waitForWizardClosed();

        const stored = await api("getSettings");
        assert.equal(
          stored.theme,
          defaults.theme,
          "the saved theme is not the skipped default",
        );
        assert.equal(stored.firstLaunch, false, "firstLaunch stayed true");
        const inMemory = await browser.execute(
          () =>
            window.__ROSI_E2E__.modules.settings.settingsStore.settings.theme,
        );
        assert.equal(
          inMemory,
          defaults.theme,
          "memory and disk disagree after the skip",
        );
        return { defaultTheme: defaults.theme, storedTheme: stored.theme };
      });
    }));

  it("blocks Skip while a finish saves", async () =>
    scenario("wizard-finish-blocks-skip", [13, 17], async () =>
      withWizard(async () => {
        await chooseWizardTheme("dark");
        await advanceToLastStep();
        await setAuditMode("saveMode", "hold");
        await clickNext();
        await browser.waitUntil(
          async () => (await auditValue("heldSaves")).length === 1,
          {
            timeout: 10_000,
            interval: 100,
            timeoutMsg: "Finish never reached its save",
          },
        );
        await skipThroughPrompt();
        assert.equal(
          await auditValue("defaultsCalls"),
          0,
          "Skip loaded the defaults while Finish was saving",
        );
        await setAuditMode("saveMode", "pass");
        await browser.execute(() => {
          window.__closeAudit.heldSaves.forEach((release) => release());
        });
        await waitForWizardClosed();
        const stored = await api("getSettings");
        assert.equal(stored.theme, "dark", "Finish did not keep the choice");
        return { storedTheme: stored.theme };
      }),
    ));

  it("restores the wizard controls when the skip fails", async () =>
    scenario("wizard-skip-failure-restores-controls", [14, 15, 17], async () =>
      withWizard(async () => {
        // The defaults load fails: nothing was skipped.
        await setAuditMode("defaultsMode", "fail");
        await browser.execute(() =>
          document.getElementById("wizard-skip").click(),
        );
        await waitFor(() => {
          const error = document.getElementById("wizard-error");
          return !error.hidden && /default settings/i.test(error.textContent);
        }, "a failed defaults load showed no error");
        const afterDefaults = await wizardState();
        assert.equal(afterDefaults.nextDisabled, false, "Next stayed locked");
        assert.equal(afterDefaults.skipDisabled, false, "Skip stayed locked");

        // The save fails: the controls come back and Next still works.
        await setAuditMode("defaultsMode", "pass");
        await setAuditMode("saveMode", "ioError");
        await browser.execute(() =>
          document.getElementById("wizard-skip").click(),
        );
        await waitFor(() => {
          const error = document.getElementById("wizard-error");
          return !error.hidden && /save setup/i.test(error.textContent);
        }, "a failed skip save showed no error");
        const afterSave = await wizardState();
        assert.equal(
          afterSave.active,
          true,
          "the wizard closed on a failed save",
        );
        assert.equal(afterSave.nextDisabled, false, "Next stayed locked");
        assert.equal(afterSave.skipDisabled, false, "Skip stayed locked");
        await clickNext();
        await waitFor(
          () =>
            Number(
              document
                .querySelector("#setup-wizard .wizard-progress")
                .getAttribute("aria-valuenow"),
            ) === 2,
          "Next did not advance after the failed skip",
          5_000,
        );
        return {
          afterDefaults: afterDefaults.errorText,
          afterSave: afterSave.errorText,
        };
      }),
    ));
});
