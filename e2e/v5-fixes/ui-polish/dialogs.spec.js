// Dialog behavior: Escape on busy and interrupt prompts, dismissal callbacks,
// button actions during the fade, update error prompts, and the licenses focus
// trap. Rows match e2e/v5-fixes/ui-polish/dialogs.failure-modes.md.
//
// Needs window.__ROSI_E2E__.modules to expose `overlays` (overlays.ts) and
// `settings` (settings-store.ts) from src/e2e-hook.ts. The modal objects, the
// interrupt confirm, and the licenses trap are driven through those modules.
// Updater rows emit real updater-status events. The IPC boundary is stubbed
// only for download_update, install_update, and check_for_updates, through the
// E2E-only registry window.__ROSI_E2E_IPC_STUBS__ that call() in src/commands.ts
// reads before invoke. Tauri's own IPC (window.ipc, __TAURI_INTERNALS__) is not
// hooked: it is non-writable in WKWebView and WebView2, so no hook there is reliable.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";
import { REPO_ROOT } from "../../helpers/profile.js";

const MEDIA = process.env.ROSI_E2E_MEDIA_URL;
const PROBE_KEY = "dialogs-probe";

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-dialogs-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-dialogs",
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

// A body that returns { notProven: reason } records the row as not proven
// (invariantPassed null). That is not a pass, and the test does not fail.
async function scenario(name, body) {
  try {
    const { notProven, ...details } = (await body()) ?? {};
    if (notProven) {
      report.checks.push({
        name,
        status: "not-proven",
        invariantPassed: null,
        reason: notProven,
        ...details,
      });
    } else {
      report.checks.push({
        name,
        status: "passed",
        invariantPassed: true,
        ...details,
      });
    }
    writeReport();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The probe state is attached to the failure so the run log shows what
    // the stubs saw (every request, native messages, and the modal/banner).
    const trace = await probe("trace").catch(
      (traceError) => `trace unavailable: ${traceError.message}`,
    );
    const traceText = JSON.stringify(trace).slice(0, 6000);
    report.checks.push({
      name,
      status: "failed",
      invariantPassed: false,
      reason: `${message} | trace ${traceText}`,
    });
    writeReport();
    const failure = new Error(`${message} | trace ${traceText}`);
    failure.stack = error instanceof Error ? error.stack : undefined;
    throw failure;
  }
}

// Runs inside the app page. It must stay self-contained: WebDriver serializes
// the function source, so it cannot close over anything from this file.
function dialogsProbe(op, arg) {
  const modules = window.__ROSI_E2E__?.modules;
  if (!modules?.overlays || !modules?.settings) {
    return {
      error: "window.__ROSI_E2E__.modules must expose overlays and settings",
    };
  }
  const { overlays, settings } = modules;
  const state = window.__dialogsProbe;
  if (op !== "install" && op !== "restore" && !state) {
    return { error: "probe is not installed" };
  }
  const bump = (name) => {
    if (name) state.counts[name] = (state.counts[name] ?? 0) + 1;
  };
  const findButton = (label) => {
    const button = [...document.querySelectorAll("#modal-buttons button")].find(
      (candidate) => candidate.textContent.trim() === label,
    );
    if (!button) throw new Error(`no modal button labelled ${label}`);
    return button;
  };
  const key = (name) =>
    new KeyboardEvent("keydown", {
      key: name,
      bubbles: true,
      cancelable: true,
    });
  // Mirrors the product rule in src/engine/overlays.ts (getFrameTabStops). The
  // summary of a details is a tab stop. A closed <details> hides its content even
  // when offsetParent is set, so checkVisibility() decides where it exists, and
  // the closed-details walk is the fallback.
  const insideClosedDetails = (element) => {
    for (
      let ancestor = element.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      if (ancestor.tagName !== "DETAILS" || ancestor.hasAttribute("open"))
        continue;
      const ownSummary = [...ancestor.children].find(
        (child) => child.tagName === "SUMMARY",
      );
      if (element !== ownSummary) return true;
    }
    return false;
  };
  const frameFocusables = (doc) =>
    [
      ...doc.querySelectorAll(
        'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"]), summary',
      ),
    ].filter(
      (element) =>
        !element.hasAttribute("disabled") &&
        element.tabIndex !== -1 &&
        element.offsetParent !== null &&
        (element.tagName !== "SUMMARY" ||
          element.parentElement?.tagName === "DETAILS") &&
        (typeof element.checkVisibility === "function"
          ? element.checkVisibility()
          : !insideClosedDetails(element)),
    );
  const snapshotModal = () => {
    const element = document.getElementById("app-modal");
    return {
      active: element.classList.contains("active"),
      hiding: element.classList.contains("hiding"),
      busy: element.getAttribute("aria-busy") === "true",
      title: document.getElementById("modal-title").textContent,
      message: document.getElementById("modal-message").textContent,
      buttons: [...document.querySelectorAll("#modal-buttons button")].map(
        (button) => button.textContent.trim(),
      ),
    };
  };

  switch (op) {
    case "install": {
      if (!window.__dialogsProbe) {
        const installed = {
          calls: [],
          args: {},
          // The registry call() in src/commands.ts reads (E2E builds only).
          // Each entry is a function that records the call, then settles.
          stubs: {},
          counts: {},
          confirm: null,
          releaseDownload: null,
          statuses: [],
          lastClick: null,
        };
        window.__dialogsProbe = installed;
        window.__ROSI_E2E_IPC_STUBS__ = installed.stubs;
        // Status events are logged so a check can show which events arrived.
        window.__TAURI__?.event
          ?.listen?.("updater-status", (event) => {
            if (installed.statuses.length < 50) {
              installed.statuses.push(JSON.stringify(event.payload));
            }
          })
          .catch(() => {});
      }
      return { installed: true };
    }
    case "trace": {
      if (!state) return { installed: false };
      return {
        installed: true,
        registry: window.__ROSI_E2E_IPC_STUBS__ === state.stubs,
        stubs: Object.keys(state.stubs),
        calls: state.calls.slice(-30),
        statuses: state.statuses.slice(-20),
        lastClick: state.lastClick,
        macPlatform: navigator.platform.toLowerCase().includes("mac"),
        hasFocus: document.hasFocus(),
        visibility: document.visibilityState,
        snapshot: snapshotModal(),
        banner: {
          active: document
            .getElementById("update-banner")
            .classList.contains("active"),
        },
      };
    }
    case "restore": {
      if (state) {
        // A held command that the test never released settles as cancelled,
        // so the renderer does not keep a pending download after the check.
        if (typeof state.releaseDownload === "function") {
          state.releaseDownload({
            success: false,
            cancelled: true,
            error: null,
          });
        }
      }
      // Removing the registry is what keeps a stub from answering a later row.
      delete window.__ROSI_E2E_IPC_STUBS__;
      delete window.__dialogsProbe;
      return { restored: true };
    }
    case "stub": {
      const command = arg.cmd;
      if (arg.mode === "clear") {
        delete state.stubs[command];
        return { cleared: command };
      }
      let settle;
      if (arg.mode === "reject") {
        settle = () => Promise.reject(arg.value);
      } else if (arg.mode === "resolve") {
        settle = () => Promise.resolve(arg.value);
      } else if (arg.mode === "hold") {
        settle = () =>
          new Promise((resolve) => {
            state.releaseDownload = resolve;
          });
      } else throw new Error(`unknown stub mode ${arg.mode}`);
      state.stubs[command] = (args) => {
        state.calls.push(command);
        state.args[command] = args ?? null;
        return settle();
      };
      return { stubbed: command };
    }
    case "release": {
      if (typeof state.releaseDownload !== "function") {
        throw new Error("no held command to release");
      }
      state.releaseDownload(arg);
      return { released: true };
    }
    case "show": {
      overlays.showModal({
        title: arg.title,
        message: arg.message ?? "Dialogs probe",
        key: arg.key ?? "dialogs-probe",
        busy: arg.busy ?? false,
        priority: arg.priority ?? false,
        onDismiss: arg.onDismissCount
          ? () => bump(arg.onDismissCount)
          : undefined,
        buttons: (arg.buttons ?? []).map((button) => ({
          label: button.label,
          primary: button.primary,
          danger: button.danger,
          disabled: button.disabled,
          action: () => {
            bump(button.count);
            if (button.throws) throw new Error("probe action failure");
            if (button.thenShow) {
              overlays.showModal({
                title: button.thenShow,
                key: "dialogs-probe",
              });
            }
            if (button.thenPriority) {
              overlays.showModal({
                title: button.thenPriority,
                key: "dialogs-probe",
                priority: true,
              });
            }
          },
        })),
      });
      return { modal: snapshotModal() };
    }
    case "clickButton": {
      const target = findButton(arg.label);
      const before = overlays.currentModalData?.title ?? null;
      target.click();
      if (arg.double) target.click();
      if (state) {
        state.lastClick = {
          label: arg.label,
          titleBefore: before,
          modalClassAfter: document.getElementById("app-modal").className,
        };
      }
      return { clicked: arg.label };
    }
    case "clickThenPriority": {
      // The priority prompt is raised in the same task as the press, so it
      // lands inside the 200 ms fade window of the pressed prompt.
      const target = findButton(arg.label);
      const started = performance.now();
      target.click();
      overlays.showModal({
        title: arg.title,
        key: "dialogs-probe",
        priority: true,
        buttons: [{ label: "OK", primary: true }],
      });
      return { elapsedMs: performance.now() - started };
    }
    case "escapeTwice": {
      // Two Escape presses in one task: the second lands inside the fade.
      const modal = document.getElementById("app-modal");
      modal.dispatchEvent(key("Escape"));
      modal.dispatchEvent(key("Escape"));
      return { sent: 2 };
    }
    case "retire": {
      overlays.retireModal(arg);
      return { retired: arg };
    }
    case "depth": {
      return [overlays.currentModalData, ...overlays.modalQueue].filter(
        (data) => data?.title === arg,
      ).length;
    }
    case "confirmInterrupt": {
      state.confirm = { settled: false, value: null };
      settings.confirmInterruptActiveWork(arg).then((value) => {
        state.confirm = { settled: true, value };
      });
      return { started: true };
    }
    case "sidebarToggle": {
      // The same platform test as isMac() in src/modules/ui.ts, so the probe
      // sends the modifier that shortcuts.ts reads on this platform.
      const mac = navigator.platform.toLowerCase().includes("mac");
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: ",",
          code: "Comma",
          ctrlKey: !mac,
          metaKey: mac,
          shiftKey: true,
          bubbles: true,
        }),
      );
      return {
        open: document.getElementById("sidebar").classList.contains("open"),
      };
    }
    case "clickElement": {
      document.getElementById(arg).click();
      return { clicked: arg };
    }
    case "closeLicenses": {
      if (
        document.getElementById("licenses-overlay").classList.contains("active")
      ) {
        overlays.hideLicenses();
      }
      return { closed: true };
    }
    case "focusTrap": {
      return overlays
        .getFocusableElements(document.getElementById("licenses-overlay"))
        .map((element) => element.id || element.tagName);
    }
    case "shiftTabOnClose": {
      const close = document.getElementById("close-licenses");
      close.focus();
      close.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      return { activeId: document.activeElement?.id ?? null };
    }
    case "tabOnFrame": {
      const frame = document.getElementById("licenses-frame");
      frame.focus();
      frame.dispatchEvent(key("Tab"));
      return { activeId: document.activeElement?.id ?? null };
    }
    case "frameTab": {
      const frame = document.getElementById("licenses-frame");
      const doc = frame.contentDocument;
      if (!doc) throw new Error("licenses frame has no same-origin document");
      const items = frameFocusables(doc);
      const last = items[items.length - 1];
      if (!last) throw new Error("licenses frame has no focusable link");
      // Focus the frame element from the parent first, as a Tab into the frame does.
      frame.focus();
      last.focus();
      const focusedLast = doc.activeElement === last;
      const diagnostics = {
        parentActive:
          document.activeElement?.id || document.activeElement?.tagName || null,
        parentHasFocus: document.hasFocus(),
        frameActive:
          doc.activeElement?.id || doc.activeElement?.tagName || null,
        frameHasFocus: doc.hasFocus(),
      };
      if (focusedLast) last.dispatchEvent(key("Tab"));
      return {
        frameFocusableCount: items.length,
        focusedLast,
        lastTag: last.tagName,
        lastInClosedDetails: insideClosedDetails(last),
        diagnostics,
        activeId: document.activeElement?.id ?? null,
      };
    }
    case "frameShiftTab": {
      const frame = document.getElementById("licenses-frame");
      const doc = frame.contentDocument;
      if (!doc) throw new Error("licenses frame has no same-origin document");
      const items = frameFocusables(doc);
      const first = items[0];
      if (!first) throw new Error("licenses frame has no focusable tab stop");
      frame.focus();
      first.focus();
      const focusedFirst = doc.activeElement === first;
      if (focusedFirst) {
        first.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Tab",
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      return {
        frameFocusableCount: items.length,
        focusedFirst,
        firstTag: first.tagName,
        firstInClosedDetails: insideClosedDetails(first),
        activeId: document.activeElement?.id ?? null,
      };
    }
    case "frameEscape": {
      const frame = document.getElementById("licenses-frame");
      const doc = frame.contentDocument;
      if (!doc) throw new Error("licenses frame has no same-origin document");
      const items = frameFocusables(doc);
      const last = items[items.length - 1];
      last.focus();
      last.dispatchEvent(key("Escape"));
      return {
        licensesActive: document
          .getElementById("licenses-overlay")
          .classList.contains("active"),
      };
    }
    case "snapshot": {
      const check = document.getElementById("checkUpdateBtn");
      const banner = document.getElementById("update-banner");
      return {
        modal: snapshotModal(),
        counts: { ...state?.counts },
        calls: [...(state?.calls ?? [])],
        args: { ...(state?.args ?? {}) },
        confirm: state?.confirm ?? null,
        queued: overlays.modalQueue.map((data) => data.title),
        current: overlays.currentModalData?.title ?? null,
        banner: {
          active: banner.classList.contains("active"),
          busy: banner.getAttribute("aria-busy") === "true",
        },
        checkButton: {
          loading: check?.classList.contains("loading") ?? false,
          busy: check?.getAttribute("aria-busy") === "true",
        },
        licenses: document
          .getElementById("licenses-overlay")
          .classList.contains("active"),
        sidebarOpen: document
          .getElementById("sidebar")
          .classList.contains("open"),
      };
    }
    default:
      throw new Error(`unknown probe op ${op}`);
  }
}

async function probe(op, arg = null) {
  const result = await browser.execute(dialogsProbe, op, arg);
  if (result?.error) throw new Error(`dialogs probe ${op}: ${result.error}`);
  return result;
}

async function snapshot() {
  return probe("snapshot");
}

async function waitForTitle(title, timeout = 8_000) {
  await browser.waitUntil(
    async () => {
      const current = (await snapshot()).modal;
      return current.active && !current.hiding && current.title === title;
    },
    { timeout, interval: 100, timeoutMsg: `modal "${title}" did not show` },
  );
}

async function waitForHidden(timeout = 5_000) {
  await browser.waitUntil(async () => !(await snapshot()).modal.active, {
    timeout,
    interval: 100,
    timeoutMsg: "modal did not hide",
  });
}

async function emitUpdaterStatus(payload) {
  const result = await browser.executeAsync((event, done) => {
    window.__TAURI__.event.emit("updater-status", event).then(
      () => done(true),
      (error) => done(String(error)),
    );
  }, payload);
  assert.equal(result, true, "updater-status event was not emitted");
}

function availableStatus(candidateId, version) {
  return {
    status: "available",
    candidateId,
    version,
    releaseNotes: null,
    isBeta: false,
    manualInstall: false,
  };
}

async function waitForQueueStatus(url, status, timeout = 60_000) {
  await browser.waitUntil(
    async () =>
      (await api("getQueue")).some(
        (item) => item.url === url && item.status === status,
      ),
    {
      timeout,
      interval: 250,
      timeoutMsg: `queue item did not reach ${status}`,
    },
  );
}

// Retires probe and updater prompts, then clicks through any others, so one
// check cannot leave a prompt behind for the next.
async function closeModals() {
  for (let round = 0; round < 10; round += 1) {
    for (const key of [PROBE_KEY, "updater-candidate", "updater-downloaded"]) {
      await probe("retire", key);
    }
    const current = (await snapshot()).modal;
    if (!current.active) return;
    if (current.hiding || current.busy) {
      await browser.pause(250);
      continue;
    }
    if (current.buttons.length > 0) {
      await probe("clickButton", { label: current.buttons[0] });
    }
    await browser.pause(300);
  }
  throw new Error("could not close the modal stack during cleanup");
}

async function openLicenses() {
  await probe("clickElement", "licensesLink");
  await browser.waitUntil(async () => (await snapshot()).licenses, {
    timeout: 5_000,
    interval: 100,
    timeoutMsg: "licenses overlay did not open",
  });
}

async function resetQueue() {
  await api("cancelQueue");
  assert.equal((await api("clearQueue")).ok, true);
}

describe("ROSI dialogs: Escape, dismissal, update errors, licenses focus", () => {
  before(async () => {
    await waitForAppReady();
    report.source = sourceIdentity();
    writeReport();
  });

  beforeEach(async () => {
    await probe("install");
    // A stub left over from an earlier row would answer this row's command.
    const fresh = await probe("trace");
    assert.deepEqual(fresh.stubs, [], "a stub survived the last teardown");
    assert.equal(
      fresh.registry,
      true,
      "the IPC stub registry is not installed",
    );
    await resetQueue();
  });

  afterEach(async () => {
    await probe("closeLicenses").catch(() => {});
    await probe("retire", PROBE_KEY).catch(() => {});
    await closeModals().catch(() => {});
    await probe("restore").catch(() => {});
    await api("cancelQueue").catch(() => {});
    await api("clearQueue").catch(() => {});
  });

  after(async () => {
    report.completedAt = new Date().toISOString();
    report.passed = report.checks.filter(
      (check) => check.status === "passed",
    ).length;
    report.failed = report.checks.filter(
      (check) => check.status === "failed",
    ).length;
    report.notProven = report.checks.filter(
      (check) => check.status === "not-proven",
    ).length;
    report.result =
      report.failed > 0 || report.checks.length === 0
        ? "failed"
        : report.notProven > 0
          ? "not-proven"
          : "passed";
    writeReport();
  });

  // B4a: busy prompts and Escape.
  it("B4-1 Escape keeps a busy prompt open", async () => {
    await scenario("busy-prompt-escape-keeps-open", async () => {
      await probe("show", {
        title: "Installing Deno...",
        busy: true,
        priority: true,
        buttons: [{ label: "Installing...", disabled: true }],
      });
      await waitForTitle("Installing Deno...");
      await browser.keys("Escape");
      await browser.pause(400);
      const current = (await snapshot()).modal;
      assert.equal(
        current.active && !current.hiding,
        true,
        "Escape closed the busy prompt",
      );
      assert.equal(current.busy, true, "busy state was lost");
      assert.equal(current.title, "Installing Deno...", "title changed");
      return { title: current.title, busy: current.busy };
    });
  });

  it("B4-2 Escape on a busy prompt does not dismiss the sidebar underneath", async () => {
    await scenario("busy-prompt-escape-leaves-sidebar", async () => {
      assert.equal(
        (await probe("sidebarToggle")).open,
        true,
        "sidebar did not open",
      );
      try {
        await probe("show", {
          title: "Installing Deno...",
          busy: true,
          priority: true,
          buttons: [{ label: "Installing...", disabled: true }],
        });
        await waitForTitle("Installing Deno...");
        await browser.keys("Escape");
        await browser.pause(400);
        const current = await snapshot();
        assert.equal(current.modal.busy, true, "busy prompt was dismissed");
        assert.equal(current.sidebarOpen, true, "Escape reached the sidebar");
      } finally {
        await probe("retire", PROBE_KEY);
        await waitForHidden().catch(() => {});
        await probe("sidebarToggle");
      }
      return { sidebarOpenAfterEscape: true };
    });
  });

  it("B4-3 Escape closes a plain prompt with no dismissal callback", async () => {
    await scenario("plain-prompt-escape-closes", async () => {
      await probe("show", {
        title: "Plain probe",
        buttons: [{ label: "OK", primary: true }],
      });
      await waitForTitle("Plain probe");
      await browser.keys("Escape");
      await waitForHidden();
      return { closed: true };
    });
  });

  // B4b: dismissal runs onDismiss once.
  it("B4-6 two Escape presses in one fade run onDismiss once", async () => {
    await scenario("dismiss-runs-once-during-fade", async () => {
      await probe("show", {
        title: "Dismiss probe",
        onDismissCount: "dismiss",
        buttons: [{ label: "Later" }],
      });
      await waitForTitle("Dismiss probe");
      await probe("escapeTwice");
      await browser.pause(400);
      const counts = (await probe("snapshot")).counts;
      assert.equal(
        counts.dismiss,
        1,
        `onDismiss ran ${counts.dismiss ?? 0} times`,
      );
      return { dismissCount: counts.dismiss };
    });
  });

  it("B4-7 a button press runs its action and not onDismiss", async () => {
    await scenario("button-press-skips-dismiss", async () => {
      await probe("show", {
        title: "Button probe",
        onDismissCount: "dismiss",
        buttons: [{ label: "Confirm", primary: true, count: "confirm" }],
      });
      await waitForTitle("Button probe");
      await probe("clickButton", { label: "Confirm" });
      await waitForHidden();
      const counts = (await snapshot()).counts;
      assert.equal(counts.confirm, 1, "the button action did not run once");
      assert.equal(counts.dismiss ?? 0, 0, "onDismiss ran for a button press");
      return { confirmCount: counts.confirm };
    });
  });

  it("B4-4 and B4-5 Escape on the interrupt confirm resolves keep-current-work", async () => {
    await scenario("interrupt-escape-resolves-keep", async () => {
      const slow = `${MEDIA}/slow.mp4?dialogs=interrupt`;
      assert.equal((await api("addToQueue", [slow])).data.added, 1);
      assert.equal((await api("startQueue")).ok, true);
      await waitForQueueStatus(slow, "downloading");
      await browser.pause(300);
      await probe("confirmInterrupt", "Restarting ROSI");
      await waitForTitle("Download in Progress");
      await browser.keys("Escape");
      await browser.waitUntil(
        async () => (await snapshot()).confirm?.settled === true,
        {
          timeout: 5_000,
          interval: 100,
          timeoutMsg: "confirmInterruptActiveWork did not settle after Escape",
        },
      );
      const after = await snapshot();
      assert.equal(
        after.confirm.value,
        false,
        "Escape did not keep the current work",
      );
      await waitForHidden();
      const item = (await api("getQueue")).find((entry) => entry.url === slow);
      assert.equal(item?.status, "downloading", "Escape stopped the download");
      return { settledValue: after.confirm.value, queueStatus: item.status };
    });
  });

  // B4c: button actions run at press time.
  it("B4-9 a priority prompt inside the fade does not drop the pressed action", async () => {
    await scenario("priority-in-fade-keeps-action", async () => {
      await probe("show", {
        title: "Confirm probe",
        buttons: [{ label: "Confirm", primary: true, count: "confirm" }],
      });
      await waitForTitle("Confirm probe");
      const { elapsedMs } = await probe("clickThenPriority", {
        label: "Confirm",
        title: "Priority probe",
      });
      assert.ok(
        elapsedMs < 200,
        `priority prompt was not inside the fade (${elapsedMs} ms)`,
      );
      await waitForTitle("Priority probe");
      await browser.pause(400);
      const counts = (await snapshot()).counts;
      assert.equal(counts.confirm, 1, "the pressed action was dropped");
      return { confirmCount: counts.confirm, elapsedMs: Math.round(elapsedMs) };
    });
  });

  it("B4-10 a double press runs the action once", async () => {
    await scenario("double-press-runs-once", async () => {
      await probe("show", {
        title: "Double probe",
        buttons: [{ label: "Go", count: "go" }],
      });
      await waitForTitle("Double probe");
      await probe("clickButton", { label: "Go", double: true });
      await browser.pause(400);
      const counts = (await snapshot()).counts;
      assert.equal(counts.go, 1, `action ran ${counts.go ?? 0} times`);
      return { goCount: counts.go };
    });
  });

  it("B4-11 a throwing action still closes the prompt and the next one shows", async () => {
    await scenario("throwing-action-teardown-runs", async () => {
      await probe("show", {
        title: "Throw probe",
        buttons: [{ label: "Boom", throws: true, count: "boom" }],
      });
      await waitForTitle("Throw probe");
      await probe("show", {
        title: "After throw",
        buttons: [{ label: "OK", primary: true }],
      });
      await probe("clickButton", { label: "Boom" });
      await waitForTitle("After throw", 4_000);
      const counts = (await snapshot()).counts;
      assert.equal(counts.boom, 1, "the throwing action did not run");
      return { boomCount: counts.boom };
    });
  });

  it("B4-12 a prompt closed by a button is not shown again after a priority prompt", async () => {
    await scenario("closing-prompt-not-redisplayed", async () => {
      await probe("show", {
        title: "Closing A",
        buttons: [{ label: "Close", count: "closeA" }],
      });
      await waitForTitle("Closing A");
      await probe("clickThenPriority", { label: "Close", title: "Priority A" });
      await waitForTitle("Priority A");
      await browser.pause(600);
      const depth = await probe("depth", "Closing A");
      assert.equal(depth, 0, "the closed prompt came back");
      return { depthAfter: depth };
    });
  });

  it("B4-13 a prompt opened by an action is queued and shown after the first", async () => {
    await scenario("action-opened-prompt-is-queued", async () => {
      await probe("show", {
        title: "Go modal",
        buttons: [{ label: "Go", count: "go", thenShow: "Second probe" }],
      });
      await waitForTitle("Go modal");
      await probe("clickButton", { label: "Go" });
      await waitForTitle("Second probe");
      assert.equal((await snapshot()).counts.go, 1, "the action did not run");
      return { secondShown: true };
    });
  });

  // B5: update errors.
  it("B5-14 a rejected download_update hides the banner and shows Update Error", async () => {
    await scenario("rejected-download-shows-error", async () => {
      await probe("stub", {
        cmd: "download_update",
        mode: "reject",
        value: "probe bridge failure",
      });
      await emitUpdaterStatus(availableStatus(9101, "9.1.1"));
      await waitForTitle("Update Available!");
      await probe("clickButton", { label: "Download & Install" });
      await waitForTitle("Update Error");
      const current = await snapshot();
      assert.equal(
        current.banner.active,
        false,
        "the update banner is still up",
      );
      assert.equal(current.banner.busy, false, "the banner is still aria-busy");
      assert.ok(
        current.modal.message.includes("probe bridge failure"),
        "Update Error does not carry the rejection message",
      );
      assert.ok(
        current.calls.includes("download_update"),
        "the download_update stub was not reached",
      );
      assert.equal(current.args.download_update?.candidateId, 9101);
      return { candidateId: 9101 };
    });
  });

  it("B5-15 a refusal with an error message shows that message", async () => {
    await scenario("refusal-message-is-shown", async () => {
      await probe("stub", {
        cmd: "download_update",
        mode: "resolve",
        value: {
          success: false,
          cancelled: false,
          error: "A download is already in progress.",
        },
      });
      await emitUpdaterStatus(availableStatus(9102, "9.1.2"));
      await waitForTitle("Update Available!");
      await probe("clickButton", { label: "Download & Install" });
      await waitForTitle("Update Error");
      const current = await snapshot();
      assert.ok(
        current.calls.includes("download_update"),
        "the download_update stub was not reached",
      );
      assert.ok(
        current.modal.message.includes("A download is already in progress."),
        "the refusal message was not shown",
      );
      assert.equal(current.banner.active, false, "the banner is still up");
      return { shown: true };
    });
  });

  it("B5-16 a failed download shows one Update Error when the status and result both report it", async () => {
    await scenario("failed-download-one-error-prompt", async () => {
      await probe("stub", { cmd: "download_update", mode: "hold" });
      await emitUpdaterStatus(availableStatus(9103, "9.1.3"));
      await waitForTitle("Update Available!");
      await probe("clickButton", { label: "Download & Install" });
      await browser.waitUntil(
        async () => (await snapshot()).calls.includes("download_update"),
        {
          timeout: 5_000,
          interval: 100,
          timeoutMsg: "download_update was not called",
        },
      );
      const message = "probe download failure";
      await emitUpdaterStatus({ status: "error", message, kind: "download" });
      await waitForTitle("Update Error");
      await probe("release", {
        success: false,
        cancelled: false,
        error: message,
      });
      await browser.pause(500);
      const depth = await probe("depth", "Update Error");
      assert.equal(depth, 1, `Update Error prompts shown or queued: ${depth}`);
      return { updateErrorPrompts: depth };
    });
  });

  it("B5-17 a cancelled download hides the banner and shows no Update Error", async () => {
    await scenario("cancelled-download-no-error", async () => {
      await probe("stub", { cmd: "download_update", mode: "hold" });
      await emitUpdaterStatus(availableStatus(9104, "9.1.4"));
      await waitForTitle("Update Available!");
      await probe("clickButton", { label: "Download & Install" });
      await browser.waitUntil(
        async () => (await snapshot()).calls.includes("download_update"),
        {
          timeout: 5_000,
          interval: 100,
          timeoutMsg: "download_update was not called",
        },
      );
      // The banner is up only if the action ran, so this proves the path.
      const pending = await snapshot();
      assert.equal(
        pending.banner.active,
        true,
        "the banner was not shown while the download was pending",
      );
      await probe("release", {
        success: false,
        cancelled: true,
        error: null,
      });
      await browser.waitUntil(async () => !(await snapshot()).banner.active, {
        timeout: 5_000,
        interval: 100,
        timeoutMsg: "the banner stayed up after the cancel",
      });
      await browser.pause(500);
      assert.equal(
        await probe("depth", "Update Error"),
        0,
        "a cancel showed Update Error",
      );
      return { updateErrorPrompts: 0 };
    });
  });

  it("B5-18 a rejected install_update hides the banner and shows Update Error", async () => {
    await scenario("rejected-install-shows-error", async () => {
      await probe("stub", {
        cmd: "install_update",
        mode: "reject",
        value: "probe install failure",
      });
      await emitUpdaterStatus({
        status: "downloaded",
        candidateId: 9301,
        version: "9.3.1",
      });
      await waitForTitle("Update Ready!");
      await probe("clickButton", { label: "Restart Now" });
      await waitForTitle("Update Error");
      const current = await snapshot();
      assert.ok(
        current.calls.includes("install_update"),
        "install_update was not called",
      );
      assert.ok(
        current.modal.message.includes("probe install failure"),
        "Update Error does not carry the install message",
      );
      assert.equal(current.banner.active, false, "the banner is still up");
      return { candidateId: 9301 };
    });
  });

  it("B5-19 a check refusal with a message shows it and ends the spinner", async () => {
    await scenario("check-refusal-message-ends-spinner", async () => {
      await probe("stub", {
        cmd: "check_for_updates",
        mode: "resolve",
        value: { reason: "message", message: "probe refusal" },
      });
      await probe("clickElement", "checkUpdateBtn");
      await waitForTitle("Update Check Failed");
      const current = await snapshot();
      assert.ok(
        current.modal.message.includes("probe refusal"),
        "the check refusal message was not shown",
      );
      assert.equal(
        current.checkButton.loading,
        false,
        "the check button still shows loading",
      );
      assert.equal(
        current.checkButton.busy,
        false,
        "the check button is still aria-busy",
      );
      return { shown: true };
    });
  });

  // B10: static source checks (typecheck covers the caller signatures).
  it("B10-22 the dead silent and settingsSaveErrorShownAt names are gone", async () => {
    await scenario("dead-save-fields-removed", async () => {
      const source = fs.readFileSync(
        path.join(REPO_ROOT, "src", "engine", "settings-store.ts"),
        "utf8",
      );
      assert.equal(
        /settingsSaveErrorShownAt/.test(source),
        false,
        "settingsSaveErrorShownAt is still declared or read",
      );
      assert.equal(
        /\bsilent\b/.test(source),
        false,
        "the silent name is still used",
      );
      return { file: "src/engine/settings-store.ts" };
    });
  });

  // C7: licenses focus trap.
  it("C7-23 the licenses frame is in the trap order after the close button", async () => {
    await scenario("licenses-trap-includes-frame", async () => {
      await openLicenses();
      const order = await probe("focusTrap");
      const closeAt = order.indexOf("close-licenses");
      const frameAt = order.indexOf("licenses-frame");
      assert.ok(closeAt >= 0, `close button missing from trap order: ${order}`);
      assert.ok(
        frameAt > closeAt,
        `licenses frame missing from trap order: ${order}`,
      );
      return { trapOrder: order };
    });
  });

  it("C7-24 Shift+Tab on the close button wraps to the licenses frame", async () => {
    await scenario("shift-tab-wraps-to-frame", async () => {
      await openLicenses();
      const { activeId } = await probe("shiftTabOnClose");
      assert.equal(activeId, "licenses-frame", `focus went to ${activeId}`);
      return { activeId };
    });
  });

  it("C7-25 Tab on the licenses frame wraps to the close button", async () => {
    await scenario("tab-on-frame-wraps-to-close", async () => {
      await openLicenses();
      const { activeId } = await probe("tabOnFrame");
      assert.equal(activeId, "close-licenses", `focus went to ${activeId}`);
      return { activeId };
    });
  });

  it("C7-26 Tab and Escape inside the frame document stay in the trap", async () => {
    await scenario("frame-document-keys-stay-trapped", async () => {
      await openLicenses();
      // Runs in background and foreground alike. Visible frame links take focus
      // without OS focus (the earlier not-proven branch was based on the hidden-link
      // filter, not on focus).
      const tab = await probe("frameTab");
      assert.ok(
        tab.frameFocusableCount > 0,
        "the frame has no focusable tab stop",
      );
      assert.equal(
        tab.lastInClosedDetails,
        false,
        `the frame's last tab stop (${tab.lastTag}) is inside a closed details`,
      );
      assert.equal(
        tab.focusedLast,
        true,
        `could not focus the last frame tab stop (${JSON.stringify(tab.diagnostics)})`,
      );
      assert.equal(
        tab.activeId,
        "close-licenses",
        `Tab from the frame's last stop went to ${tab.activeId}`,
      );
      const escape = await probe("frameEscape");
      assert.equal(
        escape.licensesActive,
        false,
        "Escape in the frame did not close licenses",
      );
      return {
        frameFocusableCount: tab.frameFocusableCount,
        lastTag: tab.lastTag,
        parentHasFocus: tab.diagnostics.parentHasFocus,
        frameHasFocus: tab.diagnostics.frameHasFocus,
      };
    });
  });

  it("C7-26b Shift+Tab on the frame's first real tab stop wraps to the close button", async () => {
    await scenario("frame-shift-tab-wraps-to-close", async () => {
      await openLicenses();
      const shift = await probe("frameShiftTab");
      assert.ok(
        shift.frameFocusableCount > 0,
        "the frame has no focusable tab stop",
      );
      assert.equal(
        shift.firstInClosedDetails,
        false,
        `the frame's first tab stop (${shift.firstTag}) is inside a closed details`,
      );
      assert.equal(
        shift.focusedFirst,
        true,
        "could not focus the first frame tab stop",
      );
      assert.equal(
        shift.activeId,
        "close-licenses",
        `Shift+Tab from the frame's first stop went to ${shift.activeId}`,
      );
      return {
        frameFocusableCount: shift.frameFocusableCount,
        firstTag: shift.firstTag,
      };
    });
  });

  it("C7-27 repeated open and close leaves Escape in the frame closing once", async () => {
    await scenario("repeated-open-close-escape", async () => {
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await openLicenses();
        await probe("clickElement", "close-licenses");
        await browser.waitUntil(async () => !(await snapshot()).licenses, {
          timeout: 5_000,
          interval: 100,
          timeoutMsg: "licenses overlay did not close",
        });
      }
      await openLicenses();
      await probe("frameEscape");
      await browser.waitUntil(async () => !(await snapshot()).licenses, {
        timeout: 5_000,
        interval: 100,
        timeoutMsg: "Escape in the frame did not close licenses after cycles",
      });
      await browser.pause(500);
      const current = await snapshot();
      assert.equal(
        current.modal.active,
        false,
        "a modal opened by a stray close",
      );
      return { cycles: 3 };
    });
  });

  it("C7-28 Escape in the frame does nothing while an app prompt is on top", async () => {
    await scenario("frame-escape-defers-to-app-prompt", async () => {
      await openLicenses();
      await probe("show", {
        title: "Over licenses",
        buttons: [{ label: "OK", primary: true }],
      });
      await waitForTitle("Over licenses");
      const escape = await probe("frameEscape");
      assert.equal(
        escape.licensesActive,
        true,
        "Escape closed licenses under an app prompt",
      );
      await probe("clickButton", { label: "OK" });
      await waitForHidden();
      await probe("clickElement", "close-licenses");
      return { licensesStayedOpen: true };
    });
  });
});
