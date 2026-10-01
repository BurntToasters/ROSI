//! Lifetime download statistics (`download-stats.json`).

use crate::constants::MAX_FORMAT_COUNTS;
use crate::ipc::{self, IpcResult, INTERNAL_ERROR};
use crate::types::{DownloadStats, Outcome};
use serde_json::Value;
use std::sync::Mutex;

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

fn load_unlocked() -> DownloadStats {
    let Some(Value::Object(raw)) = crate::fs_util::read_json(&stats_path(), 4 * 1024 * 1024) else {
        return DownloadStats::default();
    };
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
    crate::fs_util::write_json(&stats_path(), stats)
}

pub fn record(outcome: Outcome, format: Option<&str>, bytes: Option<u64>) {
    let _guard = STATS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut stats = load_unlocked();
    let now = crate::app_state::now_ms();
    stats.total_downloads += 1;
    if stats.first_download_at.is_none() {
        stats.first_download_at = Some(now);
    }
    stats.last_download_at = Some(now);
    match outcome {
        Outcome::Success => {
            stats.successful_downloads += 1;
            if let Some(format) = format.filter(|format| !format.is_empty()) {
                if stats.format_counts.contains_key(format)
                    || stats.format_counts.len() < MAX_FORMAT_COUNTS
                {
                    *stats.format_counts.entry(format.to_string()).or_insert(0) += 1;
                }
            }
            if let Some(bytes) = bytes.filter(|bytes| *bytes > 0) {
                stats.total_bytes_downloaded += bytes;
            }
        }
        Outcome::Failed => stats.failed_downloads += 1,
        Outcome::Cancelled => stats.cancelled_downloads += 1,
    }
    if let Err(error) = save_unlocked(&stats) {
        crate::logging::error(&format!("Failed to save stats: {error}"));
    }
}

#[tauri::command(async)]
pub fn get_stats() -> DownloadStats {
    let _guard = STATS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    load_unlocked()
}

#[tauri::command(async)]
pub fn reset_stats() -> IpcResult<()> {
    let _guard = STATS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    match save_unlocked(&DownloadStats::default()) {
        Ok(()) => ipc::ok(()),
        Err(error) => {
            crate::logging::error(&format!("Failed to reset stats: {error}"));
            ipc::err(INTERNAL_ERROR, "Failed to reset stats.")
        }
    }
}
