// Starts a local signed update server and points the Rust updater at it.
// Used by the updater scenarios; the key is generated into the scenario's own
// temporary directory, so nothing signed is committed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { browser } from "@wdio/globals";
import { startUpdaterServer } from "./updater-server.js";
import { generateUpdaterSigningKey } from "./updater-signing.js";

/**
 * Configures the engine. Overrides mirror the E2E binary's platform answers:
 * it is never packaged, has no bundle type, and runs under no Flatpak.
 */
export async function startUpdaterFixture({
  isPackaged = true,
  isFlatpak = false,
  betaTarget = "darwin-beta-aarch64-app",
  compactTarget = null,
  disableCompact = true,
  restartRefusals = 0,
  checkTimeoutMs,
  downloadTimeoutMs,
  installConfirmHoldMs,
  installWriteHoldMs,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-updater-e2e-"));
  const key = generateUpdaterSigningKey(dir);
  const server = await startUpdaterServer({ key });
  const config = {
    endpoint: server.endpoint,
    pubkey: key.pubkey,
    isPackaged,
    isFlatpak,
    betaTarget,
    compactTarget,
    disableCompact,
    installProbe: true,
    restartRefusals,
    checkTimeoutMs,
    downloadTimeoutMs,
    installConfirmHoldMs,
    installWriteHoldMs,
  };
  const outcome = await browser.executeAsync((payload, done) => {
    window.__TAURI__.core
      .invoke("e2e_configure_updater", { config: payload })
      .then(
        () => done({ ok: true }),
        (error) => done({ error: String(error) }),
      );
  }, config);
  if (!outcome?.ok) {
    await server.close();
    throw new Error(`e2e_configure_updater failed: ${JSON.stringify(outcome)}`);
  }
  return {
    server,
    key,
    dir,
    async close() {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Sets the persisted update channel through the engine's command. */
export async function setUpdateChannel(channel) {
  await browser.executeAsync((next, done) => {
    window.__TAURI__.core.invoke("set_update_channel", { channel: next }).then(
      () => done({ ok: true }),
      (error) => done({ error: String(error) }),
    );
  }, channel);
}

/** Starts a manual check the way the Check for updates button does. */
export async function clickManualCheck() {
  await browser.execute(() =>
    document.getElementById("checkUpdateBtn")?.click(),
  );
}

/** Captures updater-status events in the page, in arrival order. */
export async function captureUpdaterStatuses(storeName) {
  await browser.execute((name) => {
    window[name] = [];
    window.__TAURI__.event.listen("updater-status", (event) =>
      window[name].push(event.payload),
    );
  }, storeName);
}
