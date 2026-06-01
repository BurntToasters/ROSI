import type {
  DownloadRequestOptions,
  IpcErrorCode,
  IpcErrorPayload,
  IpcResult,
  NotificationRequest,
  Settings,
} from '../types';
import { isSafeExternalUrl, isSafeHttpUrl } from './validation';
import {
  ALLOWED_AUDIO_FORMATS,
  ALLOWED_CONVERT_FORMATS,
  CURRENT_SETTINGS_VERSION,
  FORMAT_ID_PATTERN,
} from '../main/constants';

const ALLOWED_GPU_TYPES = new Set(['auto', 'nvidia', 'amd', 'intel']);
const ALLOWED_UPDATE_CHANNELS = new Set(['auto', 'stable', 'beta']);
const ALLOWED_THEMES = new Set(['system', 'light', 'dark', 'purple']);

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

export function validateDownloadRequestPayload(
  value: unknown
): ValidationResult<DownloadRequestOptions> {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'Download payload must be an object.'),
    };
  }

  const { url, outputPath, ffmpegPath, convertFormat, keepOriginal, videoFormat, audioFormat } =
    value;

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

  if (!isOptionalString(ffmpegPath)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'ffmpegPath must be a string when provided.'),
    };
  }
  if (!isOptionalString(convertFormat)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'convertFormat must be a string when provided.'),
    };
  }
  const normalizedConvertFormat = convertFormat?.trim() || undefined;
  if (
    normalizedConvertFormat !== undefined &&
    !ALLOWED_CONVERT_FORMATS.has(normalizedConvertFormat)
  ) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'convertFormat must be one of: mp4, mov, mp3, m4a.'),
    };
  }
  if (keepOriginal !== undefined && !isBoolean(keepOriginal)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'keepOriginal must be a boolean when provided.'),
    };
  }
  if (!isOptionalString(videoFormat)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'videoFormat must be a string when provided.'),
    };
  }
  if (videoFormat !== undefined && !FORMAT_ID_PATTERN.test(videoFormat.trim())) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'videoFormat must be a valid yt-dlp format ID.'),
    };
  }
  if (!isOptionalString(audioFormat)) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'audioFormat must be a string when provided.'),
    };
  }
  if (audioFormat !== undefined && !FORMAT_ID_PATTERN.test(audioFormat.trim())) {
    return {
      ok: false,
      error: buildError('VALIDATION_ERROR', 'audioFormat must be a valid yt-dlp format ID.'),
    };
  }

  return {
    ok: true,
    data: {
      url: url.trim(),
      outputPath: outputPath.trim(),
      ffmpegPath: ffmpegPath?.trim() || undefined,
      convertFormat: normalizedConvertFormat,
      keepOriginal,
      videoFormat: videoFormat?.trim() || undefined,
      audioFormat: audioFormat?.trim() || undefined,
    },
  };
}

function isValidSettingsKey(key: string): key is keyof Settings {
  return (
    key === 'settingsVersion' ||
    key === 'theme' ||
    key === 'showConsoleOutput' ||
    key === 'consoleCollapsed' ||
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
    key === 'notifications' ||
    key === 'denoReminderDismissed' ||
    key === 'gpuAcceleration' ||
    key === 'gpuType' ||
    key === 'bestQuality' ||
    key === 'ffmpegPath' ||
    key === 'hideSupportModal' ||
    key === 'checkUpdatesOnStartup' ||
    key === 'updateChannel'
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

    if (
      rawKey === 'showConsoleOutput' ||
      rawKey === 'consoleCollapsed' ||
      rawKey === 'advancedOptions' ||
      rawKey === 'audioOnly' ||
      rawKey === 'convertEnabled' ||
      rawKey === 'keepOriginalAfterConvert' ||
      rawKey === 'firstLaunch' ||
      rawKey === 'hookBrowser' ||
      rawKey === 'animateBackground' ||
      rawKey === 'notifications' ||
      rawKey === 'denoReminderDismissed' ||
      rawKey === 'gpuAcceleration' ||
      rawKey === 'bestQuality' ||
      rawKey === 'hideSupportModal' ||
      rawKey === 'checkUpdatesOnStartup'
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

    if (!isString(rawValue)) {
      return {
        ok: false,
        error: buildError('VALIDATION_ERROR', `${rawKey} must be a string.`),
      };
    }
    if (rawValue.length > 1024) {
      return {
        ok: false,
        error: buildError('VALIDATION_ERROR', `${rawKey} exceeds maximum length of 1024.`),
      };
    }
    patch[rawKey] = rawValue;
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
  if (!/^(\/|[A-Za-z]:\\)/.test(trimmed)) {
    return {
      ok: false,
      error: buildError('INVALID_PATH', 'File path must be absolute.'),
    };
  }
  return { ok: true, data: trimmed };
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

  return {
    ok: true,
    data: {
      title: title?.trim(),
      body: body?.trim(),
      filePath: filePath?.trim(),
    },
  };
}
