const {
  audioFormat,
  formatList,
  videoFormat,
} = require("./format-fixtures.cjs");
const fs = require("fs");
const path = require("node:path");
const ts = require(
  path.join(path.resolve(__dirname, "../.."), "node_modules/typescript"),
);
const { JSDOM, VirtualConsole } = require(
  path.join(path.resolve(__dirname, "../.."), "node_modules/jsdom"),
);
const root = path.resolve(__dirname, "../..");
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push(e.message));
const html = fs
  .readFileSync(root + "/src/index.html", "utf8")
  .replace(/<script[\s\S]*?<\/script>/gi, "");
const dom = new JSDOM(html, {
  url: "http://localhost",
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const w = dom.window;
Object.defineProperty(w.HTMLElement.prototype, "offsetParent", {
  get() {
    return this.parentElement;
  },
});
w.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
const testSource = fs.readFileSync(
  root + "/src/tests/rosiEngine.dom.test.ts",
  "utf8",
);
const defaults = testSource.slice(
  testSource.indexOf("function defaultSettings()"),
  testSource.indexOf("function buildMockApi"),
);
w.eval(defaults);
const s = w.defaultSettings();
s.downloadFolder = "/tmp/downloads";
s.advancedOptions = true;
let downloadArgs;
const ok = (data) => Promise.resolve({ ok: true, data });
const api = new Proxy(
  {
    getChannel: () => "github",
    getSettings: () => Promise.resolve(s),
    saveSettings: (v) => ok(v),
    getAppVersion: () => Promise.resolve("5.0.0-beta.2"),
    getAppPlatform: () => Promise.resolve("darwin"),
    checkDenoInstalled: () => Promise.resolve(true),
    getQueue: () => Promise.resolve([]),
    getFormats: () =>
      ok(formatList([videoFormat("137", "1920x1080"), audioFormat("140")])),
    getVideoInfo: () => ok({}),
    downloadVideo: (a) => {
      downloadArgs = a;
      return ok({ started: true, sessionId: 1 });
    },
    isPackaged: () => Promise.resolve(false),
    getDownloadActivity: () => ok([]),
  },
  {
    get: (o, k) =>
      k in o
        ? o[k]
        : String(k).startsWith("on")
          ? () => () => {}
          : () => ok({}),
  },
);

// Renderer-side updater checks. The updater engine lives in Rust
// (src-tauri/src/updater.rs) and is covered by the real-app scenarios in
// e2e/v5-fixes/updater-engine. Here the Tauri IPC layer is a fake: commands
// are recorded, and updater-status events are emitted by the test, so only
// what the renderer does with each answer and event is checked.
const { createTauriShim } = require("./tauri-shim.cjs");
const { invocations, emit, externals } = createTauriShim();
const load = require("./load-renderer.cjs").createRendererLoader(
  w,
  root,
  ts,
  externals,
  { "api.ts": { api } },
);
for (const m of ["ui", "downloads", "queue", "settings", "updates", "dock"])
  load("modules/" + m + ".ts");
const updater = load("engine/updater-ui.ts");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const commandsNamed = (name) =>
  invocations.filter((entry) => entry.command === name);
const modalTitle = () => w.document.getElementById("modal-title").textContent;
const modalMessage = () =>
  w.document.getElementById("modal-message").textContent;
const clickModalButton = (label) => {
  const button = [...w.document.querySelectorAll("#modal-buttons button")].find(
    (entry) => entry.textContent.trim() === label,
  );
  button?.click();
  return button;
};

(async () => {
  await wait(60);
  updater.setupAutoUpdater(async () => true);

  // Channel change: the renderer forwards the channel; Rust saves and revalidates it.
  updater.notifyUpdateChannelChanged("auto");
  await wait(20);
  const channelForwarded = commandsNamed("set_update_channel").some(
    (entry) => entry.args?.channel === "auto",
  );

  // Two candidates in a row: the first prompt is retired by the second.
  emit("updater-status", {
    status: "available",
    candidateId: 1,
    version: "6.0.0",
    releaseNotes: null,
    isBeta: false,
    manualInstall: false,
  });
  await wait(30);
  const firstPrompt = modalMessage();
  const oldPromptButton = [...w.document.querySelectorAll("#modal-buttons button")].find(
    (entry) => entry.textContent.trim() === "Download & Install",
  );
  emit("updater-status", {
    status: "available",
    candidateId: 2,
    version: "7.0.0-beta.1",
    releaseNotes: null,
    isBeta: true,
    manualInstall: false,
  });
  await wait(30);
  const activePromptAfterSecondCheck = modalMessage();
  const oldPromptStillConnected = oldPromptButton?.isConnected ?? false;

  // The superseded prompt must not start a download for candidate 1.
  oldPromptButton?.click();
  await wait(30);
  const downloadCallsAfterStale = commandsNamed("download_update").map(
    (entry) => entry.args?.candidateId,
  );

  // Downloaded candidate 2 is the only one offered for install.
  clickModalButton("Later");
  emit("updater-status", {
    status: "downloaded",
    candidateId: 2,
    version: "7.0.0-beta.1",
  });
  await wait(30);
  const readyPromptTitle = modalTitle();
  clickModalButton("Restart Now");
  await wait(400);
  const installCalls = commandsNamed("install_update").map(
    (entry) => entry.args?.candidateId,
  );

  console.log(
    JSON.stringify(
      {
        channelForwarded,
        firstPrompt,
        activePromptAfterSecondCheck,
        readyPromptTitle,
        firstCandidateId: 1,
        currentCandidateId: 2,
        oldPromptStillConnected,
        downloadCallsAfterStale,
        installCalls,
      },
      null,
      2,
    ),
  );
  dom.window.close();
})();
