//! Persisted download activity (`download-activity.json`, newest first).

use crate::constants::{MAX_DOWNLOAD_ACTIVITY, MAX_PLAYLIST_ITEM_INDEX};
use crate::ipc::{self, IpcResult, INTERNAL_ERROR};
use crate::types::{DownloadCompletion, DownloadRequestOptions, Outcome, Owner};
use crate::validation::{normalize_queue_url, validate_download_request, validate_file_location};
use serde_json::Value;
use std::sync::{Mutex, OnceLock};

static ACTIVITY: OnceLock<Mutex<Vec<DownloadCompletion>>> = OnceLock::new();
const ACTIVITY_READ_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const MAX_ACTIVITY_DETAIL_PATHS: usize = 16;

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
    let paths = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(MAX_PLAYLIST_ITEM_INDEX as usize)
            .filter_map(|value| validate_file_location(value).ok())
            .collect::<Vec<_>>()
    };
    let output_paths = paths("outputPaths");
    let output_paths = (!output_paths.is_empty()).then_some(output_paths);
    let failed_paths = paths("failedPaths");
    let failed_paths = (!failed_paths.is_empty()).then_some(failed_paths);
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
        output_paths,
        failed_paths,
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
    crate::fs_util::read_json(&activity_path(), ACTIVITY_READ_LIMIT_BYTES as u64)
        .and_then(crate::fs_util::list_items)
        .map(|list| {
            list.iter()
                .filter_map(normalize_record)
                .take(MAX_DOWNLOAD_ACTIVITY)
                .collect()
        })
        .unwrap_or_default()
}

fn state() -> &'static Mutex<Vec<DownloadCompletion>> {
    ACTIVITY.get_or_init(|| Mutex::new(load()))
}

fn encode(entries: &[DownloadCompletion]) -> Result<Vec<u8>, String> {
    crate::fs_util::encode_list(entries)
}

fn compact_paths(paths: &mut Option<Vec<String>>, keep: usize) -> usize {
    let Some(values) = paths else {
        return 0;
    };
    if values.len() <= keep {
        return 0;
    }
    let original_count = values.len();
    let head_count = keep.div_ceil(2);
    let tail_count = keep.saturating_sub(head_count);
    let mut compacted = values[..head_count].to_vec();
    if tail_count > 0 {
        compacted.extend_from_slice(&values[original_count - tail_count..]);
    }
    *values = compacted;
    original_count - keep
}

fn append_activity_detail(entry: &mut DownloadCompletion, summary: &str) {
    fn append_bounded(value: &str, summary: &str, limit: usize) -> String {
        let suffix = format!(" {summary}");
        let suffix_chars = suffix.chars().count().min(limit);
        let prefix: String = value
            .chars()
            .take(limit.saturating_sub(suffix_chars))
            .collect();
        format!("{prefix}{suffix}")
    }

    entry.status_message = append_bounded(&entry.status_message, summary, 2000);
    if let Some(error) = entry.error.as_mut() {
        *error = append_bounded(error, summary, 2000);
    }
}

fn bound_activity(mut entries: Vec<DownloadCompletion>) -> Result<Vec<DownloadCompletion>, String> {
    let encoded = encode(&entries)?;
    if encoded.len() <= ACTIVITY_READ_LIMIT_BYTES {
        return Ok(entries);
    }

    // A single playlist completion can carry thousands of path strings. Only
    // compact records whose own detail cannot fit in the entire file budget;
    // ordinary records retain every path until old records have been trimmed.
    for entry in &mut entries {
        if encode(std::slice::from_ref(entry))?.len() <= ACTIVITY_READ_LIMIT_BYTES {
            continue;
        }
        let omitted_outputs = compact_paths(&mut entry.output_paths, MAX_ACTIVITY_DETAIL_PATHS);
        let omitted_failures = compact_paths(&mut entry.failed_paths, MAX_ACTIVITY_DETAIL_PATHS);
        if omitted_outputs > 0 || omitted_failures > 0 {
            let mut counts = Vec::new();
            if let Some(paths) = &entry.output_paths {
                if omitted_outputs > 0 {
                    counts.push(format!(
                        "output paths: retained {} of {}",
                        paths.len(),
                        paths.len() + omitted_outputs
                    ));
                }
            }
            if let Some(paths) = &entry.failed_paths {
                if omitted_failures > 0 {
                    counts.push(format!(
                        "failed paths: retained {} of {}",
                        paths.len(),
                        paths.len() + omitted_failures
                    ));
                }
            }
            append_activity_detail(
                entry,
                &format!("[Activity detail bounded: {}.]", counts.join("; ")),
            );
        }
    }

    if encode(&entries)?.len() <= ACTIVITY_READ_LIMIT_BYTES {
        return Ok(entries);
    }

    // Activity is newest first. Keep the largest newest prefix whose exact
    // pretty-printed bytes fit the same limit used by the reader.
    let mut low = 0usize;
    let mut high = entries.len();
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        if encode(&entries[..middle])?.len() <= ACTIVITY_READ_LIMIT_BYTES {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    if low == 0 {
        return Err("The newest activity entry exceeds the activity file size limit.".into());
    }
    entries.truncate(low);
    Ok(entries)
}

fn persist(entries: &[DownloadCompletion]) -> Result<Vec<DownloadCompletion>, String> {
    let bounded = bound_activity(entries.to_vec())?;
    let serialized = encode(&bounded)?;
    if serialized.len() > ACTIVITY_READ_LIMIT_BYTES {
        return Err("Download activity exceeds the activity file size limit.".into());
    }
    let path = activity_path();
    crate::fs_util::guard_before_replace(
        &path,
        ACTIVITY_READ_LIMIT_BYTES as u64,
        crate::fs_util::is_list_file,
        |value| crate::fs_util::ensure_schema_not_newer(value, "Download activity"),
    )?;
    crate::fs_util::atomic_write(&path, &serialized)?;
    Ok(bounded)
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
        match persist(&entries) {
            Ok(persisted) => *entries = persisted,
            Err(error) => {
                crate::logging::error(&format!("Failed to persist download activity: {error}"))
            }
        }
        entries.clone()
    };
    crate::app_state::emit("download-activity-update", snapshot);
}

/// Folders that recorded downloads wrote to or targeted, for the startup
/// staging sweep. Callers validate each folder before reading it.
pub fn recorded_output_folders() -> Vec<std::path::PathBuf> {
    let entries = state().lock().unwrap_or_else(|p| p.into_inner());
    let mut folders = Vec::new();
    for entry in entries.iter() {
        folders.push(std::path::PathBuf::from(&entry.request.output_path));
        let files = entry
            .output_path
            .iter()
            .chain(entry.output_paths.iter().flatten())
            .chain(entry.failed_paths.iter().flatten());
        for file in files {
            if let Some(parent) = std::path::Path::new(file).parent() {
                folders.push(parent.to_path_buf());
            }
        }
    }
    folders
}

#[tauri::command(async)]
pub fn get_download_activity() -> IpcResult<Vec<DownloadCompletion>> {
    ipc::ok(state().lock().unwrap_or_else(|p| p.into_inner()).clone())
}

#[tauri::command(async)]
pub fn clear_download_activity() -> IpcResult<()> {
    let mut entries = state().lock().unwrap_or_else(|p| p.into_inner());
    if let Err(error) = persist(&[]) {
        crate::logging::error(&format!("Failed to clear download activity: {error}"));
        return ipc::err(INTERNAL_ERROR, "Failed to clear download activity.");
    }
    entries.clear();
    drop(entries);
    crate::app_state::emit("download-activity-update", Vec::<DownloadCompletion>::new());
    ipc::ok(())
}
