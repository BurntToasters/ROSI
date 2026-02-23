import * as path from 'path';
import * as fs from 'fs';
import { app, dialog } from 'electron';
import log from 'electron-log/main';
import type { Settings } from '../types';

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
export const CURRENT_SETTINGS_VERSION = 1;

const defaultSettings: Settings = {
  settingsVersion: CURRENT_SETTINGS_VERSION,
  showConsoleOutput: false,
  consoleCollapsed: false,
  advancedOptions: false,
  audioOnly: false,
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

function readUpdateChannel(value: unknown): Settings['updateChannel'] {
  return value === 'stable' || value === 'beta' || value === 'auto'
    ? value
    : defaultSettings.updateChannel;
}

function readGpuType(value: unknown): Settings['gpuType'] {
  return value === 'auto' || value === 'nvidia' || value === 'amd' || value === 'intel'
    ? value
    : defaultSettings.gpuType;
}

function readSettingsVersion(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
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
    showConsoleOutput: readBoolean(
      rawSettings.showConsoleOutput,
      defaultSettings.showConsoleOutput
    ),
    consoleCollapsed: readBoolean(rawSettings.consoleCollapsed, defaultSettings.consoleCollapsed),
    advancedOptions: readBoolean(rawSettings.advancedOptions, defaultSettings.advancedOptions),
    audioOnly: readBoolean(rawSettings.audioOnly, defaultSettings.audioOnly),
    convertEnabled: readBoolean(rawSettings.convertEnabled, defaultSettings.convertEnabled),
    convertFormat: readString(rawSettings.convertFormat, defaultSettings.convertFormat),
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
  } catch {
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
    fs.writeFileSync(settingsPath, JSON.stringify(completeSettings, null, 2));
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
