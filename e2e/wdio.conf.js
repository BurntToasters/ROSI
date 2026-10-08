import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.env.ROSI_E2E_BINARY;
if (!binary) {
  throw new Error("ROSI_E2E_BINARY is not set (run npm run test:e2e)");
}

const configDir = path.dirname(fileURLToPath(import.meta.url));
// Areas with run.mjs are driven by their runner, which passes its own
// ROSI_E2E_SPECS. The default pass covers only the other areas' specs so no
// spec runs twice.
const genericV5Specs = fs
  .readdirSync(path.join(configDir, "v5-fixes"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .filter((entry) => {
    const area = path.join(configDir, "v5-fixes", entry.name);
    return (
      !fs.existsSync(path.join(area, "run.mjs")) &&
      fs.readdirSync(area).some((file) => file.endsWith(".spec.js"))
    );
  })
  .map((entry) => `./v5-fixes/${entry.name}/*.spec.js`);
// WDIO resolves these patterns relative to this config file's directory (e2e/).
const specs = process.env.ROSI_E2E_SPECS
  ? process.env.ROSI_E2E_SPECS.split(",")
      .map((spec) => spec.trim())
      .filter(Boolean)
  : ["./specs/**/*.spec.js", ...genericV5Specs];
// Process-repair specs batch many native failure cases into one `it`, so they
// get a longer ceiling than the rest of the GUI suite.
const LONG_PROCESS_SPECS = new Set([
  "./download-process-repairs.spec.js",
  "./audit3-native-targeted.spec.js",
]);
const processRepairRun =
  process.env.ROSI_E2E_PROCESS_REPAIRS === "1" &&
  specs.length === 1 &&
  LONG_PROCESS_SPECS.has(specs[0]);

async function requestGracefulAppShutdown() {
  const activeBrowser = globalThis.browser;
  if (!activeBrowser?.sessionId) return;
  // The close-flow scenario already closed the main window through the real
  // close path; there is no webview left to run the exit request in.
  if (globalThis.rosiMainWindowClosed) {
    // On Windows and Linux closing the last window exits ROSI, taking the
    // embedded WebDriver server with it, so the session cannot be deleted.
    // macOS keeps the app (and the server) running without a window.
    if (process.platform !== "darwin") activeBrowser.sessionId = undefined;
    return;
  }

  const processApiAvailable = await activeBrowser.execute(
    () => typeof window.__TAURI__?.core?.invoke === "function",
  );
  if (!processApiAvailable) {
    throw new Error("Tauri process API is unavailable during E2E teardown");
  }

  // WDIO's embedded provider terminates only the top-level app process. On
  // Windows that can orphan WebView2 children long enough to lock the isolated
  // profile. Ask Tauri to exit first, after this WebDriver command responds.
  try {
    await activeBrowser.execute(() => {
      window.setTimeout(() => {
        void window.__TAURI__.core
          .invoke("plugin:process|exit", { code: 0 })
          .catch(() => {});
      }, 250);
    });
  } catch (error) {
    // The app can exit before the reply is flushed (seen on WebKitGTK).
    if (!/UND_ERR_SOCKET|ECONNREFUSED|ECONNRESET/.test(String(error))) {
      throw error;
    }
  }
  // Exiting takes the embedded WebDriver server with it, so there is no
  // session left to delete.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  activeBrowser.sessionId = undefined;
}

export const config = {
  runner: "local",
  specs,
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "wdio:maxInstances": 1,
      "tauri:options": {
        application: binary,
        args: [],
      },
    },
  ],
  logLevel: "warn",
  // scripts/test-e2e.js starts Xvfb itself when there is no X11 or Wayland
  // display. WDIO's own wrapper ignores WAYLAND_DISPLAY and re-launches the
  // worker under xvfb-run, which breaks the worker IPC on Wayland sessions.
  autoXvfb: false,
  bail: 1,
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 2,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: binary,
        appArgs: [],
        driverProvider: "embedded",
        windowLabel: "main",
        startTimeout: 180_000,
      },
    ],
  ],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    // Give the isolated process-repair specs a bounded six-minute ceiling
    // without changing the timeout for the rest of the GUI suite.
    timeout: processRepairRun ? 360_000 : 180_000,
  },
  after: requestGracefulAppShutdown,
};
