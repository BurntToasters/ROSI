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
  modalState,
  waitForAppReady,
  waitForModal,
} from "../../helpers/ui.js";
import { REPO_ROOT } from "../../helpers/profile.js";

// Failure modes are numbered in queue-format-feedback.failure-modes.md. Each
// check lists the rows it covers. Nothing here sleeps for a fixed time: every
// wait polls a state the renderer or the backend sets.

const MEDIA = process.env.ROSI_E2E_MEDIA_URL;
const TERMINAL = ["completed", "failed", "cancelled"];
const IDLE_CONFIRM = "Remove all queued and completed items?";
const URL_EMPTY = "Please enter a video URL first.";
const URL_INVALID =
  "Please enter a valid URL starting with http:// or https://";

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-queue-format-feedback-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-queue-format-feedback",
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
// queue-format-feedback.failure-modes.md that the case exercises.
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

// Records each toast as it is added, with its type, so a toast the renderer
// caps out of the container is still counted.
async function installToastLog() {
  await browser.execute(() => {
    window.__queueFormatToastObserver?.disconnect();
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
    window.__queueFormatToastObserver = observer;
    window.__queueFormatToasts = toasts;
  });
}

async function toastEntries() {
  return browser.execute(() => [...window.__queueFormatToasts]);
}

async function clearQueueDisabled() {
  return browser.execute(
    () => document.getElementById("clearQueueBtn").disabled,
  );
}

async function waitForClearQueueDisabled(want, message) {
  await browser.waitUntil(async () => (await clearQueueDisabled()) === want, {
    timeout: 10_000,
    interval: 150,
    timeoutMsg: message,
  });
}

async function emptyQueue() {
  if ((await api("getQueue")).length === 0) return;
  const result = await api("clearQueue");
  assert.equal(result.ok, true, "clearQueue failed");
  await browser.waitUntil(async () => (await api("getQueue")).length === 0, {
    timeout: 30_000,
    interval: 250,
    timeoutMsg: "queue did not empty",
  });
}

// Adds one link through the visible Add to queue path.
async function addUrlThroughQueueField(url) {
  await browser.execute((value) => {
    const input = document.getElementById("queueUrlInput");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, url);
  await clickById("addToQueueBtn");
}

async function setUrlField(value) {
  await browser.execute((next) => {
    document.getElementById("url").value = next;
  }, value);
}

// Waits for a warning toast with this exact text that was added after `from`.
async function waitForToast(from, text, type, message) {
  await browser.waitUntil(
    async () =>
      (await toastEntries())
        .slice(from)
        .some((entry) => entry.text === text && entry.type === type),
    { timeout: 10_000, interval: 150, timeoutMsg: message },
  );
}

describe("ROSI queue and format picker feedback", () => {
  before(async () => {
    await waitForAppReady();
    report.source = sourceIdentity();
    await installToastLog();
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

  it("disables Clear Queue on an empty queue and enables it once items exist", async () =>
    scenario("clear-queue-gated-on-queue", [1, 2, 3, 4], async () => {
      assert.ok(MEDIA, "ROSI_E2E_MEDIA_URL is not set");
      await emptyQueue();
      await waitForClearQueueDisabled(
        true,
        "Clear Queue was enabled on an empty queue",
      );

      await addUrlThroughQueueField(
        `${MEDIA}/clip-one.mp4?ui=queue-feedback-gate`,
      );
      await browser.waitUntil(
        async () => (await api("getQueue")).length === 1,
        { timeout: 15_000, interval: 150, timeoutMsg: "item was not queued" },
      );
      await waitForClearQueueDisabled(
        false,
        "Clear Queue stayed disabled after an item arrived",
      );

      const cleared = await api("clearQueue");
      assert.equal(cleared.ok, true, "clearQueue failed");
      await waitForClearQueueDisabled(
        true,
        "Clear Queue stayed enabled after the queue emptied",
      );
      return { emptyDisabled: true, itemEnabled: true };
    }));

  it("words the Clear Queue confirm for a running item and keeps items on Cancel", async () =>
    scenario("clear-queue-confirm-wording", [6, 7, 8], async () => {
      assert.ok(MEDIA, "ROSI_E2E_MEDIA_URL is not set");
      await emptyQueue();
      await addUrlThroughQueueField(
        `${MEDIA}/clip-one.mp4?ui=queue-feedback-idle`,
      );
      await browser.waitUntil(
        async () => (await api("getQueue")).length === 1,
        {
          timeout: 15_000,
          interval: 150,
          timeoutMsg: "idle item was not queued",
        },
      );
      await waitForClearQueueDisabled(
        false,
        "Clear Queue stayed disabled before the idle confirm",
      );

      await clickById("clearQueueBtn");
      const idle = await waitForModal("Clear Queue");
      assert.equal(
        idle.message,
        IDLE_CONFIRM,
        "idle Clear Queue confirm changed or mentions a stop",
      );
      await clickModalButton("Cancel");
      await waitForModal(false);
      assert.equal(
        (await api("getQueue")).length,
        1,
        "Cancel on the idle confirm removed an item",
      );

      await emptyQueue();

      const slow = `${MEDIA}/slow.mp4?ui=queue-feedback-running`;
      assert.equal((await api("addToQueue", [slow])).data.added, 1);
      assert.equal((await api("startQueue")).ok, true, "startQueue failed");
      await browser.waitUntil(
        async () =>
          (await api("getQueue")).some(
            (item) => item.url === slow && item.status === "downloading",
          ),
        {
          timeout: 30_000,
          interval: 250,
          timeoutMsg: "queued item never started downloading",
        },
      );
      await waitForClearQueueDisabled(
        false,
        "Clear Queue was disabled while an item downloads",
      );

      await clickById("clearQueueBtn");
      const running = await waitForModal("Clear Queue");
      assert.match(
        running.message,
        /current download will be stopped too/,
        "running Clear Queue confirm does not say the download stops",
      );
      await clickModalButton("Cancel");
      await waitForModal(false);
      assert.equal(
        (await api("getQueue")).length,
        1,
        "Cancel on the running confirm removed an item",
      );

      assert.equal((await api("cancelQueue")).ok, true, "cancelQueue failed");
      await browser.waitUntil(
        async () =>
          (await api("getQueue")).every((item) =>
            TERMINAL.includes(item.status),
          ),
        {
          timeout: 60_000,
          interval: 250,
          timeoutMsg: "queue did not reach a terminal state after cancel",
        },
      );
      await emptyQueue();
      return { idleMessage: idle.message, runningMessage: running.message };
    }));

  it("shows format picker input errors as warning toasts, not modals", async () =>
    scenario("format-input-errors-are-toasts", [9, 10, 11], async () => {
      await setUrlField("");
      const emptyFrom = (await toastEntries()).length;
      await clickById("fetchFormatsBtn");
      await waitForToast(
        emptyFrom,
        URL_EMPTY,
        "warning",
        "empty URL did not show a warning toast",
      );
      // The handler shows the toast and any modal in one synchronous pass,
      // so the modal state is final once the toast is observed.
      assert.equal(
        (await modalState()).active,
        false,
        "an empty URL opened a modal",
      );

      await setUrlField("notaurl");
      const invalidFrom = (await toastEntries()).length;
      await clickById("fetchFormatsBtn");
      await waitForToast(
        invalidFrom,
        URL_INVALID,
        "warning",
        "invalid URL did not show a warning toast",
      );
      assert.equal(
        (await modalState()).active,
        false,
        "an invalid URL opened a modal",
      );

      await setUrlField("");
      return { emptyUrlToast: true, invalidUrlToast: true };
    }));
});
