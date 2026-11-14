import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { api, waitForAppReady } from "../../helpers/app-bridge.js";

// Run by network/run.mjs. The app records each get_formats and get_video_info
// yt-dlp argument list to ROSI_E2E_YTDLP_ARGS_LOG and stops before yt-dlp
// starts, so the cookie arguments are read without a browser profile.
const resultsDirectory = process.env.ROSI_V5_NETWORK_RESULTS_DIR;
const captureLog = process.env.ROSI_E2E_YTDLP_ARGS_LOG;
const observations = [];

// `.invalid` passes the syntactic URL check and never resolves.
const URL_UNDER_TEST = "https://rosi-e2e.invalid/watch?v=cookie-choice";
const COOKIE_FLAG = "--cookies-from-browser";

function record(name, details) {
  observations.push({ name, ...details });
  if (!resultsDirectory) return;
  fs.mkdirSync(resultsDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDirectory, "preview-cookies.observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
}

function clearCaptures() {
  assert.ok(captureLog, "ROSI_E2E_YTDLP_ARGS_LOG is not set");
  fs.rmSync(captureLog, { force: true });
}

function readCaptures() {
  if (!fs.existsSync(captureLog)) return [];
  return fs
    .readFileSync(captureLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// The browser named by --cookies-from-browser, `null` when the flag is absent.
// A repeated flag is reported as `"multiple"` so it cannot match by accident.
function cookieBrowser(args) {
  const count = args.filter((argument) => argument === COOKIE_FLAG).length;
  if (count === 0) return null;
  if (count > 1) return "multiple";
  return args[args.indexOf(COOKIE_FLAG) + 1] ?? null;
}

// Clears the capture log, makes one call through the E2E bridge, and returns
// the single argument list that call recorded for `command`.
async function captureCall(command, method, ...args) {
  clearCaptures();
  const outcome = await api(method, ...args);
  const entries = readCaptures().filter((entry) => entry.command === command);
  return {
    outcome: { ok: outcome?.ok === true, code: outcome?.error?.code ?? null },
    count: entries.length,
    args: entries.length === 1 ? entries[0].args : null,
  };
}

async function setGlobalCookies(hookBrowser, browserChoice) {
  const saved = await api("saveSettings", { hookBrowser, browserChoice });
  assert.equal(saved?.ok, true, JSON.stringify(saved));
}

// Records one check and fails the spec when its invariant does not hold.
function check(name, details) {
  const { invariantPassed, ...rest } = details;
  record(name, { ...rest, invariantPassed: invariantPassed === true });
  assert.equal(invariantPassed, true, `${name}: ${JSON.stringify(rest)}`);
}

describe("V5 preview and format cookie choice", () => {
  before(async () => {
    assert.ok(captureLog, "ROSI_E2E_YTDLP_ARGS_LOG is not set");
    await waitForAppReady();
  });

  it("uses an explicit request choice even when the saved flag is off", async () => {
    await setGlobalCookies(false, "firefox");
    const choice = { hookBrowser: true, browserChoice: "firefox" };
    const formats = await captureCall(
      "get_formats",
      "getFormats",
      URL_UNDER_TEST,
      choice,
    );
    const preview = await captureCall(
      "get_video_info",
      "getVideoInfo",
      URL_UNDER_TEST,
      "current",
      choice,
    );
    const formatsBrowser = formats.args && cookieBrowser(formats.args);
    const previewBrowser = preview.args && cookieBrowser(preview.args);
    check("explicit-choice-reaches-listing-and-preview", {
      formats,
      preview,
      formatsBrowser,
      previewBrowser,
      invariantPassed:
        formats.count === 1 &&
        preview.count === 1 &&
        formatsBrowser === "firefox" &&
        previewBrowser === "firefox",
    });
  });

  it("lets an explicit false choice win over a saved flag that is on", async () => {
    await setGlobalCookies(true, "firefox");
    const choice = { hookBrowser: false };
    const formats = await captureCall(
      "get_formats",
      "getFormats",
      URL_UNDER_TEST,
      choice,
    );
    const preview = await captureCall(
      "get_video_info",
      "getVideoInfo",
      URL_UNDER_TEST,
      "current",
      choice,
    );
    check("explicit-false-suppresses-global", {
      formats,
      preview,
      formatsBrowser: formats.args && cookieBrowser(formats.args),
      previewBrowser: preview.args && cookieBrowser(preview.args),
      invariantPassed:
        formats.count === 1 &&
        preview.count === 1 &&
        cookieBrowser(formats.args) === null &&
        cookieBrowser(preview.args) === null,
    });
  });

  it("keeps the saved flag when only a browser choice is given", async () => {
    await setGlobalCookies(true, "firefox");
    const formats = await captureCall(
      "get_formats",
      "getFormats",
      URL_UNDER_TEST,
      {
        browserChoice: "firefox",
      },
    );
    check("partial-choice-keeps-saved-flag", {
      formats,
      formatsBrowser: formats.args && cookieBrowser(formats.args),
      invariantPassed:
        formats.count === 1 && cookieBrowser(formats.args) === "firefox",
    });
  });

  it("follows the saved setting when no choice is given", async () => {
    await setGlobalCookies(true, "firefox");
    const onFormats = await captureCall(
      "get_formats",
      "getFormats",
      URL_UNDER_TEST,
    );
    const onPreview = await captureCall(
      "get_video_info",
      "getVideoInfo",
      URL_UNDER_TEST,
      "current",
    );
    await setGlobalCookies(false, "firefox");
    const offFormats = await captureCall(
      "get_formats",
      "getFormats",
      URL_UNDER_TEST,
    );
    const offPreview = await captureCall(
      "get_video_info",
      "getVideoInfo",
      URL_UNDER_TEST,
      "current",
    );
    const onBrowsers = [onFormats, onPreview].map(
      (call) => call.args && cookieBrowser(call.args),
    );
    const offBrowsers = [offFormats, offPreview].map(
      (call) => call.args && cookieBrowser(call.args),
    );
    check("no-argument-follows-global", {
      onBrowsers,
      offBrowsers,
      invariantPassed:
        [onFormats, onPreview, offFormats, offPreview].every(
          (call) => call.count === 1,
        ) &&
        onBrowsers.every((browser) => browser === "firefox") &&
        offBrowsers.every((browser) => browser === null),
    });
  });

  it("applies the Windows browser rule to a listing choice", async () => {
    await setGlobalCookies(false, "firefox");
    const platform = await api("getAppPlatform");
    const expected = platform === "win32" ? "firefox" : "chrome";
    const choice = { hookBrowser: true, browserChoice: "chrome" };
    const formats = await captureCall(
      "get_formats",
      "getFormats",
      URL_UNDER_TEST,
      choice,
    );
    const preview = await captureCall(
      "get_video_info",
      "getVideoInfo",
      URL_UNDER_TEST,
      "current",
      choice,
    );
    const formatsBrowser = formats.args && cookieBrowser(formats.args);
    const previewBrowser = preview.args && cookieBrowser(preview.args);
    check("windows-coerces-preview-browser", {
      platform,
      expected,
      formatsBrowser,
      previewBrowser,
      invariantPassed:
        formats.count === 1 &&
        preview.count === 1 &&
        formatsBrowser === expected &&
        previewBrowser === expected,
    });
  });

  it("applies the Windows browser rule to the resolved download request", async () => {
    await setGlobalCookies(false, "firefox");
    const platform = await api("getAppPlatform");
    const expected = platform === "win32" ? "firefox" : "chrome";
    const resolved = await api("resolveDownloadOptions", {
      url: URL_UNDER_TEST,
      hookBrowser: true,
      browserChoice: "chrome",
    });
    const data = resolved?.data ?? null;
    check("windows-coerces-request-browser", {
      platform,
      expected,
      resolvedOk: resolved?.ok === true,
      resolvedBrowser: data?.browserChoice ?? null,
      resolvedHookBrowser: data?.hookBrowser ?? null,
      invariantPassed:
        resolved?.ok === true &&
        data?.browserChoice === expected &&
        data?.hookBrowser === true,
    });
  });

  it("records the yt-dlp arguments with the proxy value redacted", async () => {
    await setGlobalCookies(false, "firefox");
    const preview = await captureCall(
      "get_video_info",
      "getVideoInfo",
      URL_UNDER_TEST,
      "current",
    );
    const proxyIndex = preview.args ? preview.args.indexOf("--proxy") : -1;
    const proxyValue =
      proxyIndex === -1 ? null : (preview.args[proxyIndex + 1] ?? null);
    check("log-redacts-proxy", {
      preview,
      proxyValue,
      invariantPassed:
        preview.count === 1 && proxyIndex !== -1 && proxyValue === "<redacted>",
    });
  });
});
