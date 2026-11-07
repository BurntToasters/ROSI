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
const EXPECTED_CHECKS = 9;
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

async function waitForStatus(store, predicate, message) {
  await browser.waitUntil(async () => (await statuses(store)).some(predicate), {
    timeout: 20_000,
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
});
