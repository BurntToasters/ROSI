import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Ways the first-launch ROSI 4 import can fail. The E2E passes record which
 * ids they covered, so the evidence report lists anything left uncovered.
 */
export const LEGACY_IMPORT_FAILURE_MODES = {
  "wrong-source-dir":
    "Reads the wrong ROSI 4 folder (Rosi vs rosi, Local vs Roaming AppData, ignoring XDG_CONFIG_HOME) and imports nothing.",
  "overwrites-v5":
    "Runs when ROSI 5 already has settings and replaces them, or re-imports on a later launch.",
  "unvalidated-values":
    "Copies values ROSI 5 rejects (unknown enums, a missing FFmpeg path, broken presets) into its settings.",
  "corrupt-file":
    "One corrupt ROSI 4 file crashes startup or stops the other files from importing.",
  "corrupt-settings":
    "A corrupt ROSI 4 settings.json is half-imported instead of skipped.",
  "resumes-downloads":
    "A queue item that was downloading in ROSI 4 starts downloading on launch.",
  "mutates-v4":
    "Changes or deletes ROSI 4 files, which breaks going back to ROSI 4.",
  "wizard-again":
    "Shows the first-run wizard to a user whose settings were imported.",
  "folder-unused":
    "Imports the download folder, but downloads still go somewhere else.",
  "data-dropped":
    "Imports settings but drops the queue, lifetime stats, or activity.",
  "leaks-real-profile":
    "An E2E run reads or writes the developer's real ROSI 4 data.",
};

export const LEGACY_V4_FOLDER_NAME = "rosi";

/**
 * Where Electron's `app.getPath("userData")` put ROSI 4 data inside an E2E
 * profile. v4's package name is "rosi" and it never set productName.
 */
export function legacyV4Dir(profile) {
  if (process.platform === "darwin") {
    return path.join(
      profile.home,
      "Library",
      "Application Support",
      LEGACY_V4_FOLDER_NAME,
    );
  }
  if (process.platform === "linux") {
    return path.join(profile.env.XDG_CONFIG_HOME, LEGACY_V4_FOLDER_NAME);
  }
  // Windows resolves %APPDATA% through the shell API, not the environment,
  // so E2E builds read this override instead of the real profile.
  return path.join(profile.profileDir, "legacy-appdata", LEGACY_V4_FOLDER_NAME);
}

/** A complete settings.json in ROSI 4.3.2's schema with distinctive values. */
export function legacyV4Settings({ downloadFolder, missingFfmpeg }) {
  return {
    settingsVersion: 7,
    theme: "purple",
    showConsoleOutput: true,
    consoleCollapsed: true,
    queueCollapsed: true,
    downloadProfilesEnabled: true,
    downloadMode: "best-video",
    downloadPresets: [
      {
        id: "v4-podcast",
        name: "Podcast MP3",
        profile: "audio",
        audioFormat: "mp3",
        embedMetadata: true,
      },
      "not a preset",
    ],
    askDownloadLocation: false,
    advancedOptions: false,
    audioOnly: false,
    audioFormat: "opus",
    convertEnabled: false,
    convertFormat: "mov",
    keepOriginalAfterConvert: false,
    firstLaunch: false,
    hookBrowser: false,
    browserChoice: "Firefox",
    animateBackground: false,
    flatUi: true,
    notifications: false,
    denoReminderDismissed: true,
    gpuAcceleration: false,
    gpuType: "voodoo",
    bestQuality: true,
    ffmpegPath: missingFfmpeg,
    downloadFolder,
    hideSupportModal: true,
    checkUpdatesOnStartup: false,
    updateChannel: "beta",
    writeSubtitles: false,
    subtitleLangs: "en,de",
    embedThumbnail: false,
    embedMetadata: false,
    sponsorblockRemove: false,
    showTaskbarProgress: false,
  };
}

/** What ROSI 5 must report after importing `legacyV4Settings`. */
export function expectedImportedSettings({ downloadFolder }) {
  return {
    theme: "purple",
    showConsoleOutput: true,
    queueCollapsed: true,
    downloadProfilesEnabled: true,
    downloadMode: "best-video",
    audioFormat: "opus",
    convertFormat: "mov",
    keepOriginalAfterConvert: false,
    firstLaunch: false,
    browserChoice: "firefox",
    animateBackground: false,
    flatUi: true,
    notifications: false,
    gpuType: "auto",
    ffmpegPath: "",
    downloadFolder,
    updateChannel: "beta",
    subtitleLangs: "en,de",
    showTaskbarProgress: false,
  };
}

const T0 = Date.UTC(2026, 5, 1);

/**
 * Write a ROSI 4 profile: settings, a corrupt primary queue with a valid
 * backup, lifetime stats, and activity with one record ROSI 5 must drop.
 * `corruptSettings` replaces settings.json with invalid JSON instead.
 */
export function seedLegacyV4Data(profile, { corruptSettings = false } = {}) {
  const dir = legacyV4Dir(profile);
  const downloadFolder = path.join(profile.home, "Downloads", "ROSI 4");
  const missingFfmpeg = path.join(
    profile.profileDir,
    "missing",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(downloadFolder, { recursive: true });
  const write = (name, value) =>
    fs.writeFileSync(
      path.join(dir, name),
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
  write(
    "settings.json",
    corruptSettings
      ? '{ "theme": "purple", '
      : legacyV4Settings({ downloadFolder, missingFfmpeg }),
  );
  write("download-queue.json", "{ this is not json");
  write("download-queue.backup.json", [
    {
      id: "v4-pending",
      url: "https://example.com/watch?v=rosi-v4-pending",
      status: "downloading",
      addedAt: T0,
      startedAt: T0 + 1000,
    },
    {
      id: "v4-done",
      url: "https://example.com/watch?v=rosi-v4-done",
      status: "completed",
      addedAt: T0,
      startedAt: T0 + 2000,
      completedAt: T0 + 3000,
      filename: "done.mp4",
    },
    { id: "v4-bad", url: "file:///etc/passwd", status: "pending", addedAt: T0 },
  ]);
  write("download-stats.json", {
    totalDownloads: 42,
    successfulDownloads: 39,
    failedDownloads: 2,
    cancelledDownloads: 1,
    totalBytesDownloaded: 987654321,
    formatCounts: { mp4: 30, mp3: 9 },
    firstDownloadAt: T0,
    lastDownloadAt: T0 + 86_400_000,
  });
  const activityUrl = "https://example.com/watch?v=rosi-v4-activity";
  write("download-activity.json", [
    {
      id: "v4-activity-1",
      owner: "manual",
      outcome: "success",
      statusMessage: "Download complete.",
      url: activityUrl,
      request: { url: activityUrl, outputPath: downloadFolder },
      filename: "old.mp4",
      sizeBytes: 1000,
      format: "mp4",
      startedAt: T0 + 4000,
      completedAt: T0 + 5000,
    },
    {
      id: "v4-activity-bad",
      owner: "robot",
      outcome: "success",
      url: activityUrl,
      request: { url: activityUrl, outputPath: downloadFolder },
      startedAt: T0,
      completedAt: T0,
    },
  ]);
  return {
    dir,
    downloadFolder,
    snapshot: snapshotDir(dir),
    expected: {
      settings: expectedImportedSettings({ downloadFolder }),
      presets: ["Podcast MP3"],
      queue: [
        { id: "v4-pending", status: "pending" },
        { id: "v4-done", status: "completed" },
      ],
      stats: { totalDownloads: 42, successfulDownloads: 39 },
      activityIds: ["v4-activity-1"],
    },
  };
}

/** SHA-256 of every file under `dir`, keyed by relative path. */
export function snapshotDir(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = path.relative(dir, full).split(path.sep).join("/");
        out[rel] = crypto
          .createHash("sha256")
          .update(fs.readFileSync(full))
          .digest("hex");
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
