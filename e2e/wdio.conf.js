const binary = process.env.ROSI_E2E_BINARY;
if (!binary) {
  throw new Error("ROSI_E2E_BINARY is not set (run npm run test:e2e)");
}

const specs = process.env.ROSI_E2E_SPECS
  ? [process.env.ROSI_E2E_SPECS]
  : ["./specs/**/*.spec.js"];

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
  await activeBrowser.execute(() => {
    window.setTimeout(() => {
      void window.__TAURI__.core
        .invoke("plugin:process|exit", { code: 0 })
        .catch(() => {});
    }, 50);
  });
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
    timeout: 180_000,
  },
  after: requestGracefulAppShutdown,
};
