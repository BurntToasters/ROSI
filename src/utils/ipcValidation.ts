import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  DownloadPreset,
  DownloadRequestOptions,
  IpcErrorCode,
  IpcErrorPayload,
  IpcResult,
  NotificationRequest,
  PlaylistSelection,
  QueueReorderRequest,
  Settings,
} from '../types';
import { isSafeExternalUrl, isSafeHttpUrl } from './validation';
import {
  ALLOWED_AUDIO_FORMATS,
  ALLOWED_BROWSERS,
  ALLOWED_CONVERT_FORMATS,
  CURRENT_SETTINGS_VERSION,
  FORMAT_ID_PATTERN,
  MAX_DOWNLOAD_PRESETS,
  MAX_PLAYLIST_ITEM_INDEX,
  MAX_PRESET_ID_LENGTH,
  MAX_PRESET_NAME_LENGTH,
  SUBTITLE_LANGS_PATTERN,
} from '../main/constants';

const ALLOWED_GPU_TYPES = new Set(['auto', 'nvidia', 'amd', 'intel']);
const ALLOWED_UPDATE_CHANNELS = new Set(['auto', 'stable', 'beta']);
const ALLOWED_THEMES = new Set(['system', 'light', 'dark', 'purple']);
const ALLOWED_DOWNLOAD_PROFILES = new Set(['best-video', 'audio', 'custom']);
const PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const QUEUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

type ValidationResult<T> = { ok: true; data: T } | { ok: false; error: IpcErrorPayload };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function buildError(code: IpcErrorCode, message: string, details?: string): IpcErrorPayload {
  return { code, message, details };
}

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function isPathWithinBase(resolvedPath: string, basePath: string): boolean {
  const base = path.resolve(basePath);
  const resolved = path.resolve(resolvedPath);
  const relative = path.relative(base, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isAllowedDownloadBase(resolvedPath: string): boolean {
  // macOS/Linux: home plus known external mount roots. Windows: any absolute path
  // outside blocked system directories (broader by design for drive-letter layouts).
  const homeDir = os.homedir();
  if (homeDir && isPathWithinBase(resolvedPath, homeDir)) {
    return true;
  }
  if (process.platform === 'darwin') {
    const volumesRoot = path.resolve('/Volumes');
    if (resolvedPath === volumesRoot || isPathWithinBase(resolvedPath, volumesRoot)) {
      return true;
    }
  }
  if (process.platform === 'linux') {
    // Allow common external/removable mount roots on Linux.
    for (const mountRoot of ['/mnt', '/media', '/run/media']) {
      const resolved = path.resolve(mountRoot);
      if (resolvedPath === resolved || isPathWithinBase(resolvedPath, resolved)) {
        return true;
      }
    }
  }
  if (process.platform === 'win32' && isAbsolutePath(resolvedPath)) {
    const normalized = resolvedPath.replace(/\//g, '\\').toLowerCase();
    const blocked = [
      '\\windows\\',
      '\\program files\\',
      '\\program files (x86)\\',
      '\\programdata\\',
    ];
    if (!blocked.some((prefix) => normalized.includes(prefix))) {
      return true;
    }
  }
  return false;
}

export function validateDownloadPath(value: string): ValidationResult<string> {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, data: '' };
  }
  if (!isAbsolutePath(trimmed)) {
    return {
      ok: false,
      error: buildError('INVALID_PATH', 'Download path must be an absolute path.'),
    };
  }
  const resolved = path.resolve(trimmed);
  if (!isAllowedDownloadBase(resolved)) {
    return {
      ok: false,
      error: buildError(
        'INVALID_PATH',
        'Download path must be within your home directory or an allowed external volume.'
      ),
    };
  }
  return { ok: true, data: resolved };
}

function validateOutputPath(value: string): ValidationResult<string> {
  const trimmed = value.trim();
  if (!isAbsolutePath(trimmed)) {
    return {
      ok: false,
      error: buildError('INVALID_PATH', 'Download outputPath must be an absolute path.'),
    };
  }
  return validateDownloadPath(trimmed);
}

export function validateFfmpegPathValue(
  value: string | undefined
): ValidationResult<string | undefined> {
  if (value === undefined) {
    return { ok: true, data: undefined };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, data: undefined };
  }
  if (trimmed === 'ffmpeg') {
    return { ok: true, data: 'ffmpeg' };
  }
  if (!isAbsolutePath(trimmed)) {
    return {
      ok: false,
      error: buildError(
        'VALIDATION_ERROR',
        'ffmpegPath must be an absolute path, empty string, or "ffmpeg".'
      ),
    };
  }
  const resolved = path.resolve(trimmed);
  const baseName = path.basename(resolved).toLowerCase();
  if (baseName !== 'ffmpeg' && baseName !== 'ffmpeg.exe') {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'ffmpegPath must point to ffmpeg or ffmpeg.exe.'),
    };
  }
  if (!fs.existsSync(resolved)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'ffmpegPath does not exist.'),
    };
  }
  return { ok: true, data: resolved };
}

export function okResult<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

export function errorResult(
  code: IpcErrorCode,
  message: string,
  details?: string
): IpcResult<never> {
  return { ok: false, error: buildError(code, message, details) };
}

export function validateExternalUrlPayload(value: unknown): ValidationResult<string> {
  if (!isString(value) || !isSafeExternalUrl(value)) {
    return {
      ok: false,
      error: buildError('INVALID_URL', 'Invalid external URL payload.'),
    };
  }
  return { ok: true, data: value.trim() };
}

export function validatePlaylistSelectionPayload(
  value: unknown
): ValidationResult<PlaylistSelection> {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'playlist must be an object.'),
    };
  }
  const { mode, start, end } = value;
  if (mode !== 'current' && mode !== 'all' && mode !== 'range') {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'playlist.mode must be current, all, or range.'),
    };
  }
  if (mode !== 'range') {
    if (start !== undefined || end !== undefined) {
      return {
        ok: false,
        error: buildError(
          'VALIDATION_ERROR',
          'playlist.start and playlist.end are only valid for range mode.'
        ),
      };
    }
    return { ok: true, data: { mode } };
  }
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < 1 ||
    start > end ||
    end > MAX_PLAYLIST_ITEM_INDEX
  ) {
    return {
      ok: false,
      error: buildError(
        'VALIDATION_ERROR',
        `Playlist range must use 1-based integer bounds with start <= end and end <= ${MAX_PLAYLIST_ITEM_INDEX}.`
      ),
    };
  }
  return { ok: true, data: { mode, start, end } };
}

function validatePresetList(value: unknown): ValidationResult<DownloadPreset[]> {
  if (!Array.isArray(value) || value.length > MAX_DOWNLOAD_PRESETS) {
    return {
      ok: false,
      error: buildError(
        'VALIDATION_ERROR',
        `downloadPresets must be an array with at most ${MAX_DOWNLOAD_PRESETS} entries.`
      ),
    };
  }

  const presets: DownloadPreset[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const rawPreset of value) {
    if (!isRecord(rawPreset)) {
      return {
        ok: false,
        error: buildError('VALIDATION_ERROR', 'Each download preset must be an object.'),
      };
    }
    const id = isString(rawPreset.id) ? rawPreset.id.trim() : '';
    const name = isString(rawPreset.name) ? rawPreset.name.trim() : '';
    const profile = rawPreset.profile;
    if (!id || id.length > MAX_PRESET_ID_LENGTH || !PRESET_ID_PATTERN.test(id) || ids.has(id)) {
      return {
        ok: false,
        error: buildError('VALIDATION_ERROR', 'Preset IDs must be unique safe identifiers.'),
      };
    }
    const normalizedName = name.toLocaleLowerCase();
    if (!name || name.length > MAX_PRESET_NAME_LENGTH || names.has(normalizedName)) {
      return {
        ok: false,
        error: buildError(
          'VALIDATION_ERROR',
          `Preset names must be unique and at most ${MAX_PRESET_NAME_LENGTH} characters.`
        ),
      };
    }
    if (!isString(profile) || !ALLOWED_DOWNLOAD_PROFILES.has(profile)) {
      return {
        ok: false,
        error: buildError('VALIDATION_ERROR', 'Preset profile is invalid.'),
      };
    }

    const preset: DownloadPreset = {
      id,
      name,
      profile: profile as DownloadPreset['profile'],
    };
    const booleanFields = [
      'bestQuality',
      'audioOnly',
      'convertEnabled',
      'keepOriginalAfterConvert',
      'gpuAcceleration',
      'writeSubtitles',
      'embedThumbnail',
      'embedMetadata',
      'sponsorblockRemove',
    ] as const;
    for (const key of booleanFields) {
      const fieldValue = rawPreset[key];
      if (fieldValue !== undefined && !isBoolean(fieldValue)) {
        return {
          ok: false,
          error: buildError('VALIDATION_ERROR', `Preset ${key} must be a boolean.`),
        };
      }
      if (typeof fieldValue === 'boolean') preset[key] = fieldValue;
    }

    if (rawPreset.audioFormat !== undefined) {
      if (!isString(rawPreset.audioFormat) || !ALLOWED_AUDIO_FORMATS.has(rawPreset.audioFormat)) {
        return {
          ok: false,
          error: buildError('VALIDATION_ERROR', 'Preset audioFormat is invalid.'),
        };
      }
      preset.audioFormat = rawPreset.audioFormat as DownloadPreset['audioFormat'];
    }
    for (const key of ['videoFormat', 'audioFormatId'] as const) {
      const fieldValue = rawPreset[key];
      if (
        fieldValue !== undefined &&
        (!isString(fieldValue) || !FORMAT_ID_PATTERN.test(fieldValue.trim()))
      ) {
        return {
          ok: false,
          error: buildError('VALIDATION_ERROR', `Preset ${key} is invalid.`),
        };
      }
      if (isString(fieldValue)) preset[key] = fieldValue.trim();
    }
    if (rawPreset.convertFormat !== undefined) {
      if (
        !isString(rawPreset.convertFormat) ||
        !ALLOWED_CONVERT_FORMATS.has(rawPreset.convertFormat)
      ) {
        return {
          ok: false,
          error: buildError('VALIDATION_ERROR', 'Preset convertFormat is invalid.'),
        };
      }
      preset.convertFormat = rawPreset.convertFormat;
    }
    if (rawPreset.gpuType !== undefined) {
      if (!isString(rawPreset.gpuType) || !ALLOWED_GPU_TYPES.has(rawPreset.gpuType)) {
        return {
          ok: false,
          error: buildError('VALIDATION_ERROR', 'Preset gpuType is invalid.'),
        };
      }
      preset.gpuType = rawPreset.gpuType as DownloadPreset['gpuType'];
    }
    if (rawPreset.subtitleLangs !== undefined) {
      const langs = isString(rawPreset.subtitleLangs) ? rawPreset.subtitleLangs.trim() : '';
      if (!langs || langs.length > 256 || !SUBTITLE_LANGS_PATTERN.test(langs)) {
        return {
          ok: false,
          error: buildError('VALIDATION_ERROR', 'Preset subtitleLangs is invalid.'),
        };
      }
      preset.subtitleLangs = langs;
    }
    if (rawPreset.playlist !== undefined) {
      const playlistValidation = validatePlaylistSelectionPayload(rawPreset.playlist);
      if (!playlistValidation.ok) return playlistValidation;
      preset.playlist = playlistValidation.data;
    }

    ids.add(id);
    names.add(normalizedName);
    presets.push(preset);
  }
  return { ok: true, data: presets };
}

export function validateQueueItemIdPayload(value: unknown): ValidationResult<string> {
  if (!isString(value)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'Queue item ID must be a string.'),
    };
  }
  const id = value.trim();
  if (!QUEUE_ID_PATTERN.test(id)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'Queue item ID is invalid.'),
    };
  }
  return { ok: true, data: id };
}

export function validateQueueReorderPayload(value: unknown): ValidationResult<QueueReorderRequest> {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'Queue reorder payload must be an object.'),
    };
  }
  const idValidation = validateQueueItemIdPayload(value.id);
  if (!idValidation.ok) return idValidation;
  if (value.direction !== 'up' && value.direction !== 'down') {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'Queue reorder direction must be up or down.'),
    };
  }
  return { ok: true, data: { id: idValidation.data, direction: value.direction } };
}

export function validateDownloadRequestPayload(
  value: unknown
): ValidationResult<DownloadRequestOptions> {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'Download payload must be an object.'),
    };
  }

  const { url, outputPath } = value;
  if (!isString(url) || !isSafeHttpUrl(url)) {
    return {
      ok: false,
      error: buildError('INVALID_URL', 'Download URL must be a valid http/https URL.'),
    };
  }
  if (!isString(outputPath) || outputPath.trim() === '') {
    return {
      ok: false,
      error: buildError('INVALID_PATH', 'Download outputPath must be a non-empty string path.'),
    };
  }
  const outputPathValidation = validateOutputPath(outputPath);
  if (!outputPathValidation.ok) return outputPathValidation;

  if (!isOptionalString(value.ffmpegPath)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'ffmpegPath must be a string when provided.'),
    };
  }
  const ffmpegPathValidation = validateFfmpegPathValue(value.ffmpegPath?.trim() || undefined);
  if (!ffmpegPathValidation.ok) return ffmpegPathValidation;

  if (!isOptionalString(value.convertFormat)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'convertFormat must be a string when provided.'),
    };
  }
  const convertFormat = value.convertFormat?.trim() || undefined;
  if (convertFormat !== undefined && !ALLOWED_CONVERT_FORMATS.has(convertFormat)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'convertFormat must be one of: mp4, mov, mp3, m4a.'),
    };
  }

  for (const key of ['videoFormat', 'audioFormat'] as const) {
    const fieldValue = value[key];
    if (!isOptionalString(fieldValue)) {
      return {
        ok: false,
        error: buildError('VALIDATION_ERROR', `${key} must be a string when provided.`),
      };
    }
    if (fieldValue !== undefined && !FORMAT_ID_PATTERN.test(fieldValue.trim())) {
      return {
        ok: false,
        error: buildError('VALIDATION_ERROR', `${key} must be a valid yt-dlp format ID.`),
      };
    }
  }

  const booleanFields = [
    'convertEnabled',
    'keepOriginal',
    'profileEnabled',
    'bestQuality',
    'advancedOptions',
    'audioOnly',
    'hookBrowser',
    'gpuAcceleration',
    'writeSubtitles',
    'embedThumbnail',
    'embedMetadata',
    'sponsorblockRemove',
  ] as const;
  for (const key of booleanFields) {
    if (value[key] !== undefined && !isBoolean(value[key])) {
      return {
        ok: false,
        error: buildError('VALIDATION_ERROR', `${key} must be a boolean when provided.`),
      };
    }
  }

  if (
    value.profile !== undefined &&
    (!isString(value.profile) || !ALLOWED_DOWNLOAD_PROFILES.has(value.profile))
  ) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'profile must be best-video, audio, or custom.'),
    };
  }
  if (
    value.audioOutputFormat !== undefined &&
    (!isString(value.audioOutputFormat) || !ALLOWED_AUDIO_FORMATS.has(value.audioOutputFormat))
  ) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'audioOutputFormat is invalid.'),
    };
  }
  if (
    value.gpuType !== undefined &&
    (!isString(value.gpuType) || !ALLOWED_GPU_TYPES.has(value.gpuType))
  ) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'gpuType must be auto, nvidia, amd, or intel.'),
    };
  }
  if (value.browserChoice !== undefined) {
    if (
      !isString(value.browserChoice) ||
      !ALLOWED_BROWSERS.has(value.browserChoice.toLowerCase())
    ) {
      return {
        ok: false,
        error: buildError('VALIDATION_ERROR', 'browserChoice is not an allowed browser.'),
      };
    }
  }
  if (value.subtitleLangs !== undefined) {
    const langs = isString(value.subtitleLangs) ? value.subtitleLangs.trim() : '';
    if (!langs || langs.length > 256 || !SUBTITLE_LANGS_PATTERN.test(langs)) {
      return {
        ok: false,
        error: buildError('VALIDATION_ERROR', 'subtitleLangs is invalid.'),
      };
    }
  }
  for (const key of ['presetId', 'presetName'] as const) {
    if (value[key] !== undefined && !isString(value[key])) {
      return {
        ok: false,
        error: buildError('VALIDATION_ERROR', `${key} must be a string when provided.`),
      };
    }
  }
  const presetId = isString(value.presetId) ? value.presetId.trim() : undefined;
  if (
    presetId !== undefined &&
    (!presetId || presetId.length > MAX_PRESET_ID_LENGTH || !PRESET_ID_PATTERN.test(presetId))
  ) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'presetId must be a safe preset identifier.'),
    };
  }
  const presetName = isString(value.presetName) ? value.presetName.trim() : undefined;
  if (presetName !== undefined && (!presetName || presetName.length > MAX_PRESET_NAME_LENGTH)) {
    return {
      ok: false,
      error: buildError(
        'VALIDATION_ERROR',
        `presetName must be at most ${MAX_PRESET_NAME_LENGTH} characters.`
      ),
    };
  }

  let playlist: PlaylistSelection | undefined;
  if (value.playlist !== undefined) {
    const playlistValidation = validatePlaylistSelectionPayload(value.playlist);
    if (!playlistValidation.ok) return playlistValidation;
    playlist = playlistValidation.data;
  }

  const data: DownloadRequestOptions = {
    url: url.trim(),
    outputPath: outputPathValidation.data,
    ffmpegPath: ffmpegPathValidation.data,
    convertFormat,
    videoFormat: isString(value.videoFormat) ? value.videoFormat.trim() : undefined,
    audioFormat: isString(value.audioFormat) ? value.audioFormat.trim() : undefined,
    playlist,
    profile: isString(value.profile)
      ? (value.profile as DownloadRequestOptions['profile'])
      : undefined,
    presetId,
    presetName,
    audioOutputFormat: isString(value.audioOutputFormat)
      ? (value.audioOutputFormat as DownloadRequestOptions['audioOutputFormat'])
      : undefined,
    browserChoice: isString(value.browserChoice)
      ? value.browserChoice.trim().toLowerCase()
      : undefined,
    gpuType: isString(value.gpuType)
      ? (value.gpuType as DownloadRequestOptions['gpuType'])
      : undefined,
    subtitleLangs: isString(value.subtitleLangs) ? value.subtitleLangs.trim() : undefined,
  };
  for (const key of booleanFields) {
    if (typeof value[key] === 'boolean') {
      (data as unknown as Record<string, unknown>)[key] = value[key];
    }
  }
  return { ok: true, data };
}

function isValidSettingsKey(key: string): key is keyof Settings {
  return (
    key === 'settingsVersion' ||
    key === 'theme' ||
    key === 'showConsoleOutput' ||
    key === 'consoleCollapsed' ||
    key === 'queueCollapsed' ||
    key === 'downloadProfilesEnabled' ||
    key === 'downloadMode' ||
    key === 'downloadPresets' ||
    key === 'askDownloadLocation' ||
    key === 'advancedOptions' ||
    key === 'audioOnly' ||
    key === 'audioFormat' ||
    key === 'convertEnabled' ||
    key === 'convertFormat' ||
    key === 'keepOriginalAfterConvert' ||
    key === 'firstLaunch' ||
    key === 'hookBrowser' ||
    key === 'browserChoice' ||
    key === 'animateBackground' ||
    key === 'flatUi' ||
    key === 'notifications' ||
    key === 'showTaskbarProgress' ||
    key === 'denoReminderDismissed' ||
    key === 'gpuAcceleration' ||
    key === 'gpuType' ||
    key === 'bestQuality' ||
    key === 'ffmpegPath' ||
    key === 'downloadFolder' ||
    key === 'hideSupportModal' ||
    key === 'checkUpdatesOnStartup' ||
    key === 'updateChannel' ||
    key === 'writeSubtitles' ||
    key === 'subtitleLangs' ||
    key === 'embedThumbnail' ||
    key === 'embedMetadata' ||
    key === 'sponsorblockRemove'
  );
}

export function validateSettingsPatchPayload(value: unknown): ValidationResult<Partial<Settings>> {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'Settings payload must be an object.'),
    };
  }

  const patch: Partial<Settings> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (!isValidSettingsKey(rawKey)) continue;

    if (rawKey === 'settingsVersion') {
      if (
        typeof rawValue !== 'number' ||
        !Number.isInteger(rawValue) ||
        rawValue < 1 ||
        rawValue > CURRENT_SETTINGS_VERSION
      ) {
        return {
          ok: false,
          error: buildError(
            'VALIDATION_ERROR',
            `settingsVersion must be an integer between 1 and ${CURRENT_SETTINGS_VERSION}.`
          ),
        };
      }
      patch.settingsVersion = rawValue;
      continue;
    }

    if (rawKey === 'downloadPresets') {
      const presetValidation = validatePresetList(rawValue);
      if (!presetValidation.ok) return presetValidation;
      patch.downloadPresets = presetValidation.data;
      continue;
    }

    if (
      rawKey === 'showConsoleOutput' ||
      rawKey === 'consoleCollapsed' ||
      rawKey === 'queueCollapsed' ||
      rawKey === 'downloadProfilesEnabled' ||
      rawKey === 'askDownloadLocation' ||
      rawKey === 'advancedOptions' ||
      rawKey === 'audioOnly' ||
      rawKey === 'convertEnabled' ||
      rawKey === 'keepOriginalAfterConvert' ||
      rawKey === 'firstLaunch' ||
      rawKey === 'hookBrowser' ||
      rawKey === 'animateBackground' ||
      rawKey === 'flatUi' ||
      rawKey === 'notifications' ||
      rawKey === 'showTaskbarProgress' ||
      rawKey === 'denoReminderDismissed' ||
      rawKey === 'gpuAcceleration' ||
      rawKey === 'bestQuality' ||
      rawKey === 'hideSupportModal' ||
      rawKey === 'checkUpdatesOnStartup' ||
      rawKey === 'writeSubtitles' ||
      rawKey === 'embedThumbnail' ||
      rawKey === 'embedMetadata' ||
      rawKey === 'sponsorblockRemove'
    ) {
      if (!isBoolean(rawValue)) {
        return {
          ok: false,
          error: buildError('VALIDATION_ERROR', `${rawKey} must be a boolean.`),
        };
      }
      patch[rawKey] = rawValue;
      continue;
    }

    if (rawKey === 'downloadMode') {
      if (
        !isString(rawValue) ||
        (rawValue !== 'best-video' && rawValue !== 'audio' && rawValue !== 'custom')
      ) {
        return {
          ok: false,
          error: buildError(
            'VALIDATION_ERROR',
            'downloadMode must be best-video, audio, or custom.'
          ),
        };
      }
      patch.downloadMode = rawValue as Settings['downloadMode'];
      continue;
    }

    if (rawKey === 'theme') {
      if (!isString(rawValue) || !ALLOWED_THEMES.has(rawValue)) {
        return {
          ok: false,
          error: buildError(
            'VALIDATION_ERROR',
            'theme must be one of: system, light, dark, purple.'
          ),
        };
      }
      patch.theme = rawValue as Settings['theme'];
      continue;
    }

    if (rawKey === 'gpuType') {
      if (!isString(rawValue) || !ALLOWED_GPU_TYPES.has(rawValue)) {
        return {
          ok: false,
          error: buildError(
            'VALIDATION_ERROR',
            'gpuType must be one of: auto, nvidia, amd, intel.'
          ),
        };
      }
      patch.gpuType = rawValue as Settings['gpuType'];
      continue;
    }

    if (rawKey === 'audioFormat') {
      if (!isString(rawValue) || !ALLOWED_AUDIO_FORMATS.has(rawValue)) {
        return {
          ok: false,
          error: buildError(
            'VALIDATION_ERROR',
            'audioFormat must be one of: mp3, flac, ogg, wav, m4a, opus.'
          ),
        };
      }
      patch.audioFormat = rawValue as Settings['audioFormat'];
      continue;
    }

    if (rawKey === 'convertFormat') {
      if (!isString(rawValue) || !ALLOWED_CONVERT_FORMATS.has(rawValue)) {
        return {
          ok: false,
          error: buildError(
            'VALIDATION_ERROR',
            'convertFormat must be one of: mp4, mov, mp3, m4a.'
          ),
        };
      }
      patch.convertFormat = rawValue;
      continue;
    }

    if (rawKey === 'updateChannel') {
      if (!isString(rawValue) || !ALLOWED_UPDATE_CHANNELS.has(rawValue)) {
        return {
          ok: false,
          error: buildError('VALIDATION_ERROR', 'updateChannel must be auto, stable, or beta.'),
        };
      }
      patch.updateChannel = rawValue as Settings['updateChannel'];
      continue;
    }

    if (rawKey === 'subtitleLangs') {
      if (!isString(rawValue) || rawValue.length > 256 || !SUBTITLE_LANGS_PATTERN.test(rawValue)) {
        return {
          ok: false,
          error: buildError(
            'VALIDATION_ERROR',
            'subtitleLangs must be a comma-separated list of language codes (e.g. en,es).'
          ),
        };
      }
      patch.subtitleLangs = rawValue;
      continue;
    }

    if (rawKey === 'browserChoice') {
      if (!isString(rawValue)) {
        return {
          ok: false,
          error: buildError('VALIDATION_ERROR', 'browserChoice must be a string.'),
        };
      }
      const normalized = rawValue.trim().toLowerCase();
      if (!ALLOWED_BROWSERS.has(normalized)) {
        return {
          ok: false,
          error: buildError('VALIDATION_ERROR', 'browserChoice is not an allowed browser.'),
        };
      }
      patch.browserChoice = normalized;
      continue;
    }

    if (rawKey === 'ffmpegPath') {
      if (!isString(rawValue)) {
        return {
          ok: false,
          error: buildError('VALIDATION_ERROR', 'ffmpegPath must be a string.'),
        };
      }
      if (rawValue.length > 1024) {
        return {
          ok: false,
          error: buildError('VALIDATION_ERROR', 'ffmpegPath exceeds maximum length of 1024.'),
        };
      }
      const ffmpegValidation = validateFfmpegPathValue(rawValue.trim() || undefined);
      if (!ffmpegValidation.ok) {
        return ffmpegValidation;
      }
      patch.ffmpegPath = ffmpegValidation.data || '';
      continue;
    }

    if (rawKey === 'downloadFolder') {
      if (!isString(rawValue)) {
        return {
          ok: false,
          error: buildError('VALIDATION_ERROR', 'downloadFolder must be a string.'),
        };
      }
      if (rawValue.length > 4096) {
        return {
          ok: false,
          error: buildError('VALIDATION_ERROR', 'downloadFolder exceeds maximum length of 4096.'),
        };
      }
      const folderValidation = validateDownloadPath(rawValue);
      if (!folderValidation.ok) {
        return folderValidation;
      }
      patch.downloadFolder = folderValidation.data;
      continue;
    }
  }

  return { ok: true, data: patch };
}

export function validateFileLocationPayload(value: unknown): ValidationResult<string> {
  if (!isString(value) || value.trim() === '') {
    return {
      ok: false,
      error: buildError('INVALID_PATH', 'File path must be a non-empty string.'),
    };
  }
  const trimmed = value.trim();
  if (trimmed.length > 4096) {
    return {
      ok: false,
      error: buildError('INVALID_PATH', 'File path exceeds maximum length.'),
    };
  }
  if (!isAbsolutePath(trimmed)) {
    return {
      ok: false,
      error: buildError('INVALID_PATH', 'File path must be absolute.'),
    };
  }
  const resolved = path.resolve(trimmed);
  if (!isAllowedDownloadBase(resolved)) {
    return {
      ok: false,
      error: buildError('INVALID_PATH', 'File path is outside allowed locations.'),
    };
  }
  return { ok: true, data: path.normalize(resolved) };
}

export function validateNotificationPayload(value: unknown): ValidationResult<NotificationRequest> {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'Notification payload must be an object.'),
    };
  }

  const title = value.title;
  const body = value.body;
  const filePath = value.filePath;

  if (!isOptionalString(title) || !isOptionalString(body) || !isOptionalString(filePath)) {
    return {
      ok: false,
      error: buildError(
        'VALIDATION_ERROR',
        'Notification title, body, and filePath must be strings when provided.'
      ),
    };
  }

  if (
    (title && title.length > 256) ||
    (body && body.length > 1024) ||
    (filePath && filePath.length > 4096)
  ) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'Notification field exceeds maximum length.'),
    };
  }

  let validatedFilePath: string | undefined;
  if (filePath && filePath.trim() !== '') {
    const filePathValidation = validateFileLocationPayload(filePath);
    if (!filePathValidation.ok) {
      return filePathValidation;
    }
    validatedFilePath = filePathValidation.data;
  }

  return {
    ok: true,
    data: {
      title: title?.trim(),
      body: body?.trim(),
      filePath: validatedFilePath,
    },
  };
}
