import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const APP_ID = "run.rosie.rosi";
export const E2E_WEBVIEW2_BROWSER_ARGS =
  "--disable-gpu --disable-features=CalculateNativeWinOcclusion,RendererCodeIntegrity";

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
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = E2E_WEBVIEW2_BROWSER_ARGS;
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
