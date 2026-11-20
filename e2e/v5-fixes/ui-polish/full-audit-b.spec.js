import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import {
  api,
  reloadRenderer,
  restoreBridge,
  setControl,
  stubBridge,
  stubCalls,
  waitFor,
  waitForAppReady,
} from "../../helpers/ui.js";
import { REPO_ROOT } from "../../helpers/profile.js";

// Rows are numbered in full-audit-b.failure-modes.md. Each check lists the rows it covers.

const MEDIA = process.env.ROSI_E2E_MEDIA_URL;
const DOWNLOADS = process.env.ROSI_E2E_DOWNLOADS;
const MAIN_URL = `${MEDIA}/audit-b/main.mp4`;
const QUEUED_A = `${MEDIA}/audit-b/queued-a.mp4`;
const QUEUED_B = `${MEDIA}/audit-b/queued-b.mp4`;
// Served as 404 by the local media server, so the queued download fails without network.
const FAILED_URL = `${MEDIA}/missing.mp4?audit-b=failed-row`;
const BLOCKED_MESSAGE = "Fix the playlist range before adding to the queue.";
const FOLDER_HINT = "No folder set. Downloads save to your Downloads folder.";

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-ui-polish",
  `${stamp}-full-audit-b-${process.pid}`,
);
const reportPath = path.join(artifactDir, "report.json");
const report = {
  suite: "v5-fixes-ui-polish-full-audit-b",
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
// full-audit-b.failure-modes.md that the case exercises.
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

// The auto preview starts 450 ms after the URL changes (PREVIEW_DEBOUNCE_MS)
// and then runs the real lookup. The preview controller state is not exposed to
// the page, so this stays a sleep. A hook counter for the pending preview timer
// or the fetch in flight would replace it.
const AUTO_PREVIEW_SETTLE_MS = 1_200;

async function readSettings() {
  const read = await api("getSettings");
  return read?.data ?? read;
}

// "Ask every time" opens a folder picker when a queue add starts, so it is
// switched off for the queue checks and put back by the after hook.
async function setAskEveryTime(value) {
  const current = (await readSettings()).askDownloadLocation;
  if (current === value) return current;
  await setControl("askDownloadLocationToggle", value);
  await browser.waitUntil(
    async () => (await readSettings()).askDownloadLocation === value,
    {
      timeout: 10_000,
      interval: 150,
      timeoutMsg: `askDownloadLocation did not become ${value}`,
    },
  );
  return current;
}

// Reload the page and wait until its controls and bridge are installed.
async function reloadApp() {
  await reloadRenderer();
  await waitFor(
    () =>
      document.readyState === "complete" &&
      typeof window.__ROSI_E2E__?.api?.addToQueue === "function" &&
      Boolean(document.getElementById("profileCustomBtn")) &&
      Boolean(document.getElementById("downloadBtn")),
    "reloaded page never rendered the main window controls",
    60_000,
  );
}

// Sets the URL field the way typing does, without blur, so the preview can run.
async function setUrlField(value) {
  await browser.execute((text) => {
    const input = document.getElementById("url");
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

// Shows the playlist range controls with the given range, or hides them (null).
// The renderer's own helpers are not exposed to the bridge, so this mirrors
// their DOM changes: the scope fieldset, the range fields, and the radio.
async function applyPlaylistScope(scope) {
  await browser.execute((next) => {
    const scopeEl = document.getElementById("playlistScope");
    const rangeFields = document.getElementById("playlistRangeFields");
    const error = document.getElementById("playlistScopeError");
    if (!scopeEl || !rangeFields) throw new Error("playlist scope is missing");
    const mode = next ? "range" : "current";
    const radio = document.querySelector(
      `input[name="playlist-scope"][value="${mode}"]`,
    );
    if (!radio) throw new Error(`playlist radio ${mode} is missing`);
    radio.checked = true;
    if (next) {
      document.getElementById("playlistRangeStart").value = String(next.start);
      document.getElementById("playlistRangeEnd").value = String(next.end);
    }
    rangeFields.classList.toggle("hidden", !next);
    scopeEl.classList.toggle("hidden", !next);
    if (error) error.textContent = "";
  }, scope);
  const visible = await browser.execute(
    () =>
      !document.getElementById("playlistScope")?.classList.contains("hidden"),
  );
  assert.equal(
    visible,
    Boolean(scope),
    "playlist scope visibility did not change",
  );
}

// Runs one add from the queue textarea and returns what the bridge received.
// The main URL, range, and textarea text are set first, the way a user would.
async function runQueueAdd({ mainUrl, queueText, scope }) {
  await setUrlField(mainUrl);
  // Let the URL preview settle before the scope is set, so it cannot reset it.
  await browser.pause(AUTO_PREVIEW_SETTLE_MS);
  await applyPlaylistScope(scope);
  await restoreBridge();
  await stubBridge("addToQueue", { ok: true, data: { added: 1, skipped: 0 } });
  await browser.execute((text) => {
    const status = document.getElementById("queueStatusMessage");
    if (status) status.textContent = "";
    const input = document.getElementById("queueUrlInput");
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, queueText);
  await browser.execute(() => document.getElementById("addToQueueBtn").click());
  // Every add reports through the status text, which is written on a 0 ms
  // timer after the stub call (or the range block), so it ends the flow.
  await waitFor(
    () =>
      (document.getElementById("queueStatusMessage")?.textContent.trim() ??
        "") !== "",
    "queue add did not report a status",
    10_000,
  );
  return {
    calls: await stubCalls("addToQueue"),
    status: await queueStatus(),
  };
}

async function queueStatus() {
  return browser.execute(
    () =>
      document.getElementById("queueStatusMessage")?.textContent.trim() ?? "",
  );
}

async function resetQueueForm() {
  await restoreBridge();
  await applyPlaylistScope(null);
  await setUrlField("");
  await browser.execute(() => {
    const input = document.getElementById("queueUrlInput");
    if (input) input.value = "";
    const status = document.getElementById("queueStatusMessage");
    if (status) status.textContent = "";
  });
}

// The override object sent with the add (second argument), or an empty one.
function overridesOf(call) {
  return call[1] ?? {};
}

async function selectDockTab(id) {
  await browser.execute(
    (target) => document.getElementById(target)?.click(),
    id,
  );
}

async function activeDockTab() {
  return browser.execute(
    () =>
      [...document.querySelectorAll('button[aria-selected="true"]')]
        .map((button) => button.id)
        .find((id) => id.startsWith("dockTab")) ?? null,
  );
}

// Emits the activity list and waits for the panel to rebuild its rows, which
// it does after deciding whether the tab is marked unseen.
async function emitActivity(entries) {
  await browser.execute(() => {
    window.__auditBActivityRows =
      document.getElementById("history-list")?.firstElementChild ?? null;
  });
  await browser.execute(
    (list) => window.__TAURI__.event.emit("download-activity-update", list),
    entries,
  );
  await waitFor(
    () => {
      const first =
        document.getElementById("history-list")?.firstElementChild ?? null;
      return first !== null && first !== window.__auditBActivityRows;
    },
    "the activity list was not rebuilt after the update",
    10_000,
  );
}

async function activityBadge() {
  return browser.execute(
    () =>
      document
        .getElementById("dockTabActivity")
        ?.classList.contains("has-unseen") ?? false,
  );
}

function activityEntry(id) {
  const url = `https://example.test/${id}`;
  return {
    id,
    owner: "manual",
    outcome: "cancelled",
    statusMessage: "Cancelled",
    url,
    request: { url },
    filename: `${id}.mp4`,
    outputPath: null,
    outputPaths: [],
    error: null,
    startedAt: Date.now() - 2000,
    completedAt: Date.now(),
  };
}

async function resetQueue() {
  await api("cancelQueue").catch(() => {});
  await api("clearQueue").catch(() => {});
}

describe("ROSI full audit B renderer fixes", () => {
  let originalAsk = null;

  before(async () => {
    assert.ok(MEDIA, "ROSI_E2E_MEDIA_URL is not set");
    await waitForAppReady();
    report.source = sourceIdentity();
    // Queue checks need "Ask every time" off; the after hook restores it.
    originalAsk = await setAskEveryTime(false);
    writeReport();
  });

  after(async () => {
    await restoreBridge();
    await resetQueue();
    await setAskEveryTime(originalAsk ?? false);
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

  describe("U3: queue links use the main URL's playlist scope only for the main URL", () => {
    afterEach(async () => {
      await resetQueueForm();
    });

    it("sends other queue links without the main URL's invalid range", async () =>
      scenario("queue-other-links-ignore-invalid-range", [1], async () => {
        const run = await runQueueAdd({
          mainUrl: MAIN_URL,
          queueText: QUEUED_A,
          scope: { start: 5, end: 2 },
        });
        assert.equal(
          run.calls.length,
          1,
          `expected the link to reach the queue, status was "${run.status}"`,
        );
        assert.equal(run.status.includes("Fix the playlist range"), false);
        return { overrides: overridesOf(run.calls[0]) };
      }));

    it("sends no playlist with other queue links even when the range is valid", async () =>
      scenario("queue-other-links-no-playlist-override", [2], async () => {
        const run = await runQueueAdd({
          mainUrl: MAIN_URL,
          queueText: QUEUED_A,
          scope: { start: 2, end: 4 },
        });
        assert.equal(run.calls.length, 1, `status was "${run.status}"`);
        assert.equal(
          Object.prototype.hasOwnProperty.call(
            overridesOf(run.calls[0]),
            "playlist",
          ),
          false,
          "a link that is not the main URL carried the main URL's range",
        );
        return { overrides: overridesOf(run.calls[0]) };
      }));

    it("blocks the main URL alone when its range is invalid", async () =>
      scenario("main-url-invalid-range-blocks-queue", [3], async () => {
        const run = await runQueueAdd({
          mainUrl: MAIN_URL,
          queueText: MAIN_URL,
          scope: { start: 5, end: 2 },
        });
        assert.equal(
          run.calls.length,
          0,
          "an invalid range still queued the main URL",
        );
        assert.equal(run.status, BLOCKED_MESSAGE);
        return { status: run.status };
      }));

    it("sends the main URL's valid range, with or without padding", async () =>
      scenario("main-url-range-sent-to-queue", [4, 5], async () => {
        const plain = await runQueueAdd({
          mainUrl: MAIN_URL,
          queueText: MAIN_URL,
          scope: { start: 2, end: 4 },
        });
        assert.equal(plain.calls.length, 1, `status was "${plain.status}"`);
        assert.deepEqual(overridesOf(plain.calls[0]).playlist, {
          mode: "range",
          start: 2,
          end: 4,
        });
        await restoreBridge();
        const padded = await runQueueAdd({
          mainUrl: MAIN_URL,
          queueText: `   ${MAIN_URL}   `,
          scope: { start: 2, end: 4 },
        });
        assert.equal(padded.calls.length, 1, `status was "${padded.status}"`);
        assert.deepEqual(overridesOf(padded.calls[0]).playlist, {
          mode: "range",
          start: 2,
          end: 4,
        });
        return {
          plain: overridesOf(plain.calls[0]),
          padded: overridesOf(padded.calls[0]),
        };
      }));

    it("does not apply the main range to a batch that includes the main URL", async () =>
      scenario("multi-link-batch-ignores-main-range", [6], async () => {
        const run = await runQueueAdd({
          mainUrl: MAIN_URL,
          queueText: `${MAIN_URL}\n${QUEUED_A}`,
          scope: { start: 5, end: 2 },
        });
        assert.equal(run.calls.length, 1, `status was "${run.status}"`);
        assert.equal(
          Object.prototype.hasOwnProperty.call(
            overridesOf(run.calls[0]),
            "playlist",
          ),
          false,
        );
        return { overrides: overridesOf(run.calls[0]) };
      }));

    it("sends no playlist for the main URL while the scope is hidden", async () =>
      scenario("hidden-scope-sends-no-playlist", [7], async () => {
        const run = await runQueueAdd({
          mainUrl: MAIN_URL,
          queueText: MAIN_URL,
          scope: null,
        });
        assert.equal(run.calls.length, 1, `status was "${run.status}"`);
        assert.equal(
          Object.prototype.hasOwnProperty.call(
            overridesOf(run.calls[0]),
            "playlist",
          ),
          false,
        );
        return { overrides: overridesOf(run.calls[0]) };
      }));
  });

  describe("U5: focus stays on a failed row's details and controls", () => {
    it("keeps focus on the details summary and the Retry control across a queue broadcast", async () => {
      try {
        await resetQueue();
        const added = await api("addToQueue", [FAILED_URL]);
        assert.equal(added.data.added, 1);
        assert.equal((await api("startQueue")).ok, true);
        await browser.waitUntil(
          async () =>
            (await api("getQueue")).some(
              (item) => item.url === FAILED_URL && item.status === "failed",
            ),
          {
            timeout: 90_000,
            interval: 500,
            timeoutMsg: "queued item never failed",
          },
        );
        const failedId = (await api("getQueue")).find(
          (item) => item.url === FAILED_URL,
        ).id;
        await selectDockTab("dockTabQueue");
        await waitFor(
          (id) =>
            [...document.querySelectorAll("#queueList .queue-item")].some(
              (row) =>
                row.dataset.queueId === id &&
                row.classList.contains("queue-failed"),
            ),
          "failed row did not render",
          10_000,
          failedId,
        );

        await scenario("failed-details-focus-kept", [9, 11, 12], async () => {
          await browser.execute((id) => {
            const row = [
              ...document.querySelectorAll("#queueList .queue-item"),
            ].find((candidate) => candidate.dataset.queueId === id);
            row.querySelector("details.queue-item-details > summary").click();
          }, failedId);
          await waitFor(
            (id) =>
              [...document.querySelectorAll("#queueList .queue-item")]
                .find((row) => row.dataset.queueId === id)
                ?.querySelector("details.queue-item-details")?.open === true,
            "details did not open",
            5_000,
            failedId,
          );
          const focused = await browser.execute((id) => {
            const row = [
              ...document.querySelectorAll("#queueList .queue-item"),
            ].find((candidate) => candidate.dataset.queueId === id);
            const summary = row.querySelector(
              "details.queue-item-details > summary",
            );
            summary.focus();
            return document.activeElement === summary;
          }, failedId);
          assert.equal(
            focused,
            true,
            "the details summary could not take focus",
          );

          assert.equal((await api("addToQueue", [QUEUED_A])).ok, true);
          await waitFor(
            () =>
              document.querySelectorAll("#queueList .queue-item").length >= 2,
            "second queue row did not render",
            10_000,
          );
          const after = await browser.execute((id) => {
            const active = document.activeElement;
            const details = [
              ...document.querySelectorAll("#queueList .queue-item"),
            ]
              .find((row) => row.dataset.queueId === id)
              ?.querySelector("details.queue-item-details");
            return {
              tag: active?.tagName ?? null,
              rowId: active?.closest?.(".queue-item")?.dataset.queueId ?? null,
              open: details?.open === true,
            };
          }, failedId);
          assert.equal(after.tag, "SUMMARY", `focus went to ${after.tag}`);
          assert.equal(after.rowId, failedId, "focus moved to another row");
          assert.equal(after.open, true, "details closed on the broadcast");
          return { focusAfterBroadcast: after.tag, open: after.open };
        });

        await scenario("failed-row-retry-focus-kept", [10], async () => {
          await browser.execute((id) => {
            const row = [
              ...document.querySelectorAll("#queueList .queue-item"),
            ].find((candidate) => candidate.dataset.queueId === id);
            row.querySelector('[data-queue-action="queue-item-retry"]').focus();
          }, failedId);
          const focusedBefore = await browser.execute(
            () => document.activeElement?.dataset.queueAction ?? null,
          );
          assert.equal(
            focusedBefore,
            "queue-item-retry",
            "Retry could not take focus",
          );

          assert.equal((await api("addToQueue", [QUEUED_B])).ok, true);
          await waitFor(
            () =>
              document.querySelectorAll("#queueList .queue-item").length >= 3,
            "third queue row did not render",
            10_000,
          );
          const after = await browser.execute(() => ({
            action: document.activeElement?.dataset.queueAction ?? null,
            rowId:
              document.activeElement?.closest?.(".queue-item")?.dataset
                .queueId ?? null,
          }));
          assert.equal(
            after.action,
            "queue-item-retry",
            "Retry lost focus on the broadcast",
          );
          assert.equal(after.rowId, failedId);
          return { focusAfterBroadcast: after.action };
        });
      } finally {
        await resetQueue();
        await selectDockTab("dockTabQueue");
      }
    });
  });

  describe("U6: the Activity tab is marked unseen when a new entry arrives at the cap", () => {
    it("marks the tab for new ids in a full list, not for re-sent lists or the selected tab", async () => {
      const real = await api("getDownloadActivity");
      const originalTab = await activeDockTab();
      const ids = ["a1", "a2", "a3", "a4", "a5", "a6"].map(
        (id) => `audit-b-${id}`,
      );
      const [a1, a2, a3, a4, a5, a6] = ids.map((id) => activityEntry(id));
      try {
        await scenario("activity-unseen-at-cap", [15], async () => {
          // Selecting the tab clears its badge, so the first load is cleared too.
          await selectDockTab("dockTabActivity");
          await selectDockTab("dockTabQueue");
          await emitActivity([a1, a2, a3]);
          await selectDockTab("dockTabActivity");
          await selectDockTab("dockTabQueue");
          assert.equal(await activityBadge(), false, "badge was not cleared");
          // Same count: the oldest entry drops out and one new id arrives.
          await emitActivity([a2, a3, a4]);
          await browser.waitUntil(() => activityBadge(), {
            timeout: 5_000,
            interval: 150,
            timeoutMsg:
              "a full list with a new entry did not mark the Activity tab",
          });
          return { entries: 3, newIds: 1 };
        });

        await scenario("activity-resend-no-unseen", [16], async () => {
          await selectDockTab("dockTabActivity");
          await selectDockTab("dockTabQueue");
          await emitActivity([a2, a3, a4]);
          assert.equal(
            await activityBadge(),
            false,
            "a re-sent list marked the tab",
          );
          await emitActivity([]);
          assert.equal(
            await activityBadge(),
            false,
            "an empty list marked the tab",
          );
          return { resentMarked: false, emptyMarked: false };
        });

        await scenario("activity-unseen-tab-selected", [17], async () => {
          await selectDockTab("dockTabActivity");
          await emitActivity([a4, a5, a6]);
          assert.equal(
            await activityBadge(),
            false,
            "the selected tab was marked",
          );
          await selectDockTab("dockTabQueue");
          return { selectedMarked: false };
        });
      } finally {
        await emitActivity(real.data ?? []);
        await selectDockTab(originalTab ?? "dockTabQueue");
      }
    });
  });

  describe("U7: an empty folder reads as the Downloads folder", () => {
    it("shows the default text and tooltip for an empty folder, and the path for a set one", async () => {
      const original = await readSettings();
      // The backend only accepts folders inside the E2E profile's downloads area.
      assert.ok(
        DOWNLOADS,
        "ROSI_E2E_DOWNLOADS is required for folder fixtures",
      );
      const folder = path.join(DOWNLOADS, "full-audit-b-folder");
      fs.mkdirSync(folder, { recursive: true });
      try {
        await scenario("empty-folder-downloads-default", [19, 20], async () => {
          const saved = await api("saveSettings", {
            downloadFolder: "",
            askDownloadLocation: false,
          });
          assert.equal(saved.ok, true, saved.error?.message);
          await reloadApp();
          const seen = await browser.execute(() => {
            const target = document.getElementById("downloadFolderSummary");
            return {
              text: target?.textContent.trim() ?? "",
              title: target?.title ?? "",
            };
          });
          assert.equal(seen.text, "Downloads folder (default)");
          assert.equal(seen.title, FOLDER_HINT);
          return seen;
        });

        await scenario("folder-set-shows-path", [22], async () => {
          const saved = await api("saveSettings", { downloadFolder: folder });
          assert.equal(saved.ok, true, saved.error?.message);
          await reloadApp();
          const seen = await browser.execute(() => {
            const target = document.getElementById("downloadFolderSummary");
            return {
              tail:
                target?.querySelector(".download-destination-tail")
                  ?.textContent ?? null,
              title: target?.title ?? "",
            };
          });
          assert.equal(seen.tail, path.basename(folder));
          assert.equal(seen.title, folder);
          return seen;
        });

        await scenario("initial-html-folder-text", [21], async () => {
          const markup = fs.readFileSync(
            path.join(REPO_ROOT, "src", "index.html"),
            "utf8",
          );
          assert.match(
            markup,
            /id="downloadFolderSummary"[^>]*>\s*Downloads folder \(default\)\s*</,
          );
          return { source: "src/index.html" };
        });
      } finally {
        const restored = await api("saveSettings", {
          downloadFolder: original.downloadFolder ?? "",
          askDownloadLocation: Boolean(original.askDownloadLocation),
        });
        assert.equal(restored.ok, true, restored.error?.message);
        await reloadApp();
        fs.rmSync(folder, { recursive: true, force: true });
      }
    });
  });

  describe("U8: the wizard theme radios form a labelled group", () => {
    it("exposes the theme radios as a labelled radiogroup", async () =>
      scenario("wizard-theme-radiogroup", [24, 25], async () => {
        const seen = await browser.execute(() => {
          const grid = document.querySelector(".wizard-theme-grid");
          const inGrid = grid
            ? grid.querySelectorAll('input[name="wizard-theme"]')
            : [];
          return {
            role: grid?.getAttribute("role") ?? null,
            label: grid?.getAttribute("aria-label") ?? null,
            inGrid: inGrid.length,
            inDocument: document.querySelectorAll('input[name="wizard-theme"]')
              .length,
            checked: [...inGrid].filter((radio) => radio.checked).length,
          };
        });
        assert.equal(seen.role, "radiogroup");
        assert.equal(seen.label, "Theme");
        assert.equal(seen.inGrid, 4);
        assert.equal(
          seen.inDocument,
          seen.inGrid,
          "a theme radio sits outside the group",
        );
        assert.equal(
          seen.checked,
          1,
          "the group does not hold exactly one checked theme",
        );
        return { inGrid: seen.inGrid, checked: seen.checked };
      }));
  });

  describe("U9: focus outlines survive forced-colors mode", () => {
    it("gives each focus rule a transparent 2px outline that sits outside its ring", async () =>
      scenario("focus-outline-css-rules", [27, 28, 29, 30], async () => {
        const result = await browser.execute(() => {
          const normalize = (text) => text.replace(/\s+/g, " ").trim();
          const collect = (rules, out) => {
            for (const rule of rules) {
              if (rule.selectorText) out.push(rule);
              else if (rule.cssRules) collect(rule.cssRules, out);
            }
            return out;
          };
          const rules = [];
          try {
            for (const sheet of document.styleSheets)
              collect(sheet.cssRules, rules);
          } catch (error) {
            return { error: `stylesheet unreadable: ${error}` };
          }
          const targets = {
            field: (s) => s.includes(".field:focus-visible"),
            url: (s) => s === ".url-input-container input:focus",
            toggle: (s) =>
              s === ".wizard-toggle input:focus-visible + .toggle-slider",
          };
          const out = {};
          for (const [name, match] of Object.entries(targets)) {
            const matches = rules.filter((rule) =>
              match(normalize(rule.selectorText)),
            );
            const outlined = matches.filter(
              (rule) => rule.style.outlineStyle !== "",
            );
            const shadowed = matches.filter(
              (rule) => rule.style.boxShadow !== "",
            );
            const bordered = matches.filter(
              (rule) => rule.style.borderColor !== "",
            );
            const last = outlined[outlined.length - 1];
            out[name] = {
              matches: matches.length,
              anyNone: matches.some(
                (rule) => rule.style.outlineStyle === "none",
              ),
              outlineStyle: last?.style.outlineStyle ?? null,
              outlineWidth: last?.style.outlineWidth ?? null,
              outlineColor: last?.style.outlineColor ?? null,
              outlineOffset: last?.style.outlineOffset ?? null,
              boxShadow: shadowed[shadowed.length - 1]?.style.boxShadow ?? null,
              borderColor:
                bordered[bordered.length - 1]?.style.borderColor ?? null,
            };
          }
          return out;
        });
        if (result.error) throw new Error(result.error);
        const rings = { field: 3, url: 4, toggle: 4 };
        for (const [name, ring] of Object.entries(rings)) {
          const rule = result[name];
          assert.ok(rule.matches >= 1, `${name} focus rule is missing`);
          assert.equal(
            rule.anyNone,
            false,
            `${name} focus rule still sets outline: none`,
          );
          assert.equal(rule.outlineStyle, "solid", `${name} outline style`);
          assert.equal(rule.outlineWidth, "2px", `${name} outline width`);
          // WebKit serializes transparent as rgba(0, 0, 0, 0).
          assert.ok(
            ["transparent", "rgba(0, 0, 0, 0)"].includes(rule.outlineColor),
            `${name} outline color is ${rule.outlineColor}, expected transparent`,
          );
          assert.ok(
            parseFloat(rule.outlineOffset) >= ring,
            `${name} outline offset ${rule.outlineOffset} is inside the ${ring}px ring`,
          );
          assert.ok(
            rule.boxShadow && rule.boxShadow.includes(`${ring}px`),
            `${name} lost its ${ring}px ring`,
          );
          assert.ok(rule.borderColor, `${name} lost its border color`);
        }
        return result;
      }));
  });
});
