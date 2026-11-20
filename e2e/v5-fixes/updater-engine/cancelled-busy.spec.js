import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import {
  clickModalButton,
  modalState,
  reloadRenderer,
  waitForAppReady,
  waitForModal,
} from "../../helpers/ui.js";
import { REPO_ROOT } from "../../helpers/profile.js";
import {
  captureUpdaterStatuses,
  clickManualCheck,
  setUpdateChannel,
  startUpdaterFixture,
} from "../../helpers/updater-engine-fixture.js";

// Cancelled download still stopping (e2e/v5-fixes/updater-engine/cancelled-busy.failure-modes.md).
// The update plugin cannot abort a transfer, so a cancelled one holds the engine
// until it ends. While it does, check and download answer at once with the stopping
// message, and a live (not cancelled) transfer keeps its old answers.
const EXPECTED_CHECKS = 9;
const VERSION = "9.0.7";
const STOPPING = "still stopping";
const ALREADY_IN_PROGRESS = "A download is already in progress.";
const ANSWER_LIMIT_MS = 5_000;
// A refused check or download emits no status, and the engine gives no signal
// that it did not. This is how long a stray emit gets to arrive before CB3
// counts events.
const STATUS_EMIT_WINDOW_MS = 500;

const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const artifactDir = path.join(
  REPO_ROOT,
  "e2e",
  "artifacts",
  "v5-fixes-updater-engine",
  `${stamp}-cancelled-busy-${process.pid}`,
);
const report = {
  suite: "v5-fixes-updater-engine-cancelled-busy",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  passed: false,
  checks: [],
};
let fixture = null;

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

function writeReport() {
  report.passed =
    report.checks.length === EXPECTED_CHECKS &&
    report.checks.every((check) => check.invariantPassed === true);
  fs.mkdirSync(artifactDir, { recursive: true });
  const reportPath = path.join(artifactDir, "report.json");
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  const temporaryPath = `${reportPath}.tmp`;
  fs.writeFileSync(temporaryPath, contents);
  fs.renameSync(temporaryPath, reportPath);
  fs.writeFileSync(
    `${reportPath}.sha256`,
    `${sha256(contents)}  report.json\n`,
  );
}

// One failure-mode row: its body returns the evidence, or throws.
async function recordRow(id, body) {
  try {
    const details = await body();
    report.checks.push({ id, invariantPassed: true, ...details });
  } catch (error) {
    report.checks.push({
      id,
      invariantPassed: false,
      reason: error instanceof Error ? error.message : String(error),
    });
    writeReport();
    throw error;
  }
  writeReport();
}

function osName() {
  return { darwin: "darwin", linux: "linux", win32: "windows" }[
    process.platform
  ];
}

function stableTarget() {
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch];
  return `${osName()}-${arch}`;
}

async function invoke(command, args) {
  return browser.executeAsync(
    (name, payload, done) => {
      window.__TAURI__.core.invoke(name, payload).then(
        (data) => done({ ok: true, data: data ?? null }),
        (error) => done({ error: String(error) }),
      );
    },
    command,
    args,
  );
}

async function statuses() {
  return browser.execute(() => window.engineStatuses.slice());
}

function requestCount(prefix) {
  return fixture.server.requests.filter((request) =>
    request.path.startsWith(prefix),
  ).length;
}

async function latestCandidate() {
  return (await statuses())
    .filter((event) => event.status === "available")
    .at(-1);
}

async function startScenario(options) {
  if (fixture) await fixture.close();
  await reloadRenderer();
  await setUpdateChannel("stable");
  fixture = await startUpdaterFixture(options);
  await captureUpdaterStatuses("engineStatuses");
}

describe("Updater engine: cancelled download still stopping", () => {
  before(waitForAppReady);
  after(async () => {
    if (fixture) await fixture.close();
    writeReport();
  });

  it("refuses a check and a download while a cancelled transfer is still stopping, then recovers", async () => {
    await startScenario({});
    // The artifact response is held until releaseArtifact runs.
    let releaseArtifact = () => {};
    const gate = new Promise((resolve) => {
      releaseArtifact = resolve;
    });
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: VERSION,
      payload: Buffer.from("cancelled busy payload"),
      fileName: `ROSI-${VERSION}.bin`,
      gate,
    });
    try {
      await clickManualCheck();
      await waitForModal("Update Available!", { timeout: 20_000 });
      const { candidateId } = await latestCandidate();
      await clickModalButton("Later");

      // A live transfer, not yet cancelled, keeps the old answers.
      await browser.execute((id) => {
        window.cbHeldResult = undefined;
        window.__TAURI__.core
          .invoke("download_update", { candidateId: id })
          .then((data) => {
            window.cbHeldResult = data;
          });
      }, candidateId);
      await browser.waitUntil(() => requestCount("/artifacts/") === 1, {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: "the held transfer did not start",
      });
      await recordRow("CB8", async () => {
        const feedBefore = requestCount("/latest-");
        const check = await invoke("check_for_updates");
        assert.equal(check.ok, true, JSON.stringify(check));
        assert.equal(check.data, null, JSON.stringify(check));
        const download = await invoke("download_update", { candidateId });
        assert.equal(
          download.data?.error,
          ALREADY_IN_PROGRESS,
          JSON.stringify(download),
        );
        assert.equal(
          requestCount("/latest-"),
          feedBefore,
          "a check during a live download requested a feed",
        );
        return {
          liveCheck: check.data,
          liveDownloadError: download.data.error,
        };
      });

      // Cancel: the held transfer cannot be aborted, so it keeps the engine busy.
      await invoke("cancel_update_download");
      await waitForModal("Download Cancelled", { timeout: 20_000 });
      await clickModalButton("OK");
      const statusBaseline = (await statuses()).length;
      const feedBaseline = requestCount("/latest-");
      const artifactBaseline = requestCount("/artifacts/");

      const checkStarted = Date.now();
      const check = await invoke("check_for_updates");
      const checkMs = Date.now() - checkStarted;
      const downloadStarted = Date.now();
      const download = await invoke("download_update", { candidateId });
      const downloadMs = Date.now() - downloadStarted;
      await new Promise((resolve) =>
        setTimeout(resolve, STATUS_EMIT_WINDOW_MS),
      );

      await recordRow("CB1", async () => {
        assert.equal(check.ok, true, JSON.stringify(check));
        assert.equal(check.data?.reason, "message", JSON.stringify(check));
        assert.ok(checkMs < ANSWER_LIMIT_MS, `check took ${checkMs} ms`);
        return { reason: check.data.reason, checkMs };
      });

      await recordRow("CB2", async () => {
        assert.ok(
          check.data?.message?.includes(STOPPING),
          JSON.stringify(check),
        );
        assert.ok(
          download.data?.error?.includes(STOPPING),
          JSON.stringify(download),
        );
        return {
          checkMessage: check.data.message,
          downloadError: download.data.error,
        };
      });

      await recordRow("CB3", async () => {
        const events = (await statuses()).slice(statusBaseline);
        assert.deepEqual(events, [], "a refused answer emitted a status");
        assert.equal(
          requestCount("/latest-"),
          feedBaseline,
          "a refused check requested a feed",
        );
        return { newStatusEvents: events.length };
      });

      await recordRow("CB4", async () => {
        assert.equal(download.ok, true, JSON.stringify(download));
        assert.equal(download.data?.success, false, JSON.stringify(download));
        assert.equal(download.data?.cancelled, false, JSON.stringify(download));
        assert.ok(
          download.data?.error?.includes(STOPPING) &&
            !download.data.error.includes(ALREADY_IN_PROGRESS),
          JSON.stringify(download),
        );
        assert.ok(
          downloadMs < ANSWER_LIMIT_MS,
          `download took ${downloadMs} ms`,
        );
        return { downloadMs, error: download.data.error };
      });

      await recordRow("CB5", async () => {
        assert.equal(
          requestCount("/artifacts/"),
          artifactBaseline,
          "a refused download started another transfer",
        );
        return { artifactRequests: artifactBaseline };
      });

      // Release the held response: the transfer settles as cancelled and discarded.
      releaseArtifact();
      await browser.waitUntil(
        () => browser.execute(() => window.cbHeldResult !== undefined),
        {
          timeout: 20_000,
          interval: 100,
          timeoutMsg: "the held transfer did not settle",
        },
      );
      await recordRow("CB6", async () => {
        const held = await browser.execute(() => window.cbHeldResult);
        assert.deepEqual(held, {
          success: false,
          cancelled: true,
          error: null,
        });
        const events = (await statuses()).slice(statusBaseline);
        assert.ok(
          !events.some((event) => event.status === "downloaded"),
          JSON.stringify(events),
        );
        assert.equal(
          (await modalState()).active,
          false,
          "a late transfer opened a prompt",
        );
        return { held };
      });

      await recordRow("CB7", async () => {
        await clickManualCheck();
        await waitForModal("Update Available!", { timeout: 20_000 });
        const offered = await latestCandidate();
        assert.equal(offered.version, VERSION, JSON.stringify(offered));
        assert.ok(
          requestCount("/latest-") > feedBaseline,
          "the recovered check did not request the feed",
        );
        await clickModalButton("Later");
        return {
          offeredVersion: offered.version,
          feedRequests: requestCount("/latest-"),
        };
      });
    } finally {
      // Never leave the held response open: the engine would stay busy.
      releaseArtifact();
    }
  });

  it("answers the options commands through the async command path with the same envelope", async () => {
    await recordRow("A5-1", async () => {
      const resolved = await invoke("resolve_download_options", {
        options: { url: "https://example.com/cancelled-busy-options" },
      });
      assert.equal(resolved.ok, true, JSON.stringify(resolved));
      assert.equal(resolved.data?.ok, true, JSON.stringify(resolved));
      assert.equal(
        resolved.data.data?.url,
        "https://example.com/cancelled-busy-options",
        JSON.stringify(resolved),
      );
      const preset = await invoke("resolve_preset_options", {
        options: { presetId: "cancelled-busy-missing-preset" },
      });
      assert.equal(preset.ok, true, JSON.stringify(preset));
      assert.equal(preset.data?.ok, false, JSON.stringify(preset));
      assert.ok(preset.data?.error, JSON.stringify(preset));
      return {
        resolvedUrl: resolved.data.data.url,
        presetError: preset.data.error,
      };
    });
  });
});
