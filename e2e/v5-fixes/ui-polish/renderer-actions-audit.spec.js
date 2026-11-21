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

// Failure modes are numbered in renderer-actions-audit.failure-modes.md. Each
// check lists the rows it covers. The bridge is stubbed only on the shared
// `window.__ROSI_E2E__.api` object, and every stub is removed after each check.

const MEDIA = process.env.ROSI_E2E_MEDIA_URL;
const WAIT_TOAST = "Wait for the current download to finish first.";

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-renderer-actions-audit-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-renderer-actions-audit",
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
// hash of each untracked file.
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

async function scenario(name, failureModes, body) {
  try {
    const details = await body();
    report.checks.push({
      name,
      status: "passed",
      failureModes,
      invariantPassed: true,
      ...details,
    });
    writeReport();
  } catch (error) {
    report.checks.push({
      name,
      status: "failed",
      failureModes,
      invariantPassed: false,
      reason: error instanceof Error ? error.message : String(error),
    });
    writeReport();
    throw error;
  }
}

async function resetQueue() {
  await api("cancelQueue");
  assert.equal((await api("clearQueue")).ok, true);
}

// Text from the page can hold non-ASCII characters, which the bridge rejects.
function lastToast() {
  return browser.execute(() => {
    const text =
      [...document.querySelectorAll(".toast .toast-message")].pop()
        ?.textContent ?? "";
    return text.trim().replace(/[^\x20-\x7e]/g, "?");
  });
}

async function waitForLastToast(expected, message) {
  let text = null;
  await browser.waitUntil(
    async () => {
      text = await lastToast();
      return text === expected;
    },
    {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: `${message}: last toast was ${JSON.stringify(text)}`,
    },
  );
}

async function clearToasts() {
  await browser.execute(() => {
    document.querySelectorAll(".toast").forEach((node) => node.remove());
  });
}

// Installs page-side recorders once. `calls` holds one entry per stubbed call
// and `order` holds the stubbed calls in the order they happened.
async function installProbe() {
  await browser.execute(() => {
    window.__actionsAudit = {
      calls: {},
      order: [],
      original: {},
      held: null,
      rejections: [],
    };
    window.__actionsAuditReject = (event) =>
      window.__actionsAudit.rejections.push(String(event.reason));
    window.addEventListener("unhandledrejection", window.__actionsAuditReject);
  });
}

// Replaces one bridge method with a recorder. `how` picks the behaviour:
// "value" resolves `payload`, "throw" rejects with it, "hold" waits for
// `probe.held.release()` first, and "hold-first" holds only the first call.
// A fixed set of behaviours keeps `eval` out of the page, which its CSP blocks.
async function stubApi(name, how, payload = null) {
  await browser.execute(
    (target, mode, data) => {
      const probe = window.__actionsAudit;
      if (!(target in probe.original)) {
        probe.original[target] = window.__ROSI_E2E__.api[target];
      }
      probe.calls[target] = [];
      window.__ROSI_E2E__.api[target] = (...args) => {
        probe.calls[target].push(JSON.parse(JSON.stringify(args)));
        probe.order.push(target);
        if (mode === "throw") return Promise.reject(new Error(data));
        const holds =
          mode === "hold" ||
          (mode === "hold-first" && probe.calls[target].length === 1);
        if (!holds) return Promise.resolve(data);
        return new Promise((resolve) => {
          probe.held = { release: () => resolve(data) };
        });
      };
    },
    name,
    how,
    payload,
  );
}

// Wraps the real method so the call is recorded in order and still runs.
async function spyApi(name) {
  await browser.execute((target) => {
    const probe = window.__actionsAudit;
    if (!(target in probe.original)) {
      probe.original[target] = window.__ROSI_E2E__.api[target];
    }
    probe.calls[target] = [];
    const original = probe.original[target];
    window.__ROSI_E2E__.api[target] = (...args) => {
      probe.calls[target].push(JSON.parse(JSON.stringify(args)));
      probe.order.push(target);
      return original(...args);
    };
  }, name);
}

function probeCalls(name) {
  return browser.execute(
    (target) => window.__actionsAudit.calls[target] ?? [],
    name,
  );
}

function probeOrder() {
  return browser.execute(() => [...window.__actionsAudit.order]);
}

async function restoreProbe() {
  await browser.execute(() => {
    const probe = window.__actionsAudit;
    if (!probe) return;
    for (const [name, original] of Object.entries(probe.original)) {
      window.__ROSI_E2E__.api[name] = original;
    }
    if (probe.held) probe.held.release?.();
    window.removeEventListener(
      "unhandledrejection",
      window.__actionsAuditReject,
    );
    delete window.__actionsAuditReject;
    delete window.__actionsAudit;
  });
}

async function setAskEachTime(value) {
  await browser.execute((next) => {
    const control = document.getElementById("askDownloadLocationToggle");
    control.checked = next;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await browser.waitUntil(
    async () => (await api("getSettings")).askDownloadLocation === value,
    {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: `askDownloadLocation never saved as ${value}`,
    },
  );
}

async function downloadFolder() {
  const folder = (await api("getSettings")).downloadFolder;
  assert.ok(folder, "the test profile has no download folder");
  return folder;
}

async function typeUrl(url) {
  const input = await browser.$("#url");
  await input.setValue(url);
  await waitFor(
    () => {
      const button = document.getElementById("downloadBtn");
      return (
        Boolean(button) &&
        !button.disabled &&
        !button.classList.contains("loading")
      );
    },
    "Download button never became ready",
    15_000,
  );
}

// The page click skips real pointer movement, so no toast opens under the cursor.
async function pressDownload() {
  await browser.execute(() => document.getElementById("downloadBtn").click());
}

function downloadLoading() {
  return browser.execute(
    () =>
      document.getElementById("downloadBtn")?.classList.contains("loading") ===
      true,
  );
}

async function waitForIdleButton(message) {
  await waitFor(
    () =>
      document.getElementById("downloadBtn")?.classList.contains("loading") !==
      true,
    message,
    15_000,
  );
}

let seedEntryPromise = null;

// A finished download gives the activity row that Download again replays.
function ensureSeedEntry() {
  seedEntryPromise ??= (async () => {
    const seed = `${MEDIA}/clip-one.mp4?renderer-actions=seed`;
    const started = await api("downloadVideo", { url: seed });
    assert.equal(started.ok, true, "seed download did not start");
    let entry = null;
    await browser.waitUntil(
      async () => {
        entry =
          (await api("getDownloadActivity")).data.find(
            (candidate) =>
              candidate.url === seed && candidate.outcome === "success",
          ) ?? null;
        return Boolean(entry);
      },
      {
        timeout: 120_000,
        interval: 500,
        timeoutMsg: "seed download did not complete",
      },
    );
    return entry;
  })();
  return seedEntryPromise;
}

async function showActivityRow(entry) {
  await browser.execute(() =>
    window.__ROSI_E2E__.modules.dock.selectTab("activity"),
  );
  await waitFor(
    (id) =>
      [...document.querySelectorAll(".history-item")].some(
        (row) =>
          row.dataset.activityId === id &&
          Boolean(row.querySelector('[data-activity-action="replay"]')),
      ),
    "activity row has no Download again action",
    15_000,
    entry.id,
  );
}

async function clickReplay(entry) {
  await browser.execute((id) => {
    const row = [...document.querySelectorAll(".history-item")].find(
      (candidate) => candidate.dataset.activityId === id,
    );
    const replay = row?.querySelector('[data-activity-action="replay"]');
    if (!replay) throw new Error("seed row has no Download again action");
    replay.click();
  }, entry.id);
}

function modalSnapshot() {
  return browser.execute(() => {
    const element = document.getElementById("app-modal");
    return {
      active: element.classList.contains("active"),
      hiding: element.classList.contains("hiding"),
      title: document.getElementById("modal-title").textContent,
      message: document
        .getElementById("modal-message")
        .textContent.replace(/[^\x20-\x7e\n]/g, "?"),
      buttons: [...document.querySelectorAll("#modal-buttons button")].map(
        (button) => button.textContent.trim(),
      ),
    };
  });
}

async function closeModal(label) {
  await clickModalButton(label);
  await waitForModal(false);
}

async function emitUpdaterError(message) {
  const result = await browser.executeAsync((text, done) => {
    window.__TAURI__.event
      .emit("updater-status", {
        status: "error",
        message: text,
        kind: "download",
      })
      .then(
        () => done(true),
        (error) => done(String(error)),
      );
  }, message);
  assert.equal(result, true, "updater-status event was not emitted");
}

function presetState() {
  return browser.execute(() => {
    const presets =
      window.__ROSI_E2E__.modules.settings.settingsStore.settings
        .downloadPresets ?? [];
    return {
      storeNames: presets.map((preset) => preset.name),
      optionNames: [
        ...document.querySelectorAll("#downloadPresetSelect option"),
      ]
        .filter((option) => option.value !== "")
        .map((option) => option.textContent),
      status: (document.getElementById("presetStatus")?.textContent ?? "")
        .trim()
        .replace(/[^\x20-\x7e]/g, "?"),
    };
  });
}

async function waitForPresetStatus(expected) {
  let seen = null;
  await browser.waitUntil(
    async () => {
      seen = (await presetState()).status;
      return seen === expected;
    },
    {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: `preset status never read ${JSON.stringify(expected)}: ${JSON.stringify(seen)}`,
    },
  );
}

async function submitPresetName(name) {
  await browser.execute((text) => {
    document.getElementById("presetNameInput").value = text;
    document.getElementById("savePresetBtn").click();
  }, name);
}

const FAIL_SAVE = {
  ok: false,
  error: { code: "INTERNAL_ERROR", message: "audit stub refused the save" },
};
const REFUSED = {
  ok: false,
  error: { code: "INTERNAL_ERROR", message: "audit refusal" },
};

describe("ROSI renderer actions audit: toasts, replay, presets, links, formats", () => {
  before(async () => {
    await waitForAppReady();
    report.source = sourceIdentity();
    writeReport();
  });

  beforeEach(async () => {
    await resetQueue();
    await installProbe();
  });

  afterEach(async () => {
    await restoreProbe().catch(() => {});
    await clearToasts().catch(() => {});
    await setAskEachTime(false).catch(() => {});
    await resetQueue().catch(() => {});
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

  it("keeps an error toast on screen for the longer default", async function () {
    this.timeout(60_000);
    await scenario(
      "renderer-actions-toast-default-duration",
      [1, 2],
      async () => {
        await stubApi("downloadVideo", "value", {
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "audit toast refusal" },
        });
        await clearToasts();
        // Record when the error toast enters and leaves the page.
        await browser.execute(() => {
          const life = { added: null, removed: null };
          window.__actionsAudit.life = life;
          const isToast = (node) =>
            node instanceof HTMLElement &&
            node.classList.contains("toast-error");
          const observer = new MutationObserver((records) => {
            for (const record of records) {
              record.addedNodes.forEach((node) => {
                if (isToast(node) && life.added === null) {
                  life.added = performance.now();
                }
              });
              record.removedNodes.forEach((node) => {
                if (
                  isToast(node) &&
                  life.added !== null &&
                  life.removed === null
                ) {
                  life.removed = performance.now();
                }
              });
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
          window.__actionsAudit.stopObserver = () => observer.disconnect();
        });
        await typeUrl(`${MEDIA}/clip-one.mp4?renderer-actions=toast`);
        await pressDownload();
        await waitForLastToast(
          "audit toast refusal",
          "the refused download raised no error toast",
        );
        await browser.waitUntil(
          async () =>
            browser.execute(() => window.__actionsAudit.life.removed !== null),
          {
            timeout: 30_000,
            interval: 250,
            timeoutMsg: "the error toast never left the page",
          },
        );
        const lifetimeMs = await browser.execute(() => {
          window.__actionsAudit.stopObserver();
          const { added, removed } = window.__actionsAudit.life;
          return Math.round(removed - added);
        });
        assert.ok(
          lifetimeMs >= 6000,
          `the error toast stayed ${lifetimeMs} ms, expected at least 6000`,
        );
        return { lifetimeMs };
      },
    );
  });

  it("does not start a replay when a download began during the folder dialog", async function () {
    this.timeout(240_000);
    await scenario("renderer-actions-replay-recheck", [3], async () => {
      const entry = await ensureSeedEntry();
      const folder = await downloadFolder();
      await showActivityRow(entry);
      await setAskEachTime(true);
      // The first dialog call is held open. Later calls answer at once.
      await stubApi("selectDownloadLocation", "hold-first", folder);
      await stubApi("downloadVideo", "value", {
        ok: true,
        data: { started: true, sessionId: 424242 },
      });

      await clickReplay(entry);
      await browser.waitUntil(
        async () => (await probeCalls("selectDownloadLocation")).length === 1,
        {
          timeout: 10_000,
          interval: 50,
          timeoutMsg: "the replay never opened the folder dialog",
        },
      );

      // A manual download starts while the replay waits on the dialog.
      await typeUrl(`${MEDIA}/clip-one.mp4?renderer-actions=recheck`);
      await pressDownload();
      await browser.waitUntil(
        async () =>
          (await probeCalls("downloadVideo")).length === 1 &&
          (await downloadLoading()),
        {
          timeout: 15_000,
          interval: 100,
          timeoutMsg: "the manual download never reached its running state",
        },
      );
      await clearToasts();

      // The dialog now returns to the waiting replay.
      await browser.execute(() => window.__actionsAudit.held.release());
      await waitForLastToast(
        WAIT_TOAST,
        "the late replay was not refused with the wait warning",
      );
      const requests = await probeCalls("downloadVideo");
      assert.equal(
        requests.length,
        1,
        "the late replay sent a second download request",
      );
      assert.equal(
        await downloadLoading(),
        true,
        "the running download lost its loading state",
      );

      // Stop the stand-in download through the Cancel control.
      await browser.execute(() =>
        document.getElementById("downloadBtn").click(),
      );
      await waitForIdleButton("the Cancel control did not end the download");
      return { requestsAfterRelease: requests.length };
    });
  });

  it("reports a failing folder dialog and starts nothing", async function () {
    this.timeout(240_000);
    await scenario("renderer-actions-replay-dialog-failure", [4], async () => {
      const entry = await ensureSeedEntry();
      await showActivityRow(entry);
      await setAskEachTime(true);
      await stubApi("selectDownloadLocation", "throw", "audit dialog failure");
      await stubApi("downloadVideo", "value", REFUSED);
      await clearToasts();
      await clickReplay(entry);
      await waitForLastToast(
        "Could not open the save location dialog. Please try again.",
        "a failing folder dialog showed no error toast",
      );
      assert.equal(
        (await probeCalls("downloadVideo")).length,
        0,
        "a failing folder dialog still sent a request",
      );
      assert.equal(
        await downloadLoading(),
        false,
        "a failing folder dialog left the button loading",
      );
      const rejections = await browser.execute(
        () => window.__actionsAudit.rejections,
      );
      assert.deepEqual(rejections, [], "the failing dialog was unhandled");
      return { unhandledRejections: rejections.length };
    });
  });

  it("asks for a folder only when the setting says so and flushes settings first", async function () {
    this.timeout(240_000);
    await scenario(
      "renderer-actions-replay-ask-setting",
      [5, 6, 7],
      async () => {
        const entry = await ensureSeedEntry();
        const folder = await downloadFolder();
        await showActivityRow(entry);

        // Ask every time off: no dialog, settings saved before the request.
        // Start from Ask on (saved), then turn it off without waiting for the
        // save, so the replay runs while that change is still pending.
        await setAskEachTime(true);
        await stubApi("selectDownloadLocation", "value", folder);
        await spyApi("saveSettings");
        await stubApi("downloadVideo", "value", REFUSED);
        await browser.execute(() => {
          const control = document.getElementById("askDownloadLocationToggle");
          control.checked = false;
          control.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await clickReplay(entry);
        await browser.waitUntil(
          async () => (await probeCalls("downloadVideo")).length === 1,
          {
            timeout: 15_000,
            interval: 100,
            timeoutMsg: "the replay with Ask off never sent its request",
          },
        );
        assert.equal(
          (await probeCalls("selectDownloadLocation")).length,
          0,
          "the replay asked for a folder with Ask every time off",
        );
        const order = await probeOrder();
        const saves = await probeCalls("saveSettings");
        const pendingSave = saves.findIndex(
          ([patch]) => patch?.askDownloadLocation === false,
        );
        assert.notEqual(
          pendingSave,
          -1,
          "the pending Ask change was never saved",
        );
        // The pending save is the Nth saveSettings in the order list, N = its index in calls.
        const saveSlots = order.flatMap((name, slot) =>
          name === "saveSettings" ? [slot] : [],
        );
        const pendingAt = saveSlots[pendingSave] ?? -1;
        assert.ok(
          pendingAt !== -1 && pendingAt < order.indexOf("downloadVideo"),
          `settings were not saved before the request: ${order.join(",")}`,
        );
        await waitForIdleButton("the refused replay left the button loading");

        // Ask every time on: one dialog, and its folder is the destination.
        await setAskEachTime(true);
        await stubApi("selectDownloadLocation", "value", folder);
        await stubApi("downloadVideo", "value", REFUSED);
        await clickReplay(entry);
        await browser.waitUntil(
          async () => (await probeCalls("downloadVideo")).length === 1,
          {
            timeout: 15_000,
            interval: 100,
            timeoutMsg: "the replay with Ask on never sent its request",
          },
        );
        assert.equal(
          (await probeCalls("selectDownloadLocation")).length,
          1,
          "the replay did not ask once with Ask every time on",
        );
        const [[askedRequest]] = await probeCalls("downloadVideo");
        assert.equal(
          askedRequest.outputPath,
          folder,
          "the request did not use the chosen folder",
        );
        await waitForIdleButton("the refused replay left the button loading");

        // A cancelled dialog starts nothing. The cancelled run is followed by a
        // second replay that does reach the dialog; the only downloadVideo call
        // recorded must be that second one, so the cancelled run sent nothing.
        await stubApi("selectDownloadLocation", "value", null);
        await stubApi("downloadVideo", "value", REFUSED);
        await clickReplay(entry);
        await browser.waitUntil(
          async () => (await probeCalls("selectDownloadLocation")).length === 1,
          {
            timeout: 10_000,
            interval: 50,
            timeoutMsg: "the cancelled replay never opened the dialog",
          },
        );
        await waitForIdleButton("the cancelled replay left the button loading");
        assert.equal(
          await downloadLoading(),
          false,
          "a cancelled dialog left the button loading",
        );
        await stubApi("selectDownloadLocation", "value", folder);
        await clickReplay(entry);
        await browser.waitUntil(
          async () => (await probeCalls("selectDownloadLocation")).length === 1,
          {
            timeout: 10_000,
            interval: 50,
            timeoutMsg: "the second replay never opened the dialog",
          },
        );
        await browser.waitUntil(
          async () => (await probeCalls("downloadVideo")).length >= 1,
          {
            timeout: 15_000,
            interval: 100,
            timeoutMsg: "the second replay never sent its request",
          },
        );
        const requests = await probeCalls("downloadVideo");
        assert.equal(
          requests.length,
          1,
          `expected exactly one request after the cancelled dialog, got ${requests.length}`,
        );
        assert.equal(
          requests[0][0].outputPath,
          folder,
          "the one request is not the second replay",
        );
        await waitForIdleButton("the second replay left the button loading");
        return { orderBeforeRequest: order.slice(0, 2), askedFolder: folder };
      },
    );
  });

  it("shows the same activity list after a reload", async function () {
    this.timeout(180_000);
    await scenario("renderer-actions-activity-startup", [8], async () => {
      const entry = await ensureSeedEntry();
      await reloadRenderer();
      await installProbe();
      await showActivityRow(entry);
      const backendIds = (await api("getDownloadActivity")).data
        .map((item) => item.id)
        .sort();
      assert.ok(
        backendIds.length >= 1,
        "the backend has no activity to compare",
      );
      const shownIds = () =>
        browser.execute(() =>
          [...document.querySelectorAll(".history-item")]
            .map((row) => row.dataset.activityId)
            .sort(),
        );
      // The startup read can land a moment after the row appears, so wait for
      // the list to match the backend before comparing.
      await browser.waitUntil(
        async () =>
          JSON.stringify(await shownIds()) === JSON.stringify(backendIds),
        {
          timeout: 10_000,
          interval: 100,
          timeoutMsg: "the activity rows never matched getDownloadActivity",
        },
      );
      const shown = await shownIds();
      assert.deepEqual(
        shown,
        backendIds,
        "activity rows differ from the backend",
      );
      return { backendEntries: backendIds.length, shownRows: shown.length };
    });
  });

  it("rolls back a failed preset save or delete and ignores a double click", async function () {
    this.timeout(120_000);
    await scenario(
      "renderer-actions-preset-rollback",
      [9, 10, 11],
      async () => {
        const before = await presetState();

        // A failed save keeps nothing.
        await stubApi("saveSettings", "value", FAIL_SAVE);
        await submitPresetName("audit failed");
        await waitForPresetStatus("Could not save the preset.");
        const failedSave = await presetState();
        assert.deepEqual(
          failedSave.storeNames,
          before.storeNames,
          "a failed save kept the preset in the settings store",
        );
        assert.deepEqual(
          failedSave.optionNames,
          before.optionNames,
          "a failed save kept the preset in the menu",
        );

        // A double click submits once and disables the button while it waits.
        await stubApi("saveSettings", "hold", FAIL_SAVE);
        const duringWait = await browser.execute(() => {
          document.getElementById("presetNameInput").value = "audit double";
          const button = document.getElementById("savePresetBtn");
          button.click();
          button.click();
          return { disabled: button.disabled };
        });
        assert.equal(
          duringWait.disabled,
          true,
          "Save stayed enabled during the save",
        );
        await browser.waitUntil(
          async () => (await probeCalls("saveSettings")).length >= 1,
          {
            timeout: 10_000,
            interval: 50,
            timeoutMsg: "the save never reached the bridge",
          },
        );
        await browser.execute(() => window.__actionsAudit.held.release());
        await waitFor(
          () => !document.getElementById("savePresetBtn").disabled,
          "Save stayed disabled after the save settled",
          10_000,
        );
        assert.equal(
          (await probeCalls("saveSettings")).length,
          1,
          "a double click submitted the save twice",
        );
        assert.equal(
          await browser.execute(
            () => document.getElementById("savePresetBtn").disabled,
          ),
          false,
          "Save stayed disabled after the save settled",
        );

        // A real save, then a failed delete keeps the preset.
        await restoreProbe();
        await installProbe();
        await submitPresetName("audit keep");
        await waitForPresetStatus("Saved audit keep.");
        await browser.execute(() => {
          const select = document.getElementById("downloadPresetSelect");
          const option = [...select.options].find(
            (candidate) => candidate.textContent === "audit keep",
          );
          select.value = option.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await stubApi("saveSettings", "value", FAIL_SAVE);
        await browser.execute(() =>
          document.getElementById("deletePresetBtn").click(),
        );
        await waitForPresetStatus("Could not delete the preset.");
        const failedDelete = await presetState();
        assert.ok(
          failedDelete.storeNames.includes("audit keep") &&
            failedDelete.optionNames.includes("audit keep"),
          "a failed delete removed the preset from memory or the menu",
        );

        // Remove the preset for real so the profile is left as found.
        await restoreProbe();
        await installProbe();
        await browser.execute(() =>
          document.getElementById("deletePresetBtn").click(),
        );
        await waitForPresetStatus("Deleted audit keep.");
        const after = await presetState();
        assert.deepEqual(after.storeNames, before.storeNames);
        return { presetsBefore: before.storeNames.length };
      },
    );
  });

  it("shows a toast when an external link cannot be opened", async function () {
    this.timeout(60_000);
    await scenario("renderer-actions-open-external-failure", [12], async () => {
      const routes = [
        ["rejects", "throw", "audit open failure"],
        ["refuses", "value", REFUSED],
      ];
      for (const [route, how, payload] of routes) {
        await stubApi("openExternal", how, payload);
        await clearToasts();
        await emitUpdaterError(`audit update failure ${route}`);
        await waitForModal("Update Error");
        await clickModalButton("Get Latest Version");
        await waitForLastToast(
          "Could not open the ROSI website.",
          `a ${route} openExternal showed no error toast`,
        );
        assert.equal(
          (await probeCalls("openExternal")).length,
          1,
          "Get Latest Version did not call openExternal once",
        );
        // A pressed button closes the prompt on its own.
        await browser.waitUntil(async () => !(await modalSnapshot()).active, {
          timeout: 10_000,
          interval: 100,
          timeoutMsg: "the Update Error prompt did not close",
        });
      }
      const rejections = await browser.execute(
        () => window.__actionsAudit.rejections,
      );
      assert.deepEqual(
        rejections,
        [],
        "an openExternal rejection was unhandled",
      );
      return { routes: routes.map(([route]) => route) };
    });
  });

  it("formats bad byte sizes safely and keeps the queue host label", async function () {
    this.timeout(60_000);
    await scenario("renderer-actions-format-helpers", [13, 14], async () => {
      const readStats = async (total) => {
        await browser.execute((value) => {
          const probe = window.__actionsAudit;
          if (!("getStats" in probe.original)) {
            probe.original.getStats = window.__ROSI_E2E__.api.getStats;
          }
          window.__ROSI_E2E__.api.getStats = async () => ({
            totalDownloads: 1,
            successfulDownloads: 1,
            failedDownloads: 0,
            cancelledDownloads: 0,
            totalBytesDownloaded: Number(value),
            formatCounts: {},
            lastDownloadAt: null,
          });
        }, total);
        await browser.execute(() =>
          document.getElementById("viewStatsBtn").click(),
        );
        await waitForModal("Download Statistics");
        const message = (await modalSnapshot()).message;
        await closeModal("Close");
        return message;
      };
      const bad = await readStats("NaN");
      assert.ok(
        !/NaN|undefined/.test(bad),
        `a bad total printed ${JSON.stringify(bad)}`,
      );
      const good = await readStats("1536");
      assert.ok(
        good.includes("Total downloaded: 1.5 KB"),
        `a valid total printed ${JSON.stringify(good)}`,
      );

      const host = new URL(MEDIA).hostname;
      const queued = await api("addToQueue", [
        `${MEDIA}/clip-one.mp4?renderer-actions=host`,
      ]);
      assert.equal(queued.data.added, 1, "the queue refused the test link");
      await waitFor(
        (label) => Boolean(document.querySelector(`[aria-label="${label}"]`)),
        "the queue row shows no host label",
        15_000,
        `Remove ${host} from queue`,
      );
      return { bad: bad.split("\n").pop(), good: good.split("\n").pop(), host };
    });
  });
});
