//! yt-dlp format listing (`-F`) and metadata previews (`--dump-single-json`).

use crate::constants::*;
use crate::ipc::{self, IpcResult, INTERNAL_ERROR, INVALID_URL, NOT_AVAILABLE, VALIDATION_ERROR};
use crate::process_util::{TrackedError, TrackedSlot};
use crate::types::VideoInfo;
use crate::validation::is_safe_http_url;
use serde_json::{Map, Value};

static FORMATS: TrackedSlot = TrackedSlot::new();
static VIDEO_INFO: TrackedSlot = TrackedSlot::new();

fn pick_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(str::to_string)
}

fn pick_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

fn pick_web_url(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|url| is_safe_http_url(url))
        .map(str::to_string)
}

pub fn parse_video_info(json: &str, entry_limit: usize) -> Option<VideoInfo> {
    let parsed: Value = serde_json::from_str(json).ok()?;
    let data: &Map<String, Value> = parsed.as_object()?;
    let entries = data.get("entries").and_then(Value::as_array);
    let is_playlist =
        data.get("_type").and_then(Value::as_str) == Some("playlist") || entries.is_some();

    let mut thumbnail = pick_web_url(data.get("thumbnail"));
    if thumbnail.is_none() {
        thumbnail = data
            .get("thumbnails")
            .and_then(Value::as_array)
            .and_then(|list| list.last())
            .and_then(|last| pick_web_url(last.get("url")));
    }
    if thumbnail.is_none() {
        thumbnail = entries
            .and_then(|list| list.first())
            .and_then(|first| pick_web_url(first.get("thumbnail")));
    }
    let title = pick_string(data.get("title"))
        .or_else(|| pick_string(data.get("fulltitle")))
        .unwrap_or_else(|| if is_playlist { "Playlist" } else { "Untitled" }.to_string());
    // Prefer the extractor's own total; only count entries when the listing
    // was not truncated by the preview limit.
    let reported_count = pick_number(data.get("playlist_count"));
    let truncated = entries.is_some_and(|list| list.len() >= entry_limit);
    let playlist_count =
        reported_count.or_else(|| entries.filter(|_| !truncated).map(|list| list.len() as f64));
    Some(VideoInfo {
        title,
        uploader: pick_string(data.get("uploader"))
            .or_else(|| pick_string(data.get("channel")))
            .or_else(|| pick_string(data.get("creator"))),
        duration_seconds: pick_number(data.get("duration")),
        thumbnail,
        ext: pick_string(data.get("ext")),
        view_count: pick_number(data.get("view_count")),
        is_playlist,
        playlist_count,
        webpage_url: pick_web_url(data.get("webpage_url")),
    })
}

fn resolve_playlist_mode(url: &str, requested: Option<&str>) -> &'static str {
    match requested {
        Some("all") => return "all",
        Some("current") => return "current",
        _ => {}
    }
    let Ok(parsed) = url::Url::parse(url) else {
        return "current";
    };
    let has_list = parsed.query_pairs().any(|(key, _)| key == "list");
    let path = parsed.path().to_lowercase();
    let is_playlist_path = path.ends_with("/playlist") || path.contains("/playlist/");
    if has_list || is_playlist_path {
        "all"
    } else {
        "current"
    }
}

fn ytdlp_command(args: Vec<String>) -> std::process::Command {
    crate::process_util::command(crate::sidecars::ytdlp_path(), &args, &[], true)
}

fn error_result<T: serde::Serialize>(message: String) -> IpcResult<T> {
    if message.to_lowercase().contains("cancel") {
        ipc::err(NOT_AVAILABLE, message)
    } else {
        ipc::err(INTERNAL_ERROR, message)
    }
}

fn fetch_formats(url: String) -> Result<String, String> {
    let ytdlp = crate::sidecars::ytdlp_path();
    if !ytdlp.exists() {
        return Err(format!("yt-dlp binary not found at {}", ytdlp.display()));
    }
    let command = ytdlp_command(vec!["-F".into(), "--".into(), url]);
    match FORMATS.run(
        command,
        FORMAT_FETCH_TIMEOUT,
        MAX_OUTPUT_BUFFER,
        MAX_ERROR_BUFFER,
    ) {
        Ok(output) if output.code == Some(0) => Ok(output.stdout),
        Ok(output) => Err(format!(
            "yt-dlp exited with code {}.\nOutput:\n{}\nError:\n{}",
            output
                .code
                .map_or("null".to_string(), |code| code.to_string()),
            output.stdout,
            output.stderr
        )),
        Err(TrackedError::Cancelled) => Err("Format fetch cancelled.".into()),
        Err(TrackedError::TimedOut) => Err(
            "Format fetch timed out after 60 seconds. The server may be slow or unresponsive."
                .into(),
        ),
        Err(TrackedError::Spawn(error)) => Err(format!("Failed to start yt-dlp: {error}")),
    }
}

fn fetch_video_info(url: String, playlist_mode: Option<String>) -> Result<VideoInfo, String> {
    let ytdlp = crate::sidecars::ytdlp_path();
    if !ytdlp.exists() {
        return Err(format!("yt-dlp binary not found at {}", ytdlp.display()));
    }
    let mode = resolve_playlist_mode(&url, playlist_mode.as_deref());
    let mut args = vec!["--dump-single-json".to_string()];
    if mode == "all" {
        args.extend([
            "--yes-playlist".to_string(),
            "--flat-playlist".to_string(),
            "--playlist-end".to_string(),
            PLAYLIST_PREVIEW_ENTRY_LIMIT.to_string(),
        ]);
    } else {
        args.push("--no-playlist".to_string());
    }
    args.extend([
        "--no-warnings".to_string(),
        "--skip-download".to_string(),
        "--".to_string(),
        url,
    ]);
    match VIDEO_INFO.run(
        ytdlp_command(args),
        FORMAT_FETCH_TIMEOUT,
        MAX_OUTPUT_BUFFER * 20,
        MAX_ERROR_BUFFER,
    ) {
        Ok(output) if output.code == Some(0) => {
            parse_video_info(&output.stdout, PLAYLIST_PREVIEW_ENTRY_LIMIT)
                .ok_or_else(|| "Could not parse video information.".to_string())
        }
        Ok(output) => Err(format!(
            "yt-dlp exited with code {}.\n{}",
            output
                .code
                .map_or("null".to_string(), |code| code.to_string()),
            output.stderr
        )),
        Err(TrackedError::Cancelled) => Err("Video info request cancelled.".into()),
        Err(TrackedError::TimedOut) => {
            Err("Video info request timed out. The server may be slow or unresponsive.".into())
        }
        Err(TrackedError::Spawn(error)) => Err(format!("Failed to start yt-dlp: {error}")),
    }
}

#[tauri::command]
pub async fn get_formats(url: Value) -> IpcResult<String> {
    let Some(url) = url
        .as_str()
        .filter(|url| is_safe_http_url(url))
        .map(str::to_string)
    else {
        return ipc::err(INVALID_URL, "Invalid URL provided.");
    };
    match tauri::async_runtime::spawn_blocking(move || fetch_formats(url)).await {
        Ok(Ok(formats)) => ipc::ok(formats),
        Ok(Err(message)) => error_result(message),
        Err(error) => ipc::err(INTERNAL_ERROR, error.to_string()),
    }
}

#[tauri::command(async)]
pub fn cancel_formats() {
    FORMATS.cancel();
}

#[tauri::command]
pub async fn get_video_info(url: Value, playlist_mode: Option<Value>) -> IpcResult<VideoInfo> {
    let Some(url) = url
        .as_str()
        .filter(|url| is_safe_http_url(url))
        .map(|url| url.trim().to_string())
    else {
        return ipc::err(INVALID_URL, "Invalid URL provided.");
    };
    let playlist_mode = match playlist_mode {
        None | Some(Value::Null) => None,
        Some(Value::String(mode)) if mode == "current" || mode == "all" => Some(mode),
        Some(_) => {
            return ipc::err(
                VALIDATION_ERROR,
                "Playlist preview mode must be current or all.",
            )
        }
    };
    match tauri::async_runtime::spawn_blocking(move || fetch_video_info(url, playlist_mode)).await {
        Ok(Ok(info)) => ipc::ok(info),
        Ok(Err(message)) => error_result(message),
        Err(error) => ipc::err(INTERNAL_ERROR, error.to_string()),
    }
}

#[tauri::command(async)]
pub fn cancel_video_info() {
    VIDEO_INFO.cancel();
}

pub fn cancel_all() {
    FORMATS.cancel();
    VIDEO_INFO.cancel();
}
