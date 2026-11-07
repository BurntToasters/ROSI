//! yt-dlp format listing (`-F`) and metadata previews (`--dump-single-json`).

use crate::constants::*;
use crate::ipc::{self, IpcResult, INTERNAL_ERROR, INVALID_URL, NOT_AVAILABLE, VALIDATION_ERROR};
use crate::process_util::{TrackedError, TrackedReservation, TrackedSlot};
use crate::types::{FormatEntry, FormatList, StreamKind, VideoInfo};
use crate::validation::{is_safe_http_url, is_syntactically_safe_http_url};
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
        .filter(|url| is_syntactically_safe_http_url(url))
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

enum CodecMetadata {
    Missing,
    NoStream,
    Codec(String),
}

fn codec_metadata(value: Option<&Value>) -> CodecMetadata {
    let Some(codec) = value.and_then(Value::as_str).map(str::trim) else {
        return CodecMetadata::Missing;
    };
    if codec.is_empty() {
        CodecMetadata::Missing
    } else if codec.eq_ignore_ascii_case("none") {
        CodecMetadata::NoStream
    } else {
        CodecMetadata::Codec(codec.to_string())
    }
}

fn codec_name(metadata: &CodecMetadata) -> Option<String> {
    match metadata {
        CodecMetadata::Codec(codec) => Some(codec.clone()),
        CodecMetadata::Missing | CodecMetadata::NoStream => None,
    }
}

fn pick_file_size(value: Option<&Value>) -> Option<u64> {
    value.and_then(|value| {
        value.as_u64().or_else(|| {
            value
                .as_f64()
                .filter(|size| size.is_finite() && *size >= 0.0 && *size <= u64::MAX as f64)
                .map(|size| size.round() as u64)
        })
    })
}

fn pick_resolution(data: &Map<String, Value>) -> Option<String> {
    pick_string(data.get("resolution"))
        .filter(|resolution| {
            !resolution.eq_ignore_ascii_case("unknown")
                && !resolution.eq_ignore_ascii_case("audio only")
        })
        .or_else(|| {
            let width = data.get("width").and_then(Value::as_u64)?;
            let height = data.get("height").and_then(Value::as_u64)?;
            (width > 0 && height > 0).then(|| format!("{width}x{height}"))
        })
}

fn is_non_media_format(data: &Map<String, Value>) -> bool {
    let ext = pick_string(data.get("ext"));
    let note = pick_string(data.get("format_note"));
    ext.is_some_and(|ext| ext.eq_ignore_ascii_case("mhtml"))
        || note.is_some_and(|note| {
            let note = note.to_ascii_lowercase();
            note.contains("storyboard")
                || note.contains("images only")
                || note.contains("image only")
        })
}

fn fallback_stream_kind(data: &Map<String, Value>) -> Option<StreamKind> {
    let ext = pick_string(data.get("ext"))?.to_ascii_lowercase();
    match ext.as_str() {
        "aac" | "ac3" | "alac" | "eac3" | "flac" | "m4a" | "m4b" | "mp3" | "opus" | "wav"
        | "wma" => Some(StreamKind::Audio),
        "3gp" | "avi" | "flv" | "m2ts" | "m4v" | "mkv" | "mov" | "mp4" | "mpd" | "m3u8" | "mts"
        | "mxf" | "ts" | "vob" | "webm" | "wmv" => Some(StreamKind::AudioVideo),
        _ => None,
    }
}

fn parse_format_entry(value: &Value) -> Option<FormatEntry> {
    let data = value.as_object()?;
    let format_id = pick_string(data.get("format_id"))?;
    if !is_format_id(&format_id) || is_non_media_format(data) {
        return None;
    }
    let vcodec_metadata = codec_metadata(data.get("vcodec"));
    let acodec_metadata = codec_metadata(data.get("acodec"));
    let vcodec = codec_name(&vcodec_metadata);
    let acodec = codec_name(&acodec_metadata);
    let stream_kind = match (&vcodec_metadata, &acodec_metadata) {
        (CodecMetadata::Codec(_), CodecMetadata::Codec(_)) => StreamKind::AudioVideo,
        (CodecMetadata::Codec(_), CodecMetadata::NoStream | CodecMetadata::Missing)
        | (CodecMetadata::Missing | CodecMetadata::NoStream, CodecMetadata::Codec(_)) => {
            if vcodec.is_some() {
                StreamKind::Video
            } else {
                StreamKind::Audio
            }
        }
        (CodecMetadata::NoStream, CodecMetadata::NoStream) => return None,
        (CodecMetadata::NoStream, CodecMetadata::Missing) => StreamKind::Audio,
        (CodecMetadata::Missing, CodecMetadata::NoStream) => StreamKind::Video,
        (CodecMetadata::Missing, CodecMetadata::Missing) => fallback_stream_kind(data)?,
    };
    let mut entry = FormatEntry {
        format_id,
        stream_kind,
        vcodec,
        acodec,
        resolution: pick_resolution(data),
        fps: pick_number(data.get("fps")).filter(|fps| *fps > 0.0),
        file_size_bytes: pick_file_size(data.get("filesize")),
        estimated_size_bytes: pick_file_size(data.get("filesize_approx")),
        display_label: String::new(),
    };
    entry.display_label = display_label(&entry);
    Some(entry)
}

const BYTE_UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];

/// JavaScript `Number(value.toFixed(2))` followed by `String()`, for a finite
/// value. `toFixed` rounds the exact binary value half up, away from zero;
/// Rust's `{:.2}` rounds exact ties to even, so the rounding is done here on
/// the exact decimal expansion.
fn js_fixed_two(value: f64) -> String {
    let exact = format!("{:.80}", value.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let mut digits: Vec<u8> = whole
        .bytes()
        .chain(fraction.bytes().take(2))
        .map(|byte| byte - b'0')
        .collect();
    if fraction
        .as_bytes()
        .get(2)
        .is_some_and(|digit| *digit >= b'5')
    {
        let mut carry = 1u8;
        for digit in digits.iter_mut().rev() {
            let sum = *digit + carry;
            *digit = sum % 10;
            carry = sum / 10;
            if carry == 0 {
                break;
            }
        }
        if carry > 0 {
            digits.insert(0, carry);
        }
    }
    let cents = digits.split_off(digits.len() - 2);
    let whole: String = digits
        .iter()
        .map(|digit| char::from(b'0' + digit))
        .collect();
    let whole = whole.trim_start_matches('0');
    let whole = if whole.is_empty() { "0" } else { whole };
    let is_zero = whole == "0" && cents == [0, 0];
    let mut out = String::new();
    if value < 0.0 && !is_zero {
        out.push('-');
    }
    out.push_str(whole);
    match cents[..] {
        [0, 0] => {}
        [tens, 0] => out.push_str(&format!(".{tens}")),
        [tens, ones] => out.push_str(&format!(".{tens}{ones}")),
        _ => {}
    }
    out
}

/// Byte count as `formatBytes` shows it: largest 1024-based unit, capped at PB.
fn byte_size_label(bytes: u64) -> String {
    if bytes == 0 {
        return "0 B".into();
    }
    let value = bytes as f64;
    let index = (value.ln() / 1024f64.ln())
        .floor()
        .min((BYTE_UNITS.len() - 1) as f64) as usize;
    let scaled = value / ((1u64 << (10 * index)) as f64);
    format!("{} {}", js_fixed_two(scaled), BYTE_UNITS[index])
}

/// Frame rate as the old renderer printed it: integers plain, others to two decimals.
fn fps_label(fps: f64) -> String {
    if fps.fract() == 0.0 {
        format!("{fps:.0}")
    } else {
        js_fixed_two(fps)
    }
}

/// Option text for a format picker. Reads only structured fields, in the order
/// `ID`, resolution, fps, codecs, stream kind, size, matching the renderer rules
/// this replaced.
fn display_label(entry: &FormatEntry) -> String {
    let mut label = format!("ID: {}", entry.format_id);
    if let Some(resolution) = entry
        .resolution
        .as_deref()
        .filter(|resolution| !resolution.is_empty())
    {
        label.push(' ');
        label.push_str(resolution);
    }
    if let Some(fps) = entry.fps.filter(|fps| fps.is_finite()) {
        label.push(' ');
        label.push_str(&fps_label(fps));
        label.push_str("fps");
    }
    let codecs: Vec<&str> = [entry.vcodec.as_deref(), entry.acodec.as_deref()]
        .into_iter()
        .flatten()
        .filter(|codec| !codec.is_empty())
        .collect();
    if !codecs.is_empty() {
        label.push_str(" (");
        label.push_str(&codecs.join(" + "));
        label.push(')');
    }
    if entry.stream_kind == StreamKind::AudioVideo {
        label.push_str(" (video + audio)");
    }
    if let Some(bytes) = entry.file_size_bytes {
        label.push(' ');
        label.push_str(&byte_size_label(bytes));
    } else if let Some(bytes) = entry.estimated_size_bytes {
        label.push_str(" ~");
        label.push_str(&byte_size_label(bytes));
    }
    label
}

pub fn parse_format_list(json: &str) -> Result<FormatList, String> {
    let parsed: Value =
        serde_json::from_str(json).map_err(|_| "Could not parse format metadata.".to_string())?;
    let data = parsed
        .as_object()
        .ok_or_else(|| "Could not parse format metadata.".to_string())?;
    if data.get("_type").and_then(Value::as_str) == Some("playlist")
        || data.get("entries").and_then(Value::as_array).is_some()
    {
        return Err(
            "Format lookup needs a single video URL. Open a specific playlist item and try again."
                .into(),
        );
    }
    let formats = data
        .get("formats")
        .and_then(Value::as_array)
        .ok_or_else(|| "Could not parse format metadata.".to_string())?;
    Ok(FormatList {
        formats: formats.iter().filter_map(parse_format_entry).collect(),
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

fn insert_common_args(
    args: &mut Vec<String>,
    settings: &crate::types::Settings,
    guard: &crate::network_security::NetworkSecurityGuard,
    ffmpeg_guard: &crate::ffmpeg_guard::FfmpegToolGuard,
) {
    let index = args
        .iter()
        .position(|argument| argument == "--")
        .unwrap_or(args.len());
    let mut common = crate::command_builders::build_ytdlp_runtime_args();
    common.extend(crate::command_builders::build_browser_cookie_args(
        settings.hook_browser,
        &settings.browser_choice,
    ));
    common.extend(["--proxy".into(), guard.proxy_url().to_string()]);
    common.extend([
        "--ffmpeg-location".into(),
        ffmpeg_guard.location().to_string_lossy().into_owned(),
    ]);
    args.splice(index..index, common);
}

fn ytdlp_command(args: Vec<String>) -> std::process::Command {
    let certificate = crate::command_builders::ytdlp_e2e_ca_path();
    let extra_env = certificate
        .as_deref()
        .map(|certificate| vec![("SSL_CERT_FILE", certificate)])
        .unwrap_or_default();
    crate::process_util::command(crate::sidecars::ytdlp_path(), &args, &extra_env, true)
}

fn error_result<T: serde::Serialize>(message: String) -> IpcResult<T> {
    if message.to_lowercase().contains("cancel") {
        ipc::err(NOT_AVAILABLE, message)
    } else {
        ipc::err(INTERNAL_ERROR, message)
    }
}

fn fetch_formats(
    url: String,
    reservation: TrackedReservation<'static>,
) -> Result<FormatList, String> {
    if reservation.is_cancelled() {
        return Err("Format fetch cancelled.".into());
    }
    let ytdlp = crate::sidecars::ytdlp_path();
    if reservation.is_cancelled() {
        return Err("Format fetch cancelled.".into());
    }
    if !ytdlp.exists() {
        return Err(format!("yt-dlp binary not found at {}", ytdlp.display()));
    }
    let settings = crate::settings::load();
    let guard = crate::network_security::NetworkSecurityGuard::start_with_cancellation(
        reservation.cancellation_flag(),
        &settings.upstream_proxy,
    )
    .map_err(|error| {
        if reservation.is_cancelled() {
            "Format fetch cancelled.".to_string()
        } else {
            error
        }
    })?;
    if reservation.is_cancelled() {
        return Err("Format fetch cancelled.".into());
    }
    let ffmpeg_guard = crate::ffmpeg_guard::FfmpegToolGuard::create(Some(&settings.ffmpeg_path))
        .map_err(|error| {
            if reservation.is_cancelled() {
                "Format fetch cancelled.".to_string()
            } else {
                error
            }
        })?;
    if reservation.is_cancelled() {
        return Err("Format fetch cancelled.".into());
    }
    let mut args = vec![
        "--dump-single-json".into(),
        "--no-playlist".into(),
        "--no-warnings".into(),
        "--skip-download".into(),
        "--".into(),
        url,
    ];
    insert_common_args(&mut args, &settings, &guard, &ffmpeg_guard);
    let command = ytdlp_command(args);
    match FORMATS.run_reserved_with(
        reservation,
        command,
        FORMAT_FETCH_TIMEOUT,
        MAX_OUTPUT_BUFFER * 4,
        MAX_ERROR_BUFFER,
        |output| {
            if output.code == Some(0) {
                parse_format_list(&output.stdout)
            } else {
                Err(format!(
                    "yt-dlp exited with code {}.\nOutput:\n{}\nError:\n{}",
                    output
                        .code
                        .map_or("null".to_string(), |code| code.to_string()),
                    output
                        .stdout
                        .replace(guard.proxy_url(), "<ephemeral proxy credentials>"),
                    output
                        .stderr
                        .replace(guard.proxy_url(), "<ephemeral proxy credentials>")
                ))
            }
        },
    ) {
        Ok(result) => result,
        Err(TrackedError::Cancelled) => Err("Format fetch cancelled.".into()),
        Err(TrackedError::TimedOut) => Err(
            "Format fetch timed out after 60 seconds. The server may be slow or unresponsive."
                .into(),
        ),
        Err(TrackedError::Spawn(error)) => Err(format!("Failed to start yt-dlp: {error}")),
    }
}

fn fetch_video_info(
    url: String,
    playlist_mode: Option<String>,
    reservation: TrackedReservation<'static>,
) -> Result<VideoInfo, String> {
    if reservation.is_cancelled() {
        return Err("Video info request cancelled.".into());
    }
    let ytdlp = crate::sidecars::ytdlp_path();
    if reservation.is_cancelled() {
        return Err("Video info request cancelled.".into());
    }
    if !ytdlp.exists() {
        return Err(format!("yt-dlp binary not found at {}", ytdlp.display()));
    }
    let mode = resolve_playlist_mode(&url, playlist_mode.as_deref());
    let cancellation = reservation.cancellation_flag();
    let settings = crate::settings::load();
    let guard = crate::network_security::NetworkSecurityGuard::start_with_cancellation(
        std::sync::Arc::clone(&cancellation),
        &settings.upstream_proxy,
    )
    .map_err(|error| {
        if reservation.is_cancelled() {
            "Video info request cancelled.".to_string()
        } else {
            error
        }
    })?;
    if reservation.is_cancelled() {
        return Err("Video info request cancelled.".into());
    }
    let ffmpeg_guard = crate::ffmpeg_guard::FfmpegToolGuard::create(Some(&settings.ffmpeg_path))
        .map_err(|error| {
            if reservation.is_cancelled() {
                "Video info request cancelled.".to_string()
            } else {
                error
            }
        })?;
    if reservation.is_cancelled() {
        return Err("Video info request cancelled.".into());
    }
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
    insert_common_args(&mut args, &settings, &guard, &ffmpeg_guard);
    match VIDEO_INFO.run_reserved_with(
        reservation,
        ytdlp_command(args),
        FORMAT_FETCH_TIMEOUT,
        MAX_OUTPUT_BUFFER * 20,
        MAX_ERROR_BUFFER,
        |output| {
            if cancellation.load(std::sync::atomic::Ordering::Acquire) {
                return Err("Video info request cancelled.".into());
            }
            if output.code != Some(0) {
                return Err(format!(
                    "yt-dlp exited with code {}.\n{}",
                    output
                        .code
                        .map_or("null".to_string(), |code| code.to_string()),
                    output
                        .stderr
                        .replace(guard.proxy_url(), "<ephemeral proxy credentials>")
                ));
            }
            let mut info = parse_video_info(&output.stdout, PLAYLIST_PREVIEW_ENTRY_LIMIT)
                .ok_or_else(|| "Could not parse video information.".to_string())?;
            if let Some(thumbnail_url) = info.thumbnail.as_deref() {
                // This metadata worker is itself a Tokio blocking task. Drive
                // the async thumbnail client from a plain scoped thread so it
                // does not nest another runtime on the worker. The shared
                // guard still closes its proxy sockets when cancelled.
                info.thumbnail = std::thread::scope(|scope| {
                    scope
                        .spawn(|| {
                            crate::network_security::fetch_thumbnail_data_url(&guard, thumbnail_url)
                        })
                        .join()
                        .unwrap_or_default()
                });
            }
            Ok(info)
        },
    ) {
        Ok(result) => result,
        Err(TrackedError::Cancelled) => Err("Video info request cancelled.".into()),
        Err(TrackedError::TimedOut) => {
            Err("Video info request timed out. The server may be slow or unresponsive.".into())
        }
        Err(TrackedError::Spawn(error)) => Err(format!("Failed to start yt-dlp: {error}")),
    }
}

#[tauri::command]
pub async fn get_formats(url: Value) -> IpcResult<FormatList> {
    let reservation = FORMATS.reserve();
    let Some(url) = url
        .as_str()
        .filter(|url| is_safe_http_url(url))
        .map(str::to_string)
    else {
        return ipc::err(INVALID_URL, "Invalid URL provided.");
    };
    match tauri::async_runtime::spawn_blocking(move || fetch_formats(url, reservation)).await {
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
    let reservation = VIDEO_INFO.reserve();
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
    match tauri::async_runtime::spawn_blocking(move || {
        fetch_video_info(url, playlist_mode, reservation)
    })
    .await
    {
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
