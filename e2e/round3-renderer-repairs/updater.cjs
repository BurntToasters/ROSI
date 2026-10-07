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
w.api = new Proxy(
  {
    getChannel: () => "github",
    getSettings: () => Promise.resolve(s),
    saveSettings: (v) => ok(v),
    getAppVersion: () => Promise.resolve("5.0.0-beta.2"),
    getAppPlatform: () => Promise.resolve("darwin"),
    checkDenoInstalled: () => Promise.resolve(true),
    getQueue: () => Promise.resolve([]),
    getFormats: () => ok("137 mp4 1920x1080 video only\n140 m4a audio only"),
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

const vm = require("vm");
const downloaded = [];
const installed = [];
const downloadCalls = [];
const installCalls = [];
const downloadPromises = [];
const availableEvents = [];
let channel = "stable";
let feedVersion = "6.0.0";
let checks = [];
const updaterExports = {};
const updaterJs = ts.transpileModule(
  fs
    .readFileSync(root + "/src/updater.ts", "utf8")
    .replaceAll("import.meta.env.VITE_ROSI_E2E", "'1'"),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;
w.__ROSI_E2E__ = {
  updaterAdapter: {
    invoke: (command) =>
      ({
        is_packaged: true,
        is_flatpak: false,
        get_settings: { updateChannel: channel },
        get_beta_updater_target: "darwin-beta-aarch64-app",
      })[command],
    check: (target) => {
      checks.push(target ?? "stable");
      const version = feedVersion;
      return {
        version,
        body: "notes",
        download: async () => {
          downloaded.push(version);
        },
        close: async () => {},
        install: async () => {
          installed.push(version);
        },
      };
    },
  },
};
vm.runInNewContext(updaterJs, {
  exports: updaterExports,
  require: (id) =>
    id.includes("/app")
      ? { getVersion: async () => "5.0.0-beta.2" }
      : { invoke: () => {}, check: () => {} },
  window: w,
  console,
  Date,
  Set,
  Object,
  Error,
});
w.api.checkForUpdates = updaterExports.checkForUpdates;
w.api.onUpdaterStatus = updaterExports.onUpdaterStatus;
w.api.onUpdaterProgress = updaterExports.onUpdaterProgress;
w.api.onUpdaterStatus((event) => {
  if (event.status === "available") availableEvents.push(event);
});
w.api.downloadUpdate = (candidateId) => {
  downloadCalls.push(candidateId);
  const promise = updaterExports.downloadUpdate(candidateId);
  downloadPromises.push(promise);
  return promise;
};
w.api.installUpdate = (candidateId) => {
  installCalls.push(candidateId);
  return updaterExports.installUpdate(candidateId);
};
function load(p) {
  w.eval(
    ts.transpileModule(fs.readFileSync(root + "/src/" + p, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.None,
      },
    }).outputText,
  );
}
for (const m of ["ui", "downloads", "queue", "settings", "updates", "dock"])
  load("modules/" + m + ".ts");
load("rosiEngine.ts");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await wait(120);
  await w.__ROSI_RENDERER_STARTUP_READY__;

  await updaterExports.checkForUpdates();
  await wait(30);
  const firstPrompt = w.document.getElementById("modal-message").textContent;
  const oldPromptButton = w.document.querySelector("#modal-buttons button");
  const bridgeSource = fs.readFileSync(root + "/src/tauri-bridge.ts", "utf8");
  const bridgeForwardsPreviousChannel =
    /notifyUpdaterChannelChanged:\s*\(channel,\s*save,\s*previousChannel\)\s*=>\s*notifyUpdaterChannelChanged\(channel,\s*save,\s*previousChannel\)/s.test(
      bridgeSource,
    );
  const bridgeNotify = (next, save, previousChannel) =>
    updaterExports.notifyUpdaterChannelChanged(next, save, previousChannel);
  channel = "auto";
  feedVersion = "7.0.0-beta.1";
  bridgeNotify("auto", Promise.resolve(true), "stable");
  await wait(100);
  const checksAfterChange = checks.slice();
  await updaterExports.checkForUpdates();
  await wait(50);
  const activePromptAfterSecondCheck =
    w.document.getElementById("modal-message").textContent;
  oldPromptButton?.click();
  await wait(80);
  if (downloadPromises[0]) await downloadPromises[0];
  await wait(30);
  const downloadedAfterStaleAction = downloaded.slice();
  const oldPromptStillConnected = oldPromptButton?.isConnected ?? false;
  const staleCandidateResult = await updaterExports.downloadUpdate(
    availableEvents[0]?.candidateId,
  );
  w.document.querySelector("#modal-buttons button")?.click();
  await wait(350);
  const readyPromptTitle = w.document.getElementById("modal-title").textContent;
  const staleInstallResult = await updaterExports.installUpdate(
    availableEvents[0]?.candidateId,
  );
  const installedAfterStaleAction = installed.slice();
  w.document.querySelector("#modal-buttons button")?.click();
  await wait(350);
  console.log(
    JSON.stringify(
      {
        firstPrompt,
        bridgeForwardsPreviousChannel,
        checksAfterChange,
        checks,
        activePromptAfterSecondCheck,
        readyPromptTitle,
        firstCandidateId: availableEvents[0]?.candidateId,
        currentCandidateId: availableEvents.at(-1)?.candidateId,
        oldPromptStillConnected,
        staleCandidateResult,
        staleInstallResult,
        downloadCalls,
        installCalls,
        downloadedAfterStaleAction,
        installedAfterStaleAction,
        downloaded,
        installed,
      },
      null,
      2,
    ),
  );
  dom.window.close();
})();
