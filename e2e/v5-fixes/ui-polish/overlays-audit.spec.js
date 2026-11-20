// Overlays audit: modal displacement, the shared focus-trap helper, async modal
// actions, and the licenses cleanup timer. Rows match
// e2e/v5-fixes/ui-polish/overlays-audit.failure-modes.md.
//
// Needs window.__ROSI_E2E__.modules to expose `overlays`, `ui`, and `settings`
// from src/e2e-hook.ts. The hook is only read here. Modals, the sidebar, and the
// licenses view are driven through those modules and the real DOM controls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";
import { REPO_ROOT } from "../../helpers/profile.js";

const MEDIA = process.env.ROSI_E2E_MEDIA_URL;
const BUSY_KEY = "overlays-audit-busy";
const KEYED_KEY = "overlays-audit-keyed";

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-overlays-audit-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-overlays-audit",
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
    const trace = await probe("snapshot").catch(
      (traceError) => `snapshot unavailable: ${traceError.message}`,
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
function overlaysProbe(op, arg) {
  const modules = window.__ROSI_E2E__?.modules;
  if (!modules?.overlays || !modules?.ui || !modules?.settings) {
    return {
      error:
        "window.__ROSI_E2E__.modules must expose overlays, ui, and settings",
    };
  }
  const { overlays, ui, settings } = modules;
  const state = window.__overlaysAuditProbe;
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
  const keyEvent = (name, extra = {}) =>
    new KeyboardEvent("keydown", {
      key: name,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
  const snapshotModal = () => {
    const element = document.getElementById("app-modal");
    return {
      active: element.classList.contains("active"),
      hiding: element.classList.contains("hiding"),
      busy: element.getAttribute("aria-busy") === "true",
      title: document.getElementById("modal-title").textContent,
      buttons: [...document.querySelectorAll("#modal-buttons button")].map(
        (button) => button.textContent.trim(),
      ),
    };
  };
  const sidebarSections = () => [
    ...document.querySelectorAll("#sidebar .settings-section"),
  ];
  const lastVisibleSection = () =>
    sidebarSections()
      .filter((section) => section.offsetParent !== null)
      .at(-1) ?? null;
  const isInert = (element) => element.closest("[inert]") !== null;
  // The filter the sidebar trap used before the shared helper.
  const oldSidebarFocusables = () =>
    [
      ...document
        .getElementById("sidebar")
        .querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
    ].filter(
      (element) =>
        !element.hasAttribute("disabled") &&
        element.getAttribute("aria-hidden") !== "true" &&
        element.tabIndex !== -1 &&
        element.offsetParent !== null,
    );
  const idOf = (element) =>
    element ? element.id || element.tagName.toLowerCase() : null;

  switch (op) {
    case "install": {
      if (!window.__overlaysAuditProbe) {
        const installed = {
          counts: {},
          promises: {},
          rejections: [],
          confirm: null,
          clockStart: 0,
          onRejection: null,
        };
        installed.onRejection = (event) => {
          const text = String(event.reason?.message ?? event.reason ?? "");
          if (text.includes("probe async")) installed.rejections.push(text);
        };
        window.addEventListener("unhandledrejection", installed.onRejection);
        window.__overlaysAuditProbe = installed;
      }
      return { installed: true };
    }
    case "restore": {
      if (state) {
        window.removeEventListener("unhandledrejection", state.onRejection);
      }
      delete window.__overlaysAuditProbe;
      return { restored: true };
    }
    case "show": {
      // Buttons carry a value. A promise-backed modal settles with the value of
      // the button pressed, or with arg.dismissValue when it is dismissed.
      if (arg.promiseName) {
        state.promises[arg.promiseName] = { settled: false, value: null };
      }
      const settlePromise = (value) => {
        if (arg.promiseName) {
          state.promises[arg.promiseName] = { settled: true, value };
        }
      };
      let onDismiss;
      if (arg.asyncDismiss) {
        onDismiss = async () => {
          bump("asyncDismiss");
          await Promise.resolve();
          throw new Error("probe async dismiss failure");
        };
      } else if (arg.dismissCount || arg.promiseName) {
        onDismiss = () => {
          bump(arg.dismissCount);
          settlePromise(arg.dismissValue ?? "dismissed");
        };
      }
      overlays.showModal({
        title: arg.title,
        message: "Overlays audit probe",
        key: arg.key,
        busy: arg.busy ?? false,
        priority: arg.priority ?? false,
        onDismiss,
        buttons: (arg.buttons ?? []).map((button) => ({
          label: button.label,
          primary: button.primary,
          disabled: button.disabled,
          action: button.asyncThrows
            ? async () => {
                bump("asyncAction");
                await Promise.resolve();
                throw new Error("probe async action failure");
              }
            : () => {
                bump(button.count);
                settlePromise(button.value ?? button.label);
              },
        })),
      });
      return { modal: snapshotModal() };
    }
    case "clickButton": {
      findButton(arg).click();
      return { clicked: arg };
    }
    case "escape": {
      document.getElementById("app-modal").dispatchEvent(keyEvent("Escape"));
      return { sent: true };
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
    case "scratchFocusables": {
      const container = document.createElement("div");
      container.innerHTML =
        '<button id="oa-plain">plain</button>' +
        '<div inert><button id="oa-inert">inert</button></div>' +
        '<button id="oa-hidden" style="visibility:hidden">hidden</button>';
      document.body.appendChild(container);
      try {
        return overlays
          .getFocusableElements(container)
          .map((element) => element.id);
      } finally {
        container.remove();
      }
    }
    case "sidebarOpen": {
      if (!document.getElementById("sidebar").classList.contains("open")) {
        ui.toggleSidebar();
      }
      return {
        open: document.getElementById("sidebar").classList.contains("open"),
      };
    }
    case "sidebarClose": {
      if (document.getElementById("sidebar").classList.contains("open")) {
        ui.closeSidebar();
      }
      return { closed: true };
    }
    case "collapseLastSection": {
      const section = lastVisibleSection();
      if (!section) throw new Error("no visible settings section");
      const header = section.querySelector(".settings-section-header");
      const wasCollapsed = section.classList.contains("collapsed");
      if (wasCollapsed) header.click();
      const body = section.querySelector(".settings-section-body");
      const controls = [
        ...body.querySelectorAll("input, button, select, textarea"),
      ].filter((element) => element.offsetParent !== null);
      const controlCount = controls.length;
      header.click();
      state.sectionWasCollapsed = wasCollapsed;
      state.sectionHeader = header;
      return {
        wasCollapsed,
        controlCount,
        collapsed: section.classList.contains("collapsed"),
        bodyInert: body.inert === true,
      };
    }
    case "restoreSection": {
      const header = state.sectionHeader;
      const section = header?.closest(".settings-section");
      if (section) {
        const collapsed = section.classList.contains("collapsed");
        if (collapsed !== state.sectionWasCollapsed) header.click();
      }
      return { restored: true };
    }
    case "sidebarTabWrap": {
      const sidebar = document.getElementById("sidebar");
      const list = overlays.getFocusableElements(sidebar);
      const first = list[0];
      const last = list.at(-1);
      const oldList = oldSidebarFocusables();
      const oldLast = oldList.at(-1);
      const result = {
        count: list.length,
        firstId: idOf(first),
        lastId: idOf(last),
        lastInert: last ? isInert(last) : null,
        oldLastId: idOf(oldLast),
        oldLastInert: oldLast ? isInert(oldLast) : null,
        inertInList: list.filter(isInert).length,
        oldInertInList: oldList.filter(isInert).length,
      };
      if (!first || !last) return { ...result, error: "no focusable stops" };
      // Tab on the last stop.
      last.focus();
      result.focusedLast = document.activeElement === last;
      const tab = keyEvent("Tab");
      last.dispatchEvent(tab);
      result.tabPrevented = tab.defaultPrevented;
      result.afterTabId = idOf(document.activeElement);
      result.afterTabIsFirst = document.activeElement === first;
      // Shift+Tab on the first stop.
      first.focus();
      result.focusedFirst = document.activeElement === first;
      const back = keyEvent("Tab", { shiftKey: true });
      first.dispatchEvent(back);
      result.backPrevented = back.defaultPrevented;
      result.afterBackId = idOf(document.activeElement);
      result.afterBackIsLast = document.activeElement === last;
      return result;
    }
    case "licensesTrapOrder": {
      return overlays
        .getFocusableElements(document.getElementById("licenses-overlay"))
        .map((element) => element.id || element.tagName);
    }
    case "openLicensesClick": {
      document.getElementById("licensesLink").click();
      return { clicked: true };
    }
    case "licensesHideShow": {
      // Hide, then show again in the same task, so the close cleanup is pending.
      overlays.hideLicenses();
      overlays.showLicenses();
      state.clockStart = performance.now();
      return { reopened: true };
    }
    case "licensesHideShowHide": {
      overlays.hideLicenses();
      overlays.showLicenses();
      overlays.hideLicenses();
      state.clockStart = performance.now();
      return { closed: true };
    }
    case "licensesHide": {
      overlays.hideLicenses();
      state.clockStart = performance.now();
      return { closed: true };
    }
    case "licensesShow": {
      overlays.showLicenses();
      return { shown: true };
    }
    case "elapsed": {
      return performance.now() - state.clockStart;
    }
    case "snapshot": {
      const licenses = document.getElementById("licenses-overlay");
      return {
        modal: snapshotModal(),
        isModalActive: overlays.isModalActive,
        current: overlays.currentModalData?.title ?? null,
        queued: overlays.modalQueue.map((data) => data.title),
        counts: { ...state?.counts },
        promises: { ...state?.promises },
        rejections: [...(state?.rejections ?? [])],
        confirm: state?.confirm ?? null,
        licenses: {
          active: licenses.classList.contains("active"),
          overflow: document.body.style.overflow,
          bodyLocked: document.body.classList.contains("licenses-open"),
        },
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
  const result = await browser.execute(overlaysProbe, op, arg);
  if (result?.error) throw new Error(`overlays probe ${op}: ${result.error}`);
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

// Waits until the page clock is `ms` past the last marked time. A condition
// wait, so the check is tied to the page's own timers and not to a host sleep.
async function waitForClock(ms) {
  await browser.waitUntil(async () => (await probe("elapsed")) >= ms, {
    timeout: 10_000,
    interval: 100,
    timeoutMsg: `page clock did not reach ${ms} ms`,
  });
}

// The renderer's queue view can trail the backend by a moment. While it does,
// the confirm resolves true at once and shows nothing, so the call is repeated
// until the real prompt appears.
async function startInterruptConfirm(action) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await probe("confirmInterrupt", action);
    let shown = false;
    await browser
      .waitUntil(
        async () => {
          const current = await snapshot();
          shown =
            current.modal.active &&
            !current.modal.hiding &&
            current.modal.title === "Download in Progress";
          return shown || current.confirm?.settled === true;
        },
        { timeout: 3_000, interval: 50 },
      )
      .catch(() => {});
    if (shown) return;
  }
  throw new Error("the interrupt confirm never showed");
}

// Retires probe prompts, then dismisses any others, so one check cannot leave a
// prompt behind for the next.
async function closeModals() {
  for (let round = 0; round < 12; round += 1) {
    for (const key of [BUSY_KEY, KEYED_KEY]) await probe("retire", key);
    const current = await snapshot();
    if (!current.modal.active && current.queued.length === 0) return;
    if (current.modal.hiding || current.modal.busy || !current.modal.active) {
      await browser
        .waitUntil(async () => !(await snapshot()).modal.hiding, {
          timeout: 2_000,
          interval: 50,
        })
        .catch(() => {});
      continue;
    }
    await probe("escape");
    await browser
      .waitUntil(async () => (await snapshot()).modal.hiding === false, {
        timeout: 2_000,
        interval: 50,
      })
      .catch(() => {});
  }
  throw new Error("could not close the modal stack during cleanup");
}

async function openLicenses() {
  await probe("openLicensesClick");
  await browser.waitUntil(async () => (await snapshot()).licenses.active, {
    timeout: 5_000,
    interval: 100,
    timeoutMsg: "licenses overlay did not open",
  });
}

async function closeLicensesAndWait() {
  const current = await snapshot();
  if (current.licenses.active) await probe("licensesHide");
  await browser.waitUntil(
    async () => {
      const state = (await snapshot()).licenses;
      return !state.active && state.overflow === "" && !state.bodyLocked;
    },
    {
      timeout: 5_000,
      interval: 100,
      timeoutMsg: "licenses cleanup did not finish",
    },
  );
}

function readSource(...segments) {
  return fs.readFileSync(path.join(REPO_ROOT, ...segments), "utf8");
}

describe("ROSI overlays audit: displacement, focus traps, async actions, licenses timer", () => {
  before(async () => {
    await waitForAppReady();
    report.source = sourceIdentity();
    writeReport();
  });

  beforeEach(async () => {
    await probe("install");
    await api("cancelQueue");
    assert.equal((await api("clearQueue")).ok, true);
  });

  afterEach(async () => {
    await probe("sidebarClose").catch(() => {});
    await probe("restoreSection").catch(() => {});
    await closeLicensesAndWait().catch(() => {});
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

  // F2: modal displacement.
  it("F2-1 an unkeyed modal pushed aside by a priority modal is shown again", async () => {
    await scenario("unkeyed-modal-redisplayed", async () => {
      await probe("show", {
        title: "Plain A",
        buttons: [{ label: "Close A" }],
      });
      await waitForTitle("Plain A");
      await probe("show", {
        title: "Priority B",
        priority: true,
        buttons: [{ label: "Close B" }],
      });
      await waitForTitle("Priority B");
      assert.equal(
        await probe("depth", "Plain A"),
        1,
        "the displaced unkeyed modal was dropped",
      );
      await probe("clickButton", "Close B");
      await waitForTitle("Plain A");
      return { redisplayed: "Plain A" };
    });
  });

  it("F2-2 a prompt that waits on a button or dismissal still settles after a displacement", async () => {
    await scenario("unkeyed-promise-settles-after-displacement", async () => {
      await probe("show", {
        title: "Confirm shape",
        priority: true,
        promiseName: "confirm",
        dismissValue: false,
        buttons: [
          { label: "Keep", primary: true, value: false },
          { label: "Stop", value: true },
        ],
      });
      await waitForTitle("Confirm shape");
      await probe("show", {
        title: "Other priority",
        priority: true,
        buttons: [{ label: "Close other" }],
      });
      await waitForTitle("Other priority");
      assert.equal(
        (await snapshot()).promises.confirm.settled,
        false,
        "the promise settled while its prompt was pushed aside",
      );
      await probe("clickButton", "Close other");
      await waitForTitle("Confirm shape");
      await probe("clickButton", "Stop");
      await waitForHidden();
      const settled = (await snapshot()).promises.confirm;
      assert.deepEqual(settled, { settled: true, value: true });
      return { settledValue: settled.value };
    });
  });

  it("F2-3 the real interrupt confirm settles on Escape after a displacement", async () => {
    await scenario("interrupt-confirm-settles-after-displacement", async () => {
      const slow = `${MEDIA}/slow.mp4?overlays-audit=interrupt`;
      assert.equal((await api("addToQueue", [slow])).data.added, 1);
      assert.equal((await api("startQueue")).ok, true);
      await waitForQueueStatus(slow, "downloading");
      await startInterruptConfirm("Restarting ROSI");
      await probe("show", {
        title: "Priority over confirm",
        priority: true,
        buttons: [{ label: "Close over" }],
      });
      await waitForTitle("Priority over confirm");
      await probe("clickButton", "Close over");
      await waitForTitle("Download in Progress");
      await probe("escape");
      await browser.waitUntil(
        async () => (await snapshot()).confirm?.settled === true,
        {
          timeout: 5_000,
          interval: 100,
          timeoutMsg: "confirmInterruptActiveWork never settled",
        },
      );
      const after = await snapshot();
      assert.equal(after.confirm.value, false, "Escape did not keep the work");
      await waitForHidden();
      const item = (await api("getQueue")).find((entry) => entry.url === slow);
      assert.equal(item?.status, "downloading", "the download was stopped");
      return { settledValue: after.confirm.value, queueStatus: item.status };
    });
  });

  it("F2-4 a keyed modal is shown again exactly once", async () => {
    await scenario("keyed-modal-redisplayed-once", async () => {
      await probe("show", {
        title: "Keyed A",
        key: KEYED_KEY,
        buttons: [{ label: "Close keyed" }],
      });
      await waitForTitle("Keyed A");
      await probe("show", {
        title: "Priority K",
        priority: true,
        buttons: [{ label: "Close K" }],
      });
      await waitForTitle("Priority K");
      assert.equal(await probe("depth", "Keyed A"), 1, "queued more than once");
      await probe("clickButton", "Close K");
      await waitForTitle("Keyed A");
      await probe("clickButton", "Close keyed");
      await waitForHidden();
      assert.equal(await probe("depth", "Keyed A"), 0, "it came back again");
      return { shownAgainOnce: true };
    });
  });

  it("F2-5 a busy modal pushed aside is not kept", async () => {
    await scenario("busy-modal-not-requeued", async () => {
      await probe("show", {
        title: "Busy probe",
        key: BUSY_KEY,
        busy: true,
        priority: true,
        buttons: [{ label: "Working...", disabled: true }],
      });
      await waitForTitle("Busy probe");
      await probe("show", {
        title: "Priority over busy",
        priority: true,
        buttons: [{ label: "Close busy-over" }],
      });
      await waitForTitle("Priority over busy");
      await probe("clickButton", "Close busy-over");
      await waitForHidden();
      const after = await snapshot();
      assert.equal(
        await probe("depth", "Busy probe"),
        0,
        "the busy modal came back",
      );
      assert.equal(after.queued.length, 0, "the queue is not empty");
      return { queued: after.queued.length };
    });
  });

  it("F2-6 several displacements come back in reverse order", async () => {
    await scenario("displacement-order-is-kept", async () => {
      await probe("show", {
        title: "Order A",
        buttons: [{ label: "Close oa" }],
      });
      await waitForTitle("Order A");
      await probe("show", {
        title: "Order B",
        priority: true,
        buttons: [{ label: "Close ob" }],
      });
      await waitForTitle("Order B");
      await probe("show", {
        title: "Order C",
        priority: true,
        buttons: [{ label: "Close oc" }],
      });
      await waitForTitle("Order C");
      await probe("clickButton", "Close oc");
      await waitForTitle("Order B");
      await probe("clickButton", "Close ob");
      await waitForTitle("Order A");
      return { order: ["C", "B", "A"] };
    });
  });

  it("F2-7 re-queueing does not run onDismiss", async () => {
    await scenario("displacement-skips-dismiss", async () => {
      await probe("show", {
        title: "Dismiss A",
        dismissCount: "dismissA",
        buttons: [{ label: "Close da" }],
      });
      await waitForTitle("Dismiss A");
      await probe("show", {
        title: "Priority D",
        priority: true,
        buttons: [{ label: "Close D" }],
      });
      await waitForTitle("Priority D");
      await probe("clickButton", "Close D");
      await waitForTitle("Dismiss A");
      const counts = (await snapshot()).counts;
      assert.equal(counts.dismissA ?? 0, 0, "onDismiss ran for a displacement");
      return { dismissCount: counts.dismissA ?? 0 };
    });
  });

  it("F2-8 the skipped-modal path settles the waiter (source)", async () => {
    await scenario("missing-dom-path-calls-dismiss", async () => {
      const source = readSource("src", "engine", "overlays.ts");
      const branch = source.slice(
        source.indexOf("if (!modal || !titleEl || !msgEl || !btnContainer)"),
        source.indexOf("titleEl.textContent = title"),
      );
      assert.match(
        branch,
        /runModalCallback\(displayedModalData\.onDismiss\)/,
        "the skip path does not call onDismiss",
      );
      return { file: "src/engine/overlays.ts" };
    });
  });

  // F8: one focusable helper for the traps.
  it("F8-9 the sidebar trap uses the shared helper (source)", async () => {
    await scenario("sidebar-uses-shared-helper", async () => {
      const ui = readSource("src", "modules", "ui.ts");
      const overlays = readSource("src", "engine", "overlays.ts");
      assert.equal(
        /getSidebarFocusableElements/.test(ui),
        false,
        "ui.ts still has its own sidebar filter",
      );
      assert.match(
        ui,
        /import \{ getFocusableElements \} from '\.\.\/engine\/overlays'/,
      );
      const queries = overlays.match(
        /querySelectorAll<HTMLElement>\(FOCUSABLE_SELECTOR\)/g,
      );
      assert.equal(queries?.length, 1, "overlays.ts has more than one query");
      return { sharedQueries: queries.length };
    });
  });

  it("F8-10 the shared helper drops inert and hidden content", async () => {
    await scenario("helper-drops-inert-and-hidden", async () => {
      const ids = await probe("scratchFocusables");
      assert.deepEqual(ids, ["oa-plain"], `helper returned ${ids}`);
      return { ids };
    });
  });

  it("F8-11 and F8-12 the sidebar trap wraps past a collapsed last section", async () => {
    await scenario("sidebar-wraps-past-collapsed-section", async () => {
      assert.equal((await probe("sidebarOpen")).open, true);
      const section = await probe("collapseLastSection");
      assert.equal(
        section.collapsed,
        true,
        "the last section did not collapse",
      );
      assert.equal(section.bodyInert, true, "the collapsed body is not inert");
      assert.ok(section.controlCount > 0, "the section has no controls");
      const wrap = await probe("sidebarTabWrap");
      assert.equal(wrap.error, undefined, wrap.error);
      assert.equal(wrap.lastInert, false, `last stop ${wrap.lastId} is inert`);
      assert.equal(
        wrap.inertInList,
        0,
        `${wrap.inertInList} inert controls are in the trap list`,
      );
      assert.equal(wrap.focusedLast, true, "could not focus the last stop");
      assert.equal(
        wrap.tabPrevented,
        true,
        "Tab on the last stop did not wrap",
      );
      assert.equal(
        wrap.afterTabIsFirst,
        true,
        `focus went to ${wrap.afterTabId}`,
      );
      assert.equal(wrap.focusedFirst, true, "could not focus the first stop");
      assert.equal(wrap.backPrevented, true, "Shift+Tab did not wrap");
      assert.equal(
        wrap.afterBackIsLast,
        true,
        `focus went to ${wrap.afterBackId}`,
      );
      return {
        stops: wrap.count,
        lastId: wrap.lastId,
        oldLastId: wrap.oldLastId,
        oldInertInList: wrap.oldInertInList,
        firstId: wrap.firstId,
      };
    });
  });

  it("F8-13 the licenses trap still lists the close button before the frame", async () => {
    await scenario("licenses-trap-order-unchanged", async () => {
      await openLicenses();
      const order = await probe("licensesTrapOrder");
      const closeAt = order.indexOf("close-licenses");
      const frameAt = order.indexOf("licenses-frame");
      assert.ok(closeAt >= 0, `close button missing: ${order}`);
      assert.ok(frameAt > closeAt, `frame not after close button: ${order}`);
      return { trapOrder: order };
    });
  });

  // F11: async modal actions.
  it("F11-14 a rejected async button action is handled and the modal closes", async () => {
    await scenario("async-action-rejection-handled", async () => {
      await probe("show", {
        title: "Async action",
        buttons: [{ label: "Boom", asyncThrows: true }],
      });
      await waitForTitle("Async action");
      await probe("show", {
        title: "After async action",
        buttons: [{ label: "OK", primary: true }],
      });
      await probe("clickButton", "Boom");
      await waitForTitle("After async action");
      const after = await snapshot();
      assert.equal(after.counts.asyncAction, 1, "the action did not run once");
      assert.deepEqual(after.rejections, [], "an unhandled rejection escaped");
      assert.equal(after.current, "After async action");
      return { asyncActionCount: after.counts.asyncAction };
    });
  });

  it("F11-15 and F11-16 a rejected async onDismiss is handled and the next modal shows", async () => {
    await scenario("async-dismiss-rejection-handled", async () => {
      await probe("show", {
        title: "Async dismiss",
        asyncDismiss: true,
        buttons: [{ label: "Later" }],
      });
      await waitForTitle("Async dismiss");
      await probe("show", {
        title: "After async dismiss",
        buttons: [{ label: "OK", primary: true }],
      });
      await probe("escape");
      await waitForTitle("After async dismiss");
      const after = await snapshot();
      assert.equal(after.counts.asyncDismiss, 1, "onDismiss did not run once");
      assert.deepEqual(after.rejections, [], "an unhandled rejection escaped");
      assert.equal(after.isModalActive, true);
      assert.equal(after.current, "After async dismiss");
      return { asyncDismissCount: after.counts.asyncDismiss };
    });
  });

  it("F11-17 both callback paths log through logError (source)", async () => {
    await scenario("modal-callback-failures-are-logged", async () => {
      const source = readSource("src", "engine", "overlays.ts");
      const start = source.indexOf("function runModalCallback");
      const body = source.slice(
        start,
        source.indexOf("export function displayNextModal"),
      );
      const logged = body.match(/logError\('Modal action failed'/g) ?? [];
      assert.equal(logged.length, 2, "sync and async paths must both log");
      return { logCalls: logged.length };
    });
  });

  // F12: licenses cleanup timer.
  it("F12-18 reopening licenses inside the cleanup window keeps the scroll lock", async () => {
    await scenario("licenses-reopen-keeps-scroll-lock", async () => {
      await openLicenses();
      await probe("licensesHideShow");
      await waitForClock(450);
      const state = (await snapshot()).licenses;
      assert.equal(state.active, true, "the overlay is not open");
      assert.equal(state.overflow, "hidden", "the scroll lock was lost");
      assert.equal(state.bodyLocked, true, "licenses-open was removed");
      return state;
    });
  });

  it("F12-19 a plain close clears the lock and a reopen takes it again", async () => {
    await scenario("licenses-close-clears-then-reopen-locks", async () => {
      await openLicenses();
      await probe("licensesHide");
      await browser.waitUntil(
        async () => {
          const state = (await snapshot()).licenses;
          return state.overflow === "" && !state.bodyLocked;
        },
        {
          timeout: 5_000,
          interval: 100,
          timeoutMsg: "the close cleanup never ran",
        },
      );
      await probe("licensesShow");
      const state = (await snapshot()).licenses;
      assert.equal(state.active, true);
      assert.equal(state.overflow, "hidden");
      assert.equal(state.bodyLocked, true);
      return state;
    });
  });

  it("F12-20 hide, show, hide leaves one cleanup and a closed view", async () => {
    await scenario("licenses-hide-show-hide-cleans-once", async () => {
      await openLicenses();
      await probe("licensesHideShowHide");
      await waitForClock(450);
      const state = (await snapshot()).licenses;
      assert.equal(state.active, false, "the overlay is still open");
      assert.equal(state.overflow, "", "the scroll lock stayed");
      assert.equal(state.bodyLocked, false, "licenses-open stayed");
      return state;
    });
  });
});
