//! Lifetime download statistics (`download-stats.json`).

use crate::constants::{CURRENT_PERSISTED_SCHEMA_VERSION, MAX_FORMAT_COUNTS};
use crate::ipc::{self, IpcResult, INTERNAL_ERROR};
use crate::types::{DownloadStats, Outcome};
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

const MAX_STATS_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsFile<'a> {
    schema_version: u32,
    #[serde(flatten)]
    stats: &'a DownloadStats,
}

static STATS_LOCK: Mutex<()> = Mutex::new(());

fn stats_path() -> std::path::PathBuf {
    crate::app_state::data_dir().join("download-stats.json")
}

fn number(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| n as u64)
}

/// Loads the stats file. A missing file is zero counters. An unreadable or
/// unparsable file is an error, so callers never treat it as zero and save over it.
fn load_checked() -> Result<DownloadStats, String> {
    let raw = match crate::fs_util::read_bounded(&stats_path(), MAX_STATS_FILE_BYTES)? {
        Some(raw) => raw,
        None => return Ok(DownloadStats::default()),
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(raw)) => Ok(parse_stats(&raw)),
        Ok(_) => Err("the file is not a JSON object".to_string()),
        Err(error) => Err(format!("the file could not be parsed: {error}")),
    }
}

/// Counters for display. A failed load shows zeros but never reaches a save.
fn load_for_display() -> DownloadStats {
    load_checked().unwrap_or_else(|error| {
        crate::logging::warn(&format!(
            "Could not read download stats at {}: {error}",
            stats_path().display()
        ));
        DownloadStats::default()
    })
}

fn parse_stats(raw: &serde_json::Map<String, Value>) -> DownloadStats {
    let mut stats = DownloadStats {
        total_downloads: number(raw.get("totalDownloads")).unwrap_or(0),
        successful_downloads: number(raw.get("successfulDownloads")).unwrap_or(0),
        failed_downloads: number(raw.get("failedDownloads")).unwrap_or(0),
        cancelled_downloads: number(raw.get("cancelledDownloads")).unwrap_or(0),
        total_bytes_downloaded: number(raw.get("totalBytesDownloaded")).unwrap_or(0),
        first_download_at: number(raw.get("firstDownloadAt")),
        last_download_at: number(raw.get("lastDownloadAt")),
        ..DownloadStats::default()
    };
    if let Some(Value::Object(counts)) = raw.get("formatCounts") {
        for (format, count) in counts.iter().take(MAX_FORMAT_COUNTS) {
            if let Some(count) = number(Some(count)) {
                stats.format_counts.insert(format.clone(), count);
            }
        }
    }
    stats
}

fn save_unlocked(stats: &DownloadStats) -> Result<(), String> {
    let path = stats_path();
    crate::fs_util::guard_before_replace(&path, MAX_STATS_FILE_BYTES, Value::is_object, |value| {
        crate::fs_util::ensure_schema_not_newer(value, "Download stats")
    })?;
    crate::fs_util::write_json(
        &path,
        &StatsFile {
            schema_version: CURRENT_PERSISTED_SCHEMA_VERSION,
            stats,
        },
    )
}

pub fn record(outcome: Outcome, format: Option<&str>, bytes: Option<u64>) {
    let _guard = STATS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut stats = match load_checked() {
        Ok(stats) => stats,
        Err(error) => {
            // Leave the unreadable file untouched so the user's totals survive.
            static WARNED: AtomicBool = AtomicBool::new(false);
            if !WARNED.swap(true, Ordering::Relaxed) {
                crate::logging::warn(&format!(
                    "Download stats were not updated because {} could not be loaded: {error}. The file was left unchanged.",
                    stats_path().display()
                ));
            }
            return;
        }
    };
    let now = crate::app_state::now_ms();
    stats.total_downloads = stats.total_downloads.saturating_add(1);
    if stats.first_download_at.is_none() {
        stats.first_download_at = Some(now);
    }
    stats.last_download_at = Some(now);
    match outcome {
        Outcome::Success => {
            stats.successful_downloads = stats.successful_downloads.saturating_add(1);
            if let Some(format) = format.filter(|format| !format.is_empty()) {
                if stats.format_counts.contains_key(format)
                    || stats.format_counts.len() < MAX_FORMAT_COUNTS
                {
                    let count = stats.format_counts.entry(format.to_string()).or_insert(0);
                    *count = count.saturating_add(1);
                }
            }
            if let Some(bytes) = bytes.filter(|bytes| *bytes > 0) {
                stats.total_bytes_downloaded = stats.total_bytes_downloaded.saturating_add(bytes);
            }
        }
        Outcome::Failed => stats.failed_downloads = stats.failed_downloads.saturating_add(1),
        Outcome::Cancelled => {
            stats.cancelled_downloads = stats.cancelled_downloads.saturating_add(1)
        }
    }
    if let Err(error) = save_unlocked(&stats) {
        crate::logging::error(&format!("Failed to save stats: {error}"));
    }
}

#[tauri::command]
pub async fn get_stats() -> DownloadStats {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = STATS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        load_for_display()
    })
    .await
    .unwrap_or_else(|error| {
        crate::logging::error(&format!("Download stats worker failed: {error}"));
        DownloadStats::default()
    })
}

#[tauri::command]
pub async fn reset_stats() -> IpcResult<()> {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = STATS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        match save_unlocked(&DownloadStats::default()) {
            Ok(()) => ipc::ok(()),
            Err(error) => {
                crate::logging::error(&format!("Failed to reset stats: {error}"));
                ipc::err(INTERNAL_ERROR, "Failed to reset stats.")
            }
        }
    })
    .await
    .unwrap_or_else(|error| {
        crate::logging::error(&format!("Reset stats worker failed: {error}"));
        ipc::err(INTERNAL_ERROR, "Failed to reset stats.")
    })
}
