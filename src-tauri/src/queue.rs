//! Persistent download queue (`download-queue.json` + backup) and the runner
//! that feeds queued items to the downloader one at a time.

use crate::constants::MAX_QUEUE_SIZE;
use crate::coordinator::{self, Command, QueueCommand};
use crate::downloader;
use crate::ipc::{
    self, DownloadRequestOverrides, FalliblePayload, IpcError, IpcResult, JsonObject,
    QueueUrlInput, QueueUrlsInput, VALIDATION_ERROR,
};
use crate::types::{
    DownloadCompletion, DownloadRequestOptions, Outcome, Owner, QueueItem, QueueProgress,
    QueueReorderInput, QueueStatus, Settings,
};
use crate::validation::{
    normalize_queue_url, validate_file_location, validate_queue_item_id, validate_queue_reorder,
};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

#[derive(Default)]
pub(crate) struct QueueState {
    pub(crate) items: Vec<QueueItem>,
    pub(crate) revision: u64,
    pub(crate) running: bool,
    pub(crate) cancelled: bool,
    pub(crate) active_item_id: Option<String>,
    pub(crate) runner_alive: bool,
    /// When the current run started. Progress weighting counts only items
    /// finished during this run, not results kept from earlier runs.
    pub(crate) run_started_at: u64,
    /// Set while `stop()` waits for the runner to exit, so a start cannot
    /// replace that runner and leave `stop()` waiting on the new one.
    pub(crate) stopping: bool,
}

static QUEUE: OnceLock<Mutex<QueueState>> = OnceLock::new();
const MAX_QUEUE_FILE_BYTES: usize = 32 * 1024 * 1024;
// Reserve space for completion paths, filenames, and error messages.
pub(crate) const MAX_QUEUE_ADMISSION_BYTES: usize = 24 * 1024 * 1024;
const MAX_QUEUE_URL_BYTES: usize = 64 * 1024;
struct RunnerFinished;

impl Drop for RunnerFinished {
    fn drop(&mut self) {
        coordinator::submit(Command::Queue(QueueCommand::RunnerExited));
    }
}

fn queue_path() -> std::path::PathBuf {
    crate::app_state::data_dir().join("download-queue.json")
}

fn backup_path() -> std::path::PathBuf {
    crate::app_state::data_dir().join("download-queue.backup.json")
}

type QueueWriter = dyn Fn(&Path, &Path, &[QueueItem]) -> Result<(), String> + Send + Sync;

struct QueuePersistence {
    primary: PathBuf,
    backup: PathBuf,
    writer: Box<QueueWriter>,
    revisions: Mutex<QueueWriteRevisions>,
}

#[derive(Default)]
struct QueueWriteRevisions {
    highest_attempted: u64,
    last_persisted: u64,
}

impl QueuePersistence {
    fn with_writer<F>(primary: PathBuf, backup: PathBuf, writer: F) -> Self
    where
        F: Fn(&Path, &Path, &[QueueItem]) -> Result<(), String> + Send + Sync + 'static,
    {
        Self {
            primary,
            backup,
            writer: Box::new(writer),
            revisions: Mutex::new(QueueWriteRevisions::default()),
        }
    }

    /// One mutex serializes background writes and explicit flushes. A delayed
    /// older snapshot is skipped after a newer revision was attempted, even
    /// if that write failed. A skipped flush is acknowledged only if an equal
    /// or newer revision was durably committed.
    fn persist(&self, revision: u64, snapshot: Vec<QueueItem>) -> Result<(), String> {
        let mut revisions = self
            .revisions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if revision <= revisions.last_persisted {
            return Ok(());
        }
        if revision < revisions.highest_attempted {
            return Err(format!(
                "Queue revision {revision} was superseded by revision {}; retry the latest state before closing.",
                revisions.highest_attempted
            ));
        }
        revisions.highest_attempted = revision;
        (self.writer)(&self.primary, &self.backup, &snapshot)?;
        revisions.last_persisted = revision;
        Ok(())
    }

    fn flush(&self, revision: u64, snapshot: Vec<QueueItem>) -> Result<(), String> {
        self.persist(revision, snapshot)
    }
}

fn persist_queue_files(
    primary: &Path,
    backup: &Path,
    snapshot: &[QueueItem],
) -> Result<(), String> {
    let encoded = crate::fs_util::encode_list(snapshot)?;
    if encoded.len() > MAX_QUEUE_FILE_BYTES {
        return Err(
            "Queue exceeds its durable storage limit; the previous files were preserved.".into(),
        );
    }
    crate::fs_util::guard_before_replace(
        primary,
        MAX_QUEUE_FILE_BYTES as u64,
        crate::fs_util::is_list_file,
        |value| crate::fs_util::ensure_schema_not_newer(value, "Download queue"),
    )
    .map_err(|error| format!("Queue file {} was not replaced: {error}", primary.display()))?;
    // The previous good generation is read before the primary is replaced.
    let previous = previous_generation(primary, backup)?;
    crate::fs_util::atomic_write(primary, &encoded).map_err(|error| {
        format!(
            "Could not atomically write queue file {}: {error}",
            primary.display()
        )
    })?;
    write_backup(backup, previous.as_deref().unwrap_or(&encoded))
}

fn parses_as_list(raw: &str) -> bool {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(crate::fs_util::list_items)
        .is_some()
}

/// The newest good bytes on disk before this flush: the primary when it
/// parses, else the existing backup when it parses. A blocked or unreadable
/// backup is not a good generation.
fn previous_generation(primary: &Path, backup: &Path) -> Result<Option<Vec<u8>>, String> {
    let good_primary = crate::fs_util::read_bounded(primary, MAX_QUEUE_FILE_BYTES as u64)?
        .filter(|raw| parses_as_list(raw));
    let good_backup = crate::fs_util::read_bounded(backup, MAX_QUEUE_FILE_BYTES as u64)
        .ok()
        .flatten()
        .filter(|raw| parses_as_list(raw));
    Ok(good_primary.or(good_backup).map(String::into_bytes))
}

/// Every flush writes the backup, and a failed backup write fails the flush.
/// The backup holds the previous good generation, or the latest snapshot when
/// no good generation exists yet.
fn write_backup(backup: &Path, contents: &[u8]) -> Result<(), String> {
    crate::fs_util::atomic_write(backup, contents).map_err(|error| {
        format!(
            "Could not atomically write queue backup {}: {error}",
            backup.display()
        )
    })
}

fn persistence() -> &'static QueuePersistence {
    static PERSISTENCE: OnceLock<QueuePersistence> = OnceLock::new();
    PERSISTENCE.get_or_init(|| {
        QueuePersistence::with_writer(queue_path(), backup_path(), persist_queue_files)
    })
}

pub(crate) fn revisioned_snapshot(
    queue: &mut QueueState,
    increment_revision: bool,
) -> (u64, Vec<QueueItem>) {
    if increment_revision {
        queue.revision = queue.revision.saturating_add(1);
    }
    (queue.revision, queue.items.clone())
}

pub(crate) fn state() -> MutexGuard<'static, QueueState> {
    QUEUE
        .get_or_init(|| {
            Mutex::new(QueueState {
                items: load_persisted(),
                ..QueueState::default()
            })
        })
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn generate_id() -> String {
    format!("q_{}", crate::fs_util::uuid_v4())
}

fn positive_ms(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n as u64)
}

fn normalize_item(value: &Value, used_ids: &mut HashSet<String>) -> Option<QueueItem> {
    let object = value.as_object()?;
    let url = normalize_queue_url(object.get("url").and_then(Value::as_str)?)?;
    let raw_id = object
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let mut id = if raw_id.len() <= 128 && crate::constants::is_safe_identifier(raw_id) {
        raw_id.to_string()
    } else {
        generate_id()
    };
    while used_ids.contains(&id) {
        id = generate_id();
    }
    used_ids.insert(id.clone());
    // Only terminal states survive a reload. An interrupted "downloading" item and
    // any unknown value restart as pending.
    let status = match object.get("status").and_then(Value::as_str) {
        Some("completed") => QueueStatus::Completed,
        Some("failed") => QueueStatus::Failed,
        Some("cancelled") => QueueStatus::Cancelled,
        _ => QueueStatus::Pending,
    };
    let mut item = QueueItem {
        id,
        url: url.clone(),
        status,
        added_at: positive_ms(object.get("addedAt")).unwrap_or_else(crate::app_state::now_ms),
        started_at: None,
        completed_at: None,
        request: crate::activity::normalize_stored_request(object.get("request"), Some(&url)),
        filename: None,
        output_path: None,
        size_bytes: None,
        error: None,
    };
    if status != QueueStatus::Pending {
        item.started_at = positive_ms(object.get("startedAt"));
        item.completed_at = positive_ms(object.get("completedAt"));
        item.filename = object
            .get("filename")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|name| name.chars().take(1024).collect());
        item.output_path = object
            .get("outputPath")
            .filter(|value| value.is_string())
            .and_then(|value| validate_file_location(value).ok());
        item.size_bytes = object
            .get("sizeBytes")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map(|n| n as u64);
        if status == QueueStatus::Failed {
            item.error = object
                .get("error")
                .and_then(Value::as_str)
                .map(|error| error.chars().take(2000).collect());
        }
    }
    Some(item)
}

fn read_queue(path: &std::path::Path) -> Option<Vec<QueueItem>> {
    let list = crate::fs_util::list_items(crate::fs_util::read_json(
        path,
        MAX_QUEUE_FILE_BYTES as u64,
    )?)?;
    let mut used_ids = HashSet::new();
    let mut nonterminal = HashSet::new();
    let mut items = Vec::new();
    for raw in list.iter().take(MAX_QUEUE_SIZE) {
        let Some(item) = normalize_item(raw, &mut used_ids) else {
            continue;
        };
        if item.status == QueueStatus::Pending && !nonterminal.insert(item.url.clone()) {
            continue;
        }
        items.push(item);
    }
    Some(items)
}

fn load_persisted() -> Vec<QueueItem> {
    if let Some(items) = read_queue(&queue_path()) {
        return items;
    }
    if let Some(items) = read_queue(&backup_path()) {
        crate::logging::warn("Primary queue file could not be read. Restoring queue from backup.");
        return items;
    }
    Vec::new()
}

/// Commands for the single queue writer. `Debounced` asks for a write after
/// the settle window; `Flush` writes now and acknowledges the durable revision.
enum WriteRequest {
    Debounced,
    Flush(std::sync::mpsc::SyncSender<Result<u64, String>>),
}

const PERSIST_DEBOUNCE: Duration = Duration::from_millis(300);

/// The one thread that writes queue files. Writes never overlap: debounced
/// requests are coalesced, and a flush is served from the latest state.
fn writer() -> &'static std::sync::mpsc::Sender<WriteRequest> {
    static WRITER: OnceLock<std::sync::mpsc::Sender<WriteRequest>> = OnceLock::new();
    WRITER.get_or_init(|| {
        let (sender, receiver) = std::sync::mpsc::channel::<WriteRequest>();
        std::thread::spawn(move || writer_loop(receiver));
        sender
    })
}

fn writer_loop(receiver: std::sync::mpsc::Receiver<WriteRequest>) {
    while let Ok(first) = receiver.recv() {
        let mut flushes = Vec::new();
        match first {
            WriteRequest::Flush(ack) => flushes.push(ack),
            WriteRequest::Debounced => {
                // A flush arriving inside the window ends it early.
                let deadline = std::time::Instant::now() + PERSIST_DEBOUNCE;
                loop {
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    match receiver.recv_timeout(remaining) {
                        Ok(WriteRequest::Flush(ack)) => {
                            flushes.push(ack);
                            break;
                        }
                        Ok(WriteRequest::Debounced) => {}
                        Err(_) => break,
                    }
                }
            }
        }
        while let Ok(next) = receiver.try_recv() {
            if let WriteRequest::Flush(ack) = next {
                flushes.push(ack);
            }
        }
        if flushes.is_empty() {
            let Some((revision, snapshot)) = coordinator::request(|reply| {
                Command::Queue(QueueCommand::Snapshot { bump: false, reply })
            }) else {
                continue;
            };
            if let Err(error) = persistence().persist(revision, snapshot) {
                crate::logging::error(&format!(
                    "Failed to persist queue revision {revision}: {error}"
                ));
            }
            continue;
        }
        let Some((revision, snapshot)) = coordinator::request(|reply| {
            Command::Queue(QueueCommand::Snapshot { bump: true, reply })
        }) else {
            for ack in flushes {
                let _ = ack.send(Err("Queue coordinator is not running.".into()));
            }
            continue;
        };
        let result = persistence().flush(revision, snapshot).map(|()| revision);
        for ack in flushes {
            let _ = ack.send(result.clone());
        }
    }
}

/// Debounced (300 ms) background persistence.
pub(crate) fn schedule_persist() {
    let _ = writer().send(WriteRequest::Debounced);
}

/// Durably write the latest queue. A queue file owned by a newer ROSI version
/// is never rewritten; it is already the preserved state, so its refusal does
/// not block closing, restarting, or installing an update.
pub fn flush() -> Result<(), String> {
    let (ack, acknowledged) = std::sync::mpsc::sync_channel(1);
    let result = match writer().send(WriteRequest::Flush(ack)) {
        Ok(()) => acknowledged
            .recv()
            .unwrap_or_else(|_| Err("Queue writer stopped before saving.".into())),
        Err(_) => Err("Queue writer is not running.".into()),
    };
    match result {
        Err(_)
            if crate::fs_util::is_newer_schema_file(&queue_path(), MAX_QUEUE_FILE_BYTES as u64) =>
        {
            crate::logging::warn(
                "Kept the download queue written by a newer ROSI version; this session's queue changes were not saved.",
            );
            Ok(())
        }
        result => result.map(|_| ()),
    }
}

/// Folders queued requests target, for the startup staging sweep.
pub fn queued_output_folders() -> Vec<PathBuf> {
    state()
        .items
        .iter()
        .filter_map(|item| item.request.as_ref())
        .map(|request| PathBuf::from(&request.output_path))
        .collect()
}

/// Load the persisted queue eagerly at startup.
pub fn init() {
    drop(state());
}

fn build_request(
    url: &str,
    settings: &Settings,
    overrides: Option<&Map<String, Value>>,
) -> Result<DownloadRequestOptions, crate::ipc::IpcError> {
    crate::download_options::resolve_queue_request(settings, url, overrides)
}

fn resolve_request(item: &QueueItem) -> DownloadRequestOptions {
    let stored = item
        .request
        .as_ref()
        .and_then(|request| serde_json::to_value(request).ok());
    if let Some(request) =
        crate::activity::normalize_stored_request(stored.as_ref(), Some(&item.url))
    {
        return request;
    }
    let settings = crate::settings::load();
    match build_request(&item.url, &settings, None) {
        Ok(request) => request,
        Err(_) => {
            // Settings-derived values can sit outside the strict path
            // allow-list; they were validated when saved and the downloader
            // still confines the finished file to the target directory.
            crate::logging::warn(&format!(
                "Running queued {} from unvalidated settings-derived options.",
                item.url
            ));
            crate::download_options::request_from_settings(&item.url, &settings)
        }
    }
}

pub(crate) fn clear_attempt(item: &mut QueueItem) {
    item.started_at = None;
    item.completed_at = None;
    item.filename = None;
    item.output_path = None;
    item.size_bytes = None;
    item.error = None;
}

fn synthetic_completion(
    item: &QueueItem,
    request: &DownloadRequestOptions,
    outcome: Outcome,
    message: &str,
) -> DownloadCompletion {
    let now = crate::app_state::now_ms();
    DownloadCompletion {
        id: crate::fs_util::uuid_v4(),
        session_id: None,
        owner: Owner::Queue,
        queue_item_id: Some(item.id.clone()),
        outcome,
        status_message: message.to_string(),
        url: item.url.clone(),
        profile: request.profile.clone(),
        preset_id: request.preset_id.clone(),
        preset_name: request.preset_name.clone(),
        request: request.clone(),
        filename: None,
        output_path: None,
        output_paths: None,
        failed_paths: None,
        size_bytes: None,
        format: None,
        error: (outcome == Outcome::Failed).then(|| message.to_string()),
        started_at: item.started_at.unwrap_or(now),
        completed_at: now,
    }
}

pub(crate) fn apply_completion(item: &mut QueueItem, completion: &DownloadCompletion) {
    item.status = match completion.outcome {
        Outcome::Success => QueueStatus::Completed,
        Outcome::Failed => QueueStatus::Failed,
        Outcome::Cancelled => QueueStatus::Cancelled,
    };
    item.request = Some(completion.request.clone());
    item.completed_at = Some(completion.completed_at);
    item.filename = completion.filename.clone();
    item.output_path = completion.output_path.clone();
    item.size_bytes = completion.size_bytes;
    item.error = completion.error.clone().or_else(|| {
        (completion.outcome == Outcome::Failed).then(|| completion.status_message.clone())
    });
}

/// Apply a completion to the matching item (if still present). Returns true
/// when this completion ended the run.
pub(crate) fn apply_completion_in_state(
    queue: &mut QueueState,
    item_id: &str,
    completion: &DownloadCompletion,
) -> bool {
    if let Some(item) = queue.items.iter_mut().find(|item| item.id == item_id) {
        apply_completion(item, completion);
    }
    if queue.active_item_id.as_deref() == Some(item_id) {
        queue.active_item_id = None;
    }
    end_run_if_drained(queue)
}

/// Ends a live run once no item is left pending or downloading. Called under
/// the same lock as the completion, so a retry after this point sees the run
/// as over and leaves its item pending. The runner thread exits on its own.
/// Returns true when this call ended the run.
pub(crate) fn end_run_if_drained(queue: &mut QueueState) -> bool {
    let has_work = queue
        .items
        .iter()
        .any(|item| matches!(item.status, QueueStatus::Pending | QueueStatus::Downloading));
    if !queue.running || has_work {
        return false;
    }
    queue.running = false;
    queue.active_item_id = None;
    true
}

/// Claim the next pending item for the runner. When nothing can be claimed,
/// the runner's run is over, so the state is reset and `None` is returned.
pub(crate) fn claim_next_in_state(queue: &mut QueueState) -> Option<QueueItem> {
    let next_index = queue
        .items
        .iter()
        .position(|item| item.status == QueueStatus::Pending);
    match next_index {
        Some(index) if queue.running && !queue.cancelled => {
            let item = &mut queue.items[index];
            clear_attempt(item);
            item.status = QueueStatus::Downloading;
            item.started_at = Some(crate::app_state::now_ms());
            let item = item.clone();
            queue.active_item_id = Some(item.id.clone());
            Some(item)
        }
        _ => {
            queue.running = false;
            queue.cancelled = false;
            queue.active_item_id = None;
            None
        }
    }
}

/// Record a session's terminal result for its item. The coordinator applies it
/// and publishes the queue; the activity record follows.
fn finish_item(item_id: &str, completion: DownloadCompletion) {
    let _ = coordinator::request(|reply| {
        Command::Queue(QueueCommand::ItemFinished {
            item_id: item_id.to_string(),
            completion: Box::new(completion.clone()),
            reply,
        })
    });
    crate::activity::record(&completion);
}

/// Progress for an item the runner is about to start: items finished during
/// this run plus everything still pending or downloading.
pub(crate) fn progress_for(queue: &QueueState, item_id: &str) -> QueueProgress {
    let run_started_at = queue.run_started_at;
    let finished_this_run = |entry: &&QueueItem| {
        matches!(
            entry.status,
            QueueStatus::Completed | QueueStatus::Failed | QueueStatus::Cancelled
        ) && entry
            .completed_at
            .is_some_and(|completed| completed >= run_started_at)
    };
    let completed_items = queue.items.iter().filter(finished_this_run).count();
    let remaining = queue
        .items
        .iter()
        .filter(|entry| {
            matches!(
                entry.status,
                QueueStatus::Pending | QueueStatus::Downloading
            )
        })
        .count();
    QueueProgress {
        completed_items,
        queue_total: completed_items + remaining,
        queue_item_id: Some(item_id.to_string()),
    }
}

/// Non-terminal URLs, checked before building requests so duplicates are
/// skipped without reading settings. The coordinator checks again at admission.
fn nonterminal_urls() -> HashSet<String> {
    state()
        .items
        .iter()
        .filter(|item| matches!(item.status, QueueStatus::Pending | QueueStatus::Downloading))
        .map(|item| item.url.clone())
        .collect()
}

/// Runner thread for one queue run. It does the settings, request, and
/// download waits; every queue transition is a coordinator request.
pub(crate) fn run_queue() {
    let _finished = RunnerFinished;
    loop {
        let Some(Some(item)) =
            coordinator::request(|reply| Command::Queue(QueueCommand::ClaimNext { reply }))
        else {
            return;
        };
        let request = resolve_request(&item);
        let resolved =
            crate::download_options::resolve_validated(&crate::settings::load(), request);
        let request = resolved.request.clone();
        let Some(progress) = coordinator::request(|reply| {
            Command::Queue(QueueCommand::Prepare {
                item_id: item.id.clone(),
                request: Box::new(request.clone()),
                reply,
            })
        }) else {
            return;
        };
        if crate::app_state::main_window().is_none() {
            finish_item(
                &item.id,
                synthetic_completion(&item, &request, Outcome::Failed, "Window closed"),
            );
            continue;
        }
        let (completion_sink, completions) = std::sync::mpsc::channel::<DownloadCompletion>();
        let started = loop {
            let wanted = coordinator::request(|reply| {
                Command::Queue(QueueCommand::Attempt {
                    item_id: item.id.clone(),
                    reply,
                })
            })
            .unwrap_or(false);
            if !wanted {
                break false;
            }
            if let Some(blocking) = downloader::blocking_session(Owner::Queue) {
                // A manual download that was accepted just before the queue
                // started still holds the slot. Wait for its finalization ack
                // instead of failing this and every later item.
                coordinator::await_finalized(Some(blocking));
                continue;
            }
            match downloader::start_download(
                resolved.clone(),
                Owner::Queue,
                Some(progress.clone()),
                completion_sink.clone(),
            ) {
                Ok(_session_id) => {
                    // A cancel that landed while the session was starting
                    // applies to it now, from this thread.
                    if let Some(Some(notify)) = coordinator::request(|reply| {
                        Command::Queue(QueueCommand::SessionStarted { reply })
                    }) {
                        downloader::cancel_active_session(notify);
                    }
                    break true;
                }
                Err(conflict) => coordinator::await_finalized(Some(conflict.session_id)),
            }
        };
        // Once started, the coordinator holds the only remaining sender, so
        // this receive ends when the session's terminal result is delivered.
        drop(completion_sink);
        if !started {
            // Cancelled or cleared before the download started: the runner owns
            // this item, so it records exactly one outcome for it.
            let completion =
                synthetic_completion(&item, &request, Outcome::Cancelled, "⏹️ Cancelled.");
            let recorded = coordinator::request(|reply| {
                Command::Queue(QueueCommand::ItemUnstarted {
                    item_id: item.id.clone(),
                    completion: Box::new(completion.clone()),
                    reply,
                })
            })
            .unwrap_or(false);
            if recorded {
                crate::activity::record(&completion);
            }
            continue;
        }
        if let Ok(completion) = completions.recv() {
            finish_item(&item.id, completion);
        }
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};

    struct TestDirectory(std::path::PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "rosi-queue-persistence-{}",
                crate::fs_util::uuid_v4()
            ));
            std::fs::create_dir(&path).expect("create isolated queue directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn item(id: &str, url: &str) -> QueueItem {
        QueueItem {
            id: id.into(),
            url: url.into(),
            status: QueueStatus::Pending,
            added_at: 1,
            started_at: None,
            completed_at: None,
            request: None,
            filename: None,
            output_path: None,
            size_bytes: None,
            error: None,
        }
    }

    #[test]
    fn flush_waits_for_the_serial_writer_and_leaves_primary_and_backup_at_latest_revision() {
        let directory = TestDirectory::new();
        let primary = directory.0.join("download-queue.json");
        let backup = directory.0.join("download-queue.backup.json");
        let calls = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let writer_calls = Arc::clone(&calls);
        let writer_release = Arc::clone(&release_rx);
        let persistence = Arc::new(QueuePersistence::with_writer(
            primary.clone(),
            backup.clone(),
            move |primary, backup, snapshot| {
                if writer_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    started_tx.send(()).expect("notify first write start");
                    writer_release
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .recv()
                        .expect("release first write");
                }
                persist_queue_files(primary, backup, snapshot)
            },
        ));

        let first_writer = Arc::clone(&persistence);
        std::thread::spawn(move || {
            let _ = first_writer.persist(1, vec![item("old", "https://queue.invalid/old")]);
        });
        started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("first write reached the controlled delay");

        let (ack_tx, ack_rx) = mpsc::channel();
        let latest = item("latest", "https://queue.invalid/latest");
        let flush_owner = Arc::clone(&persistence);
        std::thread::spawn(move || {
            let _ = ack_tx.send(flush_owner.flush(2, vec![latest]));
        });
        assert!(ack_rx.recv_timeout(Duration::from_millis(50)).is_err());

        release_tx.send(()).expect("release older serialized write");
        ack_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("flush acknowledges the latest write")
            .expect("latest primary and backup writes succeed");

        let ids = |path: &Path| -> Vec<String> {
            let saved: Value = serde_json::from_slice(
                &std::fs::read(path).expect("persisted queue file is readable"),
            )
            .expect("persisted queue JSON is complete");
            crate::fs_util::list_items(saved)
                .expect("persisted queue has an item list")
                .iter()
                .filter_map(|entry| entry.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        };
        assert_eq!(ids(&primary), ["latest"]);
        // The backup keeps the previous generation instead of copying the primary.
        assert_eq!(ids(&backup), ["old"]);
    }

    #[test]
    fn flush_returns_the_persistence_error_instead_of_acknowledging_durability() {
        let directory = TestDirectory::new();
        let primary = directory.0.join("download-queue.json");
        let backup = directory.0.join("download-queue.backup.json");
        let calls = Arc::new(AtomicUsize::new(0));
        let writer_calls = Arc::clone(&calls);
        let persistence =
            QueuePersistence::with_writer(primary, backup, move |primary, backup, snapshot| {
                if writer_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Err("controlled disk-full failure".into());
                }
                persist_queue_files(primary, backup, snapshot)
            });

        assert!(persistence
            .flush(1, vec![item("failed", "https://queue.invalid/failed")])
            .is_err());
        persistence
            .flush(2, vec![item("saved", "https://queue.invalid/saved")])
            .expect("a later successful flush can be acknowledged");
    }

    fn raw_item(id: &str, status: Value) -> Value {
        json!({
            "id": id,
            "url": format!("https://example.com/{id}"),
            "status": status,
            "addedAt": 1,
            "startedAt": 10,
            "completedAt": 20,
            "filename": "video.mp4",
            "sizeBytes": 5,
            "error": "boom"
        })
    }

    fn with_url(mut value: Value, url: &str) -> Value {
        value["url"] = json!(url);
        value
    }

    fn write_json(path: &Path, value: &Value) {
        std::fs::write(path, serde_json::to_vec(value).expect("encode fixture"))
            .expect("write queue fixture");
    }

    fn statuses_of(items: &[QueueItem]) -> Vec<Value> {
        serde_json::to_value(items)
            .expect("items serialize")
            .as_array()
            .expect("items are an array")
            .iter()
            .map(|entry| entry["status"].clone())
            .collect()
    }

    #[test]
    fn each_status_round_trips_through_the_item_json_unchanged() {
        for status in ["pending", "downloading", "completed", "failed", "cancelled"] {
            let raw = raw_item("q_round", json!(status));
            let item: QueueItem = serde_json::from_value(raw.clone()).expect("item deserializes");
            assert_eq!(serde_json::to_value(&item).expect("item serializes"), raw);
        }
        let minimal = json!({
            "id": "q_min",
            "url": "https://example.com/min",
            "status": "pending",
            "addedAt": 1
        });
        let item: QueueItem =
            serde_json::from_value(minimal.clone()).expect("minimal item deserializes");
        assert_eq!(
            serde_json::to_value(&item).expect("item serializes"),
            minimal
        );
    }

    #[test]
    fn persisted_file_keeps_envelope_and_lowercase_statuses_including_downloading() {
        let directory = TestDirectory::new();
        let primary = directory.0.join("download-queue.json");
        let backup = directory.0.join("download-queue.backup.json");
        let statuses = ["pending", "downloading", "completed", "failed", "cancelled"];
        let items: Vec<QueueItem> = statuses
            .iter()
            .enumerate()
            .map(|(index, status)| {
                serde_json::from_value(raw_item(&format!("q_disk_{index}"), json!(status)))
                    .expect("fixture item deserializes")
            })
            .collect();
        persist_queue_files(&primary, &backup, &items).expect("write queue files");

        let expected: Vec<Value> = statuses.iter().map(|status| json!(status)).collect();
        for path in [&primary, &backup] {
            let saved: Value =
                serde_json::from_slice(&std::fs::read(path).expect("queue file is readable"))
                    .expect("queue file is JSON");
            assert_eq!(saved["schemaVersion"], json!(1));
            let on_disk: Vec<Value> = saved["items"]
                .as_array()
                .expect("items array")
                .iter()
                .map(|entry| entry["status"].clone())
                .collect();
            assert_eq!(on_disk, expected);
        }

        // Reloading turns the interrupted "downloading" item back into pending.
        let reloaded = read_queue(&primary).expect("persisted queue reloads");
        let reloaded_statuses = statuses_of(&reloaded);
        assert_eq!(
            reloaded_statuses,
            ["pending", "pending", "completed", "failed", "cancelled"]
                .iter()
                .map(|status| json!(status))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn legacy_bare_array_and_items_wrapper_load_with_per_status_fields() {
        let directory = TestDirectory::new();
        let bare = directory.0.join("legacy-array.json");
        write_json(
            &bare,
            &json!([
                raw_item("q_done", json!("completed")),
                raw_item("q_failed", json!("failed")),
                raw_item("q_cancelled", json!("cancelled")),
                raw_item("q_waiting", json!("pending")),
            ]),
        );
        let loaded = read_queue(&bare).expect("ROSI 4 bare array loads");
        assert_eq!(
            serde_json::to_value(&loaded).expect("items serialize"),
            json!([
                {
                    "id": "q_done",
                    "url": "https://example.com/q_done",
                    "status": "completed",
                    "addedAt": 1,
                    "startedAt": 10,
                    "completedAt": 20,
                    "filename": "video.mp4",
                    "sizeBytes": 5
                },
                {
                    "id": "q_failed",
                    "url": "https://example.com/q_failed",
                    "status": "failed",
                    "addedAt": 1,
                    "startedAt": 10,
                    "completedAt": 20,
                    "filename": "video.mp4",
                    "sizeBytes": 5,
                    "error": "boom"
                },
                {
                    "id": "q_cancelled",
                    "url": "https://example.com/q_cancelled",
                    "status": "cancelled",
                    "addedAt": 1,
                    "startedAt": 10,
                    "completedAt": 20,
                    "filename": "video.mp4",
                    "sizeBytes": 5
                },
                {
                    "id": "q_waiting",
                    "url": "https://example.com/q_waiting",
                    "status": "pending",
                    "addedAt": 1
                }
            ])
        );

        let wrapped = directory.0.join("wrapped.json");
        write_json(
            &wrapped,
            &json!({"schemaVersion": 1, "items": [raw_item("q_wrapped", json!("failed"))]}),
        );
        assert_eq!(
            statuses_of(&read_queue(&wrapped).expect("items wrapper loads")),
            [json!("failed")]
        );
    }

    #[test]
    fn interrupted_downloading_item_reloads_as_pending_without_attempt_fields() {
        let directory = TestDirectory::new();
        let path = directory.0.join("download-queue.json");
        write_json(
            &path,
            &json!({"schemaVersion": 1, "items": [raw_item("q_live", json!("downloading"))]}),
        );
        let loaded = read_queue(&path).expect("interrupted queue loads");
        assert_eq!(
            serde_json::to_value(&loaded).expect("items serialize"),
            json!([{
                "id": "q_live",
                "url": "https://example.com/q_live",
                "status": "pending",
                "addedAt": 1
            }])
        );
    }

    #[test]
    fn unknown_and_odd_statuses_normalize_to_pending_and_keep_the_item() {
        let odd = [
            json!("running"),
            json!(""),
            json!("Completed"),
            json!("FAILED"),
            json!(5),
            json!(null),
            json!(["failed"]),
        ];
        for (index, status) in odd.into_iter().enumerate() {
            let id = format!("q_odd_{index}");
            let raw = raw_item(&id, status);
            let item = normalize_item(&raw, &mut HashSet::new()).expect("odd status keeps item");
            assert_eq!(
                serde_json::to_value(&item).expect("item serializes"),
                json!({
                    "id": id,
                    "url": format!("https://example.com/{id}"),
                    "status": "pending",
                    "addedAt": 1
                })
            );
        }

        let mut missing = raw_item("q_missing", json!("pending"));
        missing
            .as_object_mut()
            .expect("fixture is an object")
            .remove("status");
        let item = normalize_item(&missing, &mut HashSet::new()).expect("missing status is kept");
        assert_eq!(statuses_of(&[item]), [json!("pending")]);
    }

    #[test]
    fn duplicate_urls_dedupe_only_among_normalized_pending_items() {
        let directory = TestDirectory::new();
        let path = directory.0.join("download-queue.json");
        let shared = "https://example.com/shared";
        write_json(
            &path,
            &json!([
                with_url(raw_item("a1", json!("downloading")), shared),
                with_url(raw_item("a2", json!("downloading")), shared),
                with_url(raw_item("a3", json!("pending")), shared),
                with_url(raw_item("a4", json!("completed")), shared),
                with_url(raw_item("a5", json!("completed")), shared),
            ]),
        );
        let loaded = read_queue(&path).expect("duplicate queue loads");
        let ids: Vec<&str> = loaded.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, ["a1", "a4", "a5"]);
        assert_eq!(
            statuses_of(&loaded),
            [json!("pending"), json!("completed"), json!("completed")]
        );
    }

    #[test]
    fn corrupt_primary_reads_as_unreadable_so_backup_fallback_can_run() {
        let directory = TestDirectory::new();
        let path = directory.0.join("download-queue.json");
        std::fs::write(&path, "{\"schemaVersion\":1,\"items\":[").expect("write corrupt file");
        assert!(read_queue(&path).is_none());
    }
}

pub fn is_running() -> bool {
    state().running
}

/// Stop the runner and any active download (window close / quit / restart).
/// The interrupted item goes back to pending, so it runs again on the next
/// start instead of looking like the user cancelled it.
pub fn stop() {
    coordinator::stop();
}

#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AddResult {
    pub(crate) added: usize,
    pub(crate) skipped: usize,
}

#[tauri::command(async)]
pub fn add_to_queue(
    urls: FalliblePayload<QueueUrlsInput>,
    options: Option<FalliblePayload<DownloadRequestOverrides>>,
) -> IpcResult<AddResult> {
    let urls = match urls {
        FalliblePayload::Typed(urls) => urls.0,
        FalliblePayload::Invalid(_) => return ipc::err(VALIDATION_ERROR, "URLs must be an array."),
    };
    let options = options
        .map(FalliblePayload::into_value)
        .unwrap_or(Value::Null);
    let overrides = match &options {
        Value::Null => None,
        Value::Object(map) => Some(map),
        _ => return ipc::err(VALIDATION_ERROR, "Queue request options must be an object."),
    };
    let settings = crate::settings::load();
    let nonterminal = nonterminal_urls();
    let mut batch = HashSet::new();
    let mut pending = Vec::new();
    let input_count = urls.len();
    let mut valid = 0;
    let mut skipped = 0;
    for raw in urls {
        let url = match raw {
            QueueUrlInput::Text(raw) if raw.len() > MAX_QUEUE_URL_BYTES => {
                return ipc::err(VALIDATION_ERROR, "Queue URLs must not exceed 64 KiB.");
            }
            QueueUrlInput::Text(raw) => match normalize_queue_url(&raw) {
                Some(url) => url,
                None => {
                    skipped += 1;
                    continue;
                }
            },
            QueueUrlInput::Other(_) => {
                skipped += 1;
                continue;
            }
        };
        valid += 1;
        if nonterminal.contains(&url) || batch.contains(&url) {
            skipped += 1;
            continue;
        }
        let request = match build_request(&url, &settings, overrides) {
            Ok(request) => Some(request),
            Err(error) if overrides.is_some() => return ipc::from_error(error),
            Err(error) => {
                crate::logging::warn(&format!(
                    "Queued {url} without a request snapshot: {}",
                    error.message
                ));
                None
            }
        };
        batch.insert(url.clone());
        pending.push(QueueItem {
            id: generate_id(),
            url,
            status: QueueStatus::Pending,
            added_at: crate::app_state::now_ms(),
            started_at: None,
            completed_at: None,
            request,
            filename: None,
            output_path: None,
            size_bytes: None,
            error: None,
        });
    }
    if valid == 0 {
        if input_count > 0 {
            return ipc::ok(AddResult { added: 0, skipped });
        }
        return ipc::err(VALIDATION_ERROR, "No valid URLs provided.");
    }
    coordinator::admit_items(pending, skipped)
}

/// The renderer sends the bare ID string. A non-string is refused with the
/// ID message before the identifier policy runs.
fn typed_queue_item_id(id: FalliblePayload<String>) -> Result<String, IpcError> {
    let raw = id.into_typed(VALIDATION_ERROR, "Queue item ID must be a string.")?;
    validate_queue_item_id(&raw)
}

#[tauri::command(async)]
pub fn remove_from_queue(id: FalliblePayload<String>) -> IpcResult<()> {
    match typed_queue_item_id(id) {
        Ok(id) => coordinator::remove_item(id),
        Err(error) => ipc::from_error(error),
    }
}

#[tauri::command(async)]
pub fn retry_queue_item(id: FalliblePayload<String>) -> IpcResult<()> {
    match typed_queue_item_id(id) {
        Ok(id) => coordinator::retry_item(id),
        Err(error) => ipc::from_error(error),
    }
}

#[tauri::command(async)]
pub fn reorder_queue_item(
    request: FalliblePayload<JsonObject<QueueReorderInput>>,
) -> IpcResult<()> {
    match validate_queue_reorder(request) {
        Ok((id, up)) => coordinator::reorder_item(id, up),
        Err(error) => ipc::from_error(error),
    }
}

#[tauri::command]
pub async fn clear_queue() -> IpcResult<()> {
    tauri::async_runtime::spawn_blocking(clear_queue_blocking)
        .await
        .unwrap_or_else(|error| ipc::err(crate::ipc::INTERNAL_ERROR, error.to_string()))
}

fn clear_queue_blocking() -> IpcResult<()> {
    let Some(was_running) =
        coordinator::request(|reply| Command::Queue(QueueCommand::ClearBegin { reply }))
    else {
        return ipc::err(
            crate::ipc::INTERNAL_ERROR,
            "Queue coordinator is not running.",
        );
    };
    if was_running {
        // Completes the running session synchronously; its result reaches the
        // runner, which records the cancelled outcome.
        downloader::cancel_active_session(true);
    }
    match coordinator::request(|reply| Command::Queue(QueueCommand::ClearItems { reply })) {
        Some(()) => ipc::ok(()),
        None => ipc::err(
            crate::ipc::INTERNAL_ERROR,
            "Queue coordinator is not running.",
        ),
    }
}

/// Remove every completed, failed or cancelled item. Pending and active items
/// stay, so this never interrupts a run.
#[tauri::command(async)]
pub fn clear_finished_queue() -> IpcResult<RemovedCount> {
    match coordinator::clear_finished_items() {
        Some(removed) => ipc::ok(RemovedCount { removed }),
        None => ipc::err(
            crate::ipc::INTERNAL_ERROR,
            "Queue coordinator is not running.",
        ),
    }
}

#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct RemovedCount {
    pub(crate) removed: usize,
}

#[tauri::command(async)]
pub fn get_queue() -> Vec<QueueItem> {
    state().items.clone()
}

#[tauri::command(async)]
pub fn start_queue() -> IpcResult<Started> {
    coordinator::start()
}

#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "QueueStarted"))]
pub struct Started {
    pub(crate) started: bool,
}

#[tauri::command]
pub async fn cancel_queue() -> IpcResult<()> {
    tauri::async_runtime::spawn_blocking(cancel_queue_blocking)
        .await
        .unwrap_or_else(|error| ipc::err(crate::ipc::INTERNAL_ERROR, error.to_string()))
}

fn cancel_queue_blocking() -> IpcResult<()> {
    let Some(active) =
        coordinator::request(|reply| Command::Queue(QueueCommand::CancelBegin { reply }))
    else {
        return ipc::err(
            crate::ipc::INTERNAL_ERROR,
            "Queue coordinator is not running.",
        );
    };
    if active {
        // Completes the running session synchronously; its result reaches the
        // runner, which records the item's single cancelled outcome.
        downloader::cancel_active_session(true);
    }
    // A pending item belongs to no runner, so the handler records it here.
    let Some((_, items)) =
        coordinator::request(|reply| Command::Queue(QueueCommand::Snapshot { bump: false, reply }))
    else {
        return ipc::err(
            crate::ipc::INTERNAL_ERROR,
            "Queue coordinator is not running.",
        );
    };
    let completions: Vec<(String, DownloadCompletion)> = items
        .iter()
        .filter(|item| item.status == QueueStatus::Pending)
        .map(|item| {
            let request = resolve_request(item);
            (
                item.id.clone(),
                synthetic_completion(item, &request, Outcome::Cancelled, "⏹️ Cancelled."),
            )
        })
        .collect();
    let records: Vec<DownloadCompletion> = completions
        .iter()
        .map(|(_, completion)| completion.clone())
        .collect();
    if coordinator::request(|reply| {
        Command::Queue(QueueCommand::CancelApply { completions, reply })
    })
    .is_none()
    {
        return ipc::err(
            crate::ipc::INTERNAL_ERROR,
            "Queue coordinator is not running.",
        );
    }
    for completion in &records {
        crate::activity::record(completion);
    }
    ipc::ok(())
}

#[cfg(test)]
mod run_drain_tests {
    use super::*;
    use crate::coordinator::start_waits_for_exit;

    fn item(id: &str, status: QueueStatus) -> QueueItem {
        QueueItem {
            id: id.into(),
            url: format!("https://example.com/{id}"),
            status,
            added_at: 1,
            started_at: None,
            completed_at: None,
            request: None,
            filename: None,
            output_path: None,
            size_bytes: None,
            error: None,
        }
    }

    fn live_run(items: Vec<QueueItem>, active: Option<&str>) -> QueueState {
        QueueState {
            items,
            running: true,
            runner_alive: true,
            active_item_id: active.map(str::to_string),
            ..QueueState::default()
        }
    }

    fn completion(item_id: &str, outcome: Outcome) -> DownloadCompletion {
        DownloadCompletion {
            id: format!("completion-{item_id}"),
            session_id: None,
            owner: Owner::Queue,
            queue_item_id: Some(item_id.into()),
            outcome,
            status_message: String::new(),
            url: format!("https://example.com/{item_id}"),
            profile: None,
            preset_id: None,
            preset_name: None,
            request: DownloadRequestOptions::default(),
            filename: None,
            output_path: None,
            output_paths: None,
            failed_paths: None,
            size_bytes: None,
            format: None,
            error: None,
            started_at: 1,
            completed_at: 2,
        }
    }

    /// Mirrors the state change in `retry_queue_item`.
    fn retry_in_state(queue: &mut QueueState, id: &str) {
        let item = queue
            .items
            .iter_mut()
            .find(|item| item.id == id)
            .expect("retry target exists");
        clear_attempt(item);
        item.status = QueueStatus::Pending;
    }

    #[test]
    fn last_completed_item_ends_the_run_in_the_same_state_update() {
        let mut queue = live_run(vec![item("a", QueueStatus::Downloading)], Some("a"));
        let ended = apply_completion_in_state(&mut queue, "a", &completion("a", Outcome::Success));
        assert!(ended);
        assert!(!queue.running);
        assert_eq!(queue.active_item_id, None);
        assert_eq!(queue.items[0].status, QueueStatus::Completed);
    }

    #[test]
    fn last_failed_and_cancelled_items_end_the_run() {
        for (outcome, status) in [
            (Outcome::Failed, QueueStatus::Failed),
            (Outcome::Cancelled, QueueStatus::Cancelled),
        ] {
            let mut queue = live_run(vec![item("a", QueueStatus::Downloading)], Some("a"));
            assert!(apply_completion_in_state(
                &mut queue,
                "a",
                &completion("a", outcome)
            ));
            assert!(!queue.running);
            assert_eq!(queue.items[0].status, status);
        }
    }

    #[test]
    fn completion_with_pending_items_keeps_the_run_going() {
        let mut queue = live_run(
            vec![
                item("a", QueueStatus::Downloading),
                item("b", QueueStatus::Pending),
            ],
            Some("a"),
        );
        let ended = apply_completion_in_state(&mut queue, "a", &completion("a", Outcome::Success));
        assert!(!ended);
        assert!(queue.running);
        assert_eq!(queue.items[1].status, QueueStatus::Pending);
    }

    #[test]
    fn completion_with_another_downloading_item_keeps_the_run_going() {
        let mut queue = live_run(
            vec![
                item("a", QueueStatus::Downloading),
                item("b", QueueStatus::Downloading),
            ],
            Some("a"),
        );
        let ended = apply_completion_in_state(&mut queue, "a", &completion("a", Outcome::Success));
        assert!(!ended);
        assert!(queue.running);
    }

    #[test]
    fn retry_after_drain_stays_pending_and_is_not_claimed() {
        let mut queue = live_run(vec![item("a", QueueStatus::Downloading)], Some("a"));
        assert!(apply_completion_in_state(
            &mut queue,
            "a",
            &completion("a", Outcome::Failed)
        ));
        retry_in_state(&mut queue, "a");
        assert!(claim_next_in_state(&mut queue).is_none());
        assert_eq!(queue.items[0].status, QueueStatus::Pending);
        assert!(!queue.running);
    }

    #[test]
    fn retry_while_others_pending_joins_the_active_run() {
        let mut queue = live_run(
            vec![
                item("a", QueueStatus::Failed),
                item("b", QueueStatus::Downloading),
                item("c", QueueStatus::Pending),
            ],
            Some("b"),
        );
        assert!(!apply_completion_in_state(
            &mut queue,
            "b",
            &completion("b", Outcome::Success)
        ));
        retry_in_state(&mut queue, "a");
        let claimed = claim_next_in_state(&mut queue).expect("retried item joins the run");
        assert_eq!(claimed.id, "a");
        assert_eq!(queue.items[0].status, QueueStatus::Downloading);
        assert_eq!(queue.active_item_id.as_deref(), Some("a"));
        assert!(queue.running);
    }

    #[test]
    fn claim_with_nothing_pending_ends_the_run() {
        let mut queue = live_run(vec![item("a", QueueStatus::Completed)], None);
        assert!(claim_next_in_state(&mut queue).is_none());
        assert!(!queue.running);
    }

    #[test]
    fn completion_for_removed_item_ends_only_a_drained_run() {
        // Clear during a drain: nothing is left, so the completion ends the run.
        let mut drained = live_run(vec![], Some("gone"));
        assert!(apply_completion_in_state(
            &mut drained,
            "gone",
            &completion("gone", Outcome::Cancelled)
        ));
        assert!(!drained.running);
        assert_eq!(drained.active_item_id, None);

        // The removed item's completion while another item is still pending.
        let mut pending = live_run(vec![item("b", QueueStatus::Pending)], Some("gone"));
        assert!(!apply_completion_in_state(
            &mut pending,
            "gone",
            &completion("gone", Outcome::Success)
        ));
        assert!(pending.running);
        assert_eq!(pending.items[0].status, QueueStatus::Pending);
    }

    #[test]
    fn completion_after_the_run_ended_changes_nothing() {
        // stop() and cancel_queue() clear `running` and set `cancelled` before the
        // interrupted session's completion arrives.
        let mut queue = QueueState {
            items: vec![item("a", QueueStatus::Downloading)],
            cancelled: true,
            runner_alive: true,
            active_item_id: Some("a".into()),
            ..QueueState::default()
        };
        assert!(!apply_completion_in_state(
            &mut queue,
            "a",
            &completion("a", Outcome::Cancelled)
        ));
        assert!(queue.cancelled);
        assert!(!queue.running);
        assert_eq!(queue.items[0].status, QueueStatus::Cancelled);
    }

    #[test]
    fn start_waits_only_while_an_exiting_runner_is_alive() {
        assert!(!start_waits_for_exit(&QueueState::default()));
        let running = live_run(vec![item("a", QueueStatus::Downloading)], Some("a"));
        assert!(!start_waits_for_exit(&running));
        let drained = QueueState {
            runner_alive: true,
            ..QueueState::default()
        };
        assert!(start_waits_for_exit(&drained));
        let stopping = QueueState {
            runner_alive: true,
            stopping: true,
            ..QueueState::default()
        };
        assert!(!start_waits_for_exit(&stopping));
    }
}
