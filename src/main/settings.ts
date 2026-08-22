import * as path from 'path';
import * as fs from 'fs';
import { app, dialog } from 'electron';
import log from 'electron-log/main.js';
import type {
  AudioFormat,
  DownloadPreset,
  DownloadProfile,
  DownloadRequestOptions,
  DownloadStats,
  PlaylistSelection,
  Settings,
} from '../types';
import {
  ALLOWED_AUDIO_FORMATS,
  ALLOWED_BROWSERS,
  ALLOWED_CONVERT_FORMATS,
  FORMAT_ID_PATTERN,
  MAX_DOWNLOAD_PRESETS,
  MAX_FORMAT_COUNTS,
  MAX_PLAYLIST_ITEM_INDEX,
  MAX_PRESET_ID_LENGTH,
  MAX_PRESET_NAME_LENGTH,
  MAX_SETTINGS_IMPORT_BYTES,
  CURRENT_SETTINGS_VERSION,
  SUBTITLE_LANGS_PATTERN,
} from './constants';
import { validateDownloadPath, validateFfmpegPathValue } from '../utils/ipcValidation';
import { clearGpuCache } from './gpu';

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const statsPath = path.join(app.getPath('userData'), 'download-stats.json');
export { CURRENT_SETTINGS_VERSION } from './constants';

const defaultSettings: Settings = {
  settingsVersion: CURRENT_SETTINGS_VERSION,
  theme: 'system',
  showConsoleOutput: false,
  consoleCollapsed: false,
  queueCollapsed: false,
  downloadProfilesEnabled: false,
  downloadMode: 'best-video',
  downloadPresets: [],
  askDownloadLocation: false,
  advancedOptions: false,
  audioOnly: false,
  audioFormat: 'mp3',
  convertEnabled: false,
  convertFormat: 'mp4',
  keepOriginalAfterConvert: true,
  firstLaunch: true,
  hookBrowser: false,
  browserChoice: 'chrome',
  animateBackground: true,
  flatUi: false,
  notifications: true,
  denoReminderDismissed: false,
  gpuAcceleration: false,
  gpuType: 'auto',
  bestQuality: false,
  ffmpegPath: '',
  downloadFolder: '',
  hideSupportModal: false,
  checkUpdatesOnStartup: true,
  updateChannel: 'auto',
  writeSubtitles: false,
  subtitleLangs: 'en',
  embedThumbnail: false,
  embedMetadata: false,
  sponsorblockRemove: false,
  showTaskbarProgress: true,
};

function clonePlaylistSelection(
  playlist: PlaylistSelection | undefined
): PlaylistSelection | undefined {
  return playlist ? { ...playlist } : undefined;
}

function cloneDownloadPreset(preset: DownloadPreset): DownloadPreset {
  return {
    ...preset,
    playlist: clonePlaylistSelection(preset.playlist),
  };
}

export function getDefaultSettings(): Settings {
  return {
    ...defaultSettings,
    downloadPresets: defaultSettings.downloadPresets.map(cloneDownloadPreset),
  };
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

function readDownloadMode(value: unknown, fallback: DownloadProfile): DownloadProfile {
  return value === 'best-video' || value === 'audio' || value === 'custom' ? value : fallback;
}

function inferDownloadMode(rawSettings: Record<string, unknown>): DownloadProfile {
  if (rawSettings.audioOnly === true) return 'audio';
  if (rawSettings.advancedOptions === true) return 'custom';
  return 'best-video';
}

function readConvertFormat(value: unknown): string {
  return typeof value === 'string' && ALLOWED_CONVERT_FORMATS.has(value)
    ? value
    : defaultSettings.convertFormat;
}

function readSubtitleLangs(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.subtitleLangs;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || !SUBTITLE_LANGS_PATTERN.test(trimmed)) {
    return defaultSettings.subtitleLangs;
  }
  return trimmed;
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

function sanitizePresetName(rawName: unknown, index: number, usedNames: Set<string>): string {
  const fallback = `Preset ${index + 1}`;
  const base =
    typeof rawName === 'string'
      ? rawName.trim().replace(/\s+/g, ' ').slice(0, MAX_PRESET_NAME_LENGTH) || fallback
      : fallback;
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    const marker = ` (${suffix})`;
    candidate = `${base.slice(0, Math.max(1, MAX_PRESET_NAME_LENGTH - marker.length))}${marker}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function sanitizePresetId(
  rawId: unknown,
  name: string,
  index: number,
  usedIds: Set<string>
): string {
  const safePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
  const provided = typeof rawId === 'string' ? rawId.trim() : '';
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const fallback = `preset-${index + 1}${slug ? `-${slug}` : ''}`;
  const base =
    provided && provided.length <= MAX_PRESET_ID_LENGTH && safePattern.test(provided)
      ? provided
      : fallback.slice(0, MAX_PRESET_ID_LENGTH);
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    const marker = `-${suffix}`;
    candidate = `${base.slice(0, Math.max(1, MAX_PRESET_ID_LENGTH - marker.length))}${marker}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function sanitizePresetPlaylist(value: unknown): PlaylistSelection | undefined {
  if (!isRecord(value)) return undefined;
  if (value.mode === 'current' || value.mode === 'all') {
    return { mode: value.mode };
  }
  if (
    value.mode === 'range' &&
    typeof value.start === 'number' &&
    typeof value.end === 'number' &&
    Number.isInteger(value.start) &&
    Number.isInteger(value.end) &&
    value.start >= 1 &&
    value.end >= value.start &&
    value.end <= MAX_PLAYLIST_ITEM_INDEX
  ) {
    return { mode: 'range', start: value.start, end: value.end };
  }
  return undefined;
}

export function sanitizeDownloadPresets(value: unknown): DownloadPreset[] {
  if (!Array.isArray(value)) return [];
  const presets: DownloadPreset[] = [];
  const usedIds = new Set<string>();
  const usedNames = new Set<string>();

  for (const [index, rawPreset] of value.slice(0, MAX_DOWNLOAD_PRESETS).entries()) {
    if (!isRecord(rawPreset)) continue;
    const name = sanitizePresetName(rawPreset.name, index, usedNames);
    const id = sanitizePresetId(rawPreset.id, name, index, usedIds);
    const profile = readDownloadMode(rawPreset.profile, 'best-video');
    const preset: DownloadPreset = { id, name, profile };

    for (const key of [
      'bestQuality',
      'audioOnly',
      'convertEnabled',
      'keepOriginalAfterConvert',
      'gpuAcceleration',
      'writeSubtitles',
      'embedThumbnail',
      'embedMetadata',
      'sponsorblockRemove',
    ] as const) {
      if (typeof rawPreset[key] === 'boolean') preset[key] = rawPreset[key];
    }
    if (
      typeof rawPreset.audioFormat === 'string' &&
      ALLOWED_AUDIO_FORMATS.has(rawPreset.audioFormat)
    ) {
      preset.audioFormat = rawPreset.audioFormat as AudioFormat;
    }
    if (
      typeof rawPreset.videoFormat === 'string' &&
      FORMAT_ID_PATTERN.test(rawPreset.videoFormat.trim())
    ) {
      preset.videoFormat = rawPreset.videoFormat.trim();
    }
    if (
      typeof rawPreset.audioFormatId === 'string' &&
      FORMAT_ID_PATTERN.test(rawPreset.audioFormatId.trim())
    ) {
      preset.audioFormatId = rawPreset.audioFormatId.trim();
    }
    if (
      typeof rawPreset.convertFormat === 'string' &&
      ALLOWED_CONVERT_FORMATS.has(rawPreset.convertFormat)
    ) {
      preset.convertFormat = rawPreset.convertFormat;
    }
    if (
      rawPreset.gpuType === 'auto' ||
      rawPreset.gpuType === 'nvidia' ||
      rawPreset.gpuType === 'amd' ||
      rawPreset.gpuType === 'intel'
    ) {
      preset.gpuType = rawPreset.gpuType;
    }
    if (typeof rawPreset.subtitleLangs === 'string') {
      const langs = rawPreset.subtitleLangs.trim();
      if (langs && langs.length <= 256 && SUBTITLE_LANGS_PATTERN.test(langs)) {
        preset.subtitleLangs = langs;
      }
    }
    const playlist = sanitizePresetPlaylist(rawPreset.playlist);
    if (playlist) preset.playlist = playlist;
    presets.push(preset);
  }
  return presets;
}

export function downloadPresetToRequestOptions(
  preset: DownloadPreset
): Partial<DownloadRequestOptions> {
  const mapped: Partial<DownloadRequestOptions> = {
    profileEnabled: true,
    profile: preset.profile,
    presetId: preset.id,
    presetName: preset.name,
    bestQuality: preset.bestQuality ?? preset.profile === 'best-video',
    advancedOptions: preset.profile === 'custom',
    audioOnly: preset.audioOnly ?? preset.profile === 'audio',
    audioOutputFormat: preset.audioFormat,
    videoFormat: preset.videoFormat,
    audioFormat: preset.audioFormatId,
    convertEnabled: preset.convertEnabled,
    convertFormat: preset.convertFormat,
    keepOriginal: preset.keepOriginalAfterConvert,
    gpuAcceleration: preset.gpuAcceleration,
    gpuType: preset.gpuType,
    writeSubtitles: preset.writeSubtitles,
    subtitleLangs: preset.subtitleLangs,
    embedThumbnail: preset.embedThumbnail,
    embedMetadata: preset.embedMetadata,
    sponsorblockRemove: preset.sponsorblockRemove,
    playlist: clonePlaylistSelection(preset.playlist),
  };
  return Object.fromEntries(
    Object.entries(mapped).filter(([, value]) => value !== undefined)
  ) as Partial<DownloadRequestOptions>;
}

function readBrowserChoice(value: unknown): string {
  const raw = readString(value, defaultSettings.browserChoice);
  const capped = raw.length > 64 ? raw.slice(0, 64) : raw;
  const normalized = capped.trim().toLowerCase();
  if (ALLOWED_BROWSERS.has(normalized)) {
    return normalized;
  }
  return defaultSettings.browserChoice;
}

function readFfmpegPath(value: unknown): string {
  const raw = readString(value, defaultSettings.ffmpegPath);
  const capped = raw.length > 1024 ? raw.slice(0, 1024) : raw;
  const validation = validateFfmpegPathValue(capped.trim() || undefined);
  if (!validation.ok) {
    return defaultSettings.ffmpegPath;
  }
  return validation.data || '';
}

function readDownloadFolder(value: unknown): string {
  const raw = readString(value, defaultSettings.downloadFolder);
  const capped = raw.length > 4096 ? raw.slice(0, 4096) : raw;
  if (!capped.trim()) {
    return defaultSettings.downloadFolder;
  }
  const validation = validateDownloadPath(capped);
  if (!validation.ok) {
    return defaultSettings.downloadFolder;
  }
  return validation.data;
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
    return getDefaultSettings();
  }

  const downloadProfilesEnabled = readBoolean(
    rawSettings.downloadProfilesEnabled,
    defaultSettings.downloadProfilesEnabled
  );
  const downloadMode = readDownloadMode(rawSettings.downloadMode, inferDownloadMode(rawSettings));
  const profileFlags = downloadProfilesEnabled
    ? {
        advancedOptions: downloadMode === 'custom',
        audioOnly: downloadMode === 'audio',
        bestQuality: downloadMode === 'best-video',
      }
    : {
        advancedOptions: false,
        audioOnly: false,
        bestQuality: false,
      };

  return {
    settingsVersion: readSettingsVersion(rawSettings.settingsVersion),
    theme: readTheme(rawSettings.theme),
    showConsoleOutput: readBoolean(
      rawSettings.showConsoleOutput,
      defaultSettings.showConsoleOutput
    ),
    consoleCollapsed: readBoolean(rawSettings.consoleCollapsed, defaultSettings.consoleCollapsed),
    queueCollapsed: readBoolean(rawSettings.queueCollapsed, defaultSettings.queueCollapsed),
    downloadProfilesEnabled,
    downloadMode,
    downloadPresets: sanitizeDownloadPresets(rawSettings.downloadPresets),
    askDownloadLocation: readBoolean(
      rawSettings.askDownloadLocation,
      defaultSettings.askDownloadLocation
    ),
    advancedOptions: profileFlags.advancedOptions,
    audioOnly: profileFlags.audioOnly,
    audioFormat: readAudioFormat(rawSettings.audioFormat),
    convertEnabled: readBoolean(rawSettings.convertEnabled, defaultSettings.convertEnabled),
    convertFormat: readConvertFormat(rawSettings.convertFormat),
    keepOriginalAfterConvert: readBoolean(
      rawSettings.keepOriginalAfterConvert,
      defaultSettings.keepOriginalAfterConvert
    ),
    firstLaunch: readBoolean(rawSettings.firstLaunch, defaultSettings.firstLaunch),
    hookBrowser: readBoolean(rawSettings.hookBrowser, defaultSettings.hookBrowser),
    browserChoice: readBrowserChoice(rawSettings.browserChoice),
    animateBackground: readBoolean(
      rawSettings.animateBackground,
      defaultSettings.animateBackground
    ),
    flatUi: readBoolean(rawSettings.flatUi, defaultSettings.flatUi),
    notifications: readBoolean(rawSettings.notifications, defaultSettings.notifications),
    denoReminderDismissed: readBoolean(
      rawSettings.denoReminderDismissed,
      defaultSettings.denoReminderDismissed
    ),
    gpuAcceleration: readBoolean(rawSettings.gpuAcceleration, defaultSettings.gpuAcceleration),
    gpuType: readGpuType(rawSettings.gpuType),
    bestQuality: profileFlags.bestQuality,
    ffmpegPath: readFfmpegPath(rawSettings.ffmpegPath),
    downloadFolder: readDownloadFolder(rawSettings.downloadFolder),
    hideSupportModal: readBoolean(rawSettings.hideSupportModal, defaultSettings.hideSupportModal),
    checkUpdatesOnStartup: readBoolean(
      rawSettings.checkUpdatesOnStartup,
      defaultSettings.checkUpdatesOnStartup
    ),
    updateChannel: readUpdateChannel(rawSettings.updateChannel),
    writeSubtitles: readBoolean(rawSettings.writeSubtitles, defaultSettings.writeSubtitles),
    subtitleLangs: readSubtitleLangs(rawSettings.subtitleLangs),
    embedThumbnail: readBoolean(rawSettings.embedThumbnail, defaultSettings.embedThumbnail),
    embedMetadata: readBoolean(rawSettings.embedMetadata, defaultSettings.embedMetadata),
    sponsorblockRemove: readBoolean(
      rawSettings.sponsorblockRemove,
      defaultSettings.sponsorblockRemove
    ),
    showTaskbarProgress: readBoolean(
      rawSettings.showTaskbarProgress,
      defaultSettings.showTaskbarProgress
    ),
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
      return getDefaultSettings();
    }
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const loaded: unknown = JSON.parse(raw);
    return normalizeSettingsVersion(migrateSettings(loaded));
  } catch (error) {
    log.warn('Failed to load settings, using defaults:', error);
    return getDefaultSettings();
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
    if (
      (newSettings.ffmpegPath !== undefined && newSettings.ffmpegPath !== existing.ffmpegPath) ||
      (newSettings.gpuAcceleration !== undefined &&
        newSettings.gpuAcceleration !== existing.gpuAcceleration)
    ) {
      clearGpuCache();
    }
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
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return getDefaultStats();
    const loaded = parsed as Record<string, unknown>;
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
      stats.formatCounts = { ...(loaded.formatCounts as Record<string, number>) };
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
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), { mode: 0o600 });
    return true;
  } catch (error) {
    log.error('Failed to export settings:', error);
    return false;
  }
}

export async function importSettingsFromFile(
  parentWindow: Electron.BrowserWindow | null
): Promise<Settings | false> {
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
    const loaded: unknown = JSON.parse(raw);
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
    return migrated;
  } catch (error) {
    log.error('Failed to import settings:', error);
    return false;
  }
}
