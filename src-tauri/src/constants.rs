//! Limits and allow-lists shared by validation, settings, and the downloader.

use std::time::Duration;

pub const SPLASH_FADE_DELAY: Duration = Duration::from_millis(800);
pub const SETTINGS_FLUSH_TIMEOUT: Duration = Duration::from_millis(1500);
pub const FORMAT_FETCH_TIMEOUT: Duration = Duration::from_secs(60);
pub const DENO_CHECK_TIMEOUT: Duration = Duration::from_secs(10);
pub const DENO_INSTALL_TIMEOUT: Duration = Duration::from_secs(120);
pub const GPU_DETECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const FFMPEG_CONVERT_TIMEOUT: Duration = Duration::from_secs(600);
pub const CODEC_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_OUTPUT_BUFFER: usize = 500_000;
pub const MAX_ERROR_BUFFER: usize = 100_000;

pub const ALLOWED_AUDIO_FORMATS: &[&str] = &["mp3", "flac", "ogg", "wav", "m4a", "opus"];
pub const ALLOWED_CONVERT_FORMATS: &[&str] = &["mp4", "mov", "mp3", "m4a"];
pub const ALLOWED_BROWSERS: &[&str] = &[
    "brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi", "whale",
];
pub const ALLOWED_GPU_TYPES: &[&str] = &["auto", "nvidia", "amd", "intel"];
pub const ALLOWED_UPDATE_CHANNELS: &[&str] = &["auto", "stable", "beta"];
pub const ALLOWED_THEMES: &[&str] = &["system", "light", "dark", "purple"];
pub const ALLOWED_DOWNLOAD_PROFILES: &[&str] = &["compatible", "best-video", "audio", "custom"];
pub const ALLOWED_DOCK_TABS: &[&str] = &["queue", "activity", "console"];

pub const MAX_QUEUE_SIZE: usize = 500;
pub const MAX_DOWNLOAD_PRESETS: usize = 20;
pub const MAX_PRESET_NAME_LENGTH: usize = 40;
pub const MAX_PRESET_ID_LENGTH: usize = 64;
pub const MAX_PLAYLIST_ITEM_INDEX: u32 = 10_000;
pub const MAX_DOWNLOAD_ACTIVITY: usize = 100;
pub const MAX_FORMAT_COUNTS: usize = 10_000;
pub const MAX_SETTINGS_IMPORT_BYTES: u64 = 1_048_576;
pub const CURRENT_SETTINGS_VERSION: u32 = 7;
/// `schemaVersion` written into queue, activity and stats files.
pub const CURRENT_PERSISTED_SCHEMA_VERSION: u32 = 1;
pub const PLAYLIST_PREVIEW_ENTRY_LIMIT: usize = 500;

pub fn allowed(list: &[&str], value: &str) -> bool {
    list.contains(&value)
}

/// `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
pub fn is_format_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// `^[A-Za-z0-9.*-]+(,[A-Za-z0-9.*-]+)*$`
pub fn is_subtitle_langs(value: &str) -> bool {
    !value.is_empty()
        && value.split(',').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'*' | b'-'))
        })
}

/// `^[A-Za-z0-9][A-Za-z0-9_-]*$`
pub fn is_safe_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
