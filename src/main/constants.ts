export const SPLASH_SHOW_DELAY_MS = 300;
export const SPLASH_FADE_DELAY_MS = 800;
export const FORMAT_FETCH_TIMEOUT_MS = 60_000;
export const DENO_CHECK_TIMEOUT_MS = 10_000;
export const DENO_INSTALL_TIMEOUT_MS = 120_000;
export const GPU_DETECT_TIMEOUT_MS = 10_000;
export const FFMPEG_CONVERT_TIMEOUT_MS = 600_000;
export const MAX_OUTPUT_BUFFER = 500_000;
export const MAX_ERROR_BUFFER = 100_000;

export const FORMAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SUBTITLE_LANGS_PATTERN = /^[A-Za-z0-9.*-]+(,[A-Za-z0-9.*-]+)*$/;

export const ALLOWED_AUDIO_FORMATS = new Set(['mp3', 'flac', 'ogg', 'wav', 'm4a', 'opus']);
export const ALLOWED_CONVERT_FORMATS = new Set(['mp4', 'mov', 'mp3', 'm4a']);
export const ALLOWED_BROWSERS = new Set([
  'brave',
  'chrome',
  'chromium',
  'edge',
  'firefox',
  'opera',
  'safari',
  'vivaldi',
  'whale',
]);
export const MAX_QUEUE_SIZE = 500;
export const MAX_FORMAT_COUNTS = 10_000;
export const MAX_SETTINGS_IMPORT_BYTES = 1_048_576;
export const CURRENT_SETTINGS_VERSION = 6;
