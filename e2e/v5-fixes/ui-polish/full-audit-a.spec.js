import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";
import { REPO_ROOT } from "../../helpers/profile.js";

// Rows are numbered in full-audit-a.failure-modes.md. Each check lists the rows it covers.

const PREVIEW_URL = "https://example.com/full-audit-a";
const OPENER_ID = "full-audit-a-opener";
const SETTING_KEYS = [
  "convertEnabled",
  "gpuAcceleration",
  "keepOriginalAfterConvert",
];
const SAVE_FAILED = {
  ok: false,
  error: { code: "INTERNAL_ERROR", message: "full-audit-a save failure" },
};
const CANCEL_TEXT_FAILURE = {
  ok: false,
  error: {
    code: "INTERNAL_ERROR",
    message: "Could not cancel the metadata request",
  },
};
const NOT_AVAILABLE_FAILURE = {
  ok: false,
  error: { code: "NOT_AVAILABLE", message: "Preview was cancelled" },
};

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-full-audit-a-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-full-audit-a",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  runtime: { node: process.version },
  source: null,
  checks: [],
};

// Starting values, read from the backend before any check changes them.
let startSettings = null;
let startUrl = "";

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
// full-audit-a.failure-modes.md that the case exercises.
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

const settle = (ms) => browser.pause(ms);

// Reads `read()` every 100 ms until `done` accepts the value or the timeout ends.
// Returns the last value, so a failed assertion reports what was actually seen.
async function settled(read, done, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  let last = await read();
  while (!done(last) && Date.now() < deadline) {
    await browser.pause(100);
    last = await read();
  }
  return last;
}

async function waitForBackendSetting(key, value, message) {
  await browser.waitUntil(
    async () => (await api("getSettings"))[key] === value,
    { timeout: 10_000, interval: 150, timeoutMsg: message },
  );
}

async function setControl(id, value) {
  await browser.execute(
    (target, next) => {
      const control = document.getElementById(target);
      if (!control) throw new Error(`missing control ${target}`);
      if (control.type === "checkbox") control.checked = Boolean(next);
      else control.value = String(next);
      control.dispatchEvent(new Event("change", { bubbles: true }));
    },
    id,
    value,
  );
}

// Puts the three convert-related toggles back to the values read in before().
// Convert goes first: turning it off sets keepOriginalAfterConvert itself.
async function restoreStartSettings() {
  if (!startSettings) return;
  await setControl("convertToggle", startSettings.convertEnabled);
  await setControl("gpuAccelerationToggle", startSettings.gpuAcceleration);
  await setControl(
    "keepOriginalToggle",
    startSettings.keepOriginalAfterConvert,
  );
  for (const key of SETTING_KEYS) {
    await waitForBackendSetting(
      key,
      startSettings[key],
      `backend ${key} was not restored`,
    );
  }
}

// Replaces one bridge method with a recorder. The renderer calls the bridge at
// call time, so the stub is seen by every caller. With `hold`, each call waits
// until releaseHeld() settles it with `value`.
async function stubBridge(name, value, hold = false) {
  await browser.execute(
    (target, result, holdCalls) => {
      const bridge = window.__ROSI_E2E__.api;
      const state = (window.__fullAuditA ??= {
        originals: {},
        calls: {},
        held: [],
        stubInstalled: false,
        registryCreated: false,
      });
      if (!(target in state.originals)) {
        state.originals[target] = bridge[target];
      }
      state.calls[target] = [];
      const stub = (...args) => {
        state.calls[target].push(JSON.parse(JSON.stringify(args)));
        if (!holdCalls) return Promise.resolve(result);
        return new Promise((resolve) => state.held.push(() => resolve(result)));
      };
      stub.fullAuditStub = true;
      bridge[target] = stub;
    },
    name,
    value,
    hold,
  );
}

async function releaseHeld() {
  return browser.execute(() => {
    const pending = window.__fullAuditA?.held.splice(0) ?? [];
    pending.forEach((release) => release());
    return pending.length;
  });
}

async function restoreBridge() {
  await browser.execute(() => {
    const state = window.__fullAuditA;
    if (!state) return;
    // Settle held calls first, so no save is left waiting on a stub.
    state.held.splice(0).forEach((release) => release());
    for (const [name, original] of Object.entries(state.originals)) {
      window.__ROSI_E2E__.api[name] = original;
    }
    state.originals = {};
  });
}

async function callCount(name) {
  return browser.execute(
    (target) => window.__fullAuditA?.calls?.[target]?.length ?? 0,
    name,
  );
}

// Adds a recorder for install_update to the E2E command registry. The stub never
// calls next(), so no real install runs.
async function installInstallStub() {
  await browser.execute(() => {
    const state = (window.__fullAuditA ??= {
      originals: {},
      calls: {},
      held: [],
      stubInstalled: false,
      registryCreated: false,
    });
    if (!state.stubInstalled) {
      state.registryCreated = !window.__ROSI_E2E_IPC_STUBS__;
      state.stubInstalled = true;
    }
    window.__ROSI_E2E_IPC_STUBS__ ??= {};
    state.calls.install_update = [];
    const stub = (args) => {
      state.calls.install_update.push(args ?? null);
      return Promise.resolve(undefined);
    };
    stub.fullAuditStub = true;
    window.__ROSI_E2E_IPC_STUBS__.install_update = stub;
  });
}

async function removeInstallStub() {
  await browser.execute(() => {
    const state = window.__fullAuditA;
    const registry = window.__ROSI_E2E_IPC_STUBS__;
    if (registry?.install_update?.fullAuditStub) {
      delete registry.install_update;
    }
    // Remove the registry only if this spec created it and nothing else is in it.
    if (
      state?.registryCreated &&
      registry &&
      Object.keys(registry).length === 0
    ) {
      delete window.__ROSI_E2E_IPC_STUBS__;
    }
    if (state) {
      state.stubInstalled = false;
      state.registryCreated = false;
    }
  });
}

// A body-level button gives the licenses overlay a focus target that is outside
// the inert main content. It is removed after each check that uses it.
async function addOpener() {
  return browser.execute((id) => {
    document.getElementById(id)?.remove();
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.textContent = "Full audit opener";
    document.body.appendChild(button);
    button.focus();
    return document.activeElement?.id ?? null;
  }, OPENER_ID);
}

async function removeOpener() {
  await browser.execute(
    (id) => document.getElementById(id)?.remove(),
    OPENER_ID,
  );
}

async function licensesState() {
  return browser.execute(() => {
    const overlay = document.getElementById("licenses-overlay");
    return {
      active: overlay.classList.contains("active"),
      activeId: document.activeElement?.id ?? null,
      previousId:
        window.__ROSI_E2E__.modules.overlays.licensesPreviousFocus?.id ?? null,
    };
  });
}

async function closeLicensesIfOpen() {
  await browser.execute(() => {
    if (
      document.getElementById("licenses-overlay").classList.contains("active")
    ) {
      window.__ROSI_E2E__.modules.overlays.hideLicenses();
    }
  });
}

async function modalState() {
  return browser.execute(() => {
    const overlays = window.__ROSI_E2E__.modules.overlays;
    const modal = document.getElementById("app-modal");
    return {
      active: modal.classList.contains("active"),
      hiding: modal.classList.contains("hiding"),
      title: document.getElementById("modal-title").textContent,
      currentKey: overlays.currentModalData?.key ?? null,
      queuedKeys: overlays.modalQueue.map((data) => data.key ?? null),
      buttons: [...document.querySelectorAll("#modal-buttons button")].map(
        (button) => button.textContent.trim(),
      ),
      saveInFlight:
        window.__ROSI_E2E__.modules.settings.settingsStore.settingsSaveInFlight,
    };
  });
}

async function clickModalButton(label) {
  await browser.execute((text) => {
    const button = [...document.querySelectorAll("#modal-buttons button")].find(
      (node) => node.textContent.trim() === text,
    );
    if (!button) throw new Error(`no modal button labelled ${text}`);
    button.click();
  }, label);
}

// Updater rows emit real updater-status events, which the listener in
// updater-ui.ts handles. Mirrors emitUpdaterStatus in dialogs.spec.js.
async function emitUpdaterStatus(payload) {
  const result = await browser.executeAsync((event, done) => {
    window.__TAURI__.event.emit("updater-status", event).then(
      () => done(true),
      (error) => done(String(error)),
    );
  }, payload);
  assert.equal(result, true, "updater-status event was not emitted");
}

function downloadedStatus(candidateId, version) {
  return { status: "downloaded", candidateId, version };
}

async function setPreviewUrl(value) {
  await browser.execute((text) => {
    const input = document.getElementById("url");
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function previewSnapshot() {
  return browser.execute(() => {
    const card = document.getElementById("preview-card");
    return {
      toasts: [...document.querySelectorAll(".toast .toast-message")].map(
        (node) => node.textContent ?? "",
      ),
      visible: card.classList.contains("visible"),
      loading: card.classList.contains("loading"),
    };
  });
}

async function clickPreview() {
  await browser.execute(() => {
    const button = document.getElementById("previewBtn");
    if (!button || button.disabled) throw new Error("preview button not ready");
    button.click();
  });
}

async function clearToasts() {
  await browser.execute(() =>
    document.querySelectorAll(".toast").forEach((node) => node.remove()),
  );
}

describe("ROSI full audit A: licenses reopen, GPU select, update prompt, preview cancel", () => {
  before(async () => {
    await waitForAppReady();
    report.source = sourceIdentity();
    const backend = await api("getSettings");
    startSettings = Object.fromEntries(
      SETTING_KEYS.map((key) => [key, backend[key]]),
    );
    startUrl = await browser.execute(
      () => document.getElementById("url")?.value ?? "",
    );
    writeReport();
  });

  after(async () => {
    await closeLicensesIfOpen();
    await restoreBridge();
    await removeInstallStub();
    await removeOpener();
    await clearToasts();
    // The value only, with no input event: a valid start URL must not start a
    // preview fetch while the spec is tearing down.
    await browser.execute((text) => {
      document.getElementById("url").value = text;
    }, startUrl);
    await restoreStartSettings();
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

  // U1: showLicenses is idempotent while the overlay is open.
  it("U1 reopening licenses keeps the original opener", async () =>
    scenario("licenses-reopen-keeps-opener", [1, 2, 3, 4], async () => {
      const opener = await addOpener();
      assert.equal(opener, OPENER_ID, "opener did not take focus");
      try {
        await browser.execute(() =>
          window.__ROSI_E2E__.modules.overlays.showLicenses(),
        );
        const first = await settled(
          licensesState,
          (state) => state.activeId === "close-licenses",
        );
        assert.equal(
          first.activeId,
          "close-licenses",
          `first open focused ${first.activeId}, not the close button`,
        );
        assert.equal(first.previousId, OPENER_ID, "first open lost the opener");

        // The menu item pressed again while the overlay is open.
        await browser.execute(() =>
          window.__ROSI_E2E__.modules.overlays.showLicenses(),
        );
        await settle(200);
        const reopened = await licensesState();
        assert.equal(reopened.active, true, "overlay closed on reopen");
        assert.equal(
          reopened.previousId,
          OPENER_ID,
          `second open replaced the opener with ${reopened.previousId}`,
        );
        assert.equal(
          reopened.activeId,
          "close-licenses",
          `second open moved focus to ${reopened.activeId}`,
        );

        // One Escape closes the overlay and returns focus to the opener.
        await browser.execute(() => {
          document.getElementById("licenses-overlay").dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        const closed = await settled(
          licensesState,
          (state) => !state.active && state.activeId === OPENER_ID,
        );
        assert.equal(closed.active, false, "Escape did not close licenses");
        assert.equal(
          closed.activeId,
          OPENER_ID,
          `focus after close went to ${closed.activeId}, not the opener`,
        );

        // A later open after a close works as on the first open.
        await browser.execute(() =>
          window.__ROSI_E2E__.modules.overlays.showLicenses(),
        );
        const again = await settled(
          licensesState,
          (state) => state.active && state.activeId === "close-licenses",
        );
        assert.equal(
          again.activeId,
          "close-licenses",
          `open after a close focused ${again.activeId}`,
        );
        return { firstOpen: first, reopened, closed, reopenAfterClose: again };
      } finally {
        await closeLicensesIfOpen();
        await removeOpener();
      }
    }));

  // U2: the GPU select follows gpuAcceleration when Convert is turned back on.
  it("U2 Convert back on shows the GPU select when GPU acceleration is on", async () =>
    scenario("convert-restores-gpu-type", [5, 6, 7, 8, 9], async () => {
      const convertState = () =>
        browser.execute(() => {
          const store =
            window.__ROSI_E2E__.modules.settings.settingsStore.settings;
          return {
            gpuVisible: document
              .getElementById("gpuTypeContainer")
              .classList.contains("visible"),
            gpuAcceleration: store.gpuAcceleration,
            convertEnabled: store.convertEnabled,
          };
        });
      try {
        // GPU on: Convert off hides the select, Convert on shows it again.
        await setControl("gpuAccelerationToggle", true);
        await setControl("convertToggle", true);
        const beforeCycle = await convertState();
        assert.equal(
          beforeCycle.gpuVisible,
          true,
          "GPU select not shown with Convert on",
        );
        await setControl("convertToggle", false);
        const convertOff = await convertState();
        assert.equal(
          convertOff.gpuVisible,
          false,
          "GPU select shown with Convert off",
        );
        await setControl("convertToggle", true);
        const convertBackOn = await convertState();
        assert.equal(
          convertBackOn.gpuVisible,
          true,
          `GPU select hidden after Convert back on (gpuAcceleration ${convertBackOn.gpuAcceleration})`,
        );
        assert.equal(
          convertBackOn.gpuAcceleration,
          beforeCycle.gpuAcceleration,
          "Convert changed the GPU acceleration setting",
        );

        // GPU off: Convert back on must leave the select hidden.
        await setControl("gpuAccelerationToggle", false);
        await setControl("convertToggle", false);
        await setControl("convertToggle", true);
        const gpuOff = await convertState();
        assert.equal(
          gpuOff.gpuVisible,
          false,
          "GPU select shown with GPU acceleration off",
        );
        assert.equal(
          gpuOff.gpuAcceleration,
          false,
          "GPU acceleration changed to on",
        );
        return { beforeCycle, convertOff, convertBackOn, gpuOff };
      } finally {
        await restoreStartSettings();
      }
    }));

  // U4: a failed restart flush must offer the Update Ready prompt again.
  it("U4 a failed restart flush offers Update Ready again", async () =>
    scenario(
      "update-ready-reoffered-after-failed-flush",
      [10, 11, 12],
      async () => {
        await stubBridge("saveSettings", SAVE_FAILED);
        await installInstallStub();
        try {
          await emitUpdaterStatus(downloadedStatus(9301, "9.3.1"));
          const shown = await settled(
            modalState,
            (state) => state.active && state.title === "Update Ready!",
          );
          assert.equal(shown.active, true, "Update Ready prompt did not show");
          await clickModalButton("Restart Now");
          const reoffered = await settled(
            modalState,
            (state) =>
              state.active &&
              !state.hiding &&
              state.currentKey === "updater-downloaded",
            10_000,
          );
          assert.equal(
            reoffered.currentKey,
            "updater-downloaded",
            `Update Ready was not offered again (title ${reoffered.title})`,
          );
          assert.equal(reoffered.title, "Update Ready!");
          assert.deepEqual(reoffered.buttons, ["Restart Now", "Later"]);
          assert.ok(
            (await callCount("saveSettings")) >= 1,
            "the flush never saved",
          );
          assert.equal(
            await callCount("install_update"),
            0,
            "install_update ran after a failed flush",
          );
          // The re-offered prompt uses the same key, so a later status retires it.
          await emitUpdaterStatus({ status: "checking" });
          const retired = await settled(
            modalState,
            (state) =>
              state.currentKey === null &&
              !state.queuedKeys.includes("updater-downloaded"),
          );
          assert.equal(
            retired.currentKey,
            null,
            "a checking status did not retire the re-offered prompt",
          );
          return { reoffered, retired };
        } finally {
          await emitUpdaterStatus({ status: "checking" });
          await removeInstallStub();
          await restoreBridge();
        }
      },
    ));

  it("U4 a status change during the flush stops the re-offer", async () =>
    scenario(
      "update-ready-not-reoffered-for-stale-candidate",
      [13],
      async () => {
        await stubBridge("saveSettings", SAVE_FAILED, true);
        await installInstallStub();
        try {
          await emitUpdaterStatus(downloadedStatus(9302, "9.3.2"));
          await settled(
            modalState,
            (state) => state.active && state.title === "Update Ready!",
          );
          await clickModalButton("Restart Now");
          const held = await settled(
            () => callCount("saveSettings"),
            (count) => count >= 1,
          );
          assert.ok(held >= 1, "the flush never reached the save");
          // A checking status clears the candidate the held flush would return to.
          await emitUpdaterStatus({ status: "checking" });
          const released = await releaseHeld();
          assert.equal(released, 1, "no held save was released");
          const flushed = await settled(
            modalState,
            (state) => !state.saveInFlight,
            10_000,
          );
          assert.equal(
            flushed.saveInFlight,
            false,
            "the held flush never finished",
          );
          await settle(600);
          const after = await modalState();
          const offered =
            after.currentKey === "updater-downloaded" ||
            after.queuedKeys.includes("updater-downloaded");
          assert.equal(
            offered,
            false,
            "a prompt for a replaced candidate was offered again",
          );
          assert.equal(
            await callCount("install_update"),
            0,
            "install_update ran for a replaced candidate",
          );
          return { after };
        } finally {
          await releaseHeld();
          await emitUpdaterStatus({ status: "checking" });
          await removeInstallStub();
          await restoreBridge();
        }
      },
    ));

  it("U4 a successful restart flush installs the update once", async () =>
    scenario("update-ready-restart-installs", [14], async () => {
      await installInstallStub();
      try {
        await emitUpdaterStatus(downloadedStatus(9303, "9.3.3"));
        await settled(
          modalState,
          (state) => state.active && state.title === "Update Ready!",
        );
        await clickModalButton("Restart Now");
        const calls = await settled(
          () => callCount("install_update"),
          (count) => count >= 1,
          10_000,
        );
        assert.equal(calls, 1, "install_update was not called exactly once");
        const args = await browser.execute(
          () => window.__fullAuditA.calls.install_update[0],
        );
        assert.deepEqual(args, { candidateId: 9303 });
        await settle(600);
        const after = await modalState();
        assert.notEqual(
          after.currentKey,
          "updater-downloaded",
          "Update Ready was shown again after a successful install",
        );
        return { installArgs: args };
      } finally {
        await emitUpdaterStatus({ status: "checking" });
        await removeInstallStub();
      }
    }));

  // C3 (renderer): only NOT_AVAILABLE is a cancel.
  it("C3 a failure whose message mentions cancel still shows the error", async () =>
    scenario(
      "preview-failure-containing-cancel-shows-error",
      [17],
      async () => {
        await stubBridge("getVideoInfo", CANCEL_TEXT_FAILURE);
        try {
          await setPreviewUrl(PREVIEW_URL);
          // Let the debounced automatic preview finish before the manual one.
          await settle(1_000);
          await clearToasts();
          await clickPreview();
          const seen = await settled(
            previewSnapshot,
            (state) =>
              state.toasts.some((text) =>
                text.startsWith("Could not load preview."),
              ),
            10_000,
          );
          assert.ok(
            seen.toasts.some((text) =>
              text.includes("Could not cancel the metadata request"),
            ),
            `no failure toast; toasts: ${JSON.stringify(seen.toasts)}`,
          );
          assert.equal(seen.loading, false, "preview card is still loading");
          assert.equal(seen.visible, false, "preview card is still visible");
          return { toasts: seen.toasts };
        } finally {
          await restoreBridge();
          await clearToasts();
        }
      },
    ));

  it("C3 a NOT_AVAILABLE cancel stays silent", async () =>
    scenario("preview-not-available-stays-silent", [18], async () => {
      await stubBridge("getVideoInfo", NOT_AVAILABLE_FAILURE);
      try {
        await setPreviewUrl(PREVIEW_URL);
        await settle(1_000);
        await clearToasts();
        const before = await callCount("getVideoInfo");
        await clickPreview();
        const calls = await settled(
          () => callCount("getVideoInfo"),
          (count) => count > before,
        );
        assert.ok(
          calls > before,
          "the manual preview never called getVideoInfo",
        );
        await settle(800);
        const seen = await previewSnapshot();
        const failures = seen.toasts.filter((text) =>
          text.startsWith("Could not load preview."),
        );
        assert.deepEqual(
          failures,
          [],
          `a cancel showed a failure toast: ${JSON.stringify(failures)}`,
        );
        return { toasts: seen.toasts };
      } finally {
        await restoreBridge();
        await clearToasts();
      }
    }));

  // Shared profile: everything this spec changed is back to its start.
  it("shared state is put back", async () =>
    scenario("shared-state-restored", [9, 21], async () => {
      const state = await browser.execute(() => ({
        saveIsStub: Boolean(window.__ROSI_E2E__.api.saveSettings.fullAuditStub),
        previewIsStub: Boolean(
          window.__ROSI_E2E__.api.getVideoInfo.fullAuditStub,
        ),
        registryEntry: Boolean(window.__ROSI_E2E_IPC_STUBS__?.install_update),
        opener: Boolean(document.getElementById("full-audit-a-opener")),
        licensesActive: document
          .getElementById("licenses-overlay")
          .classList.contains("active"),
        updateReadyQueued: window.__ROSI_E2E__.modules.overlays.modalQueue.some(
          (data) => data.key === "updater-downloaded",
        ),
      }));
      assert.equal(state.saveIsStub, false, "saveSettings is still stubbed");
      assert.equal(state.previewIsStub, false, "getVideoInfo is still stubbed");
      assert.equal(state.registryEntry, false, "install_update stub remains");
      assert.equal(state.opener, false, "temporary opener remains");
      assert.equal(
        state.licensesActive,
        false,
        "licenses overlay is still open",
      );
      assert.equal(
        state.updateReadyQueued,
        false,
        "Update Ready prompt remains",
      );
      const backend = await api("getSettings");
      for (const key of SETTING_KEYS) {
        assert.equal(
          backend[key],
          startSettings[key],
          `${key} was not restored`,
        );
      }
      return { settings: startSettings, ...state };
    }));
});
