import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { browser } from "@wdio/globals";
import { waitForAppReady } from "../../helpers/app-bridge.js";
import {
  captureUpdaterStatuses,
  clickManualCheck,
  setUpdateChannel,
  startUpdaterFixture,
} from "../../helpers/updater-engine-fixture.js";

// Updater engine failure modes (e2e/v5-fixes/updater-engine/failure-modes.md).
// Each scenario runs the Rust engine against a local signed update server. The
// engine probe counts installs and restarts; scenarios read deltas because the
// probe belongs to the app process.
const EXPECTED_CHECKS = 26;
const BETA = "darwin-beta-aarch64-app";
const here = path.dirname(fileURLToPath(import.meta.url));
const runDirectory = path.join(
  here,
  "..",
  "..",
  "artifacts",
  "v5-fixes-updater-engine",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const checks = [];
let fixture = null;

function record(name, details) {
  checks.push({ name, passed: true, ...details });
}

function writeReport() {
  fs.mkdirSync(runDirectory, { recursive: true });
  const passed =
    checks.length === EXPECTED_CHECKS && checks.every((check) => check.passed);
  fs.writeFileSync(
    path.join(runDirectory, "report.json"),
    `${JSON.stringify({ area: "updater-engine", passed, checks }, null, 2)}\n`,
  );
}

const DATA_DIR = process.env.ROSI_E2E_DATA_DIR;

function settingsFile() {
  assert.ok(DATA_DIR, "ROSI_E2E_DATA_DIR is not set");
  return path.join(DATA_DIR, "settings.json");
}

/** Edits the channel on disk only, so the engine gets no channel event. */
function writeChannelOnDisk(channel) {
  const value = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  value.updateChannel = channel;
  fs.writeFileSync(settingsFile(), JSON.stringify(value));
}

/** Makes the next channel save fail: the file claims a newer schema. */
function makeSettingsUnsavable() {
  const value = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  value.settingsVersion = 9_999;
  fs.writeFileSync(settingsFile(), JSON.stringify(value));
}

function artifactRequestCount() {
  return fixture.server.requests.filter((request) =>
    request.path.startsWith("/artifacts/"),
  ).length;
}

/** Holds a response until the returned release function runs. */
function holdResponse() {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

async function dismissModal() {
  const modal = await readModal();
  if (modal.active) {
    await clickModal(modal.buttons.includes("Later") ? "Later" : "OK");
  }
}

async function latestCandidate() {
  return (await statuses("engineStatuses"))
    .filter((event) => event.status === "available")
    .at(-1);
}

function feedTargets(index) {
  return fixture.server.requests
    .slice(index)
    .map((request) => request.path)
    .filter((item) => item.startsWith("/latest-"))
    .map((item) => item.replace(/^\/latest-|\.json$/g, ""));
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

async function freshRenderer() {
  await browser.execute(() => {
    window.__ROSI_E2E__.ready = false;
    window.setTimeout(() => window.location.reload(), 50);
  });
  await waitForAppReady();
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

async function engineProbe() {
  const result = await invoke("e2e_updater_probe");
  assert.ok(result.ok, JSON.stringify(result));
  return result.data;
}

async function statuses(name) {
  return browser.execute((store) => window[store].slice(), name);
}

async function readModal() {
  return browser.execute(() => {
    const modal = document.getElementById("app-modal");
    return {
      active: modal?.classList.contains("active") === true,
      title: document.getElementById("modal-title")?.textContent?.trim() ?? "",
      message: document.getElementById("modal-message")?.textContent ?? "",
      buttons: [...document.querySelectorAll("#modal-buttons button")].map(
        (button) => button.textContent.trim(),
      ),
    };
  });
}

async function waitForModal(title) {
  await browser.waitUntil(
    async () => {
      const modal = await readModal();
      return modal.active && modal.title === title;
    },
    {
      timeout: 20_000,
      interval: 100,
      timeoutMsg: `modal "${title}" did not appear`,
    },
  );
  return readModal();
}

async function clickModal(label) {
  await browser.execute((expected) => {
    const button = [...document.querySelectorAll("#modal-buttons button")].find(
      (candidate) => candidate.textContent.trim() === expected,
    );
    if (!button) throw new Error(`modal button "${expected}" was not found`);
    button.click();
  }, label);
}

async function waitForStatus(store, predicate, message, timeout = 20_000) {
  await browser.waitUntil(async () => (await statuses(store)).some(predicate), {
    timeout,
    interval: 100,
    timeoutMsg: message,
  });
}

async function startScenario(options) {
  if (fixture) await fixture.close();
  await freshRenderer();
  await setUpdateChannel(options.channel ?? "stable");
  fixture = await startUpdaterFixture(options);
  await captureUpdaterStatuses("engineStatuses");
}

describe("Updater engine failure modes", () => {
  before(waitForAppReady);
  after(async () => {
    if (fixture) await fixture.close();
    writeReport();
  });

  it("refuses a check in an unpackaged build without any feed request", async () => {
    await startScenario({ isPackaged: false });
    const before = await engineProbe();
    await clickManualCheck();
    const modal = await waitForModal("Development Mode");
    assert.ok(modal.message.includes("development mode"), modal.message);
    await clickModal("OK");
    const feeds = fixture.server.requests.filter((request) =>
      request.path.startsWith("/latest-"),
    );
    assert.equal(feeds.length, 0, JSON.stringify(feeds));
    assert.deepEqual(await engineProbe(), before);
    record("updater-engine-dev-mode-refusal", { feedRequests: feeds.length });
  });

  it("refuses a check on a retired Linux package target without any feed request", async () => {
    await startScenario({
      channel: "beta",
      betaTarget: "linux-beta-x86_64-deb",
    });
    await clickManualCheck();
    const modal = await waitForModal("Update Check Failed");
    assert.ok(modal.message.includes("DEB and RPM"), modal.message);
    await clickModal("OK");
    const feeds = fixture.server.requests.filter((request) =>
      request.path.startsWith("/latest-"),
    );
    assert.equal(feeds.length, 0, JSON.stringify(feeds));
    record("updater-engine-retired-linux-package", {
      feedRequests: feeds.length,
      message: modal.message.split("\n").at(-1),
    });
  });

  it("ignores install and download requests for a candidate that is not pending", async () => {
    await startScenario({});
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.0.1",
      payload: Buffer.from("candidate mismatch payload"),
      fileName: "ROSI-9.0.1.bin",
    });
    await clickManualCheck();
    await waitForModal("Update Available!");
    await clickModal("Later");
    await waitForStatus(
      "engineStatuses",
      (event) => event.status === "available",
      "the candidate was not offered",
    );
    const offered = (await statuses("engineStatuses")).find(
      (event) => event.status === "available",
    );
    const beforeProbe = await engineProbe();
    const beforeCount = (await statuses("engineStatuses")).length;

    const stale = await invoke("download_update", {
      candidateId: offered.candidateId + 100,
    });
    assert.equal(stale.data?.cancelled, true, JSON.stringify(stale));

    // Nothing is downloaded yet, so install of the offered candidate is an error.
    await invoke("install_update", { candidateId: offered.candidateId });
    await waitForModal("Update Error");
    await clickModal("OK");

    // A stale candidate id is ignored without any event.
    await invoke("install_update", { candidateId: offered.candidateId + 100 });
    await browser.pause(800);
    const after = await statuses("engineStatuses");
    assert.equal(
      after.slice(beforeCount).filter((event) => event.status === "error")
        .length,
      1,
      `stale install produced an event: ${JSON.stringify(after.slice(beforeCount))}`,
    );
    assert.deepEqual(await engineProbe(), beforeProbe);
    assert.equal(
      fixture.server.requests.filter((request) =>
        request.path.startsWith("/artifacts/"),
      ).length,
      0,
    );
    record("updater-engine-candidate-mismatch", {
      staleDownloadCancelled: stale.data.cancelled,
      candidateId: offered.candidateId,
    });
  });

  it("keeps the downloaded candidate when a restart is refused and restarts on retry", async () => {
    await startScenario({ restartRefusals: 1 });
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.0.2",
      payload: Buffer.from("restart retry payload"),
      fileName: "ROSI-9.0.2.bin",
    });
    const before = await engineProbe();
    await clickManualCheck();
    await waitForModal("Update Available!");
    await clickModal("Download & Install");
    await waitForModal("Update Ready!");
    await clickModal("Later");
    const candidateId = (await statuses("engineStatuses")).find(
      (event) => event.status === "downloaded",
    )?.candidateId;
    assert.ok(candidateId !== undefined, "the download did not finish");

    await invoke("install_update", { candidateId });
    const refused = await waitForModal("Update Error");
    assert.ok(refused.message.includes("refused"), refused.message);
    await clickModal("OK");
    const afterRefusal = await engineProbe();
    assert.equal(afterRefusal.installs - before.installs, 1);
    assert.equal(afterRefusal.refusedRestarts - before.refusedRestarts, 1);
    assert.equal(afterRefusal.restarts - before.restarts, 0);

    // The retry only restarts: the verified bytes are not installed again.
    const retry = await invoke("install_update", { candidateId });
    assert.ok(retry.ok, JSON.stringify(retry));
    await browser.pause(800);
    const afterRetry = await engineProbe();
    assert.equal(afterRetry.installs - before.installs, 1);
    assert.equal(afterRetry.restarts - before.restarts, 1);
    record("updater-engine-restart-refusal-retry", {
      candidateId,
      refusedRestarts: afterRetry.refusedRestarts - before.refusedRestarts,
      installsAfterRetry: afterRetry.installs - before.installs,
    });
  });

  it("discards a download that completes after cancel", async () => {
    let releaseArtifact;
    const gate = new Promise((resolve) => {
      releaseArtifact = resolve;
    });
    await startScenario({});
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.0.3",
      payload: Buffer.from("cancelled download payload"),
      fileName: "ROSI-9.0.3.bin",
      gate,
    });
    const before = await engineProbe();
    await clickManualCheck();
    await waitForModal("Update Available!");
    await clickModal("Download & Install");
    await browser.waitUntil(
      () =>
        fixture.server.requests.some((request) =>
          request.path.startsWith("/artifacts/"),
        ),
      {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: "the download never started",
      },
    );
    await invoke("cancel_update_download");
    await waitForModal("Download Cancelled");
    await clickModal("OK");

    releaseArtifact();
    await browser.pause(2_000);
    const events = (await statuses("engineStatuses")).map(
      (event) => event.status,
    );
    assert.ok(!events.includes("downloaded"), JSON.stringify(events));
    assert.equal(
      (await readModal()).active,
      false,
      "a late download opened a prompt",
    );
    const after = await engineProbe();
    assert.equal(after.installs - before.installs, 0);
    assert.equal(after.restarts - before.restarts, 0);
    record("updater-engine-download-cancel-discards", {
      events,
      installs: after.installs - before.installs,
    });
  });

  it("emits checking before the result of a manual check", async () => {
    await startScenario({});
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.0.4",
      payload: Buffer.from("checking order payload"),
      fileName: "ROSI-9.0.4.bin",
    });
    const before = (await statuses("engineStatuses")).length;
    await clickManualCheck();
    await waitForModal("Update Available!");
    await clickModal("Later");
    const seen = (await statuses("engineStatuses"))
      .slice(before)
      .map((event) => event.status);
    const checking = seen.indexOf("checking");
    const available = seen.indexOf("available");
    assert.ok(checking >= 0 && available > checking, JSON.stringify(seen));
    record("updater-engine-checking-before-result", { sequence: seen });
  });

  it("reports a feed failure as a feed error and shows it for a manual check", async () => {
    await startScenario({});
    fixture.server.respond(osName(), 500, "controlled feed failure");
    const before = (await statuses("engineStatuses")).length;
    await clickManualCheck();
    const modal = await waitForModal("Update Error");
    assert.ok(modal.message.length > 0, modal.message);
    await clickModal("OK");
    const errors = (await statuses("engineStatuses"))
      .slice(before)
      .filter((event) => event.status === "error");
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.equal(errors[0].kind, "feed");
    record("updater-engine-feed-error", { kind: errors[0].kind });
  });

  it("reports a download failure when the archive signature does not match", async () => {
    await startScenario({});
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.0.5",
      payload: Buffer.from("signed payload"),
      fileName: "ROSI-9.0.5.bin",
    });
    fixture.server.tamper("ROSI-9.0.5.bin", Buffer.from("unsigned substitute"));
    await clickManualCheck();
    await waitForModal("Update Available!");
    await clickModal("Later");
    const offered = (await statuses("engineStatuses")).find(
      (event) => event.status === "available",
    );
    const before = (await statuses("engineStatuses")).length;
    const result = await invoke("download_update", {
      candidateId: offered.candidateId,
    });
    assert.ok(result.data?.error, JSON.stringify(result));
    await waitForModal("Update Error");
    await clickModal("OK");
    const errors = (await statuses("engineStatuses"))
      .slice(before)
      .filter((event) => event.status === "error");
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.equal(errors[0].kind, "download");
    record("updater-engine-download-error", { kind: errors[0].kind });
  });

  it("routes compact targets and falls back only when the compact feed fails", async () => {
    // Z03.1, Z03.3 (stable), Z03.4, Z03.6 of e2e/updater-zst.failure-modes.md.
    const compact = `${osName()}-aarch64-app-zst`;
    const feedsSince = (index) =>
      fixture.server.requests
        .slice(index)
        .map((request) => request.path)
        .filter((item) => item.startsWith("/latest-"))
        .map((item) => item.replace(/^\/latest-|\.json$/g, ""));
    const manualCheck = async (expectedTitle) => {
      const requestIndex = fixture.server.requests.length;
      const statusIndex = (await statuses("engineStatuses")).length;
      await clickManualCheck();
      await waitForModal(expectedTitle);
      await clickModal(
        expectedTitle === "ROSI is up to date!" ? "OK" : "Later",
      );
      const settled = (await statuses("engineStatuses"))
        .slice(statusIndex)
        .map((event) => event.status);
      return { feeds: feedsSince(requestIndex), settled };
    };

    // Z03.1: the stable compact target is asked once and its answer is used.
    await startScenario({ compactTarget: compact, disableCompact: false });
    fixture.server.publish({
      target: compact,
      version: "9.0.6",
      payload: Buffer.from("compact payload"),
      fileName: "ROSI-9.0.6.app.tar.zst",
    });
    const used = await manualCheck("Update Available!");
    assert.deepEqual(used.feeds, [compact]);
    assert.ok(used.settled.includes("available"), JSON.stringify(used));

    // Z03.4: a compact feed with no newer version is asked again, never falls back.
    fixture.server.publish({
      target: compact,
      version: "1.0.0",
      payload: Buffer.from("older compact payload"),
      fileName: "ROSI-1.0.0.app.tar.zst",
    });
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.0.7",
      payload: Buffer.from("legacy payload that must not be offered"),
      fileName: "ROSI-9.0.7.app.tar.gz",
    });
    const empty = await manualCheck("ROSI is up to date!");
    assert.deepEqual(empty.feeds, [compact, compact]);
    assert.ok(empty.settled.includes("not-available"), JSON.stringify(empty));

    // Z03.3 (stable): a missing compact feed is not retried in place; the
    // default target is asked once and its update is offered.
    fixture.server.unpublish(compact);
    const fallback = await manualCheck("Update Available!");
    assert.deepEqual(fallback.feeds, [compact, osName()]);
    const offered = (await statuses("engineStatuses"))
      .filter((event) => event.status === "available")
      .at(-1);
    assert.equal(offered?.version, "9.0.7", JSON.stringify(offered));

    // Z03.6: with no compact target, stable asks the default target and beta
    // asks the beta target, as before 5.1.
    await startScenario({});
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.0.8",
      payload: Buffer.from("default target payload"),
      fileName: "ROSI-9.0.8.app.tar.gz",
    });
    const plain = await manualCheck("Update Available!");
    assert.deepEqual(plain.feeds, [osName()]);
    const betaIndex = fixture.server.requests.length;
    await setUpdateChannel("beta");
    await browser.waitUntil(() => feedsSince(betaIndex).length >= 1, {
      timeout: 20_000,
      interval: 100,
      timeoutMsg: "the channel change did not recheck the beta target",
    });
    await browser.pause(500);
    const betaFeeds = feedsSince(betaIndex);
    assert.ok(
      betaFeeds.every((target) => target === "darwin-beta-aarch64-app"),
      JSON.stringify(betaFeeds),
    );
    await setUpdateChannel("stable");
    await browser.pause(500);
    record("updater-engine-compact-routing", {
      compactUsed: used.feeds,
      compactEmpty: empty.feeds,
      compactMissing: fallback.feeds,
      noCompactStable: plain.feeds,
      noCompactBeta: betaFeeds,
    });
  });

  it("discards a check result that arrives after the channel changed", async () => {
    // G04: the beta answer is held while the channel moves to stable.
    await startScenario({ channel: "beta" });
    await browser.pause(1_000);
    let releaseBeta = () => {};
    const betaGate = new Promise((resolve) => {
      releaseBeta = resolve;
    });
    try {
      fixture.server.publish({
        target: "darwin-beta-aarch64-app",
        version: "9.1.0-beta.1",
        payload: Buffer.from("stale beta payload"),
        fileName: "ROSI-9.1.0-beta.1.bin",
        manifestGate: betaGate,
      });
      fixture.server.publish({
        target: stableTarget(),
        route: osName(),
        version: "9.1.0",
        payload: Buffer.from("stable payload"),
        fileName: "ROSI-9.1.0.bin",
      });
      const requestIndex = fixture.server.requests.length;
      const statusIndex = (await statuses("engineStatuses")).length;
      // Not awaited: the command returns only when the held check settles.
      await browser.execute(() => {
        window.__TAURI__.core.invoke("check_for_updates").catch(() => {});
      });
      await browser.waitUntil(
        () => feedTargets(requestIndex).includes("darwin-beta-aarch64-app"),
        {
          timeout: 20_000,
          interval: 100,
          timeoutMsg: "the beta feed was not requested",
        },
      );
      await setUpdateChannel("stable");
      await waitForStatus(
        "engineStatuses",
        (event) => event.status === "available" && event.version === "9.1.0",
        "the stable update was not offered after the channel change",
      );
      releaseBeta();
      // Give the released beta answer time to reach the engine and be fenced.
      await browser.pause(1_500);
      const seen = (await statuses("engineStatuses")).slice(statusIndex);
      assert.ok(
        !seen.some((event) => event.version === "9.1.0-beta.1"),
        JSON.stringify(seen),
      );
      const offered = seen.filter((event) => event.status === "available");
      assert.equal(offered.at(-1)?.version, "9.1.0", JSON.stringify(seen));
      const modal = await readModal();
      if (modal.active && modal.buttons.includes("Later")) {
        await clickModal("Later");
      }
      record("updater-engine-stale-check-after-channel-change", {
        feeds: feedTargets(requestIndex),
        offered: offered.map((event) => event.version),
      });
    } finally {
      releaseBeta();
    }
  });

  it("refuses to revalidate until the channel is saved, then rechecks", async () => {
    // G05: a settings.json from a newer schema makes every save fail.
    assert.ok(DATA_DIR, "ROSI_E2E_DATA_DIR is not set");
    const settingsPath = path.join(DATA_DIR, "settings.json");
    await startScenario({ channel: "stable" });
    await browser.pause(1_000);
    fixture.server.publish({
      target: "darwin-beta-aarch64-app",
      version: "9.2.0-beta.1",
      payload: Buffer.from("beta payload after save"),
      fileName: "ROSI-9.2.0-beta.1.bin",
    });
    const original = fs.readFileSync(settingsPath);
    try {
      const newer = JSON.parse(original.toString("utf8"));
      newer.settingsVersion = 9_999;
      fs.writeFileSync(settingsPath, JSON.stringify(newer));
      const requestIndex = fixture.server.requests.length;
      const statusIndex = (await statuses("engineStatuses")).length;
      await setUpdateChannel("beta");
      await waitForStatus(
        "engineStatuses",
        (event) => event.status === "error",
        "the unsaved channel did not refuse the background check",
      );
      await clickManualCheck();
      const modal = await waitForModal("Update Error");
      assert.match(modal.message, /could not be saved before revalidation/);
      await clickModal("OK");
      const errors = (await statuses("engineStatuses"))
        .slice(statusIndex)
        .filter((event) => event.status === "error");
      assert.ok(errors.length >= 2, JSON.stringify(errors));
      assert.ok(
        errors.every((event) => event.kind === "feed"),
        JSON.stringify(errors),
      );
      const feedsWhileUnsaved = feedTargets(requestIndex);
      assert.deepEqual(feedsWhileUnsaved, []);
      assert.equal(
        JSON.parse(fs.readFileSync(settingsPath, "utf8")).settingsVersion,
        9_999,
        "the refused save replaced the newer settings file",
      );

      // The same channel saved successfully counts as a change and rechecks.
      fs.writeFileSync(settingsPath, original);
      const savedIndex = fixture.server.requests.length;
      await setUpdateChannel("beta");
      await waitForStatus(
        "engineStatuses",
        (event) =>
          event.status === "available" && event.version === "9.2.0-beta.1",
        "the saved channel did not recheck the beta feed",
      );
      assert.ok(
        feedTargets(savedIndex).every(
          (target) => target === "darwin-beta-aarch64-app",
        ),
        JSON.stringify(feedTargets(savedIndex)),
      );
      record("updater-engine-channel-save-failure", {
        refusedErrors: errors.length,
        feedsWhileUnsaved,
        feedsAfterSave: feedTargets(savedIndex),
      });
    } finally {
      fs.writeFileSync(settingsPath, original);
      const modal = await readModal();
      if (modal.active) {
        await clickModal(modal.buttons.includes("Later") ? "Later" : "OK");
      }
      await setUpdateChannel("stable");
      await browser.pause(500);
    }
  });

  it("retries a feed that answers no update once for an explicit target", async () => {
    await startScenario({ channel: "beta" });
    await browser.pause(1_000);
    fixture.server.queueFeed(BETA, [{ status: 204 }]);
    fixture.server.publish({
      target: BETA,
      version: "9.4.0-beta.1",
      payload: Buffer.from("empty feed retry payload"),
      fileName: "ROSI-9.4.0-beta.1.bin",
    });
    const requestIndex = fixture.server.requests.length;
    const statusIndex = (await statuses("engineStatuses")).length;
    await clickManualCheck();
    await waitForModal("Beta Update Available!");
    await clickModal("Later");
    const seen = (await statuses("engineStatuses"))
      .slice(statusIndex)
      .map((event) => event.status);
    const feeds = feedTargets(requestIndex);
    assert.deepEqual(feeds, [BETA, BETA], JSON.stringify(seen));
    assert.ok(seen.includes("available"), JSON.stringify(seen));
    record("updater-engine-feed-empty-retry", { feeds, sequence: seen });
  });

  it("retries a feed error once in place for an explicit target", async () => {
    await startScenario({ channel: "beta" });
    await browser.pause(1_000);
    fixture.server.queueFeed(BETA, [
      { status: 500, body: "controlled retry failure" },
    ]);
    fixture.server.publish({
      target: BETA,
      version: "9.4.1-beta.1",
      payload: Buffer.from("feed error retry payload"),
      fileName: "ROSI-9.4.1-beta.1.bin",
    });
    const requestIndex = fixture.server.requests.length;
    const statusIndex = (await statuses("engineStatuses")).length;
    await clickManualCheck();
    await waitForModal("Beta Update Available!");
    await clickModal("Later");
    const seen = (await statuses("engineStatuses"))
      .slice(statusIndex)
      .map((event) => event.status);
    const feeds = feedTargets(requestIndex);
    assert.deepEqual(feeds, [BETA, BETA], JSON.stringify(seen));
    assert.ok(!seen.includes("error"), JSON.stringify(seen));
    record("updater-engine-feed-error-retry", { feeds, sequence: seen });
  });

  it("discards a check whose target changed during the feed request", async () => {
    await startScenario({});
    await browser.pause(1_000);
    const original = fs.readFileSync(settingsFile());
    const held = holdResponse();
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.5.0",
      payload: Buffer.from("stale stable payload"),
      fileName: "ROSI-9.5.0.bin",
      manifestGate: held.gate,
    });
    fixture.server.publish({
      target: BETA,
      version: "9.5.1-beta.1",
      payload: Buffer.from("beta target payload"),
      fileName: "ROSI-9.5.1-beta.1.bin",
    });
    const requestIndex = fixture.server.requests.length;
    const statusIndex = (await statuses("engineStatuses")).length;
    try {
      // Not awaited: the command returns only when the held check settles.
      await browser.execute(() => {
        window.__TAURI__.core.invoke("check_for_updates").catch(() => {});
      });
      await browser.waitUntil(
        () => feedTargets(requestIndex).includes(osName()),
        {
          timeout: 20_000,
          interval: 100,
          timeoutMsg: "the stable feed was not requested",
        },
      );
      // Only the file changes, so the check gets no channel event and stays current.
      writeChannelOnDisk("beta");
      held.release();
      await waitForStatus(
        "engineStatuses",
        (event) =>
          event.status === "available" && event.version === "9.5.1-beta.1",
        "the beta target was not offered after the target changed",
      );
      await dismissModal();
      const seen = (await statuses("engineStatuses")).slice(statusIndex);
      assert.ok(
        !seen.some((event) => event.version === "9.5.0"),
        JSON.stringify(seen),
      );
      const feeds = feedTargets(requestIndex);
      assert.deepEqual(feeds, [osName(), BETA]);
      record("updater-engine-target-changed-during-feed", {
        feeds,
        offered: seen
          .filter((event) => event.status === "available")
          .map((event) => event.version),
      });
    } finally {
      held.release();
      fs.writeFileSync(settingsFile(), original);
      await dismissModal();
    }
  });

  it("re-resolves the target after a feed error and restarts when it changed", async () => {
    await startScenario({ channel: "beta" });
    await browser.pause(1_000);
    const original = fs.readFileSync(settingsFile());
    const held = holdResponse();
    fixture.server.respond(BETA, 500, "held feed failure", { gate: held.gate });
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.6.0",
      payload: Buffer.from("recheck stable payload"),
      fileName: "ROSI-9.6.0.bin",
    });
    const requestIndex = fixture.server.requests.length;
    const statusIndex = (await statuses("engineStatuses")).length;
    try {
      await browser.execute(() => {
        window.__TAURI__.core.invoke("check_for_updates").catch(() => {});
      });
      await browser.waitUntil(() => feedTargets(requestIndex).includes(BETA), {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: "the beta feed was not requested",
      });
      writeChannelOnDisk("stable");
      held.release();
      await waitForStatus(
        "engineStatuses",
        (event) => event.status === "available" && event.version === "9.6.0",
        "the stable target was not offered after the failed check",
      );
      await dismissModal();
      const seen = (await statuses("engineStatuses")).slice(statusIndex);
      assert.ok(
        !seen.some((event) => event.status === "error"),
        JSON.stringify(seen),
      );
      const feeds = feedTargets(requestIndex);
      assert.deepEqual(feeds, [BETA, BETA, osName()]);
      record("updater-engine-feed-error-recheck", {
        feeds,
        sequence: seen.map((event) => event.status),
      });
    } finally {
      held.release();
      fs.writeFileSync(settingsFile(), original);
      await dismissModal();
    }
  });

  it("ends a feed error silently when the target cannot be resolved", async () => {
    await startScenario({ channel: "beta" });
    await browser.pause(1_000);
    const original = fs.readFileSync(settingsFile());
    const held = holdResponse();
    fixture.server.respond(BETA, 500, "held feed failure", { gate: held.gate });
    const requestIndex = fixture.server.requests.length;
    const statusIndex = (await statuses("engineStatuses")).length;
    try {
      await browser.execute(() => {
        window.__TAURI__.core.invoke("check_for_updates").catch(() => {});
      });
      await browser.waitUntil(() => feedTargets(requestIndex).includes(BETA), {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: "the beta feed was not requested",
      });
      // The refused save leaves the channel unsaved; no recheck starts.
      makeSettingsUnsavable();
      await setUpdateChannel("beta");
      held.release();
      await browser.waitUntil(() => feedTargets(requestIndex).length >= 2, {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: "the feed error was not retried in place",
      });
      await browser.pause(1_000);
      const seen = (await statuses("engineStatuses")).slice(statusIndex);
      const feeds = feedTargets(requestIndex);
      assert.deepEqual(feeds, [BETA, BETA]);
      assert.ok(
        !seen.some((event) => event.status === "error"),
        JSON.stringify(seen),
      );
      assert.equal(
        (await readModal()).active,
        false,
        "a silent failure opened a prompt",
      );
      record("updater-engine-feed-error-unresolved", {
        feeds,
        sequence: seen.map((event) => event.status),
      });
    } finally {
      held.release();
      fs.writeFileSync(settingsFile(), original);
      // A successful save clears the unsaved channel and rechecks.
      await setUpdateChannel("beta");
      await browser.pause(1_000);
      await dismissModal();
    }
  });

  it("reports an installed identity as downloaded without asking the feed", async () => {
    await startScenario({ restartRefusals: 1 });
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.7.0",
      payload: Buffer.from("installed identity payload"),
      fileName: "ROSI-9.7.0.bin",
    });
    const before = await engineProbe();
    await clickManualCheck();
    await waitForModal("Update Available!");
    await clickModal("Download & Install");
    await waitForModal("Update Ready!");
    await clickModal("Later");
    const candidateId = (await statuses("engineStatuses")).find(
      (event) => event.status === "downloaded",
    )?.candidateId;
    assert.ok(candidateId !== undefined, "the download did not finish");
    await invoke("install_update", { candidateId });
    const refused = await waitForModal("Update Error");
    assert.ok(refused.message.includes("refused"), refused.message);
    await clickModal("OK");
    const afterRefusal = await engineProbe();
    assert.equal(afterRefusal.installs - before.installs, 1);
    assert.equal(afterRefusal.restarts - before.restarts, 0);

    const requestIndex = fixture.server.requests.length;
    const statusIndex = (await statuses("engineStatuses")).length;
    await clickManualCheck();
    await browser.waitUntil(
      async () =>
        (await statuses("engineStatuses"))
          .slice(statusIndex)
          .some(
            (event) =>
              event.status === "downloaded" &&
              event.candidateId === candidateId,
          ),
      {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: "the installed identity was not reported",
      },
    );
    await waitForModal("Update Ready!");
    await clickModal("Later");
    const seen = (await statuses("engineStatuses"))
      .slice(statusIndex)
      .map((event) => event.status);
    const feeds = feedTargets(requestIndex);
    assert.deepEqual(feeds, []);
    assert.ok(!seen.includes("available"), JSON.stringify(seen));
    assert.deepEqual(await engineProbe(), afterRefusal);

    // The retry finishes the pending restart and releases the candidate.
    const retry = await invoke("install_update", { candidateId });
    assert.ok(retry.ok, JSON.stringify(retry));
    await browser.pause(800);
    const done = await engineProbe();
    assert.equal(done.installs - before.installs, 1);
    assert.equal(done.restarts - before.restarts, 1);
    record("updater-engine-installed-identity-reported", {
      candidateId,
      feeds,
      sequence: seen,
    });
  });

  it("keeps a downloaded candidate when the same version is offered again", async () => {
    await startScenario({});
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.8.0",
      payload: Buffer.from("same candidate payload"),
      fileName: "ROSI-9.8.0.bin",
    });
    await clickManualCheck();
    await waitForModal("Update Available!");
    await clickModal("Download & Install");
    await waitForModal("Update Ready!");
    await clickModal("Later");
    const { candidateId } = await latestCandidate();
    const requestIndex = fixture.server.requests.length;
    const statusIndex = (await statuses("engineStatuses")).length;
    const artifactsBefore = artifactRequestCount();
    await clickManualCheck();
    await browser.waitUntil(
      async () =>
        (await statuses("engineStatuses"))
          .slice(statusIndex)
          .some(
            (event) =>
              event.status === "downloaded" &&
              event.candidateId === candidateId,
          ),
      {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: "the downloaded candidate was not reported again",
      },
    );
    await waitForModal("Update Ready!");
    await clickModal("Later");
    const seen = (await statuses("engineStatuses"))
      .slice(statusIndex)
      .map((event) => event.status);
    assert.deepEqual(feedTargets(requestIndex), [osName()]);
    assert.ok(!seen.includes("available"), JSON.stringify(seen));
    assert.equal(artifactRequestCount() - artifactsBefore, 0);
    record("updater-engine-same-candidate-redownload-skipped", {
      candidateId,
      sequence: seen,
    });
    await invoke("install_update", { candidateId });
    await browser.pause(800);
  });

  it("keeps a downloaded candidate on no update and releases an undownloaded one", async () => {
    await startScenario({});
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.10.0",
      payload: Buffer.from("kept candidate payload"),
      fileName: "ROSI-9.10.0.bin",
    });
    await clickManualCheck();
    await waitForModal("Update Available!");
    await clickModal("Download & Install");
    await waitForModal("Update Ready!");
    await clickModal("Later");
    const keptId = (await latestCandidate()).candidateId;

    // Downloaded: a no-update answer reports the download, not "not available".
    fixture.server.respond(osName(), 204);
    let statusIndex = (await statuses("engineStatuses")).length;
    await clickManualCheck();
    await browser.waitUntil(
      async () =>
        (await statuses("engineStatuses"))
          .slice(statusIndex)
          .some(
            (event) =>
              event.status === "downloaded" && event.candidateId === keptId,
          ),
      {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: "the downloaded candidate was not kept",
      },
    );
    await waitForModal("Update Ready!");
    await clickModal("Later");
    const keptEvents = (await statuses("engineStatuses"))
      .slice(statusIndex)
      .map((event) => event.status);
    assert.ok(
      !keptEvents.includes("not-available"),
      JSON.stringify(keptEvents),
    );
    await invoke("install_update", { candidateId: keptId });
    await browser.pause(800);

    // Offered but not downloaded: a no-update answer releases it.
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.10.1",
      payload: Buffer.from("offered candidate payload"),
      fileName: "ROSI-9.10.1.bin",
    });
    await clickManualCheck();
    await waitForModal("Update Available!");
    await clickModal("Later");
    const offeredId = (await latestCandidate()).candidateId;
    fixture.server.respond(osName(), 204);
    statusIndex = (await statuses("engineStatuses")).length;
    await clickManualCheck();
    await waitForModal("ROSI is up to date!");
    await clickModal("OK");
    const released = await invoke("download_update", {
      candidateId: offeredId,
    });
    assert.equal(released.data?.cancelled, true, JSON.stringify(released));
    const notAvailable = (await statuses("engineStatuses"))
      .slice(statusIndex)
      .find((event) => event.status === "not-available");
    assert.ok(notAvailable, "no not-available event followed the release");
    record("updater-engine-not-available-releases-candidate", {
      keptId,
      keptEvents,
      offeredId,
      releasedCancelled: released.data.cancelled,
    });
  });

  it("computes isBeta from the version string on available and not-available events", async () => {
    await startScenario({});
    const statusIndex = (await statuses("engineStatuses")).length;
    const checkAndDismiss = async (version, title, button) => {
      fixture.server.publish({
        target: stableTarget(),
        route: osName(),
        version,
        payload: Buffer.from(`variant ${version}`),
        fileName: `ROSI-${version}.bin`,
      });
      await clickManualCheck();
      await waitForModal(title);
      await clickModal(button);
    };
    await checkAndDismiss("9.9.0-beta.1", "Beta Update Available!", "Later");
    await checkAndDismiss("9.9.1-RC.2", "Beta Update Available!", "Later");
    await checkAndDismiss("9.9.2", "Update Available!", "Later");
    fixture.server.respond(osName(), 204);
    await clickManualCheck();
    await waitForModal("ROSI is up to date!");
    await clickModal("OK");
    const events = (await statuses("engineStatuses"))
      .slice(statusIndex)
      .filter((event) => ["available", "not-available"].includes(event.status))
      .map((event) => ({
        status: event.status,
        version: event.version,
        isBeta: event.isBeta,
      }));
    assert.deepEqual(
      events.map((event) => event.isBeta),
      [true, true, false, true],
      JSON.stringify(events),
    );
    for (const event of events) {
      assert.equal(
        event.isBeta,
        /-(beta|alpha|rc)/i.test(event.version),
        JSON.stringify(event),
      );
    }
    record("updater-engine-event-variants", { events });
  });

  it("throttles download progress to 100 ms and never reports above 100 percent", async () => {
    await startScenario({});
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.14.0",
      payload: Buffer.alloc(3 * 1024 * 1024, 7),
      fileName: "ROSI-9.14.0.bin",
      drip: { chunkBytes: 32 * 1024, intervalMs: 10 },
    });
    await browser.execute(() => {
      window.__progress = [];
      window.__TAURI__.event.listen("updater-progress", (event) => {
        window.__progress.push({ ...event.payload, at: performance.now() });
      });
    });
    await clickManualCheck();
    await waitForModal("Update Available!");
    const { candidateId } = await latestCandidate();
    await clickModal("Download & Install");
    await waitForModal("Update Ready!");
    await clickModal("Later");
    const progress = await browser.execute(() => window.__progress.slice());
    assert.ok(progress.length >= 2, JSON.stringify(progress));
    const gaps = progress
      .slice(1)
      .map((event, index) => event.at - progress[index].at);
    // Gaps are measured at page arrival, which IPC jitter can shorten; the
    // count bound below is the primary proof, so the median only guards gross bursts.
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
    assert.ok(medianGap >= 90, `progress gaps: ${JSON.stringify(gaps)}`);
    assert.ok(
      progress.every((event) => event.percent >= 0 && event.percent <= 100),
      JSON.stringify(progress.map((event) => event.percent)),
    );
    const spanMs = progress.at(-1).at - progress[0].at;
    assert.ok(
      progress.length <= Math.ceil(spanMs / 100) + 1,
      `${progress.length} events in ${spanMs} ms`,
    );

    // A cancelled download emits no more progress.
    await browser.execute((id) => {
      window.__TAURI__.core
        .invoke("download_update", { candidateId: id })
        .catch(() => {});
    }, candidateId);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.__progress.length)) >=
        progress.length + 2,
      {
        timeout: 20_000,
        interval: 50,
        timeoutMsg: "the second download made no progress",
      },
    );
    await invoke("cancel_update_download");
    await waitForModal("Download Cancelled");
    await clickModal("OK");
    const atCancel = await browser.execute(() => window.__progress.length);
    await browser.pause(1_500);
    const afterCancel = await browser.execute(() => window.__progress.length);
    assert.equal(afterCancel, atCancel, "progress arrived after the cancel");
    record("updater-engine-download-progress-throttle", {
      events: progress.length,
      minGapMs: Math.min(...gaps),
      spanMs,
      progressAfterCancel: afterCancel - atCancel,
    });
  });

  it("times out a check at 30 seconds without an override", async () => {
    await startScenario({});
    const held = holdResponse();
    fixture.server.respond(osName(), 200, "", { gate: held.gate });
    const statusIndex = (await statuses("engineStatuses")).length;
    try {
      const started = Date.now();
      // Not awaited: the command returns only when the held check settles.
      await browser.execute(() => {
        window.__TAURI__.core.invoke("check_for_updates").catch(() => {});
      });
      await waitForStatus(
        "engineStatuses",
        (event) => event.status === "error",
        "the held check never timed out",
        60_000,
      );
      const elapsedMs = Date.now() - started;
      const error = (await statuses("engineStatuses"))
        .slice(statusIndex)
        .find((event) => event.status === "error");
      assert.equal(error.kind, "feed", JSON.stringify(error));
      assert.ok(
        elapsedMs >= 29_000 && elapsedMs < 45_000,
        `check timed out after ${elapsedMs} ms`,
      );
      record("updater-engine-check-timeout", {
        elapsedMs,
        kind: error.kind,
        message: error.message,
      });
    } finally {
      held.release();
    }
  });

  it("times out a download at its configured limit and keeps the candidate", async () => {
    await startScenario({ downloadTimeoutMs: 1_500 });
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.15.0",
      payload: Buffer.alloc(4 * 1024 * 1024, 9),
      fileName: "ROSI-9.15.0.bin",
      drip: { chunkBytes: 64 * 1024, intervalMs: 100 },
    });
    await clickManualCheck();
    await waitForModal("Update Available!");
    const { candidateId } = await latestCandidate();
    await clickModal("Later");
    const started = Date.now();
    const first = await invoke("download_update", { candidateId });
    const elapsedMs = Date.now() - started;
    assert.ok(first.data?.error, JSON.stringify(first));
    // The full body takes about 6 s, so the limit is what ended the transfer.
    assert.ok(elapsedMs >= 1_400 && elapsedMs < 5_000, `${elapsedMs} ms`);
    await waitForModal("Update Error");
    await clickModal("OK");
    const errors = (await statuses("engineStatuses")).filter(
      (event) => event.status === "error",
    );
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.equal(errors[0].kind, "download");

    // A failed transfer keeps the candidate, so a retry times out, not cancels.
    const second = await invoke("download_update", { candidateId });
    assert.ok(second.data?.error, JSON.stringify(second));
    await waitForModal("Update Error");
    await clickModal("OK");
    record("updater-engine-download-timeout", {
      candidateId,
      elapsedMs,
      message: first.data.error,
      retainedCandidate: second.data.cancelled !== true,
    });
  });

  it("releases a candidate whose download fails after the bytes arrived", async () => {
    await startScenario({});
    const original = fs.readFileSync(settingsFile());
    const held = holdResponse();
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.16.0",
      payload: Buffer.from("post completion failure payload"),
      fileName: "ROSI-9.16.0.bin",
      gate: held.gate,
    });
    await clickManualCheck();
    await waitForModal("Update Available!");
    const { candidateId } = await latestCandidate();
    const statusIndex = (await statuses("engineStatuses")).length;
    try {
      const artifactsBefore = artifactRequestCount();
      await clickModal("Download & Install");
      await browser.waitUntil(() => artifactRequestCount() > artifactsBefore, {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: "the download never started",
      });
      // The channel cannot be saved while the bytes are in flight.
      makeSettingsUnsavable();
      await setUpdateChannel("stable");
      held.release();
      const modal = await waitForModal("Update Error");
      assert.match(modal.message, /could not be saved before revalidation/);
      await clickModal("OK");
      const seen = (await statuses("engineStatuses")).slice(statusIndex);
      const errors = seen.filter((event) => event.status === "error");
      assert.equal(errors.length, 1, JSON.stringify(seen));
      assert.equal(errors[0].kind, "download");
      assert.ok(!seen.some((event) => event.status === "downloaded"));
      const released = await invoke("download_update", { candidateId });
      assert.equal(released.data?.cancelled, true, JSON.stringify(released));
      record("updater-engine-download-failure-releases-candidate", {
        candidateId,
        errorKind: errors[0].kind,
        releasedCancelled: released.data.cancelled,
      });
    } finally {
      held.release();
      fs.writeFileSync(settingsFile(), original);
      await setUpdateChannel("stable");
      await browser.pause(1_000);
      await dismissModal();
    }
  });

  it("waits for an install that already started before honoring a channel change", async () => {
    await startScenario({ installWriteHoldMs: 1_500 });
    await browser.pause(1_000);
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.12.0",
      payload: Buffer.from("install hold payload"),
      fileName: "ROSI-9.12.0.bin",
    });
    fixture.server.publish({
      target: BETA,
      version: "9.12.1-beta.1",
      payload: Buffer.from("beta after install payload"),
      fileName: "ROSI-9.12.1-beta.1.bin",
    });
    await clickManualCheck();
    await waitForModal("Update Available!");
    const { candidateId } = await latestCandidate();
    await clickModal("Download & Install");
    await waitForModal("Update Ready!");
    await clickModal("Later");

    const before = await engineProbe();
    const requestIndex = fixture.server.requests.length;
    // Not awaited: the command returns once the install has finished.
    await browser.execute((id) => {
      window.__TAURI__.core
        .invoke("install_update", { candidateId: id })
        .catch(() => {});
    }, candidateId);
    // The install holds 1.5 s after it confirms its target; change the channel inside that window.
    await browser.pause(400);
    await setUpdateChannel("beta");
    const midInstall = await engineProbe();
    assert.equal(midInstall.installs - before.installs, 0);
    assert.equal(midInstall.restarts - before.restarts, 0);
    assert.deepEqual(feedTargets(requestIndex), []);

    await browser.waitUntil(
      async () => (await engineProbe()).restarts - before.restarts === 1,
      {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: "the install did not restart",
      },
    );
    const done = await engineProbe();
    assert.equal(done.installs - before.installs, 1);
    assert.equal(done.refusedRestarts - before.refusedRestarts, 0);

    // The held channel change rechecks the beta target once the install ends.
    await waitForModal("Beta Update Available!");
    await clickModal("Later");
    const feeds = feedTargets(requestIndex);
    assert.deepEqual(feeds, [BETA]);
    record("updater-engine-channel-change-during-install", {
      midInstall: {
        installs: midInstall.installs - before.installs,
        restarts: midInstall.restarts - before.restarts,
      },
      feeds,
    });
  });

  it("exits an install whose candidate a channel change released before it confirmed", async () => {
    await startScenario({ installConfirmHoldMs: 1_500 });
    await browser.pause(1_000);
    fixture.server.publish({
      target: stableTarget(),
      route: osName(),
      version: "9.13.0",
      payload: Buffer.from("stale install payload"),
      fileName: "ROSI-9.13.0.bin",
    });
    fixture.server.publish({
      target: BETA,
      version: "9.13.1-beta.1",
      payload: Buffer.from("beta after stale install"),
      fileName: "ROSI-9.13.1-beta.1.bin",
    });
    await clickManualCheck();
    await waitForModal("Update Available!");
    const { candidateId } = await latestCandidate();
    await clickModal("Download & Install");
    await waitForModal("Update Ready!");
    await clickModal("Later");

    const before = await engineProbe();
    const requestIndex = fixture.server.requests.length;
    const statusIndex = (await statuses("engineStatuses")).length;
    // Not awaited: the install waits 1.5 s before it confirms its target.
    await browser.execute((id) => {
      window.__TAURI__.core
        .invoke("install_update", { candidateId: id })
        .catch(() => {});
    }, candidateId);
    await browser.pause(400);
    // Releases the candidate while the install waits for its target check.
    await setUpdateChannel("beta");
    const midInstall = await engineProbe();
    assert.equal(midInstall.installs - before.installs, 0);

    await browser.waitUntil(() => feedTargets(requestIndex).includes(BETA), {
      timeout: 20_000,
      interval: 100,
      timeoutMsg: "the channel change did not recheck the beta target",
    });
    await waitForModal("Beta Update Available!");
    await clickModal("Later");
    const after = await engineProbe();
    assert.equal(after.installs - before.installs, 0);
    assert.equal(after.restarts - before.restarts, 0);
    assert.equal(after.refusedRestarts - before.refusedRestarts, 0);
    const seen = (await statuses("engineStatuses"))
      .slice(statusIndex)
      .map((event) => event.status);
    assert.ok(!seen.includes("error"), JSON.stringify(seen));
    const feeds = feedTargets(requestIndex);
    assert.deepEqual(feeds, [BETA]);

    const released = await invoke("download_update", { candidateId });
    assert.equal(released.data?.cancelled, true, JSON.stringify(released));
    record("updater-engine-install-identity-stale", {
      feeds,
      installs: after.installs - before.installs,
      sequence: seen,
    });
  });
});
