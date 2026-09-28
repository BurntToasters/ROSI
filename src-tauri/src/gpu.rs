//! Hardware encoder detection by probing the effective FFmpeg with a tiny
//! synthetic encode per vendor encoder. Results are cached for five minutes.

use crate::constants::GPU_DETECT_TIMEOUT;
use crate::types::GpuDetectionResult;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(300);
static CACHE: Mutex<Option<(Instant, GpuDetectionResult)>> = Mutex::new(None);

pub fn clear_cache() {
    if let Ok(mut cache) = CACHE.lock() {
        *cache = None;
    }
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
    if let Ok(cache) = CACHE.lock() {
        if let Some((at, result)) = *cache {
            if at.elapsed() < CACHE_TTL {
                return result;
            }
        }
    }
    let settings = crate::settings::load();
    let ffmpeg = crate::sidecars::effective_ffmpeg(Some(&settings.ffmpeg_path));
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
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), result));
    }
    result
}

#[tauri::command]
pub async fn detect_gpu() -> GpuDetectionResult {
    tauri::async_runtime::spawn_blocking(detect)
        .await
        .unwrap_or_default()
}
