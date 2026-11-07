import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { waitForAppReady } from "../../helpers/app-bridge.js";

const resultsDirectory = process.env.ROSI_V5_ASYNC_PROXY_RESULTS_DIR;
const observations = [];
let outcome;

function record(name, details) {
  observations.push({ name, ...details });
  if (!resultsDirectory) return;
  fs.mkdirSync(resultsDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDirectory, "observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
}

async function invokeProbe() {
  const encoded = await browser.executeAsync((done) => {
    window.__TAURI__.core.invoke("e2e_network_pipelining_probe").then(
      (value) => done(JSON.stringify({ ok: true, value })),
      (error) => done(JSON.stringify({ ok: false, error: String(error) })),
    );
  });
  return JSON.parse(encoded);
}

function probeSection(name) {
  assert.ok(outcome?.ok, JSON.stringify(outcome));
  const section = outcome.value?.asyncProxy?.[name];
  assert.ok(section, `probe omitted asyncProxy.${name}`);
  return section;
}

describe("V5 bounded asynchronous proxy", () => {
  before(async () => {
    await waitForAppReady();
    outcome = await invokeProbe();
  });

  it("serves at least 256 simultaneous vetted CONNECT tunnels", async () => {
    const capacity = outcome.value?.asyncProxy?.capacity;
    const invariantPassed =
      outcome.ok === true &&
      capacity?.requestedTunnels === 256 &&
      capacity?.activeLimit >= 256 &&
      capacity?.activeAtCapacity >= 256 &&
      capacity?.peakActiveTunnels >= 256 &&
      capacity?.peakActiveConnections >= 256;
    record("active-tunnel-capacity", {
      probeError: outcome.ok ? null : outcome.error,
      capacity: capacity ?? null,
      invariantPassed,
    });
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(capacity?.requestedTunnels, 256);
    assert.ok(capacity?.activeLimit >= 256);
    assert.ok(capacity?.activeAtCapacity >= 256);
    assert.ok(capacity?.peakActiveTunnels >= 256);
    assert.ok(capacity?.peakActiveConnections >= 256);
  });

  it("caps pending admissions and rejects overload with HTTP 503", async () => {
    const capacity = outcome.value?.asyncProxy?.capacity;
    const invariantPassed =
      outcome.ok === true &&
      capacity?.pendingLimit > 0 &&
      capacity?.pendingHighWater === capacity?.pendingLimit &&
      capacity?.overloadStatus === 503 &&
      capacity?.overloadRejections >= 1;
    record("bounded-overload", {
      probeError: outcome.ok ? null : outcome.error,
      pendingLimit: capacity?.pendingLimit ?? null,
      pendingHighWater: capacity?.pendingHighWater ?? null,
      overloadStatus: capacity?.overloadStatus ?? null,
      overloadRejections: capacity?.overloadRejections ?? null,
      invariantPassed,
    });
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.ok(capacity?.pendingLimit > 0);
    assert.equal(capacity?.pendingHighWater, capacity?.pendingLimit);
    assert.equal(capacity?.overloadStatus, 503);
    assert.ok(capacity?.overloadRejections >= 1);
  });

  it("cancels active and queued proxy sockets and upstream tunnels", async () => {
    const cancellation = probeSection("cancellation");
    const invariantPassed =
      cancellation.activeConnectionsAfterCancel === 0 &&
      cancellation.activeTunnelsAfterCancel === 0 &&
      cancellation.pendingAdmissionsAfterCancel === 0 &&
      cancellation.closedClientSockets === cancellation.expectedClientSockets &&
      cancellation.expectedClientSockets === 384 &&
      cancellation.closedOriginSockets === cancellation.expectedOriginSockets &&
      cancellation.expectedOriginSockets === 256 &&
      cancellation.elapsedMs <= 5000;
    record("operation-cancellation-cleanup", { cancellation, invariantPassed });
    assert.equal(cancellation.activeConnectionsAfterCancel, 0);
    assert.equal(cancellation.activeTunnelsAfterCancel, 0);
    assert.equal(cancellation.pendingAdmissionsAfterCancel, 0);
    assert.equal(cancellation.closedClientSockets, 384);
    assert.equal(cancellation.closedOriginSockets, 256);
    assert.ok(cancellation.elapsedMs <= 5000);
  });

  it("drops its listener and active client without blocking", async () => {
    const drop = probeSection("drop");
    const invariantPassed =
      drop.activeConnectionsAfterDrop === 0 &&
      drop.closedClientSocket === true &&
      drop.elapsedMs <= 5000;
    record("guard-drop-cleanup", { drop, invariantPassed });
    assert.equal(drop.activeConnectionsAfterDrop, 0);
    assert.equal(drop.closedClientSocket, true);
    assert.ok(drop.elapsedMs <= 5000);
  });

  it("keeps an idle tunnel from waking the relay", async () => {
    const idle = probeSection("idle");
    const invariantPassed =
      idle.openTunnels === 1 &&
      idle.activeTunnelsAtWindowEnd === 1 &&
      idle.windowMs === 5000 &&
      idle.idleWakeups <= 2;
    record("idle-tunnel-wakeups", { idle, invariantPassed });
    assert.equal(idle.openTunnels, 1);
    assert.equal(idle.activeTunnelsAtWindowEnd, 1);
    assert.equal(idle.windowMs, 5000);
    assert.ok(
      idle.idleWakeups <= 2,
      `idle tunnel woke the relay ${idle.idleWakeups} times`,
    );
  });

  it("retains HTTP pipeline blocking and bounded DNS resolution", async () => {
    const requests = outcome.value?.requests ?? [];
    const dns = outcome.value?.dnsResolution;
    const invariantPassed =
      outcome.ok === true &&
      outcome.value?.responseStatus === 200 &&
      requests.length === 1 &&
      requests.every((request) => request.includes("/first")) &&
      outcome.value?.secondTargetForwarded === false &&
      dns?.maxActiveWorkers <= dns?.workerLimit &&
      dns?.workerLimit === 4 &&
      dns?.queueHighWater <= dns?.queueLimit &&
      dns?.queueLimit === 16 &&
      dns?.batchesAtQueueLimit === 3 &&
      dns?.pendingAfterDrain === 0 &&
      dns?.activeAfterDrain === 0;
    record("framing-and-dns-regression", {
      probeError: outcome.ok ? null : outcome.error,
      requestCount: requests.length,
      responseStatus: outcome.value?.responseStatus ?? null,
      secondTargetForwarded: outcome.value?.secondTargetForwarded ?? null,
      dns: dns ?? null,
      invariantPassed,
    });
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(outcome.value?.responseStatus, 200);
    assert.equal(requests.length, 1);
    assert.ok(requests.every((request) => request.includes("/first")));
    assert.equal(outcome.value?.secondTargetForwarded, false);
    assert.equal(dns?.workerLimit, 4);
    assert.ok(dns?.maxActiveWorkers <= dns?.workerLimit);
    assert.ok(dns?.queueHighWater <= dns?.queueLimit);
    assert.equal(dns?.batchesAtQueueLimit, 3);
    assert.equal(dns?.pendingAfterDrain, 0);
    assert.equal(dns?.activeAfterDrain, 0);
  });
});
