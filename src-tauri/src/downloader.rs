//! Single active download session: yt-dlp download, optional FFmpeg
//! conversion, cancellation, structured progress, and completion reporting.
//!
//! Lock discipline: the `ACTIVE` session lock is never held while emitting
//! events, touching windows, or invoking completion callbacks (the queue's
//! callback takes the queue lock). `EVENT_PUBLISH` serializes lifecycle event
//! publication with replacing the active session so older terminal events
//! cannot arrive after a newer session becomes current.

use crate::command_builders::{
    build_ffmpeg_args, build_ytdlp_args, resolve_video_encoder, YtdlpArgsInput,
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
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

pub type CompletionCallback = Box<dyn FnOnce(DownloadCompletion) + Send + 'static>;

const CANCELLED_STATUS: &str = "⏹️ Cancelled.";
const CANCELLED_PROGRESS: &str = "⏹️ Download/Conversion cancelled by user.";
const MAX_DIAGNOSTIC_LINE: usize = 32 * 1024;
const PIPE_READER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

struct Session {
    id: u64,
    completion_id: String,
    started_at: u64,
    request: DownloadRequestOptions,
    owner: Owner,
    cancelled: bool,
    cancel_notify: bool,
    ytdlp: Option<Arc<crate::process_util::ManagedChild>>,
    ytdlp_exit_pending: bool,
    conversion_pending: bool,
    ffmpeg: Option<Arc<crate::process_util::ManagedChild>>,
    on_complete: Option<CompletionCallback>,
    ytdlp_postprocess: bool,
    ytdlp_download_finished: bool,
    conversion_format: Option<String>,
    completed_paths: Vec<PathBuf>,
    failed_paths: Vec<PathBuf>,
    conversion_failures: Vec<String>,
    reporter: Reporter,
}

static ACTIVE: Mutex<Option<Session>> = Mutex::new(None);
static SESSION_CHANGED: Condvar = Condvar::new();
static FINALIZING: Mutex<Vec<u64>> = Mutex::new(Vec::new());
static FINALIZATION_CHANGED: Condvar = Condvar::new();

struct CompletionFinalizer(u64);

impl CompletionFinalizer {
    fn begin(id: u64) -> Self {
        FINALIZING
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(id);
        Self(id)
    }
}

impl Drop for CompletionFinalizer {
    fn drop(&mut self) {
        FINALIZING
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|id| *id != self.0);
        FINALIZATION_CHANGED.notify_all();
        SESSION_CHANGED.notify_all();
    }
}

fn finalizing_ids() -> Vec<u64> {
    FINALIZING
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .copied()
        .collect()
}

fn wait_for_finalizations(ids: &[u64]) {
    let mut pending = FINALIZING.lock().unwrap_or_else(|p| p.into_inner());
    while ids.iter().any(|id| pending.contains(id)) {
        pending = FINALIZATION_CHANGED
            .wait(pending)
            .unwrap_or_else(|p| p.into_inner());
    }
}

static STARTUP: Mutex<()> = Mutex::new(());
static EVENT_PUBLISH: Mutex<()> = Mutex::new(());
static COUNTER: AtomicU64 = AtomicU64::new(0);

fn lock() -> MutexGuard<'static, Option<Session>> {
    ACTIVE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn wait_for_session_completion(id: u64) {
    let mut active = lock();
    while active.as_ref().is_some_and(|session| session.id == id) {
        active = SESSION_CHANGED
            .wait(active)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
    drop(active);
    wait_for_finalizations(&[id]);
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
    let _publish = EVENT_PUBLISH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
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
    let _publish = EVENT_PUBLISH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
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
    let mut event = progress::build_event(
        phase,
        percent,
        session.reporter.plan,
        session.reporter.queue.as_ref(),
        status,
        details,
        indeterminate,
        metrics,
    );
    event.session_id = Some(session.id);
    event
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
    output_paths: Option<Vec<PathBuf>>,
    failed_paths: Option<Vec<PathBuf>>,
    error: Option<String>,
    progress_message: Option<String>,
    suppress_legacy_complete: bool,
}

fn partial_completion_meta(session: &Session) -> CompletionMeta {
    let completed = session.completed_paths.clone();
    let failed = session.failed_paths.clone();
    let final_path = completed.last().cloned();
    let bytes = completed
        .iter()
        .filter_map(|path| crate::fs_util::file_size(path))
        .fold(0u64, u64::saturating_add);
    CompletionMeta {
        format: final_path
            .as_deref()
            .and_then(output_format_from_path)
            .or_else(|| session.conversion_format.clone()),
        bytes: (!completed.is_empty()).then_some(bytes),
        file_path: final_path,
        output_paths: (!completed.is_empty()).then_some(completed),
        failed_paths: (!failed.is_empty()).then_some(failed),
        error: (!session.conversion_failures.is_empty())
            .then(|| session.conversion_failures.join("; ")),
        ..CompletionMeta::default()
    }
}

fn output_format_from_path(path: &Path) -> Option<String> {
    path.extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
        .filter(|extension| !extension.is_empty())
}

fn complete_session(id: u64, status_message: &str, outcome: Outcome, meta: CompletionMeta) {
    let publish = EVENT_PUBLISH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let session = {
        let mut guard = lock();
        match guard.as_ref() {
            Some(session) if session.id == id => {
                let finalizer = CompletionFinalizer::begin(id);
                guard.take().map(|session| (session, finalizer))
            }
            _ => None,
        }
    };
    let Some((mut session, _finalizer)) = session else {
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
        output_paths: meta.output_paths.as_ref().map(|paths| {
            paths
                .iter()
                .map(|path| resolve_path(path).to_string_lossy().into_owned())
                .collect()
        }),
        failed_paths: meta.failed_paths.as_ref().map(|paths| {
            paths
                .iter()
                .map(|path| resolve_path(path).to_string_lossy().into_owned())
                .collect()
        }),
        size_bytes,
        format: meta.format.clone(),
        error: meta
            .error
            .clone()
            .or_else(|| (outcome == Outcome::Failed).then(|| status_message.to_string())),
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
    let mut idle = progress::idle_event(session.reporter.queue.as_ref());
    idle.session_id = Some(session.id);
    crate::app_state::emit("job-progress", idle.clone());
    if session.reporter.show_taskbar {
        apply_taskbar(&idle);
    }
    drop(publish);
    match outcome {
        Outcome::Success => crate::stats::record(outcome, meta.format.as_deref(), size_bytes),
        _ => crate::stats::record(outcome, None, None),
    }
    if let Some(callback) = session.on_complete.take() {
        callback(completion);
    }
    SESSION_CHANGED.notify_all();
}

/// Cancel the active session. `notify` controls whether the user-facing
/// cancellation message and legacy `complete` event are sent for queue runs.
pub fn cancel_active_session(notify: bool) {
    let (id, owner, children, partial, wait_for_ytdlp) = {
        let mut guard = lock();
        let Some(session) = guard.as_mut() else {
            // Snapshot under ACTIVE so completion cannot clear the slot before
            // registering its pending callback. Do not wait on future sessions.
            let pending = finalizing_ids();
            drop(guard);
            wait_for_finalizations(&pending);
            return;
        };
        session.cancelled = true;
        session.cancel_notify = notify || session.owner == Owner::Manual;
        let wait_for_ytdlp =
            session.ytdlp_exit_pending || session.conversion_pending || session.ytdlp.is_some();
        if wait_for_ytdlp {
            session.ytdlp_exit_pending = true;
        }
        (
            session.id,
            session.owner,
            [session.ffmpeg.take(), session.ytdlp.take()],
            partial_completion_meta(session),
            wait_for_ytdlp,
        )
    };
    for child in children.into_iter().flatten() {
        crate::process_util::terminate_tree(&child);
    }
    if wait_for_ytdlp {
        wait_for_session_completion(id);
        return;
    }
    let show = notify || owner == Owner::Manual;
    complete_session(
        id,
        CANCELLED_STATUS,
        Outcome::Cancelled,
        CompletionMeta {
            progress_message: show.then(|| CANCELLED_PROGRESS.to_string()),
            suppress_legacy_complete: !show,
            ..partial
        },
    );
}

pub fn kill_all_processes() {
    let (id, children, partial, wait_for_ytdlp) = {
        let mut guard = lock();
        let Some(session) = guard.as_mut() else {
            // Snapshot under ACTIVE so completion cannot clear the slot before
            // registering its pending callback. Do not wait on future sessions.
            let pending = finalizing_ids();
            drop(guard);
            wait_for_finalizations(&pending);
            return;
        };
        session.cancelled = true;
        session.cancel_notify = false;
        let wait_for_ytdlp =
            session.ytdlp_exit_pending || session.conversion_pending || session.ytdlp.is_some();
        if wait_for_ytdlp {
            session.ytdlp_exit_pending = true;
        }
        (
            session.id,
            [session.ytdlp.take(), session.ffmpeg.take()],
            partial_completion_meta(session),
            wait_for_ytdlp,
        )
    };
    for child in children.into_iter().flatten() {
        crate::process_util::terminate_tree(&child);
    }
    if wait_for_ytdlp {
        wait_for_session_completion(id);
        return;
    }
    complete_session(
        id,
        CANCELLED_STATUS,
        Outcome::Cancelled,
        CompletionMeta {
            suppress_legacy_complete: true,
            ..partial
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
) -> std::sync::mpsc::Receiver<()> {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let Some(mut reader) = reader else {
            let _ = sender.send(());
            return;
        };
        let marker = b" [truncated] ";
        let edge = (MAX_DIAGNOSTIC_LINE.saturating_sub(marker.len())) / 2;
        let mut line = Vec::with_capacity(MAX_DIAGNOSTIC_LINE);
        let mut prefix = Vec::with_capacity(edge);
        let mut tail = VecDeque::with_capacity(edge);
        let mut truncated = false;
        let mut chunk = [0u8; 8192];
        let finish = |line: &mut Vec<u8>,
                      prefix: &mut Vec<u8>,
                      tail: &mut VecDeque<u8>,
                      truncated: &mut bool,
                      on_line: &mut dyn FnMut(&str)| {
            if *truncated {
                let mut bounded = Vec::with_capacity(prefix.len() + marker.len() + tail.len());
                bounded.extend_from_slice(prefix);
                bounded.extend_from_slice(marker);
                bounded.extend(tail.iter().copied());
                let text = String::from_utf8_lossy(&bounded);
                on_line(text.as_ref());
            } else {
                let text = String::from_utf8_lossy(line);
                on_line(text.as_ref());
            }
            line.clear();
            prefix.clear();
            tail.clear();
            *truncated = false;
        };
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    for byte in &chunk[..read] {
                        if *byte == b'\n' || *byte == b'\r' {
                            finish(
                                &mut line,
                                &mut prefix,
                                &mut tail,
                                &mut truncated,
                                &mut on_line,
                            );
                            continue;
                        }
                        if !truncated && line.len() < MAX_DIAGNOSTIC_LINE {
                            line.push(*byte);
                            continue;
                        }
                        if !truncated {
                            prefix.extend_from_slice(&line[..edge.min(line.len())]);
                            tail.extend(line[line.len().saturating_sub(edge)..].iter().copied());
                            line.clear();
                            truncated = true;
                        }
                        if edge > 0 {
                            if tail.len() == edge {
                                tail.pop_front();
                            }
                            tail.push_back(*byte);
                        }
                    }
                }
            }
        }
        if truncated || !line.is_empty() {
            finish(
                &mut line,
                &mut prefix,
                &mut tail,
                &mut truncated,
                &mut on_line,
            );
        }
        let _ = sender.send(());
    });
    receiver
}

fn wait_for_readers(readers: [std::sync::mpsc::Receiver<()>; 2]) -> bool {
    let deadline = std::time::Instant::now() + PIPE_READER_TIMEOUT;
    readers.into_iter().all(|reader| {
        matches!(
            reader.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())),
            Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
        )
    })
}

fn append_bounded(buffer: &Mutex<String>, line: &str, limit: usize, keep_tail: bool) {
    let Ok(mut text) = buffer.lock() else {
        return;
    };
    let marker = "[truncated]";
    let max_line = limit.saturating_sub(1);
    let bounded_line = if line.len() > max_line {
        let edge = max_line.saturating_sub(marker.len()) / 2;
        let mut start = line.len().saturating_sub(edge);
        while start < line.len() && !line.is_char_boundary(start) {
            start += 1;
        }
        let mut end = edge.min(line.len());
        while end > 0 && !line.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}{}{}", &line[..end], marker, &line[start..])
    } else {
        line.to_string()
    };
    let addition_len = bounded_line.len().saturating_add(1);
    if text.len() + addition_len > limit {
        if !keep_tail {
            return;
        }
        let mut cut = text
            .len()
            .saturating_add(addition_len)
            .saturating_sub(limit);
        while cut < text.len() && !text.is_char_boundary(cut) {
            cut += 1;
        }
        text.drain(..cut);
    }
    text.push_str(&bounded_line);
    text.push('\n');
}

struct DownloadStage {
    directory: PathBuf,
    preserve_on_drop: bool,
    root_identity: FileIdentity,
    owned_entries: Option<HashMap<PathBuf, FileIdentity>>,
}

impl Drop for DownloadStage {
    fn drop(&mut self) {
        if self.preserve_on_drop {
            crate::logging::warn(&format!(
                "Retaining staged original files for recovery in {}",
                self.directory.display()
            ));
            return;
        }

        let Some(expected_entries) = self.owned_entries.as_ref() else {
            crate::logging::warn(&format!(
                "Retaining download staging without a complete ownership snapshot: {}",
                self.directory.display()
            ));
            return;
        };
        let Some(parent) = self.directory.parent() else {
            crate::logging::warn("Retaining download staging because its parent is unavailable.");
            return;
        };
        for _ in 0..32 {
            let quarantine = parent.join(format!(".rosi-retire-{}", crate::fs_util::uuid_v4()));
            match install_no_replace(&self.directory, &quarantine) {
                Ok(()) => {
                    let verified = file_identity(&quarantine) == Some(self.root_identity)
                        && stage_entries_match(&quarantine, expected_entries);
                    if verified {
                        if let Err(error) = std::fs::remove_dir_all(&quarantine) {
                            crate::logging::warn(&format!(
                                "Could not remove verified download staging {}: {error}",
                                quarantine.display()
                            ));
                        }
                    } else if install_no_replace(&quarantine, &self.directory).is_err() {
                        crate::logging::warn(&format!(
                            "Retaining changed download staging at {} because its original path was claimed.",
                            quarantine.display()
                        ));
                    } else {
                        crate::logging::warn(&format!(
                            "Retaining changed download staging at {} after ownership verification failed.",
                            self.directory.display()
                        ));
                    }
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                Err(error) => {
                    crate::logging::warn(&format!(
                        "Could not quarantine owned download staging {}: {error}",
                        self.directory.display()
                    ));
                    return;
                }
            }
        }
        crate::logging::warn(&format!(
            "Could not reserve a retirement name for download staging {}; retaining it.",
            self.directory.display()
        ));
    }
}

impl DownloadStage {
    fn snapshot_owned_contents(&mut self) -> Result<(), String> {
        match snapshot_stage_entries(&self.directory) {
            Ok(entries) => {
                self.owned_entries = Some(entries);
                Ok(())
            }
            Err(error) => {
                self.preserve_on_drop = true;
                Err(error)
            }
        }
    }

    fn identity_for(&self, path: &Path) -> Option<FileIdentity> {
        let relative = path.strip_prefix(&self.directory).ok()?;
        self.owned_entries.as_ref()?.get(relative).copied()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    volume: u32,
    #[cfg(windows)]
    index: u64,
}

fn file_identity(path: &Path) -> Option<FileIdentity> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() && !metadata.is_dir() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use std::ptr::{null, null_mut};
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        };

        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        let read = unsafe { GetFileInformationByHandle(handle, &mut information) } != 0;
        unsafe {
            CloseHandle(handle);
        }
        read.then_some(FileIdentity {
            volume: information.dwVolumeSerialNumber,
            index: (u64::from(information.nFileIndexHigh) << 32)
                | u64::from(information.nFileIndexLow),
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = metadata;
        None
    }
}

fn snapshot_stage_entries(root: &Path) -> Result<HashMap<PathBuf, FileIdentity>, String> {
    let mut entries = HashMap::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            let identity = file_identity(&path)
                .ok_or_else(|| format!("Could not verify staged entry {}", path.display()))?;
            let relative = path
                .strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_path_buf();
            entries.insert(relative, identity);
            if metadata.is_dir() {
                pending.push(path);
            }
        }
    }
    Ok(entries)
}

fn stage_entries_match(root: &Path, expected: &HashMap<PathBuf, FileIdentity>) -> bool {
    snapshot_stage_entries(root).is_ok_and(|current| {
        current
            .iter()
            .all(|(path, identity)| expected.get(path) == Some(identity))
    })
}

fn reserve_download_stage(download_dir: &Path) -> Result<DownloadStage, String> {
    for _ in 0..32 {
        let directory = download_dir.join(format!(".rosi-download-{}", crate::fs_util::uuid_v4()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&directory) {
            Ok(()) => {
                let Some(root_identity) = file_identity(&directory) else {
                    return Err(format!(
                        "Could not verify the reserved staging directory {}; it was retained.",
                        directory.display()
                    ));
                };
                return Ok(DownloadStage {
                    directory,
                    preserve_on_drop: false,
                    root_identity,
                    owned_entries: Some(HashMap::new()),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not reserve a private download staging directory.".to_string())
}

fn reserve_path_output_file(download_dir: &Path, session_id: u64) -> Result<PathBuf, String> {
    for _ in 0..32 {
        let path = download_dir.join(format!(
            ".rosi-path-{session_id}-{}.txt",
            crate::fs_util::uuid_v4()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => {
                drop(file);
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not reserve a unique yt-dlp path metadata file.".to_string())
}

/// Start a download. Validation failures are reported through the normal
/// completion path; `Err` only means another owner holds the session slot.
pub fn start_download(
    options: DownloadRequestOptions,
    owner: Owner,
    queue_progress: Option<QueueProgress>,
    on_complete: CompletionCallback,
) -> Result<u64, String> {
    let settings = crate::settings::load();
    let request = resolve_preset_options(&settings, options);
    let effective = apply_request_to_settings(&settings, &request);
    let snapshot = resolved_snapshot(&request, &effective);
    let plan = progress::resolve_plan(&effective);
    let startup = STARTUP
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let existing_owner = lock().as_ref().map(|session| session.owner);
    match existing_owner {
        Some(current) if current != owner => {
            return Err("Download session already active with a different owner.".to_string())
        }
        Some(_) => cancel_active_session(false),
        None => {}
    }
    let id = COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let session = Session {
        id,
        completion_id: crate::fs_util::uuid_v4(),
        started_at: crate::app_state::now_ms(),
        request: snapshot,
        owner,
        cancelled: false,
        cancel_notify: false,
        ytdlp: None,
        ytdlp_exit_pending: false,
        conversion_pending: false,
        ffmpeg: None,
        on_complete: Some(on_complete),
        ytdlp_postprocess: false,
        ytdlp_download_finished: false,
        conversion_format: None,
        completed_paths: Vec::new(),
        failed_paths: Vec::new(),
        conversion_failures: Vec::new(),
        reporter: Reporter::new(plan, queue_progress, effective.show_taskbar_progress),
    };
    {
        let _publish = EVENT_PUBLISH
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *lock() = Some(session);
    }
    let mut startup = Some(startup);

    let requested_ffmpeg = request
        .ffmpeg_path
        .clone()
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| settings.ffmpeg_path.clone());
    let ffmpeg_command = crate::sidecars::effective_ffmpeg(Some(&requested_ffmpeg));
    let ytdlp = crate::sidecars::ytdlp_path();
    let url = request.url.clone();

    if !is_safe_http_url(&url) {
        send_progress(id, "⚠️ Invalid or missing URL.");
        drop(startup.take());
        complete_session(
            id,
            "❌ Failed (Invalid URL).",
            Outcome::Failed,
            CompletionMeta::default(),
        );
        return Ok(id);
    }
    if request.output_path.trim().is_empty() {
        send_progress(id, "⚠️ Invalid or missing download folder.");
        drop(startup.take());
        complete_session(
            id,
            "❌ Failed (Invalid Folder).",
            Outcome::Failed,
            CompletionMeta::default(),
        );
        return Ok(id);
    }
    if !ytdlp.exists() {
        send_progress(
            id,
            format!("❌ Error: yt-dlp binary not found at {}", ytdlp.display()),
        );
        drop(startup.take());
        complete_session(
            id,
            "❌ Failed (Missing Dependency).",
            Outcome::Failed,
            CompletionMeta::default(),
        );
        return Ok(id);
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
            drop(startup.take());
            complete_session(
                id,
                "❌ Failed (Initial Setup Error).",
                Outcome::Failed,
                CompletionMeta::default(),
            );
            return Ok(id);
        }
    } else if !download_dir.is_dir() {
        send_progress(
            id,
            format!(
                "❌ Download path is not a directory: {}",
                download_dir.display()
            ),
        );
        drop(startup.take());
        complete_session(
            id,
            "❌ Failed (Invalid Folder).",
            Outcome::Failed,
            CompletionMeta::default(),
        );
        return Ok(id);
    }

    let download_stage = match reserve_download_stage(&download_dir) {
        Ok(stage) => stage,
        Err(error) => {
            send_progress(
                id,
                format!("❌ Could not reserve private download staging: {error}"),
            );
            drop(startup.take());
            complete_session(
                id,
                "❌ Failed (Initial Setup Error).",
                Outcome::Failed,
                CompletionMeta {
                    error: Some(error),
                    ..CompletionMeta::default()
                },
            );
            return Ok(id);
        }
    };
    let path_output_file = match reserve_path_output_file(&download_stage.directory, id) {
        Ok(path) => path,
        Err(error) => {
            send_progress(
                id,
                format!("❌ Could not reserve download metadata: {error}"),
            );
            drop(startup.take());
            complete_session(
                id,
                "❌ Failed (Initial Setup Error).",
                Outcome::Failed,
                CompletionMeta {
                    error: Some(error),
                    ..CompletionMeta::default()
                },
            );
            return Ok(id);
        }
    };
    #[cfg(feature = "e2e")]
    let media_tool_setup = if request.url.contains("repair-ffprobe-only=1") {
        crate::ffmpeg_guard::FfmpegToolGuard::create_ffprobe_only(Some(&requested_ffmpeg))
    } else {
        crate::ffmpeg_guard::FfmpegToolGuard::create(Some(&requested_ffmpeg))
    };
    #[cfg(not(feature = "e2e"))]
    let media_tool_setup = crate::ffmpeg_guard::FfmpegToolGuard::create(Some(&requested_ffmpeg));
    let ffmpeg_guard = match media_tool_setup {
        Ok(guard) => guard,
        Err(error) => {
            let _ = std::fs::remove_file(&path_output_file);
            send_progress(id, format!("❌ Secure media-tool setup failed: {error}"));
            drop(startup.take());
            complete_session(
                id,
                "❌ Download failed (secure media-tool setup error).",
                Outcome::Failed,
                CompletionMeta {
                    error: Some(error),
                    ..CompletionMeta::default()
                },
            );
            return Ok(id);
        }
    };
    let ffmpeg_location = ffmpeg_guard.location().to_string_lossy().into_owned();
    let network_guard = match crate::network_security::NetworkSecurityGuard::start() {
        Ok(guard) => guard,
        Err(error) => {
            let _ = std::fs::remove_file(&path_output_file);
            send_progress(id, format!("❌ Secure network setup failed: {error}"));
            drop(startup.take());
            complete_session(
                id,
                "❌ Download failed (secure network setup error).",
                Outcome::Failed,
                CompletionMeta {
                    error: Some(error),
                    ..CompletionMeta::default()
                },
            );
            return Ok(id);
        }
    };
    let (args, status_messages) = build_ytdlp_args(YtdlpArgsInput {
        download_dir: &download_stage.directory,
        url: &url,
        settings: &effective,
        options: &request,
        ffmpeg_location: Some(&ffmpeg_location),
        path_output_file: Some(&path_output_file),
    });
    let mut args = args;
    let proxy_url = network_guard.proxy_url().to_string();
    let proxy_index = args
        .iter()
        .position(|argument| argument == "--")
        .unwrap_or(args.len());
    args.splice(
        proxy_index..proxy_index,
        ["--proxy".to_string(), proxy_url.clone()],
    );
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
    let display_args = args
        .iter()
        .enumerate()
        .map(|(index, argument)| {
            if index > 0 && args[index - 1] == "--proxy" {
                "<ephemeral proxy credentials>"
            } else if index > 0 && args[index - 1] == "--ffmpeg-location" {
                "<protected local media tools>"
            } else {
                argument
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    send_progress(id, format!("   Command: yt-dlp {display_args}"));

    if !active_not_cancelled(id) {
        let _ = std::fs::remove_file(&path_output_file);
        return Ok(id);
    }

    let certificate = crate::command_builders::ytdlp_e2e_ca_path();
    let mut extra_env = vec![("PYTHONUNBUFFERED", "1")];
    if let Some(certificate) = certificate.as_deref() {
        extra_env.push(("SSL_CERT_FILE", certificate));
    }
    let mut command = crate::process_util::command(&ytdlp, &args, &extra_env, true);
    let child = match crate::process_util::spawn(&mut command) {
        Ok(child) => child,
        Err(error) => {
            let _ = std::fs::remove_file(&path_output_file);
            send_progress(id, format!("❌ Failed to start download process: {error}"));
            drop(startup.take());
            complete_session(
                id,
                "❌ Download failed (process spawn error).",
                Outcome::Failed,
                CompletionMeta::default(),
            );
            return Ok(id);
        }
    };
    let registered = with_session(id, |session| {
        if session.cancelled {
            false
        } else {
            session.ytdlp = Some(Arc::clone(&child));
            session.ytdlp_exit_pending = true;
            true
        }
    })
    .unwrap_or(false);
    if !registered {
        crate::process_util::terminate_tree(&child);
        let _ = std::fs::remove_file(&path_output_file);
        drop(startup.take());
        return Ok(id);
    }
    drop(startup.take());

    let stdout_buffer = Arc::new(Mutex::new(String::new()));
    let stderr_buffer = Arc::new(Mutex::new(String::new()));
    let stdout_reader = {
        let buffer = Arc::clone(&stdout_buffer);
        let proxy_url = proxy_url.clone();
        read_lines(child.take_stdout(), move |line| {
            if line.is_empty() || !is_active(id) {
                return;
            }
            let sanitized = line.replace(&proxy_url, "<ephemeral proxy credentials>");
            append_bounded(&buffer, &sanitized, MAX_OUTPUT_BUFFER, true);
            handle_ytdlp_line(id, &sanitized, false);
        })
    };
    let stderr_reader = {
        let buffer = Arc::clone(&stderr_buffer);
        let proxy_url = proxy_url.clone();
        read_lines(child.take_stderr(), move |line| {
            if line.is_empty() || !is_active(id) {
                return;
            }
            let sanitized = line.replace(&proxy_url, "<ephemeral proxy credentials>");
            append_bounded(&buffer, &sanitized, MAX_ERROR_BUFFER, true);
            handle_ytdlp_line(id, &sanitized, true);
        })
    };
    std::thread::spawn(move || {
        let code = match child.wait() {
            Ok(status) => status.code(),
            Err(_) => {
                crate::process_util::terminate_tree(&child);
                child.wait().ok().and_then(|status| status.code())
            }
        };
        let diagnostics_complete = wait_for_readers([stdout_reader, stderr_reader]);
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
            diagnostics_complete,
            path_output_file,
            stage: download_stage,
            download_dir,
            effective,
            ffmpeg_command,
        });
        drop(network_guard);
        drop(ffmpeg_guard);
    });
    Ok(id)
}

struct YtdlpExit {
    id: u64,
    code: Option<i32>,
    stdout: String,
    stderr: String,
    diagnostics_complete: bool,
    path_output_file: PathBuf,
    stage: DownloadStage,
    download_dir: PathBuf,
    effective: Settings,
    ffmpeg_command: PathBuf,
}

fn downloaded_file_paths(exit: &YtdlpExit) -> Result<Vec<PathBuf>, String> {
    let recorded = std::fs::read_to_string(&exit.path_output_file)
        .ok()
        .map(|text| {
            text.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|paths| !paths.is_empty());
    let raw_paths = recorded.unwrap_or_else(|| {
        exit.stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('[') && !line.starts_with('{'))
            .map(str::to_string)
            .collect()
    });
    let mut paths = Vec::new();
    let mut unique = HashSet::new();
    for raw in raw_paths {
        let resolved = resolve_path(&raw);
        if !is_path_within(&resolved, &exit.stage.directory) {
            return Err(format!(
                "Downloaded file path \"{}\" is outside the expected directory \"{}\".",
                resolved.display(),
                exit.stage.directory.display()
            ));
        }
        if !std::fs::symlink_metadata(&resolved)
            .is_ok_and(|metadata| metadata.file_type().is_file())
        {
            continue;
        }
        if resolved.file_name().is_some_and(|name| {
            name.to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(".part")
        }) {
            continue;
        }
        if unique.insert(resolved.clone()) {
            paths.push(resolved);
        }
    }
    if paths.is_empty() {
        return Err("Could not find a valid filepath in yt-dlp's output.".to_string());
    }
    Ok(paths)
}

fn install_download_output(temp: &Path, download_dir: &Path) -> Result<PathBuf, String> {
    let file_name = temp
        .file_name()
        .ok_or_else(|| "Downloaded output has no file name.".to_string())?;
    install_download_output_named(temp, download_dir, &file_name.to_string_lossy())
}

fn install_download_output_named(
    temp: &Path,
    download_dir: &Path,
    preferred_name: &str,
) -> Result<PathBuf, String> {
    let preferred = Path::new(preferred_name)
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Downloaded output has an invalid destination name.".to_string())?;
    let preferred = preferred.to_string_lossy();
    let preferred_path = Path::new(preferred.as_ref());
    let extension = preferred_path
        .extension()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty());
    let stem = preferred_path
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| preferred.to_string());
    sync_staged_file(temp)
        .map_err(|error| format!("Could not sync downloaded file {}: {error}", temp.display()))?;
    for suffix in 0..10_000u32 {
        let name = if suffix == 0 {
            preferred.to_string()
        } else if let Some(extension) = extension.as_deref() {
            format!("{stem} ({suffix}).{extension}")
        } else {
            format!("{stem} ({suffix})")
        };
        let destination = download_dir.join(name);
        match install_no_replace(temp, &destination) {
            Ok(()) => {
                crate::fs_util::sync_directory(download_dir).map_err(|error| {
                    format!(
                        "Could not sync download directory {} after installing {}: {error}",
                        download_dir.display(),
                        destination.display()
                    )
                })?;
                return Ok(destination);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not atomically install downloaded output {} without replacing it: {error}",
                    destination.display()
                ));
            }
        }
    }
    Err("Could not find an unused name for a downloaded output.".to_string())
}

fn sync_staged_file(path: &Path) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true);
    options.open(path)?.sync_all()
}

const CAPTION_EXTENSIONS: &[&str] = &[
    "ass", "json3", "lrc", "srt", "ssa", "srv1", "srv2", "srv3", "ttml", "vtt",
];

fn caption_sidecar_paths(
    input: &Path,
    stage: &DownloadStage,
) -> Result<Vec<(PathBuf, FileIdentity)>, String> {
    let parent = input
        .parent()
        .ok_or_else(|| format!("Caption source has no parent: {}", input.display()))?;
    let stem = input
        .file_stem()
        .ok_or_else(|| format!("Caption source has no filename: {}", input.display()))?;
    let prefix = format!("{}.", stem.to_string_lossy());
    let owned_entries = stage.owned_entries.as_ref().ok_or_else(|| {
        format!(
            "Could not enumerate captions without an ownership snapshot for {}",
            parent.display()
        )
    })?;
    let mut paths = Vec::new();
    for (relative, expected_identity) in owned_entries {
        let path = stage.directory.join(relative);
        if path.parent() != Some(parent) {
            continue;
        }
        let Some(name) = path.file_name().map(|name| name.to_string_lossy()) else {
            continue;
        };
        let extension = path
            .extension()
            .map(|extension| extension.to_string_lossy().to_ascii_lowercase());
        if !name.starts_with(&prefix)
            || !extension
                .as_deref()
                .is_some_and(|extension| CAPTION_EXTENSIONS.contains(&extension))
        {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            format!(
                "Could not inspect staged caption {}: {error}",
                path.display()
            )
        })?;
        if !metadata.file_type().is_file() {
            return Err(format!(
                "Staged caption is not a regular file: {}",
                path.display()
            ));
        }
        if file_identity(&path) != Some(*expected_identity) {
            return Err(format!(
                "Staged caption changed after ownership was recorded: {}",
                path.display()
            ));
        }
        paths.push((path, *expected_identity));
    }
    paths.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(paths)
}

fn publish_owned_caption_sidecar(
    sidecar: &Path,
    expected_identity: FileIdentity,
    download_dir: &Path,
    preferred_name: &str,
    stage: &mut DownloadStage,
) -> Result<PathBuf, String> {
    if file_identity(sidecar) != Some(expected_identity) {
        stage.preserve_on_drop = true;
        return Err(format!(
            "Staged caption changed before publication: {}",
            sidecar.display()
        ));
    }
    let mut quarantined = None;
    for _ in 0..32 {
        let quarantine = sidecar
            .parent()
            .ok_or_else(|| format!("Staged caption has no parent: {}", sidecar.display()))?
            .join(format!(
                ".rosi-caption-publish-{}",
                crate::fs_util::uuid_v4()
            ));
        match install_no_replace(sidecar, &quarantine) {
            Ok(()) => {
                quarantined = Some(quarantine);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                stage.preserve_on_drop = true;
                return Err(format!(
                    "Could not quarantine staged caption {} for identity verification: {error}",
                    sidecar.display()
                ));
            }
        }
    }
    let Some(quarantine) = quarantined else {
        stage.preserve_on_drop = true;
        return Err(format!(
            "Could not reserve a caption identity-check path for {}.",
            sidecar.display()
        ));
    };
    if file_identity(&quarantine) != Some(expected_identity) {
        stage.preserve_on_drop = true;
        let restore = install_no_replace(&quarantine, sidecar);
        return Err(match restore {
            Ok(()) => format!(
                "A replacement caption was restored to staging and was not published: {}",
                sidecar.display()
            ),
            Err(error) => format!(
                "A replacement caption was not published and remains in recovery staging at {}: {error}",
                quarantine.display()
            ),
        });
    }

    match install_download_output_named(&quarantine, download_dir, preferred_name) {
        Ok(published) if file_identity(&published) == Some(expected_identity) => Ok(published),
        Ok(published) => {
            stage.preserve_on_drop = true;
            Err(format!(
                "Caption identity changed during publication; inspect the staged recovery at {} (destination {}).",
                sidecar.display(),
                published.display()
            ))
        }
        Err(error) => {
            stage.preserve_on_drop = true;
            if quarantine.exists() {
                let _ = install_no_replace(&quarantine, sidecar);
            }
            Err(format!(
                "Could not preserve requested caption sidecar {}: {error}",
                sidecar.display()
            ))
        }
    }
}

fn publish_caption_sidecars(
    input: &Path,
    output_media: &Path,
    download_dir: &Path,
    stage: &mut DownloadStage,
) -> Result<Vec<PathBuf>, String> {
    let input_stem = input
        .file_stem()
        .ok_or_else(|| format!("Caption source has no filename: {}", input.display()))?
        .to_string_lossy();
    let output_stem = output_media
        .file_stem()
        .ok_or_else(|| {
            format!(
                "Caption destination has no filename: {}",
                output_media.display()
            )
        })?
        .to_string_lossy();
    let sidecars = match caption_sidecar_paths(input, stage) {
        Ok(sidecars) => sidecars,
        Err(error) => {
            stage.preserve_on_drop = true;
            return Err(error);
        }
    };
    let mut published = Vec::new();
    for (sidecar, expected_identity) in sidecars {
        let Some(name) = sidecar.file_name().map(|name| name.to_string_lossy()) else {
            continue;
        };
        let Some(suffix) = name.strip_prefix(&format!("{input_stem}")) else {
            continue;
        };
        let preferred = format!("{output_stem}{suffix}");
        match publish_owned_caption_sidecar(
            &sidecar,
            expected_identity,
            download_dir,
            &preferred,
            stage,
        ) {
            Ok(path) => published.push(path),
            Err(error) => {
                stage.preserve_on_drop = true;
                return Err(format!(
                    "Could not preserve requested caption sidecar {}: {error}",
                    sidecar.display()
                ));
            }
        }
    }
    Ok(published)
}

fn install_downloaded_file_paths(
    stage_paths: Vec<PathBuf>,
    download_dir: &Path,
    stage: &mut DownloadStage,
    write_subtitles: bool,
) -> (Vec<PathBuf>, Vec<PathBuf>, Vec<String>) {
    let mut paths = Vec::with_capacity(stage_paths.len());
    let mut failed_paths = Vec::new();
    let mut errors = Vec::new();
    for staged in stage_paths {
        let installed = match install_download_output(&staged, download_dir) {
            Ok(path) => path,
            Err(error) => {
                if staged.exists() {
                    stage.preserve_on_drop = true;
                }
                failed_paths.push(staged.clone());
                errors.push(format!("{}: {error}", staged.display()));
                continue;
            }
        };
        paths.push(installed.clone());
        if write_subtitles {
            if let Err(error) = publish_caption_sidecars(&staged, &installed, download_dir, stage) {
                errors.push(error);
            }
        }
    }
    (paths, failed_paths, errors)
}

fn completion_meta_for_paths(
    paths: Vec<PathBuf>,
    failed_paths: Vec<PathBuf>,
    error: Option<String>,
) -> CompletionMeta {
    let final_path = paths.last().cloned();
    let bytes = paths
        .iter()
        .filter_map(|path| crate::fs_util::file_size(path))
        .fold(0u64, u64::saturating_add);
    let format = final_path
        .as_ref()
        .and_then(|path| path.extension())
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase());
    CompletionMeta {
        format,
        bytes: (!paths.is_empty()).then_some(bytes),
        file_path: final_path,
        output_paths: (!paths.is_empty()).then_some(paths),
        failed_paths: (!failed_paths.is_empty()).then_some(failed_paths),
        error,
        ..CompletionMeta::default()
    }
}

fn recover_staged_downloads(exit: &mut YtdlpExit) -> (Vec<PathBuf>, Vec<PathBuf>, Vec<String>) {
    let staged = match downloaded_file_paths(exit) {
        Ok(paths) => paths,
        Err(error) => {
            // Early failures have no media. Explicit cancellation may discard
            // unfinished owned parts only after helper diagnostics drain.
            // The destructor still verifies identity and contents on removal.
            let discard_cancelled_parts = exit.diagnostics_complete
                && with_session(exit.id, |session| session.cancelled).unwrap_or(false);
            if exit.stage.owned_entries.as_ref().is_some_and(|entries| {
                entries.keys().all(|relative| {
                    let path = exit.stage.directory.join(relative);
                    path == exit.path_output_file
                        || (discard_cancelled_parts
                            && path.extension().is_some_and(|extension| {
                                extension.to_string_lossy().eq_ignore_ascii_case("part")
                            })
                            && std::fs::symlink_metadata(&path)
                                .is_ok_and(|metadata| metadata.file_type().is_file()))
                })
            }) {
                return (Vec::new(), Vec::new(), Vec::new());
            }
            exit.stage.preserve_on_drop = true;
            return (
                Vec::new(),
                Vec::new(),
                vec![format!(
                    "{error} Staging retained for recovery at {}.",
                    exit.stage.directory.display()
                )],
            );
        }
    };
    install_downloaded_file_paths(
        staged,
        &exit.download_dir,
        &mut exit.stage,
        exit.effective.write_subtitles,
    )
}

fn on_ytdlp_exit(mut exit: YtdlpExit) {
    if let Err(error) = exit.stage.snapshot_owned_contents() {
        crate::logging::error(&format!(
            "Could not snapshot download staging ownership for {}: {error}",
            exit.stage.directory.display()
        ));
    }
    let id = exit.id;
    let Some((cancelled, cancel_notify)) = with_session(id, |session| {
        session.ytdlp = None;
        (session.cancelled, session.cancel_notify)
    }) else {
        let _ = std::fs::remove_file(&exit.path_output_file);
        SESSION_CHANGED.notify_all();
        return;
    };
    let path_output_file = exit.path_output_file.clone();
    let cleanup = || {
        let _ = std::fs::remove_file(&path_output_file);
    };
    if cancelled {
        let (paths, failed, errors) = recover_staged_downloads(&mut exit);
        cleanup();
        complete_session(
            id,
            CANCELLED_STATUS,
            Outcome::Cancelled,
            CompletionMeta {
                progress_message: cancel_notify.then(|| CANCELLED_PROGRESS.into()),
                suppress_legacy_complete: !cancel_notify,
                ..completion_meta_for_paths(
                    paths,
                    failed,
                    (!errors.is_empty()).then(|| errors.join("; ")),
                )
            },
        );
        return;
    }
    if !exit.diagnostics_complete {
        let (paths, mut failed, mut errors) = recover_staged_downloads(&mut exit);
        cleanup();
        let message = "yt-dlp output pipes remained open after the process ended.";
        errors.push(message.to_string());
        failed.extend(paths.iter().filter(|path| !path.exists()).cloned());
        send_progress(id, format!("❌ Download failed: {message}"));
        complete_session(
            id,
            "❌ Download failed (helper output did not close).",
            Outcome::Failed,
            completion_meta_for_paths(paths, failed, Some(errors.join("; "))),
        );
        return;
    }
    if exit.code != Some(0) {
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
        let (paths, failed, mut errors) = recover_staged_downloads(&mut exit);
        errors.insert(0, format!("yt-dlp process exited with code {code}"));
        cleanup();
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
            completion_meta_for_paths(paths, failed, Some(errors.join("; "))),
        );
        return;
    }
    let staged_downloads = match downloaded_file_paths(&exit) {
        Ok(paths) => paths,
        Err(error) => {
            exit.stage.preserve_on_drop = true;
            let error = format!(
                "{error} Staging retained for recovery at {}.",
                exit.stage.directory.display()
            );
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
                CompletionMeta {
                    error: Some(error),
                    ..CompletionMeta::default()
                },
            );
            return;
        }
    };
    if exit.effective.convert_enabled {
        cleanup();
        send_progress(
            id,
            format!(
                "✅ Download finished. Identified {} file{}.",
                staged_downloads.len(),
                if staged_downloads.len() == 1 { "" } else { "s" }
            ),
        );
        let handed_off = with_session(id, |session| {
            if session.cancelled {
                false
            } else {
                session.ytdlp_exit_pending = false;
                session.conversion_pending = true;
                true
            }
        })
        .unwrap_or(false);
        if !handed_off {
            let (paths, failed, errors) = recover_staged_downloads(&mut exit);
            complete_session(
                id,
                CANCELLED_STATUS,
                Outcome::Cancelled,
                CompletionMeta {
                    progress_message: cancel_notify.then(|| CANCELLED_PROGRESS.into()),
                    suppress_legacy_complete: !cancel_notify,
                    ..completion_meta_for_paths(
                        paths,
                        failed,
                        (!errors.is_empty()).then(|| errors.join("; ")),
                    )
                },
            );
            return;
        }
        run_conversion(
            id,
            staged_downloads,
            exit.stage,
            exit.download_dir,
            exit.effective,
            exit.ffmpeg_command,
        );
        return;
    }
    let (downloaded, failed_paths, errors) = install_downloaded_file_paths(
        staged_downloads,
        &exit.download_dir,
        &mut exit.stage,
        exit.effective.write_subtitles,
    );
    cleanup();
    if !errors.is_empty() || downloaded.is_empty() {
        let errors = if errors.is_empty() {
            vec!["No completed downloaded files could be published.".to_string()]
        } else {
            errors
        };
        let error = errors.join("; ");
        send_progress(
            id,
            format!("❌ Could not safely install downloaded files: {error}"),
        );
        complete_session(
            id,
            "❌ Failed (File Installation Error).",
            Outcome::Failed,
            completion_meta_for_paths(downloaded, failed_paths, Some(error)),
        );
        return;
    }
    send_progress(
        id,
        format!(
            "✅ Download finished. Identified {} file{}.",
            downloaded.len(),
            if downloaded.len() == 1 { "" } else { "s" }
        ),
    );
    send_progress(id, "ℹ️ Conversion not enabled for this download.");
    let expect_convert =
        with_session(id, |session| session.reporter.plan.expect_convert).unwrap_or(false);
    let phase = if expect_convert {
        Phase::Convert
    } else {
        Phase::Download
    };
    emit_phase(id, phase, 100.0, "Download complete", Some(false));
    let final_path = downloaded
        .last()
        .cloned()
        .expect("download paths validated");
    let format = final_path
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .filter(|ext| !ext.is_empty());
    let mut meta = completion_meta_for_paths(downloaded, Vec::new(), None);
    if meta.format.is_none() {
        meta.format = format;
        meta.file_path = Some(final_path);
    }
    let (cancelled, cancel_notify) =
        with_session(id, |session| (session.cancelled, session.cancel_notify))
            .unwrap_or((true, false));
    if cancelled {
        meta.progress_message = cancel_notify.then(|| CANCELLED_PROGRESS.into());
        meta.suppress_legacy_complete = !cancel_notify;
        complete_session(id, CANCELLED_STATUS, Outcome::Cancelled, meta);
    } else {
        complete_session(
            id,
            "✅ Download complete (no conversion).",
            Outcome::Success,
            meta,
        );
    }
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

#[derive(Debug)]
enum ConversionFailure {
    Cancelled,
    TimedOut,
    Spawn(std::io::Error),
    Exit(Option<i32>, String),
    Setup(String),
    SetupPublished { message: String, path: PathBuf },
}

fn active_not_cancelled(id: u64) -> bool {
    with_session(id, |session| !session.cancelled).unwrap_or(false)
}

fn install_conversion_output_for_session(
    id: u64,
    temp: &Path,
    input: &Path,
    target: &str,
    download_dir: &Path,
) -> Result<PathBuf, ConversionFailure> {
    with_session(id, |session| {
        if session.cancelled {
            return Err(ConversionFailure::Cancelled);
        }
        let output = install_conversion_output(temp, input, target, download_dir)
            .map_err(ConversionFailure::Setup)?;
        session.conversion_format = Some(target.to_string());
        session.completed_paths.push(output.clone());
        Ok(output)
    })
    .unwrap_or(Err(ConversionFailure::Cancelled))
}

fn record_conversion_failure(id: u64, path: &Path, detail: &str) {
    with_session(id, |session| {
        if !session.cancelled {
            session.failed_paths.push(path.to_path_buf());
            session
                .conversion_failures
                .push(format!("{}: {detail}", path.display()));
        }
    });
}

struct ConversionTemp {
    directory: PathBuf,
    output: PathBuf,
}

impl Drop for ConversionTemp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.output);
        let _ = std::fs::remove_dir(&self.directory);
    }
}

fn reserve_conversion_temp(input: &Path, target: &str) -> Result<ConversionTemp, String> {
    let parent = input.parent().unwrap_or_else(|| Path::new("."));
    for _ in 0..32 {
        let directory = parent.join(format!(".rosi-convert-{}", crate::fs_util::uuid_v4()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&directory) {
            Ok(()) => {
                return Ok(ConversionTemp {
                    output: directory.join(format!("output.{target}")),
                    directory,
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not reserve a unique conversion staging path.".to_string())
}

#[cfg(unix)]
fn path_cstring(path: &Path) -> std::io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error.to_string()))
}

/// Move a complete staging file into place atomically without replacing an
/// existing destination. The staging directory is beside the source, keeping
/// this operation on the same volume even for removable filesystems.
#[cfg(target_os = "linux")]
fn install_no_replace(temp: &Path, destination: &Path) -> std::io::Result<()> {
    let temp = path_cstring(temp)?;
    let destination = path_cstring(destination)?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            temp.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
fn install_no_replace(temp: &Path, destination: &Path) -> std::io::Result<()> {
    let temp = path_cstring(temp)?;
    let destination = path_cstring(destination)?;
    let result =
        unsafe { libc::renamex_np(temp.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn install_no_replace(temp: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    // `std::fs::rename` replaces an existing destination on Windows. Use the
    // Win32 move primitive without MOVEFILE_REPLACE_EXISTING so an output
    // collision fails atomically instead of overwriting a user's file.
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    let temp: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result =
        unsafe { MoveFileExW(temp.as_ptr(), destination.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if result != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn install_no_replace(temp: &Path, destination: &Path) -> std::io::Result<()> {
    // Hard-link installation is also an atomic no-replace operation. Some
    // filesystems do not support it; in that case conversion fails safely.
    std::fs::hard_link(temp, destination)
}

fn install_conversion_output(
    temp: &Path,
    input: &Path,
    target: &str,
    download_dir: &Path,
) -> Result<PathBuf, String> {
    let raw_stem = input
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut stem = sanitize_filename(&raw_stem);
    if stem.trim().is_empty() {
        stem = format!("download_{}", crate::fs_util::uuid_v4());
    }
    // Leave room for the largest collision suffix (` (9999)`) and the
    // longest supported extension so every installed component stays within
    // common 255-byte filesystem limits.
    let max_stem_bytes = 255usize.saturating_sub(7 + 1 + target.len());
    let mut end = stem.len().min(max_stem_bytes);
    while end > 0 && !stem.is_char_boundary(end) {
        end -= 1;
    }
    stem.truncate(end);
    sync_staged_file(temp).map_err(|error| {
        format!(
            "Could not sync converted output {}: {error}",
            temp.display()
        )
    })?;
    for suffix in 0..10_000u32 {
        let name = if suffix == 0 {
            format!("{stem}.{target}")
        } else {
            format!("{stem} ({suffix}).{target}")
        };
        let candidate = download_dir.join(name);
        match install_no_replace(temp, &candidate) {
            Ok(()) => {
                crate::fs_util::sync_directory(download_dir).map_err(|error| {
                    format!(
                        "Could not sync output directory {} after installing {}: {error}",
                        download_dir.display(),
                        candidate.display()
                    )
                })?;
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                "Could not atomically install converted output {} without replacing it: {error}",
                candidate.display()
            ))
            }
        }
    }
    Err("Could not find an unused filename for the converted output.".to_string())
}

fn execute_ffmpeg(
    id: u64,
    ffmpeg: &Path,
    args: &[String],
    duration_seconds: Option<f64>,
    progress_start: f64,
    progress_span: f64,
) -> Result<(), ConversionFailure> {
    if !active_not_cancelled(id) {
        return Err(ConversionFailure::Cancelled);
    }
    let mut command = crate::process_util::command(ffmpeg, args, &[], true);
    let child = crate::process_util::spawn(&mut command).map_err(ConversionFailure::Spawn)?;
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
        return Err(ConversionFailure::Cancelled);
    }

    let progress_state = Arc::new(Mutex::new(progress::FfmpegProgressState::new(
        duration_seconds,
    )));
    let stdout_reader = {
        let state = Arc::clone(&progress_state);
        read_lines(child.take_stdout(), move |line| {
            if !active_not_cancelled(id) {
                return;
            }
            let percent = state
                .lock()
                .ok()
                .and_then(|mut state| state.push(&format!("{line}\n")));
            if let Some(percent) = percent {
                let aggregate =
                    progress_start + (percent.clamp(0.0, 100.0) / 100.0) * progress_span;
                emit_convert_progress(id, Some(aggregate), "Converting...");
            }
        })
    };
    let stderr = Arc::new(Mutex::new(String::new()));
    let stderr_reader = {
        let stderr = Arc::clone(&stderr);
        read_lines(child.take_stderr(), move |line| {
            let text = line.trim();
            if !text.is_empty() {
                append_bounded(&stderr, text, MAX_ERROR_BUFFER, true);
                send_progress(id, format!("[ffmpeg] {text}"));
            }
        })
    };

    let mut timed_out = false;
    let status = match child.wait_timeout(FFMPEG_CONVERT_TIMEOUT) {
        Ok(Some(status)) => Some(status),
        Ok(None) => {
            timed_out = true;
            if with_session(id, |session| {
                session
                    .ffmpeg
                    .as_ref()
                    .is_some_and(|owned| Arc::ptr_eq(owned, &child))
            })
            .unwrap_or(false)
            {
                send_progress(id, "❌ Conversion timed out after 10 minutes.");
            }
            crate::process_util::terminate_tree(&child);
            child.wait().ok()
        }
        Err(_) => {
            crate::process_util::terminate_tree(&child);
            child.wait().ok()
        }
    };
    let readers_complete = wait_for_readers([stdout_reader, stderr_reader]);
    timed_out |= !readers_complete;
    let was_cancelled = with_session(id, |session| {
        if session
            .ffmpeg
            .as_ref()
            .is_some_and(|owned| Arc::ptr_eq(owned, &child))
        {
            session.ffmpeg = None;
        }
        session.cancelled
    })
    .unwrap_or(true);
    if was_cancelled {
        return Err(ConversionFailure::Cancelled);
    }
    if timed_out {
        return Err(ConversionFailure::TimedOut);
    }
    let Some(status) = status else {
        return Err(ConversionFailure::Setup(
            "Could not read FFmpeg's exit status.".to_string(),
        ));
    };
    if status.success() {
        Ok(())
    } else {
        Err(ConversionFailure::Exit(
            status.code(),
            stderr.lock().map(|text| text.clone()).unwrap_or_default(),
        ))
    }
}

fn probe_media_codecs_for_session(
    id: u64,
    ffmpeg: &Path,
    input: &Path,
) -> Result<crate::command_builders::SourceCodecs, String> {
    let args = vec![
        "-hide_banner".to_string(),
        "-protocol_whitelist".to_string(),
        "file".to_string(),
        "-i".to_string(),
        input.to_string_lossy().into_owned(),
    ];
    let mut command = crate::process_util::command(ffmpeg, &args, &[], true);
    let child = match crate::process_util::spawn(&mut command) {
        Ok(child) => child,
        Err(error) => {
            crate::logging::warn(&format!("Failed to spawn ffmpeg codec probe: {error}"));
            return Err(format!("Could not start the codec probe: {error}"));
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
        return Err("The download session ended before its codec probe completed.".into());
    }

    let output =
        crate::process_util::wait_with_output(&child, CODEC_PROBE_TIMEOUT, 4096, MAX_ERROR_BUFFER);
    let cancelled = with_session(id, |session| {
        if session
            .ffmpeg
            .as_ref()
            .is_some_and(|owned| Arc::ptr_eq(owned, &child))
        {
            session.ffmpeg = None;
        }
        session.cancelled
    })
    .unwrap_or(true);
    if cancelled {
        return Err("The download session was cancelled during its codec probe.".into());
    }
    match output {
        Ok(output) if output.timed_out => {
            crate::logging::warn("FFmpeg codec probe timed out or left output pipes open.");
            Err("The codec probe timed out or left output pipes open.".into())
        }
        Ok(output) if output.stderr.len() >= MAX_ERROR_BUFFER => {
            crate::logging::warn("FFmpeg codec probe diagnostics reached the capture limit.");
            Err("The codec probe diagnostics were truncated at the capture limit.".into())
        }
        Ok(output) if !output.stderr.contains("Input #") || !output.stderr.contains("Stream #") => {
            crate::logging::warn(
                "FFmpeg codec probe returned no complete input stream diagnostics.",
            );
            Err("The codec probe did not identify the input streams.".into())
        }
        Ok(output) => Ok(crate::command_builders::parse_codecs(&output.stderr)),
        Err(error) => {
            crate::logging::warn(&format!("Failed to run ffmpeg codec probe: {error}"));
            Err(format!("Failed to run the codec probe: {error}"))
        }
    }
}

struct ConversionPosition {
    index: usize,
    count: usize,
}

struct ConvertedOutput {
    path: PathBuf,
    unchanged: bool,
    preserve_original: bool,
}

fn convert_one(
    id: u64,
    input: &Path,
    download_dir: &Path,
    target: &str,
    effective: &Settings,
    ffmpeg: &Path,
    position: ConversionPosition,
) -> Result<ConvertedOutput, ConversionFailure> {
    let input_ext = input
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let progress_start = position.index as f64 * 100.0 / position.count.max(1) as f64;
    let progress_span = 100.0 / position.count.max(1) as f64;
    if input_ext == target {
        send_progress(
            id,
            format!(
                "ℹ️ {} is already {}. Skipping conversion.",
                input.file_name().unwrap_or_default().to_string_lossy(),
                target.to_uppercase()
            ),
        );
        emit_convert_progress(id, Some(progress_start + progress_span), "Entry complete");
        return Ok(ConvertedOutput {
            path: input.to_path_buf(),
            unchanged: true,
            preserve_original: false,
        });
    }
    send_progress(
        id,
        format!(
            "🎬 Converting {} to {}...",
            input.file_name().unwrap_or_default().to_string_lossy(),
            target.to_uppercase()
        ),
    );
    let (codecs, probe_complete) = match probe_media_codecs_for_session(id, ffmpeg, input) {
        Ok(codecs) => (codecs, true),
        Err(error) => {
            crate::logging::warn(&format!(
                "Could not reliably inspect codecs for {}; retaining the original after conversion: {error}",
                input.display()
            ));
            (crate::command_builders::SourceCodecs::default(), false)
        }
    };
    if !active_not_cancelled(id) {
        return Err(ConversionFailure::Cancelled);
    }
    let preserve_original =
        crate::command_builders::must_preserve_original(target, &codecs, probe_complete);
    let selected_encoder = resolve_video_encoder(effective);
    let original_args = build_ffmpeg_args(input, input, target, &selected_encoder, Some(&codecs));
    let gpu_encoder_used = effective.gpu_acceleration
        && selected_encoder != "copy"
        && original_args
            .windows(2)
            .any(|pair| pair[0] == "-c:v" && pair[1] == selected_encoder);
    let encoders = if gpu_encoder_used {
        vec![selected_encoder.clone(), "libx264".to_string()]
    } else {
        vec![selected_encoder]
    };
    for (attempt, encoder) in encoders.iter().enumerate() {
        let staging = reserve_conversion_temp(input, target).map_err(ConversionFailure::Setup)?;
        let temp = &staging.output;
        let args = build_ffmpeg_args(input, temp, target, encoder, Some(&codecs));
        if *encoder != "libx264" && *encoder != "copy" {
            send_progress(id, format!("🖥️ Using GPU acceleration ({encoder})"));
        } else if attempt > 0 {
            send_progress(
                id,
                "⚠️ GPU encoder failed. Retrying conversion on the CPU (libx264).",
            );
        }
        match execute_ffmpeg(
            id,
            ffmpeg,
            &args,
            codecs.duration_seconds,
            progress_start,
            progress_span,
        ) {
            Ok(()) => {
                if !active_not_cancelled(id) {
                    let _ = std::fs::remove_file(temp);
                    return Err(ConversionFailure::Cancelled);
                }
                if !std::fs::symlink_metadata(temp)
                    .is_ok_and(|metadata| metadata.file_type().is_file())
                    || crate::fs_util::file_size(temp).unwrap_or(0) == 0
                {
                    let _ = std::fs::remove_file(temp);
                    return Err(ConversionFailure::Setup(
                        "FFmpeg reported success without creating a non-empty output.".to_string(),
                    ));
                }
                let output = match install_conversion_output_for_session(
                    id,
                    temp,
                    input,
                    target,
                    download_dir,
                ) {
                    Ok(output) => output,
                    Err(error) => {
                        let _ = std::fs::remove_file(temp);
                        return Err(error);
                    }
                };
                emit_convert_progress(id, Some(progress_start + progress_span), "Entry complete");
                return Ok(ConvertedOutput {
                    path: output,
                    unchanged: false,
                    preserve_original,
                });
            }
            Err(ConversionFailure::Exit(code, _stderr)) if attempt + 1 < encoders.len() => {
                let _ = std::fs::remove_file(temp);
                send_progress(
                    id,
                    format!(
                        "⚠️ GPU FFmpeg attempt exited with code {}; trying CPU encoder.",
                        code.map_or("null".to_string(), |value| value.to_string())
                    ),
                );
            }
            Err(error) => {
                let _ = std::fs::remove_file(temp);
                return Err(error);
            }
        }
    }
    Err(ConversionFailure::Setup(
        "No compatible FFmpeg encoder attempt completed.".to_string(),
    ))
}

fn failure_message(failure: &ConversionFailure) -> String {
    match failure {
        ConversionFailure::Cancelled => "Conversion cancelled.".into(),
        ConversionFailure::TimedOut => "FFmpeg conversion timed out after 10 minutes.".into(),
        ConversionFailure::Spawn(error) if error.kind() == std::io::ErrorKind::NotFound => {
            "FFmpeg was not found at the configured path.".into()
        }
        ConversionFailure::Spawn(error) => format!("Could not start FFmpeg: {error}"),
        ConversionFailure::Exit(code, details) => format!(
            "FFmpeg exited with code {}. {}",
            code.map_or("null".to_string(), |value| value.to_string()),
            details
                .lines()
                .rev()
                .take(8)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join(" | ")
        ),
        ConversionFailure::Setup(message) => message.clone(),
        ConversionFailure::SetupPublished { message, .. } => message.clone(),
    }
}

fn complete_conversion_batch(
    id: u64,
    target: String,
    total_entries: usize,
    completed: Vec<PathBuf>,
    failed: Vec<PathBuf>,
    failures: Vec<String>,
    cancelled: bool,
) {
    let final_path = completed.last().cloned();
    let format = final_path
        .as_deref()
        .and_then(output_format_from_path)
        .or_else(|| Some(target.clone()));
    let bytes = completed
        .iter()
        .filter_map(|path| crate::fs_util::file_size(path))
        .fold(0u64, u64::saturating_add);
    let meta = CompletionMeta {
        format,
        bytes: (!completed.is_empty()).then_some(bytes),
        file_path: final_path,
        output_paths: (!completed.is_empty()).then_some(completed),
        failed_paths: (!failed.is_empty()).then_some(failed.clone()),
        error: (!failures.is_empty()).then(|| failures.join("; ")),
        progress_message: cancelled.then(|| CANCELLED_PROGRESS.into()),
        ..CompletionMeta::default()
    };
    if cancelled {
        complete_session(id, CANCELLED_STATUS, Outcome::Cancelled, meta);
    } else if failed.is_empty() {
        complete_session(id, "🎬 Conversion complete.", Outcome::Success, meta);
    } else {
        let status = format!(
            "❌ Conversion partially failed ({} of {} entries).",
            failed.len(),
            total_entries
        );
        complete_session(id, &status, Outcome::Failed, meta);
    }
}

#[derive(Debug)]
struct PublicationFailure {
    media_path: Option<PathBuf>,
    detail: String,
}

fn find_published_identity(download_dir: &Path, identity: FileIdentity) -> Option<PathBuf> {
    std::fs::read_dir(download_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
                && file_identity(path) == Some(identity)
        })
}

fn publish_staged_source(
    input: &Path,
    download_dir: &Path,
    stage: &mut DownloadStage,
) -> Result<PathBuf, PublicationFailure> {
    match install_download_output(input, download_dir) {
        Ok(path) => Ok(path),
        Err(error) => {
            if input.exists() {
                stage.preserve_on_drop = true;
                Err(PublicationFailure {
                    media_path: None,
                    detail: format!(
                        "{error} The original remains in owned staging at {}.",
                        input.display()
                    ),
                })
            } else {
                // A post-install directory sync can fail after the no-replace
                // move succeeded. In that case the source is already present
                // at its final path, so preserving the now-empty staging
                // directory would add no protection.
                let media_path = stage
                    .identity_for(input)
                    .and_then(|identity| find_published_identity(download_dir, identity));
                Err(PublicationFailure {
                    media_path,
                    detail: error,
                })
            }
        }
    }
}

fn publish_staged_source_with_captions(
    input: &Path,
    download_dir: &Path,
    stage: &mut DownloadStage,
    write_subtitles: bool,
) -> Result<PathBuf, PublicationFailure> {
    let published = publish_staged_source(input, download_dir, stage)?;
    if write_subtitles {
        if let Err(detail) = publish_caption_sidecars(input, &published, download_dir, stage) {
            stage.preserve_on_drop = true;
            return Err(PublicationFailure {
                media_path: Some(published),
                detail,
            });
        }
    }
    Ok(published)
}

fn push_completed_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}

fn publish_same_extension_for_session(
    id: u64,
    input: &Path,
    target: &str,
    download_dir: &Path,
    stage: &mut DownloadStage,
    write_subtitles: bool,
) -> Result<PathBuf, ConversionFailure> {
    with_session(id, |session| {
        if session.cancelled {
            return Err(ConversionFailure::Cancelled);
        }
        let published = match publish_staged_source_with_captions(
            input,
            download_dir,
            stage,
            write_subtitles,
        ) {
            Ok(published) => published,
            Err(failure) => {
                if let Some(path) = failure.media_path {
                    session.completed_paths.push(path.clone());
                    return Err(ConversionFailure::SetupPublished {
                        message: failure.detail,
                        path,
                    });
                }
                return Err(ConversionFailure::Setup(failure.detail));
            }
        };
        session.conversion_format = Some(target.to_string());
        session.completed_paths.push(published.clone());
        Ok(published)
    })
    .unwrap_or(Err(ConversionFailure::Cancelled))
}

/// Remove only the source that was present in this session's ownership
/// snapshot. Moving it to a fresh private quarantine first makes the identity
/// recheck apply to the entry we actually remove. A replacement is instead
/// installed with no-replace semantics in the user's selected folder.
fn retire_staged_source(
    input: &Path,
    download_dir: &Path,
    stage: &mut DownloadStage,
) -> Result<Option<PathBuf>, PublicationFailure> {
    let Some(expected_identity) = stage.identity_for(input) else {
        return publish_staged_source(input, download_dir, stage).map(Some);
    };
    let Some(parent) = input.parent() else {
        stage.preserve_on_drop = true;
        return Err(PublicationFailure {
            media_path: None,
            detail: format!("Staged source has no parent: {}", input.display()),
        });
    };
    let Some(file_name) = input.file_name() else {
        stage.preserve_on_drop = true;
        return Err(PublicationFailure {
            media_path: None,
            detail: format!("Staged source has no filename: {}", input.display()),
        });
    };

    for _ in 0..32 {
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        let quarantine_dir =
            parent.join(format!(".rosi-source-retire-{}", crate::fs_util::uuid_v4()));
        match builder.create(&quarantine_dir) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                stage.preserve_on_drop = input.exists();
                return Err(PublicationFailure {
                    media_path: None,
                    detail: format!(
                        "Could not reserve a private quarantine for staged original {}: {error}",
                        input.display()
                    ),
                });
            }
        }
        let quarantine = quarantine_dir.join(file_name);
        match install_no_replace(input, &quarantine) {
            Ok(()) => {
                if file_identity(&quarantine) == Some(expected_identity) {
                    if let Err(error) = std::fs::remove_file(&quarantine) {
                        stage.preserve_on_drop = true;
                        return Err(PublicationFailure {
                            media_path: None,
                            detail: format!(
                                "Could not remove verified original {} from private quarantine {}: {error}",
                                input.display(),
                                quarantine.display()
                            ),
                        });
                    }
                    if let Err(error) = std::fs::remove_dir(&quarantine_dir) {
                        stage.preserve_on_drop = true;
                        return Err(PublicationFailure {
                            media_path: None,
                            detail: format!(
                                "Could not remove empty source quarantine {}: {error}",
                                quarantine_dir.display()
                            ),
                        });
                    }
                    return Ok(None);
                }
                return match install_download_output(&quarantine, download_dir) {
                    Ok(path) => match std::fs::remove_dir(&quarantine_dir) {
                        Ok(()) => Ok(Some(path)),
                        Err(error) => {
                            stage.preserve_on_drop = true;
                            Err(PublicationFailure {
                                media_path: Some(path.clone()),
                                detail: format!(
                                    "Preserved replaced source at {} but could not retire its empty quarantine {}: {error}",
                                    path.display(),
                                    quarantine_dir.display()
                                ),
                            })
                        }
                    },
                    Err(error) => {
                        let source_remains = quarantine.exists();
                        if !source_remains {
                            let _ = std::fs::remove_dir(&quarantine_dir);
                        }
                        stage.preserve_on_drop = source_remains || quarantine_dir.exists();
                        Err(PublicationFailure {
                            media_path: None,
                            detail: format!(
                                "A replaced source was retained in private staging at {}: {error}",
                                quarantine.display()
                            ),
                        })
                    }
                };
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                stage.preserve_on_drop = true;
                return Err(PublicationFailure {
                    media_path: None,
                    detail: format!(
                        "The private source quarantine path was claimed unexpectedly: {}",
                        quarantine.display()
                    ),
                });
            }
            Err(error) => {
                let _ = std::fs::remove_dir(&quarantine_dir);
                if input.exists() {
                    stage.preserve_on_drop = true;
                }
                return Err(PublicationFailure {
                    media_path: None,
                    detail: format!(
                        "Could not quarantine staged original {}: {error}",
                        input.display()
                    ),
                });
            }
        }
    }
    stage.preserve_on_drop = input.exists();
    Err(PublicationFailure {
        media_path: None,
        detail: format!(
            "Could not reserve a private quarantine for staged original {}.",
            input.display()
        ),
    })
}

struct PendingSourcePublication<'a> {
    id: u64,
    inputs: &'a [PathBuf],
    download_dir: &'a Path,
    stage: &'a mut DownloadStage,
    write_subtitles: bool,
    completed: &'a mut Vec<PathBuf>,
    failed: &'a mut Vec<PathBuf>,
    failures: &'a mut Vec<String>,
}

fn publish_pending_sources(publication: PendingSourcePublication<'_>) {
    for input in publication.inputs {
        if !input.exists() {
            continue;
        }
        match publish_staged_source_with_captions(
            input,
            publication.download_dir,
            publication.stage,
            publication.write_subtitles,
        ) {
            Ok(path) => {
                send_progress(
                    publication.id,
                    format!("ℹ️ Preserved original download: {}", path.display()),
                );
                if !publication.completed.contains(&path) {
                    publication.completed.push(path);
                }
            }
            Err(error) => {
                let failed_path = error.media_path.unwrap_or_else(|| input.clone());
                crate::logging::error(&format!(
                    "Could not fully publish staged original {}: {}",
                    input.display(),
                    error.detail
                ));
                if !publication.completed.contains(&failed_path)
                    && failed_path != *input
                    && failed_path.exists()
                {
                    publication.completed.push(failed_path.clone());
                }
                publication.failed.push(failed_path.clone());
                publication
                    .failures
                    .push(format!("{}: {}", failed_path.display(), error.detail));
            }
        }
    }
}

fn run_conversion(
    id: u64,
    downloaded: Vec<PathBuf>,
    mut stage: DownloadStage,
    download_dir: PathBuf,
    effective: Settings,
    ffmpeg: PathBuf,
) {
    std::thread::spawn(move || {
        send_progress(id, "⏳ Checking if conversion is needed...");
        let target = if effective.convert_format.trim().is_empty() {
            "mp4".to_string()
        } else {
            effective.convert_format.trim().to_lowercase()
        };
        let count = downloaded.len();
        let total_entries = count;
        let mut completed = Vec::new();
        let mut failed = Vec::new();
        let mut failures = Vec::new();
        let mut missing_ffmpeg = false;
        for (index, input) in downloaded.iter().enumerate() {
            if !active_not_cancelled(id) {
                publish_pending_sources(PendingSourcePublication {
                    id,
                    inputs: &downloaded[index..],
                    download_dir: &download_dir,
                    stage: &mut stage,
                    write_subtitles: effective.write_subtitles,
                    completed: &mut completed,
                    failed: &mut failed,
                    failures: &mut failures,
                });
                complete_conversion_batch(
                    id,
                    target,
                    total_entries,
                    completed,
                    failed,
                    failures,
                    true,
                );
                return;
            }
            match convert_one(
                id,
                input,
                &download_dir,
                &target,
                &effective,
                &ffmpeg,
                ConversionPosition { index, count },
            ) {
                Ok(result) if result.unchanged => {
                    match publish_same_extension_for_session(
                        id,
                        input,
                        &target,
                        &download_dir,
                        &mut stage,
                        effective.write_subtitles,
                    ) {
                        Ok(output) => {
                            completed.push(output);
                        }
                        Err(ConversionFailure::Cancelled) => {
                            publish_pending_sources(PendingSourcePublication {
                                id,
                                inputs: &downloaded[index..],
                                download_dir: &download_dir,
                                stage: &mut stage,
                                write_subtitles: effective.write_subtitles,
                                completed: &mut completed,
                                failed: &mut failed,
                                failures: &mut failures,
                            });
                            complete_conversion_batch(
                                id,
                                target,
                                total_entries,
                                completed,
                                failed,
                                failures,
                                true,
                            );
                            return;
                        }
                        Err(error) => {
                            let detail = failure_message(&error);
                            let failed_path = match &error {
                                ConversionFailure::SetupPublished { path, .. } => {
                                    push_completed_path(&mut completed, path.clone());
                                    path.clone()
                                }
                                _ => input.clone(),
                            };
                            failed.push(failed_path.clone());
                            failures.push(format!("{}: {detail}", failed_path.display()));
                            record_conversion_failure(id, &failed_path, &detail);
                            if input.exists() {
                                stage.preserve_on_drop = true;
                            }
                        }
                    }
                }
                Ok(result) => {
                    let output = result.path;
                    if !active_not_cancelled(id) {
                        publish_pending_sources(PendingSourcePublication {
                            id,
                            inputs: &downloaded[index..],
                            download_dir: &download_dir,
                            stage: &mut stage,
                            write_subtitles: effective.write_subtitles,
                            completed: &mut completed,
                            failed: &mut failed,
                            failures: &mut failures,
                        });
                        if output.exists() && !completed.contains(&output) {
                            completed.push(output);
                        }
                        complete_conversion_batch(
                            id,
                            target,
                            total_entries,
                            completed,
                            failed,
                            failures,
                            true,
                        );
                        return;
                    }
                    let should_preserve_original = result.preserve_original;
                    let mut preserve_publication_failed = false;
                    if should_preserve_original {
                        match publish_staged_source_with_captions(
                            input,
                            &download_dir,
                            &mut stage,
                            effective.write_subtitles,
                        ) {
                            Ok(path) => {
                                send_progress(
                                    id,
                                    format!(
                                        "ℹ️ Retained original to preserve artwork or unsupported or unverified captions: {}",
                                        path.display()
                                    ),
                                );
                                push_completed_path(&mut completed, path);
                            }
                            Err(error) => {
                                preserve_publication_failed = true;
                                let failed_path =
                                    error.media_path.clone().unwrap_or_else(|| input.clone());
                                if error.media_path.is_some() {
                                    push_completed_path(&mut completed, failed_path.clone());
                                }
                                failed.push(failed_path.clone());
                                failures.push(format!(
                                    "{}: {}",
                                    failed_path.display(),
                                    error.detail
                                ));
                                record_conversion_failure(id, &failed_path, &error.detail);
                            }
                        }
                    } else if effective.write_subtitles {
                        if let Err(error) =
                            publish_caption_sidecars(input, &output, &download_dir, &mut stage)
                        {
                            let detail = format!("Could not publish requested captions: {error}");
                            let preserved = publish_staged_source_with_captions(
                                input,
                                &download_dir,
                                &mut stage,
                                true,
                            );
                            preserve_publication_failed = true;
                            let (failed_path, detail) = match preserved {
                                Ok(path) => {
                                    push_completed_path(&mut completed, path.clone());
                                    (path, detail)
                                }
                                Err(preserve_error) => {
                                    let failed_path = preserve_error
                                        .media_path
                                        .clone()
                                        .unwrap_or_else(|| input.clone());
                                    if preserve_error.media_path.is_some() {
                                        push_completed_path(&mut completed, failed_path.clone());
                                    }
                                    (failed_path, format!("{detail}; {}", preserve_error.detail))
                                }
                            };
                            failed.push(failed_path.clone());
                            failures.push(format!("{}: {detail}", failed_path.display()));
                            record_conversion_failure(id, &failed_path, &detail);
                        }
                    }
                    if !should_preserve_original
                        && !effective.keep_original_after_convert
                        && !preserve_publication_failed
                    {
                        match retire_staged_source(input, &download_dir, &mut stage) {
                            Ok(None) => send_progress(
                                id,
                                format!("🗑️ Deleted owned original: {}", input.display()),
                            ),
                            Ok(Some(path)) => {
                                send_progress(
                                    id,
                                    format!(
                                        "ℹ️ Preserved replaced original file: {}",
                                        path.display()
                                    ),
                                );
                                push_completed_path(&mut completed, path);
                            }
                            Err(error) => {
                                send_progress(
                                    id,
                                    format!(
                                        "⚠️ Could not retire original safely: {}",
                                        error.detail
                                    ),
                                );
                                let failed_path =
                                    error.media_path.clone().unwrap_or_else(|| input.clone());
                                if error.media_path.is_some() {
                                    push_completed_path(&mut completed, failed_path.clone());
                                }
                                failed.push(failed_path.clone());
                                failures.push(format!(
                                    "{}: {}",
                                    failed_path.display(),
                                    error.detail
                                ));
                                record_conversion_failure(id, &failed_path, &error.detail);
                            }
                        }
                    } else if !should_preserve_original
                        && effective.keep_original_after_convert
                        && !preserve_publication_failed
                    {
                        match publish_staged_source(input, &download_dir, &mut stage) {
                            Ok(path) => {
                                send_progress(
                                    id,
                                    format!("ℹ️ Keeping original file: {}", path.display()),
                                );
                                push_completed_path(&mut completed, path);
                            }
                            Err(error) => {
                                let failed_path =
                                    error.media_path.clone().unwrap_or_else(|| input.clone());
                                if error.media_path.is_some() {
                                    push_completed_path(&mut completed, failed_path.clone());
                                }
                                failed.push(failed_path.clone());
                                failures.push(format!(
                                    "{}: {}",
                                    failed_path.display(),
                                    error.detail
                                ));
                                record_conversion_failure(id, &failed_path, &error.detail);
                            }
                        }
                    }
                    send_progress(
                        id,
                        format!("🎉 Successfully converted to {}", output.display()),
                    );
                    push_completed_path(&mut completed, output);
                }
                Err(ConversionFailure::Cancelled) => {
                    publish_pending_sources(PendingSourcePublication {
                        id,
                        inputs: &downloaded[index..],
                        download_dir: &download_dir,
                        stage: &mut stage,
                        write_subtitles: effective.write_subtitles,
                        completed: &mut completed,
                        failed: &mut failed,
                        failures: &mut failures,
                    });
                    complete_conversion_batch(
                        id,
                        target,
                        total_entries,
                        completed,
                        failed,
                        failures,
                        true,
                    );
                    return;
                }
                Err(error) => {
                    if matches!(&error, ConversionFailure::Spawn(spawn) if spawn.kind() == std::io::ErrorKind::NotFound)
                    {
                        missing_ffmpeg = true;
                    }
                    let detail = failure_message(&error);
                    let preserved = publish_staged_source_with_captions(
                        input,
                        &download_dir,
                        &mut stage,
                        effective.write_subtitles,
                    );
                    let failed_path = match preserved {
                        Ok(path) => {
                            send_progress(
                                id,
                                format!("❌ Conversion failed for {}: {detail}", path.display()),
                            );
                            push_completed_path(&mut completed, path.clone());
                            path
                        }
                        Err(preserve_error) => {
                            let failed_path = preserve_error
                                .media_path
                                .clone()
                                .unwrap_or_else(|| input.clone());
                            if preserve_error.media_path.is_some() {
                                push_completed_path(&mut completed, failed_path.clone());
                            }
                            let detail = format!("{detail}; {}", preserve_error.detail);
                            send_progress(
                                id,
                                format!(
                                    "❌ Conversion failed for {}: {detail}",
                                    failed_path.display()
                                ),
                            );
                            failures.push(format!("{}: {detail}", failed_path.display()));
                            record_conversion_failure(id, &failed_path, &detail);
                            failed.push(failed_path);
                            continue;
                        }
                    };
                    record_conversion_failure(id, &failed_path, &detail);
                    failed.push(failed_path.clone());
                    failures.push(format!("{}: {detail}", failed_path.display()));
                }
            }
        }
        if missing_ffmpeg {
            send_progress(
                id,
                format!("❌ FFmpeg was not found at {}.", ffmpeg.display()),
            );
            show_ffmpeg_missing_dialog(&ffmpeg);
        }
        if failed.is_empty() {
            emit_convert_progress(id, Some(100.0), "Conversion complete");
        }
        complete_conversion_batch(
            id,
            target,
            total_entries,
            completed,
            failed,
            failures,
            false,
        );
    });
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    started: bool,
    session_id: u64,
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
        Ok(session_id) => ipc::ok(Started {
            started: true,
            session_id,
        }),
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

#[cfg(test)]
mod audit4_tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    static SERIAL: Mutex<()> = Mutex::new(());

    fn session(callback: CompletionCallback) -> Session {
        Session {
            id: u64::MAX,
            completion_id: "audit4".into(),
            started_at: 1,
            request: DownloadRequestOptions::default(),
            owner: Owner::Queue,
            cancelled: false,
            cancel_notify: false,
            ytdlp: None,
            ytdlp_exit_pending: false,
            conversion_pending: false,
            ffmpeg: None,
            on_complete: Some(callback),
            ytdlp_postprocess: false,
            ytdlp_download_finished: false,
            conversion_format: None,
            completed_paths: vec![],
            failed_paths: vec![],
            conversion_failures: vec![],
            reporter: Reporter::new(progress::Plan::default(), None, false),
        }
    }

    #[test]
    fn cancellation_waits_for_callback_after_active_slot_is_empty() {
        let _serial = SERIAL.lock().unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        *lock() = Some(session(Box::new(move |_| {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        })));
        let completion = std::thread::spawn(|| {
            complete_session(
                u64::MAX,
                "Done",
                Outcome::Success,
                CompletionMeta::default(),
            )
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(lock().is_none());
        let (cancel_tx, cancel_rx) = mpsc::channel();
        let cancel = std::thread::spawn(move || {
            cancel_active_session(false);
            cancel_tx.send(()).unwrap();
        });
        let early = cancel_rx.recv_timeout(Duration::from_millis(100)).is_ok();
        release_tx.send(()).unwrap();
        completion.join().unwrap();
        cancel.join().unwrap();
        assert!(
            !early,
            "Cancellation returned before completion callback finished"
        );
    }

    #[test]
    fn cancellation_retains_explicit_recovery_error() {
        let _serial = SERIAL.lock().unwrap();
        let (tx, rx) = mpsc::channel();
        *lock() = Some(session(Box::new(move |completion| {
            tx.send(completion).unwrap();
        })));
        complete_session(
            u64::MAX,
            "Cancelled",
            Outcome::Cancelled,
            CompletionMeta {
                error: Some("Recovery at /tmp/staging".into()),
                ..CompletionMeta::default()
            },
        );
        assert_eq!(
            rx.recv().unwrap().error.as_deref(),
            Some("Recovery at /tmp/staging")
        );
    }
}
