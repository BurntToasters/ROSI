import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { waitForAppReady } from "../../helpers/app-bridge.js";

const resultsDirectory = process.env.ROSI_V5_NETWORK_RESULTS_DIR;
const observations = [];
// Must match the fixed matrix in network_security.rs (e2e_policy_matrix).
const EXPECTED_ADDRESS_ROWS = 44;
const EXPECTED_URL_ROWS = 14;

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

describe("V5 network destination policy", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("classifies every fixed IP literal with the shared policy", async () => {
    const outcome = await invokeProbe();
    const matrix = outcome.value?.policyMatrix;
    const addresses = matrix?.addresses ?? [];
    const mismatches = addresses.filter((row) => row.expected !== row.actual);
    record("address-policy-matrix", {
      rows: addresses.length,
      mismatches,
      invariantPassed:
        outcome.ok === true &&
        addresses.length === EXPECTED_ADDRESS_ROWS &&
        mismatches.length === 0,
    });
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(addresses.length, EXPECTED_ADDRESS_ROWS);
    assert.deepEqual(mismatches, []);
  });

  it("allows NAT64 only for public embedded IPv4", async () => {
    const outcome = await invokeProbe();
    const rows = (outcome.value?.policyMatrix?.addresses ?? []).filter((row) =>
      row.address.toLowerCase().startsWith("64:ff9b:"),
    );
    const publicRows = rows.filter((row) => row.expected === true);
    const blockedRows = rows.filter((row) => row.expected === false);
    record("nat64-policy", {
      publicRows: publicRows.map((row) => row.address),
      blockedRows: blockedRows.map((row) => row.address),
      invariantPassed:
        publicRows.length >= 2 &&
        blockedRows.length >= 7 &&
        rows.every((row) => row.actual === row.expected),
    });
    assert.ok(publicRows.length >= 2, "no public NAT64 rows were checked");
    assert.ok(blockedRows.length >= 7, "no blocked NAT64 rows were checked");
    assert.ok(rows.every((row) => row.actual === row.expected));
  });

  it("applies the same rules to URL literals in the syntactic pre-check", async () => {
    const outcome = await invokeProbe();
    const urls = outcome.value?.policyMatrix?.urls ?? [];
    const mismatches = urls.filter((row) => row.expected !== row.actual);
    record("url-policy-matrix", {
      rows: urls.length,
      mismatches,
      invariantPassed:
        urls.length === EXPECTED_URL_ROWS && mismatches.length === 0,
    });
    assert.equal(urls.length, EXPECTED_URL_ROWS);
    assert.deepEqual(mismatches, []);
  });
});
