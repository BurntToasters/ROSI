//! Single active download session: yt-dlp download, optional FFmpeg
//! conversion, cancellation, structured progress, and completion reporting.
//!
//! Lock discipline: the `ACTIVE` session lock is never held while emitting
//! events, touching windows, or invoking completion callbacks (the queue's
//! callback takes the queue lock).

use crate::command_builders::{
    build_ffmpeg_args, build_ytdlp_args, probe_media_codecs, resolve_video_encoder, YtdlpArgsInput,
};
use crate::constants::*;
use crate::ipc::{self, IpcResult, INTERNAL_ERROR, NOT_AVAILABLE};
use crate::progress::{self, Metrics, Reporter};
use crate::types::{
    DownloadCompletion, DownloadRequestOptions, JobProgressEvent, Outcome, Owner, Phase,
    QueueProgress, Settings,
};
use crate::validation::{is_path_within, is_safe_http_url, resolve_path};
use serde_json::{Map, Value};
use shared_child::SharedChild;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

pub type CompletionCallback = Box<dyn FnOnce(DownloadCompletion) + Send + 'static>;

const CANCELLED_STATUS: &str = "⏹️ Cancelled.";
const CANCELLED_PROGRESS: &str = "⏹️ Download/Conversion cancelled by user.";

struct Session {
    id: u64,
    completion_id: String,
    started_at: u64,
    request: DownloadRequestOptions,
    owner: Owner,
    cancelled: bool,
    ytdlp: Option<Arc<SharedChild>>,
    ffmpeg: Option<Arc<SharedChild>>,
    on_complete: Option<CompletionCallback>,
    ytdlp_postprocess: bool,
    ytdlp_download_finished: bool,
    reporter: Reporter,
}

static ACTIVE: Mutex<Option<Session>> = Mutex::new(None);
static COUNTER: AtomicU64 = AtomicU64::new(0);

fn lock() -> MutexGuard<'static, Option<Session>> {
    ACTIVE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn with_session<R>(id: u64, f: impl FnOnce(&mut Session) -> R) -> Option<R> {
    let mut guard = lock();
    match guard.as_mut() {
        Some(session) if session.id == id => Some(f(session)),
        _ => None,
    }
}

fn is_active(id: u64) -> bool {
    with_session(id, |_| ()).is_some()
}

pub fn is_busy() -> bool {
    lock().is_some()
}

pub fn can_start(owner: Owner) -> bool {
    lock().as_ref().is_none_or(|session| session.owner == owner)
}

fn send_progress(id: u64, message: impl Into<String>) {
    if is_active(id) {
        crate::app_state::emit("progress", message.into());
    }
}

fn apply_taskbar(event: &JobProgressEvent) {
    if cfg!(target_os = "linux") {
        return;
    }
    let Some(window) = crate::app_state::main_window() else {
        return;
    };
    use tauri::window::{ProgressBarState, ProgressBarStatus};
    let state = if event.phase == Phase::Idle {
        ProgressBarState {
            status: Some(ProgressBarStatus::None),
            progress: None,
        }
    } else if event.indeterminate {
        ProgressBarState {
            status: Some(ProgressBarStatus::Indeterminate),
            progress: None,
        }
    } else {
        ProgressBarState {
            status: Some(ProgressBarStatus::Normal),
            progress: Some(event.overall_percent.clamp(0.0, 100.0).round() as u64),
        }
    };
    let _ = window.set_progress_bar(state);
}

fn emit_job_progress(id: u64, event: JobProgressEvent) {
    let show_taskbar = with_session(id, |session| {
        session
            .reporter
            .should_emit(&event)
            .then_some(session.reporter.show_taskbar)
    })
    .flatten();
    if let Some(show_taskbar) = show_taskbar {
        crate::app_state::emit("job-progress", event.clone());
        if show_taskbar {
            apply_taskbar(&event);
        }
    }
}

fn build_for(
    session: &Session,
    phase: Phase,
    percent: f64,
    status: &str,
    details: Option<String>,
    indeterminate: Option<bool>,
    metrics: Metrics,
) -> JobProgressEvent {
    progress::build_event(
        phase,
        percent,
        session.reporter.plan,
        session.reporter.queue.as_ref(),
        status,
        details,
        indeterminate,
        metrics,
    )
}

fn emit_phase(id: u64, phase: Phase, percent: f64, status: &str, indeterminate: Option<bool>) {
    let event = with_session(id, |session| {
        build_for(
            session,
            phase,
            percent,
            status,
            None,
            indeterminate,
            Metrics::default(),
        )
    });
    if let Some(event) = event {
        emit_job_progress(id, event);
    }
}

/// Update phase state from one yt-dlp line. Returns whether the line was
/// progress output that should not also be echoed to the console.
fn handle_progress_line(id: u64, line: &str) -> bool {
    let result = with_session(id, |session| {
        if let Some(json) = progress::try_parse_json(line) {
            if let Some(postprocessor) = json.postprocessor.as_deref() {
                // Post-processing reports no byte counts; it occupies the
                // merge span of the progress plan.
                session.ytdlp_download_finished = true;
                session.ytdlp_postprocess = true;
                let label = progress::postprocess_label(postprocessor);
                return (
                    Some(build_for(
                        session,
                        Phase::Merge,
                        f64::NAN,
                        label,
                        None,
                        Some(true),
                        Metrics::default(),
                    )),
                    true,
                );
            }
            let finished = json.status.as_deref() == Some("finished");
            let mut phase = if session.ytdlp_postprocess {
                Phase::Merge
            } else {
                Phase::Download
            };
            if !session.ytdlp_postprocess && finished {
                session.ytdlp_download_finished = true;
                phase = Phase::Download;
            } else if session.ytdlp_download_finished && !session.ytdlp_postprocess {
                session.ytdlp_postprocess = true;
                phase = Phase::Merge;
            }
            let percent = if finished && phase == Phase::Download {
                100.0
            } else {
                progress::json_to_phase_percent(&json)
            };
            let (status, details) = progress::format_summary(&json, percent);
            // A second format (bestvideo+bestaudio) downloads inside the merge
            // span so overall progress keeps moving forward.
            let label = if phase == Phase::Merge {
                "Downloading...".to_string()
            } else {
                status
            };
            let metrics = Metrics {
                downloaded_bytes: json.downloaded_bytes,
                total_bytes: json.total_bytes.or(json.total_bytes_estimate),
                speed_bytes_per_second: json.speed,
                eta_seconds: json.eta,
            };
            return (
                Some(build_for(
                    session,
                    phase,
                    percent,
                    &label,
                    Some(details),
                    Some(!percent.is_finite()),
                    metrics,
                )),
                true,
            );
        }
        if let Some(legacy) = progress::parse_legacy(line) {
            let details = match (&legacy.speed, &legacy.eta) {
                (Some(speed), Some(eta)) => format!("{} • {speed} • ETA: {eta}", legacy.total_size),
                _ if !legacy.total_size.is_empty() => format!("Size: {}", legacy.total_size),
                _ => String::new(),
            };
            return (
                Some(build_for(
                    session,
                    Phase::Download,
                    legacy.percent,
                    "Downloading...",
                    Some(details),
                    None,
                    Metrics::default(),
                )),
                true,
            );
        }
        if line.contains("Merging formats") || line.contains("[Merger]") {
            session.ytdlp_postprocess = true;
            return (
                Some(build_for(
                    session,
                    Phase::Merge,
                    f64::NAN,
                    "Merging video and audio...",
                    None,
                    Some(true),
                    Metrics::default(),
                )),
                false,
            );
        }
        (None, false)
    });
    let Some((event, handled)) = result else {
        return true;
    };
    if let Some(event) = event {
        emit_job_progress(id, event);
    }
    handled
}

fn handle_ytdlp_line(id: u64, line: &str, is_stderr: bool) {
    let trimmed = line.trim();
    if trimmed.is_empty() || !is_active(id) {
        return;
    }
    if trimmed.starts_with('{') {
        handle_progress_line(id, trimmed);
        if let Some(summary) = progress::try_parse_json(trimmed)
            .and_then(|json| progress::summarize_for_console(&json))
        {
            send_progress(id, summary);
        }
        return;
    }
    if handle_progress_line(id, trimmed) {
        return;
    }
    if is_stderr {
        send_progress(id, format!("[yt-dlp stderr] {trimmed}"));
    } else {
        send_progress(id, trimmed.to_string());
    }
}

#[derive(Default)]
struct CompletionMeta {
    format: Option<String>,
    bytes: Option<u64>,
    file_path: Option<PathBuf>,
    error: Option<String>,
    progress_message: Option<String>,
    suppress_legacy_complete: bool,
}

fn complete_session(id: u64, status_message: &str, outcome: Outcome, meta: CompletionMeta) {
    let session = {
        let mut guard = lock();
        match guard.as_ref() {
            Some(session) if session.id == id => guard.take(),
            _ => None,
        }
    };
    let Some(mut session) = session else {
        return;
    };
    let final_path = meta.file_path.map(resolve_path);
    let size_bytes = meta
        .bytes
        .or_else(|| final_path.as_deref().and_then(crate::fs_util::file_size));
    let completion = DownloadCompletion {
        id: session.completion_id.clone(),
        session_id: Some(session.id),
        owner: session.owner,
        queue_item_id: session
            .reporter
            .queue
            .as_ref()
            .and_then(|queue| queue.queue_item_id.clone()),
        outcome,
        status_message: status_message.to_string(),
        url: session.request.url.clone(),
        profile: session.request.profile.clone(),
        preset_id: session.request.preset_id.clone(),
        preset_name: session.request.preset_name.clone(),
        request: session.request.clone(),
        filename: final_path
            .as_ref()
            .and_then(|path| path.file_name())
            .map(|name| name.to_string_lossy().into_owned()),
        output_path: final_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        size_bytes,
        format: meta.format.clone(),
        error: (outcome == Outcome::Failed).then(|| {
            meta.error
                .clone()
                .unwrap_or_else(|| status_message.to_string())
        }),
        started_at: session.started_at,
        completed_at: crate::app_state::now_ms(),
    };
    if let Some(message) = meta.progress_message {
        crate::app_state::emit("progress", message);
    }
    if !meta.suppress_legacy_complete {
        crate::app_state::emit("complete", status_message.to_string());
    }
    crate::app_state::emit("download-complete", completion.clone());
    match outcome {
        Outcome::Success => crate::stats::record(outcome, meta.format.as_deref(), size_bytes),
        _ => crate::stats::record(outcome, None, None),
    }
    let idle = progress::idle_event(session.reporter.queue.as_ref());
    crate::app_state::emit("job-progress", idle.clone());
    if session.reporter.show_taskbar {
        apply_taskbar(&idle);
    }
    if let Some(callback) = session.on_complete.take() {
        callback(completion);
    }
}

/// Cancel the active session. `notify` controls whether the user-facing
/// cancellation message and legacy `complete` event are sent for queue runs.
pub fn cancel_active_session(notify: bool) {
    let taken = {
        let mut guard = lock();
        guard.as_mut().map(|session| {
            session.cancelled = true;
            (
                session.id,
                session.owner,
                [session.ffmpeg.take(), session.ytdlp.take()],
            )
        })
    };
    let Some((id, owner, children)) = taken else {
        return;
    };
    for child in children.into_iter().flatten() {
        crate::process_util::terminate_tree(&child);
    }
    let show = notify || owner == Owner::Manual;
    complete_session(
        id,
        CANCELLED_STATUS,
        Outcome::Cancelled,
        CompletionMeta {
            progress_message: show.then(|| CANCELLED_PROGRESS.to_string()),
            suppress_legacy_complete: !show,
            ..CompletionMeta::default()
        },
    );
}

pub fn kill_all_processes() {
    let taken = {
        let mut guard = lock();
        guard.as_mut().map(|session| {
            session.cancelled = true;
            (session.id, [session.ytdlp.take(), session.ffmpeg.take()])
        })
    };
    let Some((id, children)) = taken else {
        return;
    };
    for child in children.into_iter().flatten() {
        crate::process_util::terminate_tree(&child);
    }
    complete_session(
        id,
        CANCELLED_STATUS,
        Outcome::Cancelled,
        CompletionMeta {
            suppress_legacy_complete: true,
            ..CompletionMeta::default()
        },
    );
}

fn to_map(value: &impl serde::Serialize) -> Map<String, Value> {
    match serde_json::to_value(value) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn resolve_preset_options(
    settings: &Settings,
    options: DownloadRequestOptions,
) -> DownloadRequestOptions {
    let Some(preset) = options.preset_id.as_deref().and_then(|id| {
        settings
            .download_presets
            .iter()
            .find(|preset| preset.id == id)
    }) else {
        return options;
    };
    let mut merged = crate::settings::preset_to_request_options(preset);
    for (key, value) in to_map(&options) {
        merged.insert(key, value);
    }
    if options.preset_name.is_none() {
        merged.insert("presetName".into(), Value::String(preset.name.clone()));
    }
    serde_json::from_value(Value::Object(merged)).unwrap_or(options)
}

fn apply_request_to_settings(settings: &Settings, options: &DownloadRequestOptions) -> Settings {
    let mut effective = settings.clone();
    if let Some(profile) = &options.profile {
        effective.download_mode = profile.clone();
    }
    effective.advanced_options = effective.download_mode == "custom";
    effective.audio_only = effective.download_mode == "audio";
    effective.best_quality = effective.download_mode == "best-video";
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
    if let Some(value) = &options.gpu_type {
        effective.gpu_type = value.clone();
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

fn resolved_snapshot(
    options: &DownloadRequestOptions,
    effective: &Settings,
) -> DownloadRequestOptions {
    DownloadRequestOptions {
        url: options.url.trim().to_string(),
        output_path: options.output_path.clone(),
        ffmpeg_path: options
            .ffmpeg_path
            .clone()
            .filter(|path| !path.is_empty())
            .or_else(|| Some(effective.ffmpeg_path.clone()).filter(|path| !path.is_empty())),
        convert_enabled: Some(effective.convert_enabled),
        convert_format: Some(effective.convert_format.clone()),
        keep_original: Some(effective.keep_original_after_convert),
        video_format: options.video_format.clone(),
        audio_format: options.audio_format.clone(),
        playlist: Some(
            options
                .playlist
                .clone()
                .unwrap_or(crate::types::PlaylistSelection {
                    mode: "current".into(),
                    start: None,
                    end: None,
                }),
        ),
        profile: Some(effective.download_mode.clone()),
        preset_id: options.preset_id.clone(),
        preset_name: options.preset_name.clone(),
        best_quality: Some(effective.best_quality),
        advanced_options: Some(effective.advanced_options),
        audio_only: Some(effective.audio_only),
        audio_output_format: Some(effective.audio_format.clone()),
        hook_browser: Some(effective.hook_browser),
        browser_choice: Some(effective.browser_choice.clone()),
        gpu_acceleration: Some(effective.gpu_acceleration),
        gpu_type: Some(effective.gpu_type.clone()),
        write_subtitles: Some(effective.write_subtitles),
        subtitle_langs: Some(effective.subtitle_langs.clone()),
        embed_thumbnail: Some(effective.embed_thumbnail),
        embed_metadata: Some(effective.embed_metadata),
        sponsorblock_remove: Some(effective.sponsorblock_remove),
    }
}

/// Stream lines (split on `\n` and `\r`) from a child pipe.
fn read_lines<R: Read + Send + 'static>(
    reader: Option<R>,
    mut on_line: impl FnMut(&str) + Send + 'static,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let Some(reader) = reader else {
            return;
        };
        let mut reader = BufReader::new(reader);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buffer);
                    for line in text.split(['\n', '\r']) {
                        on_line(line);
                    }
                }
            }
        }
    })
}

fn append_bounded(buffer: &Mutex<String>, line: &str, limit: usize, keep_tail: bool) {
    let Ok(mut text) = buffer.lock() else {
        return;
    };
    if text.len() + line.len() + 1 > limit {
        if !keep_tail {
            return;
        }
        let mut cut = text.len().saturating_sub(limit / 2);
        while cut < text.len() && !text.is_char_boundary(cut) {
            cut += 1;
        }
        text.drain(..cut);
    }
    text.push_str(line);
    text.push('\n');
}

/// Start a download. Validation failures are reported through the normal
/// completion path; `Err` only means another owner holds the session slot.
pub fn start_download(
    options: DownloadRequestOptions,
    owner: Owner,
    queue_progress: Option<QueueProgress>,
    on_complete: CompletionCallback,
) -> Result<(), String> {
    let existing_owner = lock().as_ref().map(|session| session.owner);
    match existing_owner {
        Some(current) if current != owner => {
            return Err("Download session already active with a different owner.".to_string())
        }
        Some(_) => cancel_active_session(false),
        None => {}
    }

    let settings = crate::settings::load();
    let request = resolve_preset_options(&settings, options);
    let effective = apply_request_to_settings(&settings, &request);
    let snapshot = resolved_snapshot(&request, &effective);
    let id = COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let plan = progress::resolve_plan(&effective);
    let session = Session {
        id,
        completion_id: crate::fs_util::uuid_v4(),
        started_at: crate::app_state::now_ms(),
        request: snapshot,
        owner,
        cancelled: false,
        ytdlp: None,
        ffmpeg: None,
        on_complete: Some(on_complete),
        ytdlp_postprocess: false,
        ytdlp_download_finished: false,
        reporter: Reporter::new(plan, queue_progress, effective.show_taskbar_progress),
    };
    *lock() = Some(session);

    let requested_ffmpeg = request
        .ffmpeg_path
        .clone()
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| settings.ffmpeg_path.clone());
    let ffmpeg_command = crate::sidecars::effective_ffmpeg(Some(&requested_ffmpeg));
    let ffmpeg_location = crate::sidecars::ffmpeg_location_for_ytdlp(Some(&requested_ffmpeg));
    let ytdlp = crate::sidecars::ytdlp_path();
    let url = request.url.clone();

    if !is_safe_http_url(&url) {
        send_progress(id, "⚠️ Invalid or missing URL.");
        complete_session(
            id,
            "❌ Failed (Invalid URL).",
            Outcome::Failed,
            CompletionMeta::default(),
        );
        return Ok(());
    }
    if request.output_path.trim().is_empty() {
        send_progress(id, "⚠️ Invalid or missing download folder.");
        complete_session(
            id,
            "❌ Failed (Invalid Folder).",
            Outcome::Failed,
            CompletionMeta::default(),
        );
        return Ok(());
    }
    if !ytdlp.exists() {
        send_progress(
            id,
            format!("❌ Error: yt-dlp binary not found at {}", ytdlp.display()),
        );
        complete_session(
            id,
            "❌ Failed (Missing Dependency).",
            Outcome::Failed,
            CompletionMeta::default(),
        );
        return Ok(());
    }

    let download_dir = resolve_path(&request.output_path);
    with_session(id, |session| {
        session.request.output_path = download_dir.to_string_lossy().into_owned();
    });
    if !download_dir.exists() {
        send_progress(
            id,
            format!("📂 Creating directory: {}", download_dir.display()),
        );
        if let Err(error) = std::fs::create_dir_all(&download_dir) {
            send_progress(id, format!("❌ Error before starting download: {error}"));
            complete_session(
                id,
                "❌ Failed (Initial Setup Error).",
                Outcome::Failed,
                CompletionMeta::default(),
            );
            return Ok(());
        }
    } else if !download_dir.is_dir() {
        send_progress(
            id,
            format!(
                "❌ Download path is not a directory: {}",
                download_dir.display()
            ),
        );
        complete_session(
            id,
            "❌ Failed (Invalid Folder).",
            Outcome::Failed,
            CompletionMeta::default(),
        );
        return Ok(());
    }

    let path_output_file = download_dir.join(format!(
        ".rosi-path-{id}-{}.txt",
        crate::app_state::now_ms()
    ));
    let (args, status_messages) = build_ytdlp_args(YtdlpArgsInput {
        download_dir: &download_dir,
        url: &url,
        settings: &effective,
        options: &request,
        ffmpeg_location: ffmpeg_location.as_deref(),
        path_output_file: Some(&path_output_file),
    });
    for message in status_messages {
        send_progress(id, message);
    }
    emit_phase(
        id,
        Phase::Download,
        f64::NAN,
        "Starting download...",
        Some(true),
    );
    send_progress(id, format!("🚀 Starting download: {url}"));
    send_progress(id, format!("   Command: yt-dlp {}", args.join(" ")));

    let mut command =
        crate::process_util::command(&ytdlp, &args, &[("PYTHONUNBUFFERED", "1")], true);
    let child = match crate::process_util::spawn(&mut command) {
        Ok(child) => child,
        Err(error) => {
            let _ = std::fs::remove_file(&path_output_file);
            send_progress(id, format!("❌ Failed to start download process: {error}"));
            complete_session(
                id,
                "❌ Download failed (process spawn error).",
                Outcome::Failed,
                CompletionMeta::default(),
            );
            return Ok(());
        }
    };
    with_session(id, |session| session.ytdlp = Some(Arc::clone(&child)));

    let stdout_buffer = Arc::new(Mutex::new(String::new()));
    let stderr_buffer = Arc::new(Mutex::new(String::new()));
    let stdout_reader = {
        let buffer = Arc::clone(&stdout_buffer);
        read_lines(child.take_stdout(), move |line| {
            if line.is_empty() || !is_active(id) {
                return;
            }
            append_bounded(&buffer, line, MAX_OUTPUT_BUFFER, true);
            handle_ytdlp_line(id, line, false);
        })
    };
    let stderr_reader = {
        let buffer = Arc::clone(&stderr_buffer);
        read_lines(child.take_stderr(), move |line| {
            if line.is_empty() || !is_active(id) {
                return;
            }
            append_bounded(&buffer, line, MAX_ERROR_BUFFER, false);
            handle_ytdlp_line(id, line, true);
        })
    };
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|status| status.code());
        let _ = stdout_reader.join();
        let _ = stderr_reader.join();
        let stdout = stdout_buffer
            .lock()
            .map(|text| text.clone())
            .unwrap_or_default();
        let stderr = stderr_buffer
            .lock()
            .map(|text| text.clone())
            .unwrap_or_default();
        on_ytdlp_exit(YtdlpExit {
            id,
            code,
            stdout,
            stderr,
            path_output_file,
            download_dir,
            effective,
            ffmpeg_command,
        });
    });
    Ok(())
}

struct YtdlpExit {
    id: u64,
    code: Option<i32>,
    stdout: String,
    stderr: String,
    path_output_file: PathBuf,
    download_dir: PathBuf,
    effective: Settings,
    ffmpeg_command: PathBuf,
}

fn downloaded_file_path(exit: &YtdlpExit) -> Result<PathBuf, String> {
    let from_file = std::fs::read_to_string(&exit.path_output_file)
        .ok()
        .and_then(|text| {
            text.lines()
                .map(str::trim)
                .rfind(|line| !line.is_empty())
                .map(str::to_string)
        });
    let raw = from_file.or_else(|| {
        exit.stdout
            .lines()
            .map(str::trim)
            .rfind(|line| {
                !line.is_empty()
                    && !line.starts_with('[')
                    && !line.starts_with('{')
                    && !line.starts_with("WARNING")
            })
            .map(str::to_string)
    });
    let raw = raw
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| "Could not find a valid filepath in yt-dlp's output.".to_string())?;
    let resolved = resolve_path(&raw);
    if !is_path_within(&resolved, &exit.download_dir) {
        return Err(format!(
            "Downloaded file path \"{}\" is outside the expected directory \"{}\".",
            resolved.display(),
            exit.download_dir.display()
        ));
    }
    Ok(resolved)
}

fn on_ytdlp_exit(exit: YtdlpExit) {
    let id = exit.id;
    let Some(cancelled) = with_session(id, |session| {
        session.ytdlp = None;
        session.cancelled
    }) else {
        let _ = std::fs::remove_file(&exit.path_output_file);
        return;
    };
    let cleanup = || {
        let _ = std::fs::remove_file(&exit.path_output_file);
    };
    if cancelled {
        cleanup();
        complete_session(
            id,
            CANCELLED_STATUS,
            Outcome::Cancelled,
            CompletionMeta {
                progress_message: Some(CANCELLED_PROGRESS.into()),
                ..CompletionMeta::default()
            },
        );
        return;
    }
    if exit.code != Some(0) {
        cleanup();
        let code = exit
            .code
            .map_or("null".to_string(), |code| code.to_string());
        let tail: Vec<&str> = exit
            .stderr
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect();
        let tail = tail[tail.len().saturating_sub(12)..].join(" | ");
        crate::logging::warn(&format!("yt-dlp exited with code {code}: {tail}"));
        send_progress(
            id,
            format!("❌ Download failed: yt-dlp process exited with code {code}"),
        );
        if exit.stderr.contains("different Team IDs")
            || exit.stderr.contains("[PYI-")
            || exit.stderr.contains("Failed to load Python shared library")
        {
            send_progress(
                id,
                "   macOS blocked the bundled yt-dlp runtime (code signing). Install yt-dlp via Homebrew as a workaround, or use a rebuilt ROSI release with signed helpers.",
            );
        }
        send_progress(id, "   Check console and stderr output above for details.");
        complete_session(
            id,
            "❌ Download failed.",
            Outcome::Failed,
            CompletionMeta::default(),
        );
        return;
    }
    let downloaded = match downloaded_file_path(&exit) {
        Ok(path) => path,
        Err(error) => {
            cleanup();
            send_progress(
                id,
                "❌ Error determining downloaded file path after download.",
            );
            send_progress(id, format!("   Error: {error}"));
            complete_session(
                id,
                "❌ Failed (File Path Error).",
                Outcome::Failed,
                CompletionMeta::default(),
            );
            return;
        }
    };
    cleanup();
    send_progress(
        id,
        format!(
            "✅ Download finished. Identified file: {}",
            downloaded.display()
        ),
    );
    if exit.effective.convert_enabled {
        run_conversion(id, downloaded, &exit.effective, &exit.ffmpeg_command);
        return;
    }
    send_progress(id, "ℹ️ Conversion not enabled for this download.");
    let expect_convert =
        with_session(id, |session| session.reporter.plan.expect_convert).unwrap_or(false);
    let phase = if expect_convert {
        Phase::Convert
    } else {
        Phase::Download
    };
    emit_phase(id, phase, 100.0, "Download complete", Some(false));
    let format = downloaded
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .filter(|ext| !ext.is_empty());
    complete_session(
        id,
        "✅ Download complete (no conversion).",
        Outcome::Success,
        CompletionMeta {
            format,
            bytes: crate::fs_util::file_size(&downloaded),
            file_path: Some(downloaded),
            ..CompletionMeta::default()
        },
    );
}

/// Port of npm `sanitize-filename`: strip reserved/control characters,
/// Windows reserved names, and trailing dots/spaces; cap at 255 bytes.
pub fn sanitize_filename(input: &str) -> String {
    let mut cleaned: String = input
        .chars()
        .filter(|c| {
            !matches!(c, '/' | '?' | '<' | '>' | '\\' | ':' | '*' | '|' | '"')
                && !(('\u{0}'..='\u{1f}').contains(c) || ('\u{80}'..='\u{9f}').contains(c))
        })
        .collect();
    if cleaned.chars().all(|c| c == '.') {
        cleaned.clear();
    }
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        cleaned.clear();
    }
    let trimmed = cleaned.trim_end_matches(['.', ' ']).to_string();
    let mut end = trimmed.len().min(255);
    while end > 0 && !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    trimmed[..end].to_string()
}

fn emit_convert_progress(id: u64, percent: Option<f64>, status: &str) {
    let value = percent.unwrap_or(f64::NAN);
    emit_phase(
        id,
        Phase::Convert,
        value,
        status,
        Some(percent.is_none() || !value.is_finite()),
    );
}

fn show_ffmpeg_missing_dialog(ffmpeg: &Path) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let Some(app) = crate::app_state::app() else {
        return;
    };
    let mut dialog = app
        .dialog()
        .message(format!(
            "Failed to start conversion: FFmpeg not found at {}.\n\nROSI uses bundled FFmpeg by default. If you set a custom FFmpeg path, make sure it points to a valid FFmpeg binary.",
            ffmpeg.display()
        ))
        .title("FFmpeg Error")
        .kind(MessageDialogKind::Error);
    if let Some(window) = crate::app_state::main_window() {
        dialog = dialog.parent(&window);
    }
    dialog.show(|_| {});
}

fn run_conversion(id: u64, downloaded: PathBuf, effective: &Settings, ffmpeg: &Path) {
    send_progress(id, "⏳ Checking if conversion is needed...");
    let original_name = downloaded
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut sanitized = sanitize_filename(&original_name);
    if sanitized.trim().is_empty() {
        let ext = downloaded
            .extension()
            .map(|ext| format!(".{}", ext.to_string_lossy()))
            .unwrap_or_else(|| ".mp4".to_string());
        sanitized = format!("download_{}{ext}", crate::app_state::now_ms());
        send_progress(
            id,
            format!("⚠️ Original filename contained only invalid characters. Using: {sanitized}"),
        );
    }
    let parent = downloaded
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let input = parent.join(&sanitized);
    if input != downloaded {
        if let Err(error) = crate::fs_util::rename_replacing(&downloaded, &input) {
            send_progress(id, format!("❌ Error setting up conversion: {error}"));
            complete_session(
                id,
                "❌ Conversion failed (setup error).",
                Outcome::Failed,
                CompletionMeta::default(),
            );
            return;
        }
        send_progress(id, format!("Renamed to sanitized filename: {sanitized}"));
    }
    let input_name = input
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let target = if effective.convert_format.is_empty() {
        "mp4".to_string()
    } else {
        effective.convert_format.to_lowercase()
    };
    let input_ext = input
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if input_ext == target {
        send_progress(
            id,
            format!(
                "ℹ️ Downloaded file is already {} ({input_name}). Skipping conversion.",
                target.to_uppercase()
            ),
        );
        complete_session(
            id,
            &format!("✅ Done (Already {}).", target.to_uppercase()),
            Outcome::Success,
            CompletionMeta {
                format: Some(target),
                bytes: crate::fs_util::file_size(&input),
                file_path: Some(input),
                ..CompletionMeta::default()
            },
        );
        return;
    }
    let output = input.with_extension(&target);
    let output_name = output
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if output.exists() {
        send_progress(
            id,
            format!("⚠️ Output file {output_name} already exists. Overwriting."),
        );
    }
    send_progress(
        id,
        format!("🎬 Converting {input_name} to {}...", target.to_uppercase()),
    );

    let codecs = probe_media_codecs(ffmpeg, &input);
    let encoder = resolve_video_encoder(effective);
    if !is_active(id) {
        return;
    }
    emit_convert_progress(id, Some(0.0), "Converting...");
    let args = build_ffmpeg_args(&input, &output, &target, &encoder, Some(&codecs));
    let reencodes_video =
        args.iter().any(|arg| arg == "-c:v") && !args.iter().any(|arg| arg == "copy");
    if effective.gpu_acceleration && encoder != "copy" && reencodes_video {
        send_progress(id, format!("🖥️ Using GPU acceleration ({encoder})"));
    }

    let mut command = crate::process_util::command(ffmpeg, &args, &[], true);
    let child = match crate::process_util::spawn(&mut command) {
        Ok(child) => child,
        Err(error) => {
            let cancelled = with_session(id, |session| session.cancelled).unwrap_or(true);
            if cancelled {
                complete_session(
                    id,
                    CANCELLED_STATUS,
                    Outcome::Cancelled,
                    CompletionMeta {
                        progress_message: Some(CANCELLED_PROGRESS.into()),
                        ..CompletionMeta::default()
                    },
                );
            } else if error.kind() == std::io::ErrorKind::NotFound {
                send_progress(
                    id,
                    format!(
                        "❌ Failed to start conversion: FFmpeg was not found at {}.",
                        ffmpeg.display()
                    ),
                );
                complete_session(
                    id,
                    "❌ Conversion failed (FFmpeg not found).",
                    Outcome::Failed,
                    CompletionMeta::default(),
                );
                show_ffmpeg_missing_dialog(ffmpeg);
            } else {
                send_progress(
                    id,
                    format!("❌ Failed to start conversion process: {error}"),
                );
                complete_session(
                    id,
                    "❌ Conversion failed (ffmpeg spawn error).",
                    Outcome::Failed,
                    CompletionMeta::default(),
                );
            }
            return;
        }
    };
    let registered = with_session(id, |session| {
        if session.cancelled {
            false
        } else {
            session.ffmpeg = Some(Arc::clone(&child));
            true
        }
    })
    .unwrap_or(false);
    if !registered {
        crate::process_util::terminate_tree(&child);
        return;
    }

    let progress_state = Arc::new(Mutex::new(progress::FfmpegProgressState::new(
        codecs.duration_seconds,
    )));
    let stdout_reader = {
        let state = Arc::clone(&progress_state);
        read_lines(child.take_stdout(), move |line| {
            if !is_active(id) {
                return;
            }
            let percent = state
                .lock()
                .ok()
                .and_then(|mut state| state.push(&format!("{line}\n")));
            if let Some(percent) = percent {
                emit_convert_progress(id, Some(percent), "Converting...");
            }
        })
    };
    let stderr_reader = read_lines(child.take_stderr(), move |line| {
        let text = line.trim();
        if !text.is_empty() {
            send_progress(id, format!("[ffmpeg] {text}"));
        }
    });

    let keep_original = effective.keep_original_after_convert;
    std::thread::spawn(move || {
        let status = match child.wait_timeout(FFMPEG_CONVERT_TIMEOUT) {
            Ok(Some(status)) => Some(status),
            Ok(None) => {
                if with_session(id, |session| {
                    session
                        .ffmpeg
                        .as_ref()
                        .is_some_and(|owned| Arc::ptr_eq(owned, &child))
                })
                .unwrap_or(false)
                {
                    send_progress(id, "❌ Conversion timed out after 10 minutes.");
                    crate::process_util::terminate_tree(&child);
                    complete_session(
                        id,
                        "❌ Conversion failed (timeout).",
                        Outcome::Failed,
                        CompletionMeta::default(),
                    );
                }
                let _ = child.wait();
                None
            }
            Err(_) => None,
        };
        let _ = stdout_reader.join();
        let _ = stderr_reader.join();
        let Some(status) = status else {
            return;
        };
        let Some(cancelled) = with_session(id, |session| {
            session.ffmpeg = None;
            session.cancelled
        }) else {
            return;
        };
        if cancelled {
            complete_session(
                id,
                CANCELLED_STATUS,
                Outcome::Cancelled,
                CompletionMeta {
                    progress_message: Some(CANCELLED_PROGRESS.into()),
                    ..CompletionMeta::default()
                },
            );
            return;
        }
        if status.code() == Some(0) {
            emit_convert_progress(id, Some(100.0), "Conversion complete");
            send_progress(
                id,
                format!("🎉 Successfully converted to {}", output.display()),
            );
            let paths_differ = if cfg!(windows) {
                input.to_string_lossy().to_lowercase() != output.to_string_lossy().to_lowercase()
            } else {
                input != output
            };
            if !keep_original && paths_differ {
                send_progress(
                    id,
                    format!("Attempting to delete original file: {input_name}"),
                );
                match std::fs::remove_file(&input) {
                    Ok(()) => send_progress(id, format!("🗑️ Deleted original file: {input_name}")),
                    Err(error) => send_progress(
                        id,
                        format!("⚠️ Could not delete original file: {input_name} ({error})"),
                    ),
                }
            } else if keep_original {
                send_progress(
                    id,
                    format!("ℹ️ Keeping original file ({input_name}) as per settings."),
                );
            } else {
                send_progress(
                    id,
                    format!(
                        "ℹ️ Input and output paths resolved to the same file ({}), cannot delete original.",
                        input.display()
                    ),
                );
            }
            complete_session(
                id,
                "🎬 Conversion complete.",
                Outcome::Success,
                CompletionMeta {
                    format: Some(target),
                    bytes: crate::fs_util::file_size(&output),
                    file_path: Some(output),
                    ..CompletionMeta::default()
                },
            );
        } else {
            let code = status
                .code()
                .map_or("null".to_string(), |code| code.to_string());
            send_progress(
                id,
                format!("❌ Conversion failed: FFmpeg process exited with code {code}"),
            );
            send_progress(id, "   Check FFmpeg output above for details.");
            let _ = std::fs::remove_file(&output);
            complete_session(
                id,
                "❌ Conversion failed.",
                Outcome::Failed,
                CompletionMeta::default(),
            );
        }
    });
}

#[derive(serde::Serialize)]
pub struct Started {
    started: bool,
}

#[tauri::command(async)]
pub fn download_video(options: Value) -> IpcResult<Started> {
    let request = match crate::validation::validate_download_request(&options) {
        Ok(request) => request,
        Err(error) => return ipc::from_error(error),
    };
    if !can_start(Owner::Manual) {
        return ipc::err(NOT_AVAILABLE, "A queue download is already in progress.");
    }
    let on_complete: CompletionCallback =
        Box::new(|completion| crate::activity::record(&completion));
    match start_download(request, Owner::Manual, None, on_complete) {
        Ok(()) => ipc::ok(Started { started: true }),
        Err(error) => {
            crate::logging::error(&format!("Error in download-video handler: {error}"));
            ipc::err(INTERNAL_ERROR, "Failed to start download.")
        }
    }
}

#[tauri::command(async)]
pub fn cancel_download() {
    cancel_active_session(true);
}
