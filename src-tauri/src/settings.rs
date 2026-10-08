//! Settings model, lenient migration from any persisted/imported JSON, and the
//! settings commands (load, save, reset, import, export).

use crate::constants::*;
use crate::ipc::{self, IpcResult, INTERNAL_ERROR};
use crate::types::{DownloadPreset, DownloadRequestOptions, PlaylistSelection, Settings};
use crate::validation::{set_preset_bool, validate_download_path, validate_ffmpeg_path_value};
use serde_json::{Map, Value};
use std::sync::Mutex;
use tauri_plugin_dialog::DialogExt;

static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
const MAX_SETTINGS_FILE_BYTES: u64 = 2 * 1024 * 1024;

pub fn default_settings() -> Settings {
    Settings {
        settings_version: CURRENT_SETTINGS_VERSION,
        theme: "system".into(),
        show_console_output: false,
        dock_tab: "queue".into(),
        dock_collapsed: false,
        download_mode: "compatible".into(),
        download_presets: Vec::new(),
        ask_download_location: false,
        advanced_options: false,
        audio_only: false,
        audio_format: "mp3".into(),
        convert_enabled: false,
        convert_format: "mp4".into(),
        keep_original_after_convert: true,
        first_launch: true,
        hook_browser: false,
        browser_choice: "chrome".into(),
        animate_background: true,
        flat_ui: false,
        notifications: true,
        deno_reminder_dismissed: false,
        gpu_acceleration: false,
        gpu_type: "auto".into(),
        best_quality: false,
        ffmpeg_path: String::new(),
        download_folder: String::new(),
        hide_support_modal: false,
        check_updates_on_startup: true,
        update_channel: "auto".into(),
        write_subtitles: false,
        subtitle_langs: "en".into(),
        embed_thumbnail: false,
        embed_metadata: false,
        sponsorblock_remove: false,
        show_taskbar_progress: true,
    }
}

fn settings_path() -> std::path::PathBuf {
    crate::app_state::data_dir().join("settings.json")
}

fn read_bool(raw: &Map<String, Value>, key: &str, fallback: bool) -> bool {
    raw.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

fn read_choice(raw: &Map<String, Value>, key: &str, list: &[&str], fallback: &str) -> String {
    raw.get(key)
        .and_then(Value::as_str)
        .filter(|value| allowed(list, value))
        .unwrap_or(fallback)
        .to_string()
}

fn read_subtitle_langs(raw: &Map<String, Value>, fallback: &str) -> String {
    let Some(value) = raw.get("subtitleLangs").and_then(Value::as_str) else {
        return fallback.to_string();
    };
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 256 || !is_subtitle_langs(trimmed) {
        return fallback.to_string();
    }
    trimmed.to_string()
}

fn truncate_chars(value: &str, max: usize) -> &str {
    match value.char_indices().nth(max) {
        Some((index, _)) => &value[..index],
        None => value,
    }
}

fn read_browser_choice(raw: &Map<String, Value>, fallback: &str) -> String {
    let value = raw
        .get("browserChoice")
        .and_then(Value::as_str)
        .unwrap_or(fallback);
    let normalized = truncate_chars(value, 64).trim().to_lowercase();
    if allowed(ALLOWED_BROWSERS, &normalized) {
        normalized
    } else {
        fallback.to_string()
    }
}

fn read_ffmpeg_path(raw: &Map<String, Value>) -> String {
    let value = raw.get("ffmpegPath").and_then(Value::as_str).unwrap_or("");
    let capped = truncate_chars(value, 1024).trim();
    if capped.is_empty() {
        return String::new();
    }
    validate_ffmpeg_path_value(Some(capped))
        .ok()
        .flatten()
        .unwrap_or_default()
}

fn read_download_folder(raw: &Map<String, Value>) -> String {
    let value = raw
        .get("downloadFolder")
        .and_then(Value::as_str)
        .unwrap_or("");
    let capped = truncate_chars(value, 4096);
    if capped.trim().is_empty() {
        return String::new();
    }
    validate_download_path(capped).unwrap_or_default()
}

fn read_settings_version(raw: &Map<String, Value>) -> u32 {
    raw.get("settingsVersion")
        .and_then(Value::as_f64)
        .filter(|version| {
            version.fract() == 0.0
                && *version >= 1.0
                && *version <= f64::from(CURRENT_SETTINGS_VERSION)
        })
        .map(|version| version as u32)
        .unwrap_or(CURRENT_SETTINGS_VERSION)
}

fn infer_download_mode(raw: &Map<String, Value>) -> &'static str {
    if raw.get("audioOnly").and_then(Value::as_bool) == Some(true) {
        "audio"
    } else if raw.get("advancedOptions").and_then(Value::as_bool) == Some(true) {
        "custom"
    } else {
        "compatible"
    }
}

/// Earlier builds hid profiles behind `downloadProfilesEnabled`; with it off,
/// downloads used the compatible format whatever `downloadMode` said.
fn read_download_mode(raw: &Map<String, Value>) -> String {
    if raw.get("downloadProfilesEnabled").and_then(Value::as_bool) == Some(false) {
        return "compatible".into();
    }
    read_choice(
        raw,
        "downloadMode",
        ALLOWED_DOWNLOAD_PROFILES,
        infer_download_mode(raw),
    )
}

fn sanitize_preset_name(
    raw: Option<&Value>,
    index: usize,
    used: &mut std::collections::HashSet<String>,
) -> String {
    let fallback = format!("Preset {}", index + 1);
    let base = raw
        .and_then(Value::as_str)
        .map(|name| name.split_whitespace().collect::<Vec<_>>().join(" "))
        .map(|name| truncate_chars(&name, MAX_PRESET_NAME_LENGTH).to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback);
    let mut candidate = base.clone();
    let mut suffix = 2;
    while used.contains(&candidate.to_lowercase()) {
        let marker = format!(" ({suffix})");
        let keep = MAX_PRESET_NAME_LENGTH
            .saturating_sub(marker.chars().count())
            .max(1);
        candidate = format!("{}{marker}", truncate_chars(&base, keep));
        suffix += 1;
    }
    used.insert(candidate.to_lowercase());
    candidate
}

fn sanitize_preset_id(
    raw: Option<&Value>,
    name: &str,
    index: usize,
    used: &mut std::collections::HashSet<String>,
) -> String {
    let provided = raw.and_then(Value::as_str).map(str::trim).unwrap_or("");
    let mut slug = String::new();
    for ch in name.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            slug.push(ch);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    let fallback = if slug.is_empty() {
        format!("preset-{}", index + 1)
    } else {
        format!("preset-{}-{slug}", index + 1)
    };
    let base = if !provided.is_empty()
        && provided.len() <= MAX_PRESET_ID_LENGTH
        && is_safe_identifier(provided)
    {
        provided.to_string()
    } else {
        truncate_chars(&fallback, MAX_PRESET_ID_LENGTH).to_string()
    };
    let mut candidate = base.clone();
    let mut suffix = 2;
    while used.contains(&candidate) {
        let marker = format!("-{suffix}");
        let keep = MAX_PRESET_ID_LENGTH.saturating_sub(marker.len()).max(1);
        candidate = format!("{}{marker}", truncate_chars(&base, keep));
        suffix += 1;
    }
    used.insert(candidate.clone());
    candidate
}

fn sanitize_preset_playlist(value: Option<&Value>) -> Option<PlaylistSelection> {
    let object = value?.as_object()?;
    match object.get("mode").and_then(Value::as_str)? {
        mode @ ("current" | "all") => Some(PlaylistSelection {
            mode: mode.to_string(),
            start: None,
            end: None,
        }),
        "range" => {
            let integer = |key: &str| {
                object
                    .get(key)
                    .and_then(Value::as_f64)
                    .filter(|value| value.fract() == 0.0)
            };
            let (start, end) = (integer("start")?, integer("end")?);
            (start >= 1.0 && end >= start && end <= f64::from(MAX_PLAYLIST_ITEM_INDEX)).then(|| {
                PlaylistSelection {
                    mode: "range".into(),
                    start: Some(start as u32),
                    end: Some(end as u32),
                }
            })
        }
        _ => None,
    }
}

pub fn sanitize_download_presets(value: Option<&Value>) -> Vec<DownloadPreset> {
    let Some(list) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut presets = Vec::new();
    let mut used_ids = std::collections::HashSet::new();
    let mut used_names = std::collections::HashSet::new();
    for (index, raw) in list.iter().take(MAX_DOWNLOAD_PRESETS).enumerate() {
        let Some(object) = raw.as_object() else {
            continue;
        };
        let name = sanitize_preset_name(object.get("name"), index, &mut used_names);
        let id = sanitize_preset_id(object.get("id"), &name, index, &mut used_ids);
        let profile = object
            .get("profile")
            .and_then(Value::as_str)
            .filter(|value| allowed(ALLOWED_DOWNLOAD_PROFILES, value))
            .unwrap_or("best-video")
            .to_string();
        let mut preset = DownloadPreset {
            id,
            name,
            profile,
            ..DownloadPreset::default()
        };
        for key in crate::validation::preset_boolean_fields() {
            if let Some(flag) = object.get(*key).and_then(Value::as_bool) {
                set_preset_bool(&mut preset, key, flag);
            }
        }
        let string = |key: &str| object.get(key).and_then(Value::as_str);
        preset.audio_format = string("audioFormat")
            .filter(|value| allowed(ALLOWED_AUDIO_FORMATS, value))
            .map(str::to_string);
        preset.video_format = string("videoFormat")
            .map(str::trim)
            .filter(|value| is_format_id(value))
            .map(str::to_string);
        preset.audio_format_id = string("audioFormatId")
            .map(str::trim)
            .filter(|value| is_format_id(value))
            .map(str::to_string);
        preset.convert_format = string("convertFormat")
            .filter(|value| allowed(ALLOWED_CONVERT_FORMATS, value))
            .map(str::to_string);
        preset.gpu_type = string("gpuType")
            .filter(|value| allowed(ALLOWED_GPU_TYPES, value))
            .map(str::to_string);
        preset.subtitle_langs = string("subtitleLangs")
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= 256 && is_subtitle_langs(value))
            .map(str::to_string);
        preset.playlist = sanitize_preset_playlist(object.get("playlist"));
        presets.push(preset);
    }
    presets
}

/// Map a saved preset onto request overrides. Unset preset fields stay unset
/// so request/on-screen values keep precedence.
pub fn preset_to_request_options(preset: &DownloadPreset) -> Map<String, Value> {
    let options = DownloadRequestOptions {
        profile: Some(preset.profile.clone()),
        preset_id: Some(preset.id.clone()),
        preset_name: Some(preset.name.clone()),
        best_quality: Some(
            preset
                .best_quality
                .unwrap_or(preset.profile == "best-video"),
        ),
        advanced_options: Some(preset.profile == "custom"),
        audio_only: Some(preset.audio_only.unwrap_or(preset.profile == "audio")),
        audio_output_format: preset.audio_format.clone(),
        video_format: preset.video_format.clone(),
        audio_format: preset.audio_format_id.clone(),
        convert_enabled: preset.convert_enabled,
        convert_format: preset.convert_format.clone(),
        keep_original: preset.keep_original_after_convert,
        gpu_acceleration: preset.gpu_acceleration,
        gpu_type: preset.gpu_type.clone(),
        write_subtitles: preset.write_subtitles,
        subtitle_langs: preset.subtitle_langs.clone(),
        embed_thumbnail: preset.embed_thumbnail,
        embed_metadata: preset.embed_metadata,
        sponsorblock_remove: preset.sponsorblock_remove,
        playlist: preset.playlist.clone(),
        ..DownloadRequestOptions::default()
    };
    let mut map = match serde_json::to_value(options) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    // url/outputPath are request-only and always come from the caller.
    map.remove("url");
    map.remove("outputPath");
    map
}

/// Coerce any JSON value into a valid, current-schema settings object.
pub fn migrate_settings(raw: &Value) -> Settings {
    let defaults = default_settings();
    let Some(raw) = raw.as_object() else {
        return defaults;
    };
    let download_mode = read_download_mode(raw);
    let (advanced_options, audio_only, best_quality) = (
        download_mode == "custom",
        download_mode == "audio",
        download_mode == "best-video",
    );
    Settings {
        settings_version: read_settings_version(raw),
        theme: read_choice(raw, "theme", ALLOWED_THEMES, &defaults.theme),
        show_console_output: read_bool(raw, "showConsoleOutput", defaults.show_console_output),
        dock_tab: read_choice(raw, "dockTab", ALLOWED_DOCK_TABS, &defaults.dock_tab),
        dock_collapsed: read_bool(raw, "dockCollapsed", defaults.dock_collapsed),
        download_mode,
        download_presets: sanitize_download_presets(raw.get("downloadPresets")),
        ask_download_location: read_bool(
            raw,
            "askDownloadLocation",
            defaults.ask_download_location,
        ),
        advanced_options,
        audio_only,
        audio_format: read_choice(
            raw,
            "audioFormat",
            ALLOWED_AUDIO_FORMATS,
            &defaults.audio_format,
        ),
        convert_enabled: read_bool(raw, "convertEnabled", defaults.convert_enabled),
        convert_format: read_choice(
            raw,
            "convertFormat",
            ALLOWED_CONVERT_FORMATS,
            &defaults.convert_format,
        ),
        keep_original_after_convert: read_bool(
            raw,
            "keepOriginalAfterConvert",
            defaults.keep_original_after_convert,
        ),
        first_launch: read_bool(raw, "firstLaunch", defaults.first_launch),
        hook_browser: read_bool(raw, "hookBrowser", defaults.hook_browser),
        browser_choice: read_browser_choice(raw, &defaults.browser_choice),
        animate_background: read_bool(raw, "animateBackground", defaults.animate_background),
        flat_ui: read_bool(raw, "flatUi", defaults.flat_ui),
        notifications: read_bool(raw, "notifications", defaults.notifications),
        deno_reminder_dismissed: read_bool(
            raw,
            "denoReminderDismissed",
            defaults.deno_reminder_dismissed,
        ),
        gpu_acceleration: read_bool(raw, "gpuAcceleration", defaults.gpu_acceleration),
        gpu_type: read_choice(raw, "gpuType", ALLOWED_GPU_TYPES, &defaults.gpu_type),
        best_quality,
        ffmpeg_path: read_ffmpeg_path(raw),
        download_folder: read_download_folder(raw),
        hide_support_modal: read_bool(raw, "hideSupportModal", defaults.hide_support_modal),
        check_updates_on_startup: read_bool(
            raw,
            "checkUpdatesOnStartup",
            defaults.check_updates_on_startup,
        ),
        update_channel: read_choice(
            raw,
            "updateChannel",
            ALLOWED_UPDATE_CHANNELS,
            &defaults.update_channel,
        ),
        write_subtitles: read_bool(raw, "writeSubtitles", defaults.write_subtitles),
        subtitle_langs: read_subtitle_langs(raw, &defaults.subtitle_langs),
        embed_thumbnail: read_bool(raw, "embedThumbnail", defaults.embed_thumbnail),
        embed_metadata: read_bool(raw, "embedMetadata", defaults.embed_metadata),
        sponsorblock_remove: read_bool(raw, "sponsorblockRemove", defaults.sponsorblock_remove),
        show_taskbar_progress: read_bool(
            raw,
            "showTaskbarProgress",
            defaults.show_taskbar_progress,
        ),
    }
}

fn normalized(mut settings: Settings) -> Settings {
    settings.settings_version = CURRENT_SETTINGS_VERSION;
    settings
}

fn load_unlocked() -> Settings {
    match crate::fs_util::read_json(&settings_path(), MAX_SETTINGS_FILE_BYTES) {
        Some(value) => normalized(migrate_settings(&value)),
        None => default_settings(),
    }
}

pub fn load() -> Settings {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    load_unlocked()
}

fn write_unlocked(settings: &Settings) -> Result<(), String> {
    protect_existing_settings()?;
    crate::fs_util::write_json(&settings_path(), settings)
}

fn check_schema(value: &Value) -> Result<(), String> {
    if value
        .get("settingsVersion")
        .and_then(Value::as_f64)
        .is_some_and(|version| version > f64::from(CURRENT_SETTINGS_VERSION))
    {
        return Err("These settings belong to a newer ROSI version. Reopen that version to change settings; this version will preserve the original file.".into());
    }
    Ok(())
}

/// Preserve damaged bytes before a defaults-based save, and never downgrade
/// a newer schema or replace settings that cannot be read safely.
fn protect_existing_settings() -> Result<(), String> {
    crate::fs_util::guard_before_replace(
        &settings_path(),
        MAX_SETTINGS_FILE_BYTES,
        Value::is_object,
        check_schema,
    )
}

/// Merge a validated patch into the persisted settings.
pub fn save_patch(patch: &Map<String, Value>) -> Result<Settings, String> {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let existing = load_unlocked();
    let mut merged = match serde_json::to_value(&existing) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    for (key, value) in patch {
        merged.insert(key.clone(), value.clone());
    }
    let complete = normalized(migrate_settings(&Value::Object(merged)));
    if complete.ffmpeg_path != existing.ffmpeg_path
        || complete.gpu_acceleration != existing.gpu_acceleration
    {
        crate::gpu::clear_cache();
    }
    write_unlocked(&complete)?;
    Ok(complete)
}

pub fn save_all(settings: &Settings) -> Result<(), String> {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    write_unlocked(settings)
}

/// Validate a ROSI 4 settings object and save it as the ROSI 5 settings.
pub fn import_legacy(raw: &Value) -> Result<(), String> {
    check_schema(raw)?;
    save_all(&normalized(migrate_settings(raw)))
}

fn show_save_error(message: &str) {
    if let Some(app) = crate::app_state::app() {
        app.dialog()
            .message(format!("Failed to save settings: {message}"))
            .title("Settings Save Error")
            .kind(tauri_plugin_dialog::MessageDialogKind::Error)
            .show(|_| {});
    }
}

#[tauri::command(async)]
pub fn get_settings() -> Settings {
    static REPORTED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    let path = settings_path();
    let problem = match crate::fs_util::read_bounded(&path, MAX_SETTINGS_FILE_BYTES) {
        Ok(Some(raw)) => match serde_json::from_str::<Value>(&raw) {
            Ok(value @ Value::Object(_)) => check_schema(&value).err(),
            _ => Some("Your settings file is damaged. ROSI is showing defaults and will preserve a recovery copy before saving changes.".to_string()),
        },
        Ok(None) => None,
        Err(error) => Some(format!(
            "ROSI could not read your settings file at {}: {error}. ROSI is showing defaults and will not overwrite it. Check that the file is readable and no larger than 2 MB, fix or move it, then restart ROSI.",
            path.display()
        )),
    }
    .or_else(crate::legacy::recovery_message);
    if let Some(message) = problem {
        REPORTED.get_or_init(|| {
            crate::logging::warn(&message);
            if let Some(app) = crate::app_state::app() {
                app.dialog()
                    .message(message)
                    .title("ROSI Profile Recovery")
                    .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
                    .show(|_| {});
            }
        });
    }
    load()
}

#[tauri::command(async)]
pub fn get_default_settings() -> IpcResult<Settings> {
    ipc::ok(default_settings())
}

#[tauri::command(async)]
pub fn save_settings(settings: Value) -> IpcResult<Settings> {
    let patch = match crate::validation::validate_settings_patch(&settings) {
        Ok(patch) => patch,
        Err(error) => return ipc::from_error(error),
    };
    match save_patch(&patch) {
        Ok(saved) => ipc::ok(saved),
        Err(error) => {
            crate::logging::error(&format!("Failed to save settings: {error}"));
            show_save_error(&error);
            ipc::err(INTERNAL_ERROR, error)
        }
    }
}

#[tauri::command(async)]
pub fn reset_settings(app: tauri::AppHandle) -> Result<(), String> {
    let defaults = default_settings();
    crate::window::restart_with(&app, || save_all(&defaults))
}

#[derive(serde::Serialize)]
pub struct Exported {
    exported: bool,
}

#[derive(serde::Serialize)]
pub struct Imported {
    imported: bool,
}

#[tauri::command]
pub async fn export_settings(app: tauri::AppHandle) -> IpcResult<Exported> {
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .set_title("Export Settings")
            .set_file_name("rosi-settings.json")
            .add_filter("JSON", &["json"]);
        if let Some(window) = crate::app_state::main_window() {
            dialog = dialog.set_parent(&window);
        }
        let Some(path) = dialog.blocking_save_file() else {
            return Err("Export cancelled or failed.".to_string());
        };
        let path = path.into_path().map_err(|error| error.to_string())?;
        crate::fs_util::write_json(&path, &load())
    })
    .await;
    match outcome {
        Ok(Ok(())) => ipc::ok(Exported { exported: true }),
        Ok(Err(message)) => {
            if message != "Export cancelled or failed." {
                crate::logging::error(&format!("Failed to export settings: {message}"));
            }
            ipc::err(INTERNAL_ERROR, "Export cancelled or failed.")
        }
        Err(error) => {
            crate::logging::error(&format!("Export settings worker failed: {error}"));
            ipc::err(INTERNAL_ERROR, "Failed to export settings.")
        }
    }
}

#[tauri::command]
pub async fn import_settings(app: tauri::AppHandle) -> IpcResult<Imported> {
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .set_title("Import Settings")
            .add_filter("JSON", &["json"]);
        if let Some(window) = crate::app_state::main_window() {
            dialog = dialog.set_parent(&window);
        }
        let path = dialog
            .blocking_pick_file()
            .ok_or_else(|| "cancelled".to_string())?
            .into_path()
            .map_err(|error| error.to_string())?;
        let raw = crate::fs_util::read_bounded(&path, MAX_SETTINGS_IMPORT_BYTES)?
            .ok_or_else(|| "Import file disappeared.".to_string())?;
        let parsed: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        if !parsed.is_object() {
            return Err("Imported settings file has invalid structure.".to_string());
        }
        check_schema(&parsed)?;
        let migrated = normalized(migrate_settings(&parsed));
        save_all(&migrated)?;
        crate::gpu::clear_cache();
        Ok(migrated)
    })
    .await;
    match outcome {
        Ok(Ok(settings)) => {
            crate::app_state::emit("settings-imported", settings);
            ipc::ok(Imported { imported: true })
        }
        Ok(Err(message)) => {
            if message != "cancelled" {
                crate::logging::warn(&format!("Failed to import settings: {message}"));
            }
            ipc::err(INTERNAL_ERROR, "Import cancelled or failed.")
        }
        Err(error) => {
            crate::logging::error(&format!("Import settings worker failed: {error}"));
            ipc::err(INTERNAL_ERROR, "Failed to import settings.")
        }
    }
}
