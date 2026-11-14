import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exactMochaTitlePattern } from "../scripts/e2e/core.js";

const binary = process.env.ROSI_E2E_BINARY;
if (!binary) {
  throw new Error("ROSI_E2E_BINARY is not set (run npm run test:e2e)");
}

const configDir = path.dirname(fileURLToPath(import.meta.url));

// Embedded WebDriver port. Passed to @wdio/tauri-service explicitly so the
// waits below poll the port the service launches the app on.
const WEBDRIVER_PORT =
  Number.parseInt(process.env.TAURI_WEBDRIVER_PORT ?? "", 10) || 4445;
// Bounds for the two waits that guard each spec's session start.
const SESSION_WAIT_TIMEOUT_MS = 30_000;
const SESSION_WAIT_POLL_MS = 250;
// Backend output captured by captureBackendLogs (see the service options).
const CAPTURED_LOG_DIR = path.join(process.cwd(), "logs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Hook errors in config hooks are logged and do not fail the spec, so a
// failed wait exits the worker. A non-zero worker exit fails that spec.
function failWorker(message) {
  console.error(`[e2e] ${message}`);
  process.exit(1);
}

/** One TCP probe of 127.0.0.1:port. "refused" means nothing is listening. */
function probeTcpPort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (state) => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(1_000, () => finish("timeout"));
    socket.once("connect", () => finish("listening"));
    socket.once("error", (error) =>
      finish(
        error.code === "ECONNREFUSED"
          ? "refused"
          : `error:${error.code ?? error.message}`,
      ),
    );
  });
}

/**
 * Wait until the previous app has exited and released the port. Otherwise the
 * service can reuse that app for the next spec, and then the app exits under
 * the session.
 */
async function waitForEmbeddedPortRelease(port) {
  const deadline = Date.now() + SESSION_WAIT_TIMEOUT_MS;
  let state = "listening";
  while (Date.now() < deadline) {
    state = await probeTcpPort(port);
    if (state === "refused") return;
    await sleep(SESSION_WAIT_POLL_MS);
  }
  failWorker(
    `The previous ROSI app still accepts connections on 127.0.0.1:${port} ` +
      `(last probe: ${state}) after ${SESSION_WAIT_TIMEOUT_MS} ms. The next ` +
      `spec would attach to that stale app. Backend output is in the run ` +
      `output and in ${CAPTURED_LOG_DIR}.`,
  );
}

/**
 * Wait until the new app's embedded WebDriver answers GET /status with
 * ready=true, the same rule the service uses. Runs before the real session is
 * created.
 */
async function waitForEmbeddedWebDriver(port) {
  const deadline = Date.now() + SESSION_WAIT_TIMEOUT_MS;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const data = await response.json();
        if (data?.value?.ready === true) return;
        last = `ready=${data?.value?.ready}`;
      } else {
        last = `HTTP ${response.status}`;
      }
    } catch (error) {
      last = error.cause?.code ?? error.name ?? error.message;
    }
    await sleep(SESSION_WAIT_POLL_MS);
  }
  failWorker(
    `Embedded WebDriver on 127.0.0.1:${port} did not report ready on GET ` +
      `/status within ${SESSION_WAIT_TIMEOUT_MS} ms (last: ${last}). The app ` +
      `may have crashed during startup. Backend output is in the run output ` +
      `and in ${CAPTURED_LOG_DIR}.`,
  );
}
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
  "./download-process.spec.js",
  "./download-process-targeted.spec.js",
]);
const processRepairRun =
  process.env.ROSI_E2E_PROCESS_REPAIRS === "1" &&
  specs.length === 1 &&
  LONG_PROCESS_SPECS.has(specs[0]);
const selectedMochaTitles = process.env.ROSI_E2E_MOCHA_TITLES
  ? JSON.parse(process.env.ROSI_E2E_MOCHA_TITLES)
  : null;

async function requestGracefulAppShutdown() {
  const activeBrowser = globalThis.browser;
  if (!activeBrowser?.sessionId) return;
  // The close-flow scenario already closed the main window through the real
  // close path; there is no webview left to run the exit request in.
  if (globalThis.rosiMainWindowClosed) {
    // On Windows and Linux closing the last window exits ROSI, taking the
    // embedded WebDriver server with it, so the session cannot be deleted.
    // macOS keeps the app (and the server) running without a window.
    if (process.platform !== "darwin") {
      activeBrowser.sessionId = undefined;
      await waitForEmbeddedPortRelease(WEBDRIVER_PORT);
    }
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
  await waitForEmbeddedPortRelease(WEBDRIVER_PORT);
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
        embeddedPort: WEBDRIVER_PORT,
        // Backend stdout/stderr is forwarded into the run output so a crash
        // during startup is visible in the failure message.
        captureBackendLogs: true,
        windowLabel: "main",
        startTimeout: 180_000,
      },
    ],
  ],
  // Runs before each spec's real session. The service already waits for the
  // app it launches; this confirms the port answers before POST /session.
  beforeSession: async function waitForEmbeddedWebDriverSession() {
    await waitForEmbeddedWebDriver(WEBDRIVER_PORT);
  },
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    ...(selectedMochaTitles
      ? { grep: new RegExp(exactMochaTitlePattern(selectedMochaTitles)) }
      : {}),
    // Give the isolated process-repair specs a bounded six-minute ceiling
    // without changing the timeout for the rest of the GUI suite.
    timeout: processRepairRun ? 360_000 : 180_000,
  },
  after: requestGracefulAppShutdown,
};
