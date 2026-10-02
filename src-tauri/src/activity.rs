//! Persisted download activity (`download-activity.json`, newest first).

use crate::constants::MAX_DOWNLOAD_ACTIVITY;
use crate::ipc::{self, IpcResult, INTERNAL_ERROR};
use crate::types::{DownloadCompletion, DownloadRequestOptions, Outcome, Owner};
use crate::validation::{normalize_queue_url, validate_download_request, validate_file_location};
use serde_json::Value;
use std::sync::{Mutex, OnceLock};

static ACTIVITY: OnceLock<Mutex<Vec<DownloadCompletion>>> = OnceLock::new();

fn activity_path() -> std::path::PathBuf {
    crate::app_state::data_dir().join("download-activity.json")
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Re-validate a stored request snapshot, optionally forcing the URL. A stale
/// custom FFmpeg path is dropped rather than discarding the whole request.
pub fn normalize_stored_request(
    value: Option<&Value>,
    authoritative_url: Option<&str>,
) -> Option<DownloadRequestOptions> {
    let mut candidate = value?.as_object()?.clone();
    if let Some(url) = authoritative_url {
        candidate.insert("url".into(), Value::String(url.to_string()));
    }
    let had_ffmpeg = candidate.get("ffmpegPath").is_some_and(|v| !v.is_null());
    match validate_download_request(&Value::Object(candidate.clone())) {
        Ok(request) => Some(request),
        Err(_) if had_ffmpeg => {
            candidate.remove("ffmpegPath");
            validate_download_request(&Value::Object(candidate)).ok()
        }
        Err(_) => None,
    }
}

fn positive_ms(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n as u64)
}

pub fn normalize_record(value: &Value) -> Option<DownloadCompletion> {
    let object = value.as_object()?;
    let id = object.get("id").and_then(Value::as_str)?.trim().to_string();
    if id.is_empty() || id.len() > 128 {
        return None;
    }
    let outcome = Outcome::parse(object.get("outcome").and_then(Value::as_str)?)?;
    let owner = match object.get("owner").and_then(Value::as_str)? {
        "manual" => Owner::Manual,
        "queue" => Owner::Queue,
        _ => return None,
    };
    let url = normalize_queue_url(object.get("url").and_then(Value::as_str)?)?;
    let request = normalize_stored_request(object.get("request"), Some(&url))?;
    let now = crate::app_state::now_ms();
    let started_at = positive_ms(object.get("startedAt")).unwrap_or(now);
    let completed_at = positive_ms(object.get("completedAt"))
        .filter(|completed| *completed >= started_at)
        .unwrap_or(started_at);
    let status_message = object
        .get("statusMessage")
        .and_then(Value::as_str)
        .map(|message| truncate(message, 2000))
        .unwrap_or_else(|| {
            match outcome {
                Outcome::Success => "Download completed.",
                Outcome::Cancelled => "Download cancelled.",
                Outcome::Failed => "Download failed.",
            }
            .to_string()
        });
    let output_path = object
        .get("outputPath")
        .filter(|value| value.is_string())
        .and_then(|value| validate_file_location(value).ok());
    let filename = object
        .get("filename")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| truncate(name, 1024))
        .or_else(|| {
            output_path.as_ref().and_then(|path| {
                std::path::Path::new(path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            })
        });
    let string = |key: &str, max: usize| {
        object
            .get(key)
            .and_then(Value::as_str)
            .map(|value| truncate(value, max))
    };
    let profile = object
        .get("profile")
        .and_then(Value::as_str)
        .filter(|profile| matches!(*profile, "compatible" | "best-video" | "audio" | "custom"))
        .map(str::to_string)
        .or_else(|| request.profile.clone());
    let error = match outcome {
        Outcome::Failed => Some(string("error", 2000).unwrap_or_else(|| status_message.clone())),
        _ => None,
    };
    Some(DownloadCompletion {
        id,
        session_id: object.get("sessionId").and_then(Value::as_u64),
        owner,
        queue_item_id: string("queueItemId", 128),
        outcome,
        status_message,
        url,
        profile,
        preset_id: string("presetId", 64).or_else(|| request.preset_id.clone()),
        preset_name: string("presetName", 40).or_else(|| request.preset_name.clone()),
        request,
        filename,
        output_path,
        size_bytes: object
            .get("sizeBytes")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map(|n| n as u64),
        format: object
            .get("format")
            .and_then(Value::as_str)
            .filter(|format| format.len() <= 32)
            .map(str::to_string),
        error,
        started_at,
        completed_at,
    })
}

fn load() -> Vec<DownloadCompletion> {
    match crate::fs_util::read_json(&activity_path(), 16 * 1024 * 1024) {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(normalize_record)
            .take(MAX_DOWNLOAD_ACTIVITY)
            .collect(),
        _ => Vec::new(),
    }
}

fn state() -> &'static Mutex<Vec<DownloadCompletion>> {
    ACTIVITY.get_or_init(|| Mutex::new(load()))
}

fn persist(entries: &[DownloadCompletion]) -> bool {
    match crate::fs_util::write_json(&activity_path(), &entries) {
        Ok(()) => true,
        Err(error) => {
            crate::logging::error(&format!("Failed to persist download activity: {error}"));
            false
        }
    }
}

pub fn record(completion: &DownloadCompletion) {
    let snapshot = {
        let mut entries = state().lock().unwrap_or_else(|p| p.into_inner());
        if entries.iter().any(|entry| entry.id == completion.id) {
            return;
        }
        let Some(normalized) = serde_json::to_value(completion)
            .ok()
            .as_ref()
            .and_then(normalize_record)
        else {
            crate::logging::warn("Ignoring invalid structured download completion metadata.");
            return;
        };
        entries.insert(0, normalized);
        entries.truncate(MAX_DOWNLOAD_ACTIVITY);
        persist(&entries);
        entries.clone()
    };
    crate::app_state::emit("download-activity-update", snapshot);
}

#[tauri::command(async)]
pub fn get_download_activity() -> IpcResult<Vec<DownloadCompletion>> {
    ipc::ok(state().lock().unwrap_or_else(|p| p.into_inner()).clone())
}

#[tauri::command(async)]
pub fn clear_download_activity() -> IpcResult<()> {
    let mut entries = state().lock().unwrap_or_else(|p| p.into_inner());
    entries.clear();
    if !persist(&entries) {
        return ipc::err(INTERNAL_ERROR, "Failed to clear download activity.");
    }
    drop(entries);
    crate::app_state::emit("download-activity-update", Vec::<DownloadCompletion>::new());
    ipc::ok(())
}
