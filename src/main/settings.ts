import * as path from 'path';
import * as fs from 'fs';
import { app, dialog } from 'electron';
import log from 'electron-log/main.js';
import type { AudioFormat, DownloadStats, Settings } from '../types';
import {
  ALLOWED_AUDIO_FORMATS,
  ALLOWED_CONVERT_FORMATS,
  MAX_FORMAT_COUNTS,
  MAX_SETTINGS_IMPORT_BYTES,
  CURRENT_SETTINGS_VERSION,
} from './constants';

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const statsPath = path.join(app.getPath('userData'), 'download-stats.json');
export { CURRENT_SETTINGS_VERSION } from './constants';

const defaultSettings: Settings = {
  settingsVersion: CURRENT_SETTINGS_VERSION,
  theme: 'system',
  showConsoleOutput: false,
  consoleCollapsed: false,
  advancedOptions: false,
  audioOnly: false,
  audioFormat: 'mp3',
  convertEnabled: false,
  convertFormat: 'mp4',
  keepOriginalAfterConvert: true,
  firstLaunch: true,
  hookBrowser: false,
  browserChoice: 'Chrome',
  animateBackground: true,
  notifications: true,
  denoReminderDismissed: false,
  gpuAcceleration: false,
  gpuType: 'auto',
  bestQuality: false,
  ffmpegPath: '',
  hideSupportModal: false,
  checkUpdatesOnStartup: true,
  updateChannel: 'auto',
};

export function getDefaultSettings(): Settings {
  return { ...defaultSettings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function readAudioFormat(value: unknown): AudioFormat {
  return typeof value === 'string' && ALLOWED_AUDIO_FORMATS.has(value as AudioFormat)
    ? (value as AudioFormat)
    : defaultSettings.audioFormat;
}

function readConvertFormat(value: unknown): string {
  return typeof value === 'string' && ALLOWED_CONVERT_FORMATS.has(value)
    ? value
    : defaultSettings.convertFormat;
}

function readUpdateChannel(value: unknown): Settings['updateChannel'] {
  return value === 'stable' || value === 'beta' || value === 'auto'
    ? value
    : defaultSettings.updateChannel;
}

function readTheme(value: unknown): Settings['theme'] {
  return value === 'system' || value === 'light' || value === 'dark' || value === 'purple'
    ? value
    : defaultSettings.theme;
}

function readGpuType(value: unknown): Settings['gpuType'] {
  return value === 'auto' || value === 'nvidia' || value === 'amd' || value === 'intel'
    ? value
    : defaultSettings.gpuType;
}

function readSettingsVersion(value: unknown): number {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= CURRENT_SETTINGS_VERSION
  ) {
    return value;
  }
  return CURRENT_SETTINGS_VERSION;
}

export function migrateSettings(rawSettings: unknown): Settings {
  if (!isRecord(rawSettings)) {
    return { ...defaultSettings };
  }

  return {
    settingsVersion: readSettingsVersion(rawSettings.settingsVersion),
    theme: readTheme(rawSettings.theme),
    showConsoleOutput: readBoolean(
      rawSettings.showConsoleOutput,
      defaultSettings.showConsoleOutput
    ),
    consoleCollapsed: readBoolean(rawSettings.consoleCollapsed, defaultSettings.consoleCollapsed),
    advancedOptions: readBoolean(rawSettings.advancedOptions, defaultSettings.advancedOptions),
    audioOnly: readBoolean(rawSettings.audioOnly, defaultSettings.audioOnly),
    audioFormat: readAudioFormat(rawSettings.audioFormat),
    convertEnabled: readBoolean(rawSettings.convertEnabled, defaultSettings.convertEnabled),
    convertFormat: readConvertFormat(rawSettings.convertFormat),
    keepOriginalAfterConvert: readBoolean(
      rawSettings.keepOriginalAfterConvert,
      defaultSettings.keepOriginalAfterConvert
    ),
    firstLaunch: readBoolean(rawSettings.firstLaunch, defaultSettings.firstLaunch),
    hookBrowser: readBoolean(rawSettings.hookBrowser, defaultSettings.hookBrowser),
    browserChoice: readString(rawSettings.browserChoice, defaultSettings.browserChoice),
    animateBackground: readBoolean(
      rawSettings.animateBackground,
      defaultSettings.animateBackground
    ),
    notifications: readBoolean(rawSettings.notifications, defaultSettings.notifications),
    denoReminderDismissed: readBoolean(
      rawSettings.denoReminderDismissed,
      defaultSettings.denoReminderDismissed
    ),
    gpuAcceleration: readBoolean(rawSettings.gpuAcceleration, defaultSettings.gpuAcceleration),
    gpuType: readGpuType(rawSettings.gpuType),
    bestQuality: readBoolean(rawSettings.bestQuality, defaultSettings.bestQuality),
    ffmpegPath: readString(rawSettings.ffmpegPath, defaultSettings.ffmpegPath),
    hideSupportModal: readBoolean(rawSettings.hideSupportModal, defaultSettings.hideSupportModal),
    checkUpdatesOnStartup: readBoolean(
      rawSettings.checkUpdatesOnStartup,
      defaultSettings.checkUpdatesOnStartup
    ),
    updateChannel: readUpdateChannel(rawSettings.updateChannel),
  };
}

function normalizeSettingsVersion(settings: Settings): Settings {
  return {
    ...settings,
    settingsVersion: CURRENT_SETTINGS_VERSION,
  };
}

export function loadSettings(): Settings {
  try {
    if (!fs.existsSync(settingsPath)) {
      return { ...defaultSettings };
    }
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const loaded = JSON.parse(raw);
    return normalizeSettingsVersion(migrateSettings(loaded));
  } catch (error) {
    log.warn('Failed to load settings, using defaults:', error);
    return { ...defaultSettings };
  }
}

export function saveSettings(
  newSettings: Partial<Settings>,
  mainWindow: Electron.BrowserWindow | null
): boolean {
  try {
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = loadSettings();
    const completeSettings = normalizeSettingsVersion(
      migrateSettings({ ...existing, ...newSettings })
    );
    const tmpPath = `${settingsPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(completeSettings, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, settingsPath);
    return true;
  } catch (error) {
    log.error('Failed to save settings:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        'Settings Save Error',
        `Failed to save settings: ${(error as Error).message}`
      );
    }
    return false;
  }
}

function getDefaultStats(): DownloadStats {
  return {
    totalDownloads: 0,
    successfulDownloads: 0,
    failedDownloads: 0,
    cancelledDownloads: 0,
    totalBytesDownloaded: 0,
    formatCounts: {},
    firstDownloadAt: null,
    lastDownloadAt: null,
  };
}

export function loadStats(): DownloadStats {
  try {
    if (!fs.existsSync(statsPath)) return getDefaultStats();
    const raw = fs.readFileSync(statsPath, 'utf-8');
    const loaded = JSON.parse(raw);
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) return getDefaultStats();
    const stats = getDefaultStats();
    if (typeof loaded.totalDownloads === 'number') stats.totalDownloads = loaded.totalDownloads;
    if (typeof loaded.successfulDownloads === 'number')
      stats.successfulDownloads = loaded.successfulDownloads;
    if (typeof loaded.failedDownloads === 'number') stats.failedDownloads = loaded.failedDownloads;
    if (typeof loaded.cancelledDownloads === 'number')
      stats.cancelledDownloads = loaded.cancelledDownloads;
    if (typeof loaded.totalBytesDownloaded === 'number')
      stats.totalBytesDownloaded = loaded.totalBytesDownloaded;
    if (
      loaded.formatCounts &&
      typeof loaded.formatCounts === 'object' &&
      !Array.isArray(loaded.formatCounts) &&
      loaded.formatCounts !== null
    )
      stats.formatCounts = { ...loaded.formatCounts };
    if (typeof loaded.firstDownloadAt === 'number') stats.firstDownloadAt = loaded.firstDownloadAt;
    if (typeof loaded.lastDownloadAt === 'number') stats.lastDownloadAt = loaded.lastDownloadAt;
    return stats;
  } catch (error) {
    log.warn('Failed to load stats, using defaults:', error);
    return getDefaultStats();
  }
}

export function saveStats(stats: DownloadStats): boolean {
  try {
    const dir = path.dirname(statsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${statsPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(stats, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, statsPath);
    return true;
  } catch (error) {
    log.error('Failed to save stats:', error);
    return false;
  }
}

export function recordDownload(
  outcome: 'success' | 'failed' | 'cancelled',
  format?: string,
  bytes?: number
): void {
  const stats = loadStats();
  stats.totalDownloads += 1;
  const now = Date.now();
  if (!stats.firstDownloadAt) stats.firstDownloadAt = now;
  stats.lastDownloadAt = now;

  if (outcome === 'success') {
    stats.successfulDownloads += 1;
    if (format && Object.keys(stats.formatCounts).length < MAX_FORMAT_COUNTS) {
      stats.formatCounts[format] = (stats.formatCounts[format] || 0) + 1;
    }
    if (typeof bytes === 'number' && bytes > 0) {
      stats.totalBytesDownloaded += bytes;
    }
  } else if (outcome === 'failed') {
    stats.failedDownloads += 1;
  } else {
    stats.cancelledDownloads += 1;
  }

  saveStats(stats);
}

export function resetStats(): boolean {
  return saveStats(getDefaultStats());
}

export async function exportSettingsToFile(
  parentWindow: Electron.BrowserWindow | null
): Promise<boolean> {
  if (!parentWindow || parentWindow.isDestroyed()) return false;
  const { canceled, filePath } = await dialog.showSaveDialog(parentWindow, {
    title: 'Export Settings',
    defaultPath: 'rosi-settings.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return false;
  try {
    const settings = loadSettings();
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2));
    return true;
  } catch (error) {
    log.error('Failed to export settings:', error);
    return false;
  }
}

export async function importSettingsFromFile(
  parentWindow: Electron.BrowserWindow | null
): Promise<boolean> {
  if (!parentWindow || parentWindow.isDestroyed()) return false;
  const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow, {
    title: 'Import Settings',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return false;
  try {
    const stat = fs.statSync(filePaths[0]);
    if (stat.size > MAX_SETTINGS_IMPORT_BYTES) {
      log.warn(
        `Settings import file too large: ${stat.size} bytes (max ${MAX_SETTINGS_IMPORT_BYTES}).`
      );
      return false;
    }
    const raw = fs.readFileSync(filePaths[0], 'utf-8');
    const loaded = JSON.parse(raw);
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
      log.warn('Imported settings file has invalid structure.');
      return false;
    }
    const migrated = normalizeSettingsVersion(migrateSettings(loaded));
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${settingsPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, settingsPath);
    return true;
  } catch (error) {
    log.error('Failed to import settings:', error);
    return false;
  }
}
