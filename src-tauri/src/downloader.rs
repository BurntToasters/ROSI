//! Single active download session: yt-dlp download, optional FFmpeg
//! conversion, cancellation, structured progress, and completion reporting.
//!
//! Lock discipline: the `ACTIVE` session lock is never held while emitting
//! events, touching windows, or invoking completion callbacks (the queue's
//! callback takes the queue lock). `EVENT_PUBLISH` serializes lifecycle event
//! publication with replacing the active session so older terminal events
//! cannot arrive after a newer session becomes current.
//!
//! Lifecycle waits go through the coordinator (coordinator.rs): a session is
//! registered in the same critical section that installs it in `ACTIVE`, and
//! its terminal result acks every `await_finalized` on it. Events for a stale
//! session are dropped under `EVENT_PUBLISH`, since `with_session` matches only
//! the current session.
//!
//! Lock order, outermost first:
//!
//! - Session chain: `STARTUP` -> `EVENT_PUBLISH` -> `ACTIVE`. `STARTUP` only
//!   serializes starts; no completion path takes it.
//! - Queue chain: only the coordinator thread takes `QUEUE` and `ACTIVE` (via
//!   `can_start`), and it never waits on a process or an ack.
//! - `PERSIST_SIGNAL` is a leaf.
//! - Registration and terminal results are non-blocking sends to the
//!   coordinator.

use crate::command_builders::{build_ytdlp_args, YtdlpArgsInput};
use crate::constants::*;
use crate::ipc::{self, DownloadRequestInput, FalliblePayload, IpcResult, NOT_AVAILABLE};
use crate::progress::{self, Metrics, Reporter};
use crate::staging::{reserve_download_stage, reserve_path_output_file, DownloadStage};
use crate::types::{
    DownloadCompletion, DownloadRequestOptions, JobProgressEvent, Outcome, Owner, Phase,
    QueueProgress, Settings,
};
use crate::validation::{is_path_within, is_safe_http_url, resolve_path};
use std::collections::{HashSet, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::watch;

mod conversion;
mod publication;

use conversion::run_conversion;
use publication::{install_download_output, publish_caption_sidecars};

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
    /// Signalled by `cancel_session`; the proxy observes it through a receiver.
    network_cancellation: watch::Sender<bool>,
    cancel_notify: bool,
    ytdlp: Option<Arc<crate::process_util::ManagedChild>>,
    ytdlp_exit_pending: bool,
    conversion_pending: bool,
    ffmpeg: Option<Arc<crate::process_util::ManagedChild>>,
    ytdlp_postprocess: bool,
    ytdlp_download_finished: bool,
    conversion_format: Option<String>,
    completed_paths: Vec<PathBuf>,
    failed_paths: Vec<PathBuf>,
    conversion_failures: Vec<String>,
    /// Set when a playlist run lost some entries but produced others.
    partial_error: Option<String>,
    reporter: Reporter,
}

/// The session slot. It holds session data only; lifecycle waits go through
/// the coordinator's await acks.
static ACTIVE: Mutex<Option<Session>> = Mutex::new(None);
/// Mirrors whether ACTIVE holds a session, so the main thread can ask without
/// waiting on the session lock.
static ACTIVE_PRESENT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

static STARTUP: Mutex<()> = Mutex::new(());
static EVENT_PUBLISH: Mutex<()> = Mutex::new(());
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
    ACTIVE_PRESENT.load(Ordering::SeqCst)
}

pub fn can_start(owner: Owner) -> bool {
    lock().as_ref().is_none_or(|session| session.owner == owner)
}

/// The active session's id when another owner holds the slot. Callers wait on
/// it with `coordinator::await_finalized` instead of polling.
pub fn blocking_session(owner: Owner) -> Option<u64> {
    lock()
        .as_ref()
        .filter(|session| session.owner != owner)
        .map(|session| session.id)
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
    // The session stays registered with the coordinator until its terminal
    // result is routed below, so awaits on it are not released early.
    let session = {
        let mut guard = lock();
        match guard.as_ref() {
            Some(session) if session.id == id => {
                let taken = guard.take();
                ACTIVE_PRESENT.store(false, Ordering::SeqCst);
                taken
            }
            _ => None,
        }
    };
    let Some(mut session) = session else {
        return;
    };
    let mut outcome = outcome;
    let mut meta = meta;
    let partial_status;
    let mut status_message = status_message;
    if let Some(partial) = session.partial_error.take() {
        if outcome == Outcome::Success || outcome == Outcome::Failed {
            outcome = Outcome::Failed;
            partial_status = format!("⚠️ Playlist partially downloaded. {partial}");
            status_message = &partial_status;
            meta.error = Some(match meta.error.take() {
                Some(existing) => format!("{partial}; {existing}"),
                None => partial,
            });
        }
    }
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
    crate::coordinator::terminal(session.id, completion);
}

/// Cancel the active session. `notify` controls whether the user-facing
/// cancellation message and legacy `complete` event are sent for queue runs.
/// Manual sessions always announce their cancellation.
pub fn cancel_active_session(notify: bool) {
    cancel_session(notify, true, false);
}

/// Shutdown and stop path: never announces the cancellation, and kills yt-dlp
/// before ffmpeg.
pub fn kill_all_processes() {
    cancel_session(false, false, true);
}

/// Shared cancel body. `notify` and `notify_manual` decide whether the cancel
/// is announced (`show`). `ytdlp_first` sets the child termination order:
/// ffmpeg then yt-dlp for cancels, yt-dlp then ffmpeg for shutdown.
fn cancel_session(notify: bool, notify_manual: bool, ytdlp_first: bool) {
    let (id, children, partial, wait_for_ytdlp, show) = {
        let mut guard = lock();
        let Some(session) = guard.as_mut() else {
            // Registration happens in the same critical section that installs a
            // session, so every session still awaiting finalization is already
            // registered. A session started after this point is not awaited.
            drop(guard);
            crate::coordinator::await_finalized(None);
            return;
        };
        session.cancelled = true;
        session.network_cancellation.send_replace(true);
        let show = notify || (notify_manual && session.owner == Owner::Manual);
        session.cancel_notify = show;
        let wait_for_ytdlp =
            session.ytdlp_exit_pending || session.conversion_pending || session.ytdlp.is_some();
        if wait_for_ytdlp {
            session.ytdlp_exit_pending = true;
        }
        let children = if ytdlp_first {
            [session.ytdlp.take(), session.ffmpeg.take()]
        } else {
            [session.ffmpeg.take(), session.ytdlp.take()]
        };
        (
            session.id,
            children,
            partial_completion_meta(session),
            wait_for_ytdlp,
            show,
        )
    };
    for child in children.into_iter().flatten() {
        crate::process_util::terminate_tree(&child);
    }
    if wait_for_ytdlp {
        // The reader thread finalizes the session once yt-dlp has exited.
        crate::coordinator::await_finalized(Some(id));
        return;
    }
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

/// Returned when another owner holds the session slot. The caller keeps its
/// completion sender and can retry later.
pub struct OwnerConflict {
    pub message: String,
    /// The session holding the slot, for the caller to await.
    pub session_id: u64,
}

/// Start a download. Validation failures are reported through the normal
/// completion path; `Err` only means another owner holds the session slot.
pub fn start_download(
    options: crate::download_options::ResolvedDownloadOptions,
    owner: Owner,
    queue_progress: Option<QueueProgress>,
    completion: Sender<DownloadCompletion>,
) -> Result<u64, OwnerConflict> {
    let request = options.request;
    let effective = options.effective_settings;
    let snapshot = request.clone();
    let plan = progress::resolve_plan(&effective);
    let startup = STARTUP
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let existing = lock().as_ref().map(|session| (session.id, session.owner));
    match existing {
        Some((session_id, current)) if current != owner => {
            return Err(OwnerConflict {
                message: "Download session already active with a different owner.".to_string(),
                session_id,
            })
        }
        // Waits for the previous session's finalization ack before this one
        // installs, so the slot is never shared.
        Some(_) => cancel_active_session(false),
        None => {}
    }
    let id = COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let (network_cancellation, network_cancel_receiver) = watch::channel(false);
    let session = Session {
        id,
        completion_id: crate::fs_util::uuid_v4(),
        started_at: crate::app_state::now_ms(),
        request: snapshot,
        owner,
        cancelled: false,
        network_cancellation,
        cancel_notify: false,
        ytdlp: None,
        ytdlp_exit_pending: false,
        conversion_pending: false,
        ffmpeg: None,
        ytdlp_postprocess: false,
        ytdlp_download_finished: false,
        conversion_format: None,
        completed_paths: Vec::new(),
        failed_paths: Vec::new(),
        conversion_failures: Vec::new(),
        partial_error: None,
        reporter: Reporter::new(plan, queue_progress, effective.show_taskbar_progress),
    };
    {
        let _publish = EVENT_PUBLISH
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut guard = lock();
        // Registration is a non-blocking send made under the same lock that
        // installs the session. Any cancel that can see the session is
        // therefore ordered after its registration.
        crate::coordinator::register(id, completion);
        *guard = Some(session);
        ACTIVE_PRESENT.store(true, Ordering::SeqCst);
    }
    let mut startup = Some(startup);

    let requested_ffmpeg = request
        .ffmpeg_path
        .clone()
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| effective.ffmpeg_path.clone());
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
    let network_guard =
        match crate::network_security::NetworkSecurityGuard::start_with_cancel_signal(
            network_cancel_receiver,
            &effective.upstream_proxy,
        ) {
            Ok(guard) => guard,
            Err(error) => {
                let _ = std::fs::remove_file(&path_output_file);
                if !active_not_cancelled(id) {
                    drop(startup.take());
                    return Ok(id);
                }
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
    // A playlist run exits non-zero when any entry fails, even after the other
    // entries downloaded. Keep going for the files it produced (including
    // conversion) and report the run as partially failed at the end.
    if exit.code != Some(0) && exit.code.is_some() && !cancelled {
        let playlist_run = with_session(id, |session| {
            session
                .request
                .playlist
                .as_ref()
                .is_some_and(|playlist| playlist.mode != "current")
        })
        .unwrap_or(false);
        if playlist_run && downloaded_file_paths(&exit).is_ok() {
            let code = exit.code.unwrap_or_default();
            let failed_entries = exit
                .stderr
                .lines()
                .filter(|line| line.trim_start().starts_with("ERROR:"))
                .count()
                .max(1);
            let message = format!(
                "{failed_entries} playlist entr{} failed (yt-dlp exited with code {code}).",
                if failed_entries == 1 { "y" } else { "ies" }
            );
            send_progress(
                id,
                format!("⚠️ {message} Continuing with the downloaded entries."),
            );
            with_session(id, |session| session.partial_error = Some(message));
            exit.code = Some(0);
        }
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
    let Some(final_path) = downloaded.last().cloned() else {
        complete_session(
            id,
            "❌ Failed (No installed file).",
            Outcome::Failed,
            completion_meta_for_paths(downloaded, failed_paths, None),
        );
        return;
    };
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

fn active_not_cancelled(id: u64) -> bool {
    with_session(id, |session| !session.cancelled).unwrap_or(false)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "DownloadStarted"))]
pub struct Started {
    started: bool,
    session_id: u64,
}

#[tauri::command(async)]
pub fn download_video(options: FalliblePayload<DownloadRequestInput>) -> IpcResult<Started> {
    let settings = crate::settings::load();
    let resolved =
        match crate::download_options::resolve_value(&settings, &options.into_value(), None) {
            Ok(resolved) => resolved,
            Err(error) => return ipc::from_error(error),
        };
    // The runner briefly holds no session between items, so the session slot
    // alone cannot tell that a queue run owns the downloader.
    if !can_start(Owner::Manual) || crate::queue::is_running() {
        return ipc::err(NOT_AVAILABLE, "A queue download is already in progress.");
    }
    let (completion, recorded) = std::sync::mpsc::channel::<DownloadCompletion>();
    std::thread::spawn(move || {
        if let Ok(completion) = recorded.recv() {
            crate::activity::record(&completion);
        }
    });
    match start_download(resolved, Owner::Manual, None, completion) {
        Ok(session_id) => ipc::ok(Started {
            started: true,
            session_id,
        }),
        Err(conflict) => {
            crate::logging::warn(&format!("Refused a manual download: {}", conflict.message));
            ipc::err(NOT_AVAILABLE, "A queue download is already in progress.")
        }
    }
}

#[tauri::command]
pub async fn cancel_download() {
    // Cancellation waits for helper exit and file publication; keep that off
    // the async runtime's worker threads.
    let _ = tauri::async_runtime::spawn_blocking(|| cancel_active_session(true)).await;
}

#[cfg(test)]
mod audit4_tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    static SERIAL: Mutex<()> = Mutex::new(());

    fn session() -> Session {
        Session {
            id: u64::MAX,
            completion_id: "audit4".into(),
            started_at: 1,
            request: DownloadRequestOptions::default(),
            owner: Owner::Queue,
            cancelled: false,
            network_cancellation: watch::channel(false).0,
            cancel_notify: false,
            ytdlp: None,
            ytdlp_exit_pending: false,
            conversion_pending: false,
            ffmpeg: None,
            ytdlp_postprocess: false,
            ytdlp_download_finished: false,
            conversion_format: None,
            completed_paths: vec![],
            failed_paths: vec![],
            conversion_failures: vec![],
            partial_error: None,
            reporter: Reporter::new(progress::Plan::default(), None, false),
        }
    }

    #[test]
    fn cancellation_retains_explicit_recovery_error() {
        let _serial = SERIAL.lock().unwrap();
        let (tx, rx) = mpsc::channel();
        crate::coordinator::register(u64::MAX, tx);
        *lock() = Some(session());
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
            rx.recv_timeout(Duration::from_secs(5))
                .unwrap()
                .error
                .as_deref(),
            Some("Recovery at /tmp/staging")
        );
    }
}
