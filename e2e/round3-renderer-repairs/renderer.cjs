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
Object.defineProperty(w.HTMLElement.prototype, "inert", {
  configurable: true,
  get() {
    return this.hasAttribute("inert");
  },
  set(value) {
    if (value) this.setAttribute("inert", "");
    else this.removeAttribute("inert");
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
s.downloadPresets = [
  {
    id: "saved-custom",
    name: "Saved custom",
    profile: "custom",
    bestQuality: false,
    audioOnly: false,
    audioFormat: "mp3",
    convertEnabled: false,
    convertFormat: "mp4",
    keepOriginalAfterConvert: true,
    gpuAcceleration: false,
    gpuType: "auto",
    writeSubtitles: false,
    subtitleLangs: "en",
    embedThumbnail: false,
    embedMetadata: false,
    sponsorblockRemove: false,
    videoFormat: "88",
    audioFormatId: "89",
  },
];
let downloadArgs;
let queueArgs;
let getFormatsImpl;
let formatRequests = [];
let cancelFormatsCount = 0;
let updaterStatusHandler;
const settingsSaveResolvers = [];
let deferNextSettingsSave = false;
const ok = (data) => Promise.resolve({ ok: true, data });
getFormatsImpl = () => ok("137 mp4 1920x1080 video only\n140 m4a audio only");
w.api = new Proxy(
  {
    getChannel: () => "github",
    getSettings: () => Promise.resolve(s),
    saveSettings: (v) => {
      if (!deferNextSettingsSave) return ok(v);
      deferNextSettingsSave = false;
      return new Promise((resolve) =>
        settingsSaveResolvers.push(() => resolve({ ok: true, data: v })),
      );
    },
    getAppVersion: () => Promise.resolve("5.0.0-beta.2"),
    getAppPlatform: () => Promise.resolve("darwin"),
    checkDenoInstalled: () => Promise.resolve(true),
    getQueue: () => Promise.resolve([]),
    getFormats: (url) => {
      formatRequests.push(url);
      return getFormatsImpl(url);
    },
    cancelFormats: () => {
      cancelFormatsCount++;
    },
    getVideoInfo: () => ok({}),
    downloadVideo: (a) => {
      downloadArgs = a;
      return ok({ started: true, sessionId: 1 });
    },
    addToQueue: (urls, options) => {
      queueArgs = { urls, options };
      return ok({ added: urls.length, skipped: 0 });
    },
    isPackaged: () => Promise.resolve(false),
    getDownloadActivity: () => ok([]),
    onUpdaterStatus: (callback) => {
      updaterStatusHandler = callback;
      return () => {};
    },
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
  w.document.getElementById("settingsBtn").click();
  w.document.getElementById("resetSettings").click();
  await wait(80);
  const afterOpen = {
    modalActive: w.document
      .getElementById("app-modal")
      .classList.contains("active"),
    sidebarOpen: w.document
      .getElementById("sidebar")
      .classList.contains("open"),
    focus:
      w.document.activeElement.id ||
      w.document.activeElement.textContent.trim(),
    errors: errors.slice(0, 3),
    errorCount: errors.length,
  };
  w.document
    .getElementById("app-modal")
    .dispatchEvent(
      new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  await wait(300);
  const afterClose = {
    sidebarOpen: w.document
      .getElementById("sidebar")
      .classList.contains("open"),
    mainAriaHidden: w.document
      .getElementById("main-content")
      .getAttribute("aria-hidden"),
    mainInert: w.document.getElementById("main-content").inert,
  };
  w.rosiModules.ui.closeSidebar();

  w.document.getElementById("licensesLink").click();
  await wait(30);
  updaterStatusHandler?.({
    status: "available",
    candidateId: 11,
    version: "6.0.0",
  });
  await wait(40);
  const licensesWithModal = {
    licensesActive: w.document
      .getElementById("licenses-overlay")
      .classList.contains("active"),
    modalActive: w.document
      .getElementById("app-modal")
      .classList.contains("active"),
    focusId: w.document.activeElement.id,
    focusedInModal: w.document
      .getElementById("app-modal")
      .contains(w.document.activeElement),
    mainAriaHidden: w.document
      .getElementById("main-content")
      .getAttribute("aria-hidden"),
    errorCount: errors.length,
  };
  w.document.activeElement.dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await wait(260);
  const modalClosedWithLicenses = {
    licensesActive: w.document
      .getElementById("licenses-overlay")
      .classList.contains("active"),
    modalActive: w.document
      .getElementById("app-modal")
      .classList.contains("active"),
    focusedInLicenses: w.document
      .getElementById("licenses-overlay")
      .contains(w.document.activeElement),
    mainAriaHidden: w.document
      .getElementById("main-content")
      .getAttribute("aria-hidden"),
    mainInert: w.document.getElementById("main-content").inert,
  };
  updaterStatusHandler?.({
    status: "available",
    candidateId: 12,
    version: "6.0.1",
  });
  await wait(30);
  w.document.getElementById("close-licenses").click();
  const licenseClosedUnderModal = {
    licensesActive: w.document
      .getElementById("licenses-overlay")
      .classList.contains("active"),
    modalActive: w.document
      .getElementById("app-modal")
      .classList.contains("active"),
    focusedInModal: w.document
      .getElementById("app-modal")
      .contains(w.document.activeElement),
    mainAriaHidden: w.document
      .getElementById("main-content")
      .getAttribute("aria-hidden"),
  };
  w.document.activeElement.dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await wait(260);
  const focusAfterLicenseAndModalClose = {
    focusId: w.document.activeElement.id,
    focusInsideInactiveLicense: w.document
      .getElementById("licenses-overlay")
      .contains(w.document.activeElement),
    mainAriaHidden: w.document
      .getElementById("main-content")
      .getAttribute("aria-hidden"),
  };

  updaterStatusHandler?.({
    status: "available",
    candidateId: 13,
    version: "6.0.2",
  });
  await wait(30);
  w.document.querySelector("#modal-buttons button:last-child").click();
  updaterStatusHandler?.({
    status: "downloaded",
    candidateId: 14,
    version: "7.0.0",
  });
  await wait(260);
  const promptAfterOldHideTimer = {
    modalActive: w.document
      .getElementById("app-modal")
      .classList.contains("active"),
    title: w.document.getElementById("modal-title").textContent,
    focusInsideModal: w.document
      .getElementById("app-modal")
      .contains(w.document.activeElement),
  };
  w.document.querySelector("#modal-buttons button:last-child").click();
  await wait(230);

  const input = w.document.getElementById("url");
  input.value = "https://example.com/a";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  w.document.getElementById("fetchFormatsBtn").click();
  await wait(40);
  w.document.getElementById("videoFormat").value = "137";
  w.document.getElementById("audioFormat").value = "140";
  input.value = "https://example.com/b";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  const afterUrlChangeFormats = {
    video: w.document.getElementById("videoFormat").value,
    audio: w.document.getElementById("audioFormat").value,
    videoOptions: [...w.document.getElementById("videoFormat").options].map(
      (o) => o.value,
    ),
    audioOptions: [...w.document.getElementById("audioFormat").options].map(
      (o) => o.value,
    ),
  };

  let resolveFirst;
  let resolveSecond;
  getFormatsImpl = (url) =>
    new Promise((resolve) => {
      if (url.endsWith("/c")) resolveFirst = resolve;
      else resolveSecond = resolve;
    });
  input.value = "https://example.com/c";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  w.document.getElementById("fetchFormatsBtn").click();
  await wait(20);
  input.value = "https://example.com/d";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  w.document.getElementById("fetchFormatsBtn").click();
  await wait(20);
  resolveSecond?.({
    ok: true,
    data: "88 mp4 1280x720 video only\n89 m4a audio only",
  });
  await wait(20);
  resolveFirst?.({
    ok: true,
    data: "177 mp4 3840x2160 video only\n178 m4a audio only",
  });
  await wait(40);
  const staleReplyFormats = {
    requests: formatRequests.slice(),
    videoOptions: [...w.document.getElementById("videoFormat").options].map(
      (o) => o.value,
    ),
    audioOptions: [...w.document.getElementById("audioFormat").options].map(
      (o) => o.value,
    ),
    cancelFormatsCount,
    fetchButtonLoading: w.document
      .getElementById("fetchFormatsBtn")
      .classList.contains("loading"),
  };

  const presetSelect = w.document.getElementById("downloadPresetSelect");
  presetSelect.value = "saved-custom";
  presetSelect.dispatchEvent(new w.Event("change", { bubbles: true }));
  w.document.getElementById("applyPresetBtn").click();
  await wait(20);
  const beforeManualDownload = {
    url: input.value,
    videoFormat: w.document.getElementById("videoFormat").value,
    audioFormat: w.document.getElementById("audioFormat").value,
    videoOptions: [...w.document.getElementById("videoFormat").options].map(
      (o) => o.value,
    ),
    audioOptions: [...w.document.getElementById("audioFormat").options].map(
      (o) => o.value,
    ),
    downloadButtonDisabled: w.document.getElementById("downloadBtn").disabled,
    mainAriaHidden: w.document
      .getElementById("main-content")
      .getAttribute("aria-hidden"),
  };
  deferNextSettingsSave = true;
  w.document.getElementById("downloadBtn").click();
  await wait(30);
  input.value = "https://example.com/e";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  getFormatsImpl = () => ok("277 mp4 1920x1080 video only\n278 m4a audio only");
  w.document.getElementById("fetchFormatsBtn").click();
  await wait(40);
  w.document.getElementById("videoFormat").value = "277";
  w.document.getElementById("audioFormat").value = "278";
  settingsSaveResolvers[0]?.();
  await wait(100);
  const manualSubmission = {
    url: downloadArgs?.url,
    videoFormat: downloadArgs?.videoFormat,
    audioFormat: downloadArgs?.audioFormat,
    pendingSaveCount: settingsSaveResolvers.length,
    presetOptions: [...presetSelect.options].map((option) => option.value),
    presetValue: presetSelect.value,
    urlValue: input.value,
    downloadButtonDisabled: w.document.getElementById("downloadBtn").disabled,
    formatRequests: formatRequests.slice(),
    toast: w.document.getElementById("toast-container").textContent,
  };

  w.document.getElementById("queueUrlInput").value = "https://example.com/e";
  deferNextSettingsSave = true;
  w.document.getElementById("addToQueueBtn").click();
  await wait(30);
  input.value = "https://example.com/f";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  getFormatsImpl = () => ok("377 mp4 1920x1080 video only\n378 m4a audio only");
  w.document.getElementById("fetchFormatsBtn").click();
  await wait(40);
  w.document.getElementById("videoFormat").value = "377";
  w.document.getElementById("audioFormat").value = "378";
  settingsSaveResolvers[1]?.();
  await wait(100);
  const queuedSubmission = queueArgs;

  let resolvePresetLookup;
  getFormatsImpl = () =>
    new Promise((resolve) => {
      resolvePresetLookup = resolve;
    });
  input.value = "https://example.com/g";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  w.document.getElementById("fetchFormatsBtn").click();
  await wait(30);
  w.document.getElementById("applyPresetBtn").click();
  await wait(30);
  resolvePresetLookup?.({
    ok: true,
    data: "477 mp4 1920x1080 video only\n478 m4a audio only",
  });
  await wait(50);
  const presetSurvivesStaleLookup = {
    video: w.document.getElementById("videoFormat").value,
    audio: w.document.getElementById("audioFormat").value,
    videoOptions: [...w.document.getElementById("videoFormat").options].map(
      (o) => o.value,
    ),
    audioOptions: [...w.document.getElementById("audioFormat").options].map(
      (o) => o.value,
    ),
  };

  const overlayCss = fs.readFileSync(root + "/src/css/05-overlays.css", "utf8");
  const appModalStackingRule =
    overlayCss.match(/#app-modal\s*\{[^}]*\}/s)?.[0] ?? "";
  const appModalAboveLicenses =
    /z-index:\s*calc\(var\(--z-modal\)\s*\+\s*1\)/.test(appModalStackingRule);

  w.document.getElementById("downloadBtn").click();
  await wait(80);
  console.log(
    JSON.stringify(
      {
        afterOpen,
        afterClose,
        licensesWithModal,
        modalClosedWithLicenses,
        licenseClosedUnderModal,
        focusAfterLicenseAndModalClose,
        promptAfterOldHideTimer,
        afterUrlChangeFormats,
        staleReplyFormats,
        beforeManualDownload,
        downloadArgs,
        manualSubmission,
        queuedSubmission,
        presetSurvivesStaleLookup,
        appModalAboveLicenses,
      },
      null,
      2,
    ),
  );
  dom.window.close();
})();
