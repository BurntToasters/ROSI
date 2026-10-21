import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const APP_ID = "run.rosie.rosi";
const permanentDisabledFeatures = [
  "CalculateNativeWinOcclusion",
  "RendererCodeIntegrity",
];
// TEMP_WEBVIEW2_LOCKOUT_WORKAROUND: TEMPORARY UPSTREAM WORKAROUND, REMOVE.
// Cause: a fresh WebView2 environment can generate a failed Windows interactive
// logon (Event 4625, not an app password attempt); repeated E2E launches
// increment the bad-password counter and can lock the account.
// Tracking: MicrosoftEdge/WebView2Feedback #5722, Chromium #562403601.
// Chromium runs the probe when either feature is enabled
// (chrome_autofill_client.cc).
// REMOVE after the fixed stable WebView2 runtime is verified to no longer log
// Event 4625 on fresh environment creation; see
// e2e/webview2-lockout.failure-modes.md
export const TEMP_WEBVIEW2_LOCKOUT_FEATURES = [
  "AutofillAiWalletPrivatePasses",
  "AutofillAmbientAutofill",
];
export const E2E_WEBVIEW2_BROWSER_ARGS = `--disable-gpu --disable-features=${[
  ...permanentDisabledFeatures,
  ...TEMP_WEBVIEW2_LOCKOUT_FEATURES,
].join(",")}`;

const FEATURE_SWITCHES = ["--disable-features=", "--enable-features="];

/**
 * Merges WebView2 browser-argument strings. All --disable-features and
 * --enable-features values collapse into one switch each, placed where the
 * first occurrence appeared; other switches are kept once, in order.
 */
export function mergeWebView2BrowserArgs(...argStrings) {
  const order = [];
  const seen = new Set();
  const features = new Map(FEATURE_SWITCHES.map((prefix) => [prefix, []]));
  for (const argString of argStrings) {
    if (!argString) continue;
    for (const token of String(argString).split(/\s+/)) {
      if (!token) continue;
      const prefix = FEATURE_SWITCHES.find((item) => token.startsWith(item));
      if (prefix) {
        const names = features.get(prefix);
        if (!seen.has(prefix)) {
          seen.add(prefix);
          order.push(prefix);
        }
        for (const name of token.slice(prefix.length).split(",")) {
          const trimmed = name.trim();
          if (trimmed && !names.includes(trimmed)) names.push(trimmed);
        }
      } else if (!seen.has(token)) {
        seen.add(token);
        order.push(token);
      }
    }
  }
  return order
    .map((item) => {
      const names = features.get(item);
      if (!names) return item;
      return names.length ? `${item}${names.join(",")}` : null;
    })
    .filter((item) => item !== null)
    .join(" ");
}

export function hostBinaryName(platform = process.platform) {
  return platform === "win32" ? "rosi.exe" : "rosi";
}

export function e2eBinaryPath(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, "src-tauri", "target", "debug", hostBinaryName());
}

export function e2eStampPath(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, "src-tauri", "target", "debug", ".rosi-e2e-stamp");
}

/** Settings that skip first-run UI so the suite exercises the main window. */
export function e2eSettings({ downloadFolder, ffmpegPath = "" }) {
  return {
    settingsVersion: 7,
    firstLaunch: false,
    hideSupportModal: true,
    denoReminderDismissed: true,
    checkUpdatesOnStartup: false,
    notifications: false,
    animateBackground: false,
    showConsoleOutput: true,
    askDownloadLocation: false,
    // A 5.0 beta profile with profiles off: it must load as Compatible so
    // upgrading never changes which file a download produces.
    downloadProfilesEnabled: false,
    downloadMode: "best-video",
    downloadFolder,
    ffmpegPath,
  };
}

export function createE2eProfile({
  ffmpegPath = "",
  seedSettings = true,
} = {}) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-e2e-"));
  const home = path.join(profileDir, "home");
  const dataDir = path.join(profileDir, "app-data");
  // Downloads must live under HOME: the backend confines download folders to
  // the user's home (or mounted volumes) on macOS and Linux.
  const downloads = path.join(home, "Downloads", "rosi-e2e");
  for (const dir of [home, dataDir, downloads]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Without a ROSI 5 settings.json the app treats the profile as a first
  // launch and imports ROSI 4 data if it finds any.
  if (seedSettings) {
    fs.writeFileSync(
      path.join(dataDir, "settings.json"),
      `${JSON.stringify(e2eSettings({ downloadFolder: downloads, ffmpegPath }), null, 2)}\n`,
    );
  }
  const env = {
    ROSI_E2E: "1",
    ROSI_E2E_DATA_DIR: dataDir,
    ROSI_E2E_ALLOW_LOOPBACK: "1",
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: path.join(profileDir, "data"),
    XDG_CONFIG_HOME: path.join(profileDir, "config"),
    XDG_STATE_HOME: path.join(profileDir, "state"),
    XDG_CACHE_HOME: path.join(profileDir, "cache"),
  };
  if (process.platform === "win32") {
    const webview2 = path.join(profileDir, "webview2");
    fs.mkdirSync(webview2, { recursive: true });
    env.WEBVIEW2_USER_DATA_FOLDER = webview2;
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = mergeWebView2BrowserArgs(
      process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
      E2E_WEBVIEW2_BROWSER_ARGS,
    );
    // %APPDATA% comes from the shell API, so a temp USERPROFILE cannot hide
    // the developer's real ROSI 4 folder; E2E builds honor this override.
    env.ROSI_E2E_LEGACY_V4_DIR = path.join(
      profileDir,
      "legacy-appdata",
      "rosi",
    );
  }
  // Linux: point the XDG Downloads folder outside HOME (like a data disk) so
  // the suite checks that the OS-configured folder is accepted there.
  const xdgDownloads = path.join(profileDir, "data-disk", "Downloads");
  if (process.platform === "linux") {
    env.WEBKIT_DISABLE_COMPOSITING_MODE = "1";
    fs.mkdirSync(xdgDownloads, { recursive: true });
    fs.mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
    fs.writeFileSync(
      path.join(env.XDG_CONFIG_HOME, "user-dirs.dirs"),
      `XDG_DOWNLOAD_DIR="${xdgDownloads}"\n`,
    );
  }
  return { profileDir, home, dataDir, downloads, xdgDownloads, env };
}
