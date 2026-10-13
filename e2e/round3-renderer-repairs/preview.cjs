const fs = require("fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const ts = require(path.join(root, "node_modules/typescript"));
const { JSDOM, VirtualConsole } = require(
  path.join(root, "node_modules/jsdom"),
);
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
const previewCalls = [];
let resolvePreview;
const ok = (data) => Promise.resolve({ ok: true, data });
const previewResolutions = new Map();
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
    getVideoInfo: (url) => {
      previewCalls.push(url);
      return new Promise((r) => {
        previewResolutions.set(url, r);
      });
    },
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

  const input = w.document.getElementById("url");
  input.value = "https://example.com/a";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  await wait(550);
  input.value = "https://example.com/b";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  await wait(550);
  previewResolutions.get("https://example.com/a")?.({
    ok: true,
    data: { title: "A", url: "https://example.com/a" },
  });
  await wait(50);
  previewResolutions.get("https://example.com/b")?.({
    ok: true,
    data: { title: "B", url: "https://example.com/b" },
  });
  await wait(100);
  console.log(
    JSON.stringify(
      {
        previewCalls,
        input: input.value,
        previewVisible: w.document
          .getElementById("preview-card")
          .classList.contains("visible"),
        previewTitle: w.document.getElementById("preview-title").textContent,
        buttonLoading: w.document
          .getElementById("previewBtn")
          .classList.contains("loading"),
      },
      null,
      2,
    ),
  );
  dom.window.close();
})();
