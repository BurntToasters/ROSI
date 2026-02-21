import * as path from 'path';
import * as fs from 'fs';
import { app, dialog } from 'electron';
import log from 'electron-log/main';
import type { Settings } from '../types';

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

const defaultSettings: Settings = {
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

export function loadSettings(): Settings {
  try {
    if (!fs.existsSync(settingsPath)) {
      return { ...defaultSettings };
    }
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const loaded = JSON.parse(raw);
    return { ...defaultSettings, ...loaded };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(
  newSettings: Partial<Settings>,
  mainWindow: Electron.BrowserWindow | null
) {
  try {
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const completeSettings = { ...defaultSettings, ...newSettings };
    fs.writeFileSync(settingsPath, JSON.stringify(completeSettings, null, 2));
  } catch (error) {
    log.error('Failed to save settings:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        'Settings Save Error',
        `Failed to save settings: ${(error as Error).message}`
      );
    }
  }
}
