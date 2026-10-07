//! Hardware encoder detection by probing the effective FFmpeg with a tiny
//! synthetic encode per vendor encoder. Results are cached for five minutes.

use crate::constants::GPU_DETECT_TIMEOUT;
use crate::types::GpuDetectionResult;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(300);
static CACHE_GENERATION: AtomicU64 = AtomicU64::new(0);

struct CacheEntry {
    at: Instant,
    ffmpeg: PathBuf,
    generation: u64,
    result: GpuDetectionResult,
}

static CACHE: Mutex<Option<CacheEntry>> = Mutex::new(None);

pub fn clear_cache() {
    CACHE_GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut cache) = CACHE.lock() {
        *cache = None;
    }
}

fn ffmpeg_identity(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn probe_encoder(ffmpeg: &std::path::Path, encoder: &str) -> bool {
    let args: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "nullsrc=s=64x64:d=0.1",
        "-c:v",
        encoder,
        "-f",
        "null",
        "-",
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    let mut command = crate::process_util::command(ffmpeg, &args, &[], true);
    match crate::process_util::run_with_timeout(&mut command, GPU_DETECT_TIMEOUT, 4096, 4096) {
        Ok(output) => !output.timed_out && output.code == Some(0),
        Err(error) => {
            crate::logging::warn(&format!("Failed to spawn GPU probe ({encoder}): {error}"));
            false
        }
    }
}

pub fn detect() -> GpuDetectionResult {
    let generation = CACHE_GENERATION.load(Ordering::Acquire);
    let settings = crate::settings::load();
    let ffmpeg = crate::sidecars::effective_ffmpeg(Some(&settings.ffmpeg_path));
    let identity = ffmpeg_identity(&ffmpeg);
    if let Ok(cache) = CACHE.lock() {
        if CACHE_GENERATION.load(Ordering::Acquire) == generation {
            if let Some(entry) = cache.as_ref() {
                if entry.generation == generation
                    && entry.ffmpeg == identity
                    && entry.at.elapsed() < CACHE_TTL
                {
                    return entry.result;
                }
            }
        }
    }
    let probes: Vec<_> = ["h264_nvenc", "h264_amf", "h264_qsv"]
        .into_iter()
        .map(|encoder| {
            let ffmpeg = ffmpeg.clone();
            std::thread::spawn(move || probe_encoder(&ffmpeg, encoder))
        })
        .collect();
    let mut results = probes
        .into_iter()
        .map(|probe| probe.join().unwrap_or(false));
    let result = GpuDetectionResult {
        nvidia: results.next().unwrap_or(false),
        amd: results.next().unwrap_or(false),
        intel: results.next().unwrap_or(false),
    };
    let current_settings = crate::settings::load();
    let current_ffmpeg = crate::sidecars::effective_ffmpeg(Some(&current_settings.ffmpeg_path));
    if CACHE_GENERATION.load(Ordering::Acquire) == generation
        && ffmpeg_identity(&current_ffmpeg) == identity
    {
        if let Ok(mut cache) = CACHE.lock() {
            if CACHE_GENERATION.load(Ordering::Acquire) == generation {
                *cache = Some(CacheEntry {
                    at: Instant::now(),
                    ffmpeg: identity,
                    generation,
                    result,
                });
            }
        }
    }
    result
}

#[tauri::command]
pub async fn detect_gpu() -> GpuDetectionResult {
    tauri::async_runtime::spawn_blocking(detect)
        .await
        .unwrap_or_default()
}
