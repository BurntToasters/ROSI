import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import {
  api,
  restoreBridge,
  setControl,
  stubBridge,
  stubCalls,
  waitFor,
  waitForAppReady,
  waitForBackendSetting,
} from "../../helpers/ui.js";
import { REPO_ROOT } from "../../helpers/profile.js";

// Rows are numbered in wording.failure-modes.md. Each check lists the rows it covers.

const MEDIA = process.env.ROSI_E2E_MEDIA_URL;
const NEWER_VERSION_TEXT =
  "A newer ROSI version saved these settings. Changes made here are not kept.";

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-wording-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-wording",
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
// wording.failure-modes.md that the case exercises.
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

// Waits until the predicate holds before the deadline (ms since epoch).
async function waitUntilBefore(predicate, deadline, message) {
  await browser.waitUntil(predicate, {
    timeout: Math.max(200, deadline - Date.now()),
    interval: 100,
    timeoutMsg: message,
  });
}

// Polls the toast until `deadline` (ms since epoch). The first poll where
// `ok` fails is returned at once; otherwise the last status. Replaces a blind
// wait: the toast must stay in the wanted state for the whole span.
async function holdToastUntil(
  text,
  deadline,
  ok = (status) => status.present && !status.hiding,
) {
  let last = null;
  let broken = null;
  await browser.waitUntil(
    async () => {
      last = await toastStatus(text);
      if (!ok(last)) {
        broken = last;
        return true;
      }
      return Date.now() >= deadline;
    },
    {
      timeout: Math.max(1_000, deadline - Date.now() + 2_000),
      interval: 100,
      timeoutMsg: `toast hold did not finish: ${text}`,
    },
  );
  return broken ?? last;
}

// The manual download handler ran: the button is idle and the progress bar,
// which the completion handler hides after 2 s, is gone.
async function waitForManualCompletionHandled() {
  await waitFor(
    () =>
      !document
        .getElementById("progress-container")
        ?.classList.contains("visible") &&
      !document.getElementById("downloadBtn")?.classList.contains("loading"),
    "the manual download completion was not handled",
    15_000,
  );
}

// Records every download completion the renderer receives, for waits.
async function installCompletionLog() {
  await browser.execute(() => {
    window.__wordingCompletions?.unsubscribe?.();
    const log = { list: [], unsubscribe: null };
    window.__wordingCompletions = log;
    log.unsubscribe = window.__ROSI_E2E__.api.onDownloadComplete(
      (completion) => {
        log.list.push({
          url: completion.url,
          outcome: completion.outcome,
          owner: completion.owner,
        });
      },
    );
  });
}

async function completionFor(url, timeout = 120_000) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (target) =>
          (window.__wordingCompletions?.list ?? []).some(
            (entry) => entry.url === target,
          ),
        url,
      ),
    { timeout, interval: 300, timeoutMsg: `no completion for ${url}` },
  );
  return browser.execute(
    (target) =>
      window.__wordingCompletions.list.find((entry) => entry.url === target),
    url,
  );
}

// Types the link into the URL field the way a user does, then presses Download.
async function startManualDownload(url) {
  await (await browser.$("#url")).setValue(url);
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const button = document.getElementById("downloadBtn");
        return (
          Boolean(button) &&
          !button.disabled &&
          !button.classList.contains("loading")
        );
      }),
    { timeout: 15_000, timeoutMsg: "Download button never became ready" },
  );
  await (await browser.$("#downloadBtn")).click();
}

// Sets the URL field without the user path, so the test controls validation timing.
async function setUrlField(value, blur) {
  await browser.execute(
    (text, doBlur) => {
      const input = document.getElementById("url");
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (doBlur) input.dispatchEvent(new Event("blur", { bubbles: true }));
    },
    value,
    blur,
  );
}

async function summaryState() {
  return browser.execute(() => {
    const summary = document.getElementById("downloadOutputSummary");
    return {
      state: summary?.dataset.state ?? null,
      text: summary?.textContent.trim() ?? "",
    };
  });
}

async function clearToasts() {
  await browser.execute(() =>
    document.querySelectorAll(".toast").forEach((node) => node.remove()),
  );
}

async function openToast(message, type, duration) {
  await browser.execute(
    (text, kind, ms) => {
      const options = { type: kind };
      if (ms !== null) options.duration = ms;
      window.__ROSI_E2E__.modules.ui.showToast(text, options);
    },
    message,
    type,
    duration ?? null,
  );
  return Date.now();
}

async function toastStatus(message) {
  return browser.execute((text) => {
    const toast = [...document.querySelectorAll(".toast")].find(
      (node) => node.querySelector(".toast-message")?.textContent === text,
    );
    if (!toast) return { present: false, hiding: false };
    return {
      present: true,
      hiding: toast.classList.contains("hiding"),
    };
  }, message);
}

// Dispatches a pointer or focus event on the toast. Real hover and focus are
// used where the window has focus; the events are the ones the toast listens for.
async function dispatchOnToast(message, type) {
  await browser.execute(
    (text, kind) => {
      const toast = [...document.querySelectorAll(".toast")].find(
        (node) => node.querySelector(".toast-message")?.textContent === text,
      );
      if (!toast) throw new Error(`toast not found: ${text}`);
      if (kind === "mouseenter" || kind === "mouseleave") {
        toast.dispatchEvent(new MouseEvent(kind));
      } else {
        toast.dispatchEvent(
          new FocusEvent(kind, { bubbles: true, relatedTarget: null }),
        );
      }
    },
    message,
    type,
  );
}

async function focusToastButton(message) {
  return browser.execute((text) => {
    const toast = [...document.querySelectorAll(".toast")].find(
      (node) => node.querySelector(".toast-message")?.textContent === text,
    );
    const button = toast?.querySelector(".toast-dismiss");
    if (!button) throw new Error(`toast dismiss button not found: ${text}`);
    // Without window focus, focus() moves activeElement but fires no focusin.
    if (document.hasFocus()) button.focus();
    if (document.hasFocus() && document.activeElement === button)
      return "focus";
    toast.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    return "synthetic";
  }, message);
}

async function blurToastButton(message) {
  return browser.execute((text) => {
    const toast = [...document.querySelectorAll(".toast")].find(
      (node) => node.querySelector(".toast-message")?.textContent === text,
    );
    const button = toast?.querySelector(".toast-dismiss");
    if (!button) throw new Error(`toast dismiss button not found: ${text}`);
    if (document.activeElement === button) button.blur();
    else
      button.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
      );
  }, message);
}

describe("ROSI wording, manual notifications, and toast timing", () => {
  before(async () => {
    await waitForAppReady();
    report.source = sourceIdentity();
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

  it("shows exactly one error line for an invalid URL", async () =>
    scenario("invalid-url-one-error-line", [1, 2, 4], async () => {
      await setUrlField("not a URL", true);
      await waitFor(
        () =>
          document.getElementById("downloadOutputSummary")?.dataset.state ===
          "invalid-url",
        "summary never reached invalid-url",
      );
      const seen = await browser.execute(() => {
        const lines = [
          "urlValidationMessage",
          "downloadOutputSummary",
          "downloadReadiness",
        ].map((id) => {
          const element = document.getElementById(id);
          const rect = element?.getBoundingClientRect();
          const shown =
            Boolean(element) &&
            !element.hidden &&
            rect.height > 0 &&
            getComputedStyle(element).display !== "none";
          return {
            id,
            text: element?.textContent.trim() ?? "",
            shown,
            tone: element?.dataset.tone ?? null,
            height: rect ? rect.height : 0,
          };
        });
        const summary = document.getElementById("downloadOutputSummary");
        return {
          lines,
          summaryText: summary?.textContent.trim() ?? null,
          summaryHeight: summary?.getBoundingClientRect().height ?? null,
          invalid: document.getElementById("url")?.getAttribute("aria-invalid"),
        };
      });
      // A readiness hint with tone "warning" or "info" is not an error line here.
      const errorLines = seen.lines.filter(
        (line) =>
          line.shown &&
          line.text.length > 0 &&
          (line.id !== "downloadReadiness" || line.tone === "error"),
      );
      assert.equal(
        errorLines.length,
        1,
        `expected one visible error line, saw ${JSON.stringify(errorLines)}`,
      );
      assert.equal(errorLines[0].id, "urlValidationMessage");
      assert.equal(seen.summaryText, "", "summary still shows text");
      assert.ok(
        seen.summaryHeight <= 1,
        `empty summary takes ${seen.summaryHeight}px`,
      );
      assert.equal(seen.invalid, "true", "URL field is not marked invalid");
      return { errorLines: errorLines.map((line) => line.id) };
    }));

  it("leaves the invalid-URL state when the URL is fixed", async () =>
    scenario("invalid-url-recovers", [3], async () => {
      await setUrlField(
        "https://www.youtube.com/watch?v=wording-recover",
        false,
      );
      await browser.waitUntil(
        async () => {
          const summary = await summaryState();
          return summary.state !== "invalid-url" && summary.text.length > 0;
        },
        {
          timeout: 10_000,
          interval: 150,
          timeoutMsg: "summary stayed empty after the URL was fixed",
        },
      );
      const summary = await summaryState();
      await setUrlField("", false);
      return { state: summary.state };
    }));

  it("names only the missing URL when the save location is set", async () =>
    scenario("hint-names-only-missing-url", [5], async () => {
      const original = (await api("getSettings")).askDownloadLocation;
      // Turning the toggle off with no folder opens a picker. Answer it with no choice.
      await stubBridge("selectDownloadLocation", null);
      try {
        await setUrlField("", false);
        await setControl("askDownloadLocationToggle", false);
        await waitForBackendSetting(
          "askDownloadLocation",
          false,
          "ask-every-time did not save as off",
        );
        await waitFor(
          () =>
            /Enter a valid URL to see what this download will use/.test(
              document.getElementById("downloadOutputSummary")?.textContent ??
                "",
            ),
          "hint did not name only the URL",
        );
        const summary = await summaryState();
        assert.equal(summary.state, "profile-preview");
        assert.doesNotMatch(summary.text, /save location/i);
        return { hint: summary.text };
      } finally {
        await setControl("askDownloadLocationToggle", original);
        await waitForBackendSetting(
          "askDownloadLocation",
          original,
          "ask-every-time was not restored",
        );
        await restoreBridge();
      }
    }));

  it("adds the missing save location to the hint when the toggle changes", async () =>
    scenario("hint-updates-on-location-toggle", [6, 7], async () => {
      const original = (await api("getSettings")).askDownloadLocation;
      await stubBridge("selectDownloadLocation", null);
      try {
        await setUrlField("", false);
        await setControl("askDownloadLocationToggle", false);
        await waitForBackendSetting(
          "askDownloadLocation",
          false,
          "ask-every-time did not save as off",
        );
        await waitFor(
          () =>
            /Enter a valid URL to see what this download will use/.test(
              document.getElementById("downloadOutputSummary")?.textContent ??
                "",
            ),
          "hint did not start from the URL-only wording",
        );
        // No URL edit: only the location toggle changes.
        await setControl("askDownloadLocationToggle", true);
        await waitForBackendSetting(
          "askDownloadLocation",
          true,
          "ask-every-time did not save as on",
        );
        await waitFor(
          () =>
            /Enter a valid URL and choose a save location to see what this download will use/.test(
              document.getElementById("downloadOutputSummary")?.textContent ??
                "",
            ),
          "hint did not add the save location after the toggle changed",
          5_000,
        );
        const summary = await summaryState();
        return { hint: summary.text };
      } finally {
        await setControl("askDownloadLocationToggle", original);
        await waitForBackendSetting(
          "askDownloadLocation",
          original,
          "ask-every-time was not restored",
        );
        await restoreBridge();
      }
    }));

  it("uses the newer-version wording for a NEWER_VERSION save", async () =>
    scenario("newer-version-wording", [8], async () => {
      const value = await browser.execute(
        () => window.rosiMessages?.settings?.newerVersion ?? null,
      );
      assert.equal(value, NEWER_VERSION_TEXT, "newer-version text is wrong");
      // The backend answers a save with NEWER_VERSION. The stub stands in for
      // that answer, and the save path must show the sentence to the user.
      const original = (await api("getSettings")).askDownloadLocation;
      await stubBridge("saveSettings", {
        ok: false,
        error: { code: "NEWER_VERSION", message: "newer settings file" },
      });
      try {
        await setControl("askDownloadLocationToggle", !original);
        await waitFor(
          (expected) =>
            (
              document.getElementById("settingsSaveFeedback")?.textContent ?? ""
            ).includes(expected),
          "the newer-version sentence did not reach #settingsSaveFeedback",
          10_000,
          NEWER_VERSION_TEXT,
        );
        const saveCalls = await stubCalls("saveSettings");
        assert.ok(saveCalls.length >= 1, "the save never reached the stub");
      } finally {
        await restoreBridge();
        await setControl("askDownloadLocationToggle", original);
        await waitForBackendSetting(
          "askDownloadLocation",
          original,
          "ask-every-time was not restored",
        );
      }
      return { text: value };
    }));

  it("has no user-facing 'effective options' text", async () =>
    scenario("no-effective-options-in-messages", [9, 10], async () => {
      const strings = await browser.execute(() => {
        const out = [];
        const walk = (value, depth) => {
          if (typeof value === "string") out.push(value);
          else if (typeof value === "function") {
            // Sample arguments cover every message shape.
            const result = value("sample", true, false, 2);
            if (typeof result === "string") out.push(result);
          } else if (value && typeof value === "object" && depth < 6) {
            for (const child of Object.values(value)) walk(child, depth + 1);
          }
        };
        walk(window.rosiMessages, 0);
        return out;
      });
      assert.ok(
        strings.length > 20,
        `message walk found only ${strings.length} strings`,
      );
      const offending = strings.filter((text) =>
        /effective options/i.test(text),
      );
      assert.deepEqual(offending, [], "a message still says effective options");

      await setUrlField("", false);
      await waitFor(
        () =>
          document.getElementById("downloadOutputSummary")?.dataset.state ===
          "profile-preview",
        "summary did not return to the profile preview",
      );
      const rendered = await summaryState();
      assert.doesNotMatch(rendered.text, /effective options/i);
      return { checkedStrings: strings.length };
    }));

  it("sends exactly one Download Failed notification for a manual failure and none when notifications are off", async () =>
    scenario(
      "manual-failure-one-notification",
      [12, 13, 14, 16, 17],
      async () => {
        const original = (await api("getSettings")).notifications;
        await installCompletionLog();
        await setControl("notificationsToggle", true);
        await waitForBackendSetting(
          "notifications",
          true,
          "notifications were not saved on",
        );
        await stubBridge("showNotification", { ok: true });
        try {
          const onUrl = `${MEDIA}/missing.mp4?wording=manual-fail-on`;
          await startManualDownload(onUrl);
          const completed = await completionFor(onUrl);
          assert.equal(completed.outcome, "failed", "download did not fail");
          await waitFor(
            () =>
              (window.__rosiStubs?.calls ?? []).some(
                (call) => call.name === "showNotification",
              ),
            "the failure did not send a notification",
            15_000,
          );
          await waitForManualCompletionHandled();
          const calls = await stubCalls("showNotification");
          assert.equal(
            calls.length,
            1,
            `a manual failure sent ${calls.length} notification(s)`,
          );
          const [options] = calls[0];
          assert.equal(options.title, "Download Failed");
          assert.ok(
            typeof options.body === "string" && options.body.length > 0,
            "failure notification has no body",
          );
          assert.ok(
            !options.body.includes("\n") && options.body.length <= 160,
            `failure body is ${options.body.length} characters or multi-line`,
          );

          // With notifications off, a second failure sends nothing.
          await setControl("notificationsToggle", false);
          await waitForBackendSetting(
            "notifications",
            false,
            "notifications were not saved off",
          );
          const before = (await stubCalls("showNotification")).length;
          const offUrl = `${MEDIA}/missing.mp4?wording=manual-fail-off`;
          await startManualDownload(offUrl);
          const offCompleted = await completionFor(offUrl);
          assert.equal(
            offCompleted.outcome,
            "failed",
            "second download did not fail",
          );
          await waitForManualCompletionHandled();
          const offSent = (await stubCalls("showNotification")).length - before;
          assert.equal(
            offSent,
            0,
            `a failure with notifications off sent ${offSent} notification(s)`,
          );
          return {
            notifications: calls.length,
            title: options.title,
            body: options.body,
            offNotifications: offSent,
          };
        } finally {
          await restoreBridge();
          await setControl("notificationsToggle", original);
          await waitForBackendSetting(
            "notifications",
            original,
            "notifications were not restored",
          );
        }
      },
    ));

  it("sends no notification when a manual download is cancelled", async () =>
    scenario("manual-cancel-no-notification", [15], async () => {
      const original = (await api("getSettings")).notifications;
      await installCompletionLog();
      await setControl("notificationsToggle", true);
      await waitForBackendSetting(
        "notifications",
        true,
        "notifications were not saved on",
      );
      await stubBridge("showNotification", { ok: true });
      try {
        const url = `${MEDIA}/slow.mp4?wording=manual-cancel`;
        await startManualDownload(url);
        await browser.waitUntil(
          () =>
            browser.execute(() =>
              document
                .getElementById("downloadBtn")
                ?.classList.contains("loading"),
            ),
          { timeout: 30_000, timeoutMsg: "manual download never started" },
        );
        await api("cancelDownload");
        const completed = await completionFor(url, 60_000);
        assert.equal(
          completed.outcome,
          "cancelled",
          "download was not cancelled",
        );
        await waitForManualCompletionHandled();
        const calls = await stubCalls("showNotification");
        assert.equal(
          calls.length,
          0,
          `a cancelled download sent ${calls.length} notification(s)`,
        );
        return { notifications: 0 };
      } finally {
        await restoreBridge();
        await setControl("notificationsToggle", original);
        await waitForBackendSetting(
          "notifications",
          original,
          "notifications were not restored",
        );
      }
    }));

  it("keeps an error toast for about 8 s and removes it by 9.5 s", async () =>
    scenario("error-toast-timing", [18, 19], async () => {
      await clearToasts();
      const text = `wording error ${Date.now()}`;
      const started = await openToast(text, "error");
      const at6 = await holdToastUntil(text, started + 6_000);
      assert.equal(
        at6.present && !at6.hiding,
        true,
        `error toast was not visible at 6 s: ${JSON.stringify(at6)}`,
      );
      await waitUntilBefore(
        async () => !(await toastStatus(text)).present,
        started + 9_500,
        "error toast was still present at 9.5 s",
      );
      return { visibleAt6s: true, goneBy9_5s: true };
    }));

  it("keeps a warning toast for about 8 s and removes it by 9.5 s", async () =>
    scenario("warning-toast-timing", [20], async () => {
      await clearToasts();
      const text = `wording warning ${Date.now()}`;
      const started = await openToast(text, "warning");
      const at6 = await holdToastUntil(text, started + 6_000);
      assert.equal(
        at6.present && !at6.hiding,
        true,
        `warning toast was not visible at 6 s: ${JSON.stringify(at6)}`,
      );
      await waitUntilBefore(
        async () => !(await toastStatus(text)).present,
        started + 9_500,
        "warning toast was still present at 9.5 s",
      );
      return { visibleAt6s: true, goneBy9_5s: true };
    }));

  it("honors an explicit toast duration over the error default", async () =>
    scenario("explicit-duration-wins", [21], async () => {
      await clearToasts();
      const text = `wording explicit ${Date.now()}`;
      const started = await openToast(text, "error", 1_500);
      await waitUntilBefore(
        async () => !(await toastStatus(text)).present,
        started + 3_000,
        "explicit 1.5 s error toast was still present at 3 s",
      );
      return { goneBy3s: true };
    }));

  it("keeps the info toast default at 4 s", async () =>
    scenario("info-toast-unchanged", [22], async () => {
      await clearToasts();
      const text = `wording info ${Date.now()}`;
      const started = await openToast(text, "info");
      const at1 = await holdToastUntil(
        text,
        started + 1_000,
        (status) => status.present,
      );
      assert.equal(at1.present, true, "info toast did not appear");
      await waitUntilBefore(
        async () => !(await toastStatus(text)).present,
        started + 5_500,
        "info toast was still present at 5.5 s",
      );
      return { goneBy5_5s: true };
    }));

  it("pauses an error toast while it is hovered and resumes on leave", async () =>
    scenario("hover-pauses-toast", [23, 24], async () => {
      await clearToasts();
      const text = `wording hover ${Date.now()}`;
      const started = await openToast(text, "error");
      await holdToastUntil(text, started + 2_000);
      await dispatchOnToast(text, "mouseenter");
      const whileHovered = await holdToastUntil(text, started + 9_500);
      assert.equal(
        whileHovered.present && !whileHovered.hiding,
        true,
        `hovered error toast dismissed: ${JSON.stringify(whileHovered)}`,
      );
      await dispatchOnToast(text, "mouseleave");
      const leftAt = Date.now();
      const afterLeave = await holdToastUntil(text, leftAt + 1_000);
      assert.equal(
        afterLeave.present && !afterLeave.hiding,
        true,
        "toast dismissed right after the pointer left",
      );
      // About 6 s of the 8 s default remained when the pointer left.
      await waitUntilBefore(
        async () => !(await toastStatus(text)).present,
        leftAt + 7_500,
        "toast did not dismiss after the hover resumed",
      );
      return { hoveredAt: "9.5s", resumedAfterLeave: true };
    }));

  it("pauses an error toast while its dismiss button has focus", async () =>
    scenario("focus-pauses-toast", [25], async () => {
      await clearToasts();
      const text = `wording focus ${Date.now()}`;
      const started = await openToast(text, "error");
      await holdToastUntil(text, started + 1_000);
      const focusMode = await focusToastButton(text);
      const whileFocused = await holdToastUntil(text, started + 9_500);
      assert.equal(
        whileFocused.present && !whileFocused.hiding,
        true,
        `focused error toast dismissed: ${JSON.stringify(whileFocused)}`,
      );
      await blurToastButton(text);
      const blurredAt = Date.now();
      const afterBlur = await holdToastUntil(text, blurredAt + 1_000);
      assert.equal(
        afterBlur.present && !afterBlur.hiding,
        true,
        "toast dismissed right after focus left",
      );
      await waitUntilBefore(
        async () => !(await toastStatus(text)).present,
        blurredAt + 8_000,
        "toast did not dismiss after focus left",
      );
      return { focusMode, resumedAfterBlur: true };
    }));

  it("announces each toast through one live region", async () =>
    scenario("one-live-mechanism", [26, 27], async () => {
      await clearToasts();
      const errorText = `wording live error ${Date.now()}`;
      const infoText = `wording live info ${Date.now()}`;
      // Persistent toasts (duration 0) so the check is not timing-dependent.
      await openToast(errorText, "error", 0);
      await openToast(infoText, "info", 0);
      // Reads the DOM without throwing in the page: a missing toast is
      // reported as null with every toast text that is present, so a failure
      // names the cause instead of a WebDriver error.
      // The page returns a flat list and the matching runs here: the embedded
      // WebDriver refused the earlier nested-closure script on Windows.
      const readToasts = async () => {
        const present = await browser.execute(() =>
          [...document.querySelectorAll(".toast")].map((node) => ({
            text: node.querySelector(".toast-message")?.textContent ?? "",
            parent: node.parentElement?.id ?? null,
            ownRole: node.getAttribute("role"),
            ownLive: node.getAttribute("aria-live"),
            region: node.closest("[aria-live]")?.id ?? null,
            regionLive:
              node.closest("[aria-live]")?.getAttribute("aria-live") ?? null,
          })),
        );
        const pick = (text) => {
          const toast = present.find((entry) => entry.text === text);
          if (!toast) return null;
          const { ownRole, ownLive, region, regionLive } = toast;
          return { ownRole, ownLive, region, regionLive };
        };
        return {
          error: pick(errorText),
          info: pick(infoText),
          present: present.map(({ text, parent }) => ({ text, parent })),
        };
      };
      let latest = null;
      await browser
        .waitUntil(
          async () => {
            latest = await readToasts();
            return latest.error !== null && latest.info !== null;
          },
          { timeout: 5_000, interval: 100 },
        )
        .catch((error) => {
          throw new Error(
            `persistent toasts never reached the DOM (${error.message}); present: ${JSON.stringify(latest?.present)}`,
          );
        });
      const seen = latest;
      assert.notEqual(
        seen.error,
        null,
        `error toast missing; present: ${JSON.stringify(seen.present)}`,
      );
      assert.notEqual(
        seen.info,
        null,
        `info toast missing; present: ${JSON.stringify(seen.present)}`,
      );
      assert.equal(
        seen.error.ownRole,
        null,
        "error toast carries its own role",
      );
      assert.equal(
        seen.error.ownLive,
        null,
        "error toast carries its own aria-live",
      );
      assert.equal(seen.error.region, "toast-container-assertive");
      assert.equal(seen.error.regionLive, "assertive");
      assert.equal(seen.info.ownRole, null, "info toast carries its own role");
      assert.equal(
        seen.info.ownLive,
        null,
        "info toast carries its own aria-live",
      );
      assert.equal(seen.info.region, "toast-container");
      assert.equal(seen.info.regionLive, "polite");
      await clearToasts();
      return { error: seen.error, info: seen.info };
    }));
});
