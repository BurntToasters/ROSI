//! Shared precedence, validation, and snapshot logic for manual and queued
//! downloads.

use crate::ipc::{self, DownloadRequestInput, FalliblePayload, IpcError, IpcResult};
use crate::types::{DownloadProfile, DownloadRequestOptions, GpuType, PlaylistSelection, Settings};
use crate::validation::{validate_download_path, validate_download_request};
use serde_json::{Map, Value};

#[derive(Clone, Debug)]
pub struct ResolvedDownloadOptions {
    pub request: DownloadRequestOptions,
    pub effective_settings: Settings,
}

fn to_map(value: &impl serde::Serialize) -> Map<String, Value> {
    match serde_json::to_value(value) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn apply_request_to_settings(settings: &Settings, options: &DownloadRequestOptions) -> Settings {
    let mut effective = settings.clone();
    // IPC validation admits only known names, so an unknown value cannot reach here.
    if let Some(profile) = options.profile.as_deref().and_then(DownloadProfile::parse) {
        effective.download_mode = profile;
    }
    effective.advanced_options = effective.download_mode == DownloadProfile::Custom;
    effective.audio_only = effective.download_mode == DownloadProfile::Audio;
    effective.best_quality = effective.download_mode == DownloadProfile::BestVideo;
    if let Some(value) = options.advanced_options {
        effective.advanced_options = value;
    }
    if let Some(value) = options.audio_only {
        effective.audio_only = value;
    }
    if let Some(value) = options.best_quality {
        effective.best_quality = value;
    }
    if let Some(value) = &options.audio_output_format {
        effective.audio_format = value.clone();
    }
    if let Some(value) = options.convert_enabled {
        effective.convert_enabled = value;
    }
    if let Some(format) = &options.convert_format {
        if !format.trim().is_empty() {
            effective.convert_format = format.clone();
            if options.convert_enabled.is_none() {
                effective.convert_enabled = true;
            }
        } else if options.convert_enabled.is_none() {
            effective.convert_enabled = false;
        }
    }
    if let Some(value) = options.keep_original {
        effective.keep_original_after_convert = value;
    }
    if let Some(value) = options.hook_browser {
        effective.hook_browser = value;
    }
    if let Some(value) = options
        .browser_choice
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        effective.browser_choice = value.clone();
    }
    if let Some(value) = options.gpu_acceleration {
        effective.gpu_acceleration = value;
    }
    if let Some(value) = options.gpu_type.as_deref().and_then(GpuType::parse) {
        effective.gpu_type = value;
    }
    if let Some(value) = options.write_subtitles {
        effective.write_subtitles = value;
    }
    if let Some(value) = options
        .subtitle_langs
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        effective.subtitle_langs = value.clone();
    }
    if let Some(value) = options.embed_thumbnail {
        effective.embed_thumbnail = value;
    }
    if let Some(value) = options.embed_metadata {
        effective.embed_metadata = value;
    }
    if let Some(value) = options.sponsorblock_remove {
        effective.sponsorblock_remove = value;
    }
    if let Some(value) = &options.ffmpeg_path {
        effective.ffmpeg_path = value.clone();
    }
    effective
}

fn snapshot(options: &DownloadRequestOptions, effective: &Settings) -> DownloadRequestOptions {
    DownloadRequestOptions {
        url: options.url.trim().to_string(),
        output_path: options.output_path.clone(),
        // Keep an empty path in the snapshot too: it means the app default,
        // not "read a possibly changed settings value when replaying".
        ffmpeg_path: Some(effective.ffmpeg_path.clone()),
        convert_enabled: Some(effective.convert_enabled),
        convert_format: Some(effective.convert_format.clone()),
        keep_original: Some(effective.keep_original_after_convert),
        video_format: options.video_format.clone(),
        audio_format: options.audio_format.clone(),
        playlist: Some(options.playlist.clone().unwrap_or(PlaylistSelection {
            mode: "current".into(),
            start: None,
            end: None,
        })),
        profile: Some(effective.download_mode.as_str().to_string()),
        preset_id: options.preset_id.clone(),
        preset_name: options.preset_name.clone(),
        best_quality: Some(effective.best_quality),
        advanced_options: Some(effective.advanced_options),
        audio_only: Some(effective.audio_only),
        audio_output_format: Some(effective.audio_format.clone()),
        hook_browser: Some(effective.hook_browser),
        browser_choice: Some(effective.browser_choice.clone()),
        gpu_acceleration: Some(effective.gpu_acceleration),
        gpu_type: Some(effective.gpu_type.as_str().to_string()),
        write_subtitles: Some(effective.write_subtitles),
        subtitle_langs: Some(effective.subtitle_langs.clone()),
        embed_thumbnail: Some(effective.embed_thumbnail),
        embed_metadata: Some(effective.embed_metadata),
        sponsorblock_remove: Some(effective.sponsorblock_remove),
    }
}

fn finish_resolution(
    options: DownloadRequestOptions,
    effective_settings: Settings,
) -> ResolvedDownloadOptions {
    let request = snapshot(&options, &effective_settings);
    ResolvedDownloadOptions {
        request,
        effective_settings,
    }
}

/// Resolve a request that has already passed `validate_download_request`.
/// Resolve an already validated stored request. No preset is consulted: the
/// stored values are authoritative, and any field the snapshot left absent
/// falls back to current settings only.
pub fn resolve_validated(
    settings: &Settings,
    options: DownloadRequestOptions,
) -> ResolvedDownloadOptions {
    let effective = apply_request_to_settings(settings, &options);
    finish_resolution(options, effective)
}

/// Build a settings-default < preset < explicit-override request and validate
/// it. The returned snapshot is what the download runner and queue store.
pub fn resolve_value(
    settings: &Settings,
    value: &Value,
    forced_url: Option<&str>,
) -> Result<ResolvedDownloadOptions, IpcError> {
    let Some(overrides) = value.as_object() else {
        return validate_download_request(value)
            .map(|request| resolve_validated(settings, request));
    };
    let url_hint = forced_url
        .or_else(|| overrides.get("url").and_then(Value::as_str))
        .unwrap_or_default();
    let mut candidate = to_map(&request_from_settings(url_hint, settings));
    let preset_id = overrides
        .get("presetId")
        .and_then(Value::as_str)
        .map(str::trim);
    if let Some(preset) =
        preset_id.and_then(|id| settings.download_presets.iter().find(|p| p.id == id))
    {
        candidate.extend(crate::settings::preset_to_request_options(preset));
    }
    for (key, value) in overrides {
        if !value.is_null() {
            candidate.insert(key.clone(), value.clone());
        }
    }
    if let Some(url) = forced_url {
        candidate.insert("url".into(), Value::String(url.to_string()));
    }
    let request = validate_download_request(&Value::Object(candidate))?;
    let effective = apply_request_to_settings(settings, &request);
    Ok(finish_resolution(request, effective))
}

fn resolve_output_path(settings: &Settings) -> String {
    let configured = settings.download_folder.trim();
    if !configured.is_empty() {
        if let Ok(path) = validate_download_path(configured) {
            if !path.is_empty() {
                return path;
            }
        }
    }
    crate::app_state::downloads_dir()
        .to_string_lossy()
        .into_owned()
}

/// Settings-derived defaults shared by manual and queued requests. Both paths
/// start here, so the output path and playlist fallbacks cannot diverge.
pub fn request_from_settings(url: &str, settings: &Settings) -> DownloadRequestOptions {
    DownloadRequestOptions {
        url: url.to_string(),
        output_path: resolve_output_path(settings),
        ..DownloadRequestOptions::default()
    }
}

pub fn resolve_queue_request(
    settings: &Settings,
    url: &str,
    overrides: Option<&Map<String, Value>>,
) -> Result<DownloadRequestOptions, IpcError> {
    let value = Value::Object(overrides.cloned().unwrap_or_default());
    resolve_value(settings, &value, Some(url)).map(|resolved| resolved.request)
}

#[tauri::command]
pub fn resolve_download_options(
    options: FalliblePayload<DownloadRequestInput>,
) -> IpcResult<DownloadRequestOptions> {
    let settings = crate::settings::load();
    match resolve_value(&settings, &options.into_value(), None) {
        Ok(resolved) => ipc::ok(resolved.request),
        Err(error) => ipc::from_error(error),
    }
}
