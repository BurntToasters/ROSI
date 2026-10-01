//! Persistent download queue (`download-queue.json` + backup) and the runner
//! that feeds queued items to the downloader one at a time.

use crate::constants::MAX_QUEUE_SIZE;
use crate::downloader::{self, CompletionCallback};
use crate::ipc::{self, IpcResult, NOT_AVAILABLE, VALIDATION_ERROR};
use crate::types::{
    DownloadCompletion, DownloadRequestOptions, Outcome, Owner, PlaylistSelection, QueueItem,
    QueueProgress, Settings,
};
use crate::validation::{
    normalize_queue_url, validate_download_path, validate_download_request, validate_file_location,
    validate_queue_item_id, validate_queue_reorder,
};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

#[derive(Default)]
struct QueueState {
    items: Vec<QueueItem>,
    running: bool,
    cancelled: bool,
    active_item_id: Option<String>,
    runner_alive: bool,
}

static QUEUE: OnceLock<Mutex<QueueState>> = OnceLock::new();
/// Serializes the runner's "is the queue still running? then start" step
/// against cancel/clear/stop, so a cancel can never land between the check and
/// `start_download`. Never acquired while holding the queue lock.
static START_GUARD: Mutex<()> = Mutex::new(());
static PERSIST_SIGNAL: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

fn queue_path() -> std::path::PathBuf {
    crate::app_state::data_dir().join("download-queue.json")
}

fn backup_path() -> std::path::PathBuf {
    crate::app_state::data_dir().join("download-queue.backup.json")
}

fn state() -> MutexGuard<'static, QueueState> {
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
    let status = match object.get("status").and_then(Value::as_str) {
        Some(status @ ("pending" | "completed" | "failed" | "cancelled")) => status.to_string(),
        _ => "pending".to_string(),
    };
    let mut item = QueueItem {
        id,
        url: url.clone(),
        status: status.clone(),
        added_at: positive_ms(object.get("addedAt")).unwrap_or_else(crate::app_state::now_ms),
        started_at: None,
        completed_at: None,
        request: crate::activity::normalize_stored_request(object.get("request"), Some(&url)),
        filename: None,
        output_path: None,
        size_bytes: None,
        error: None,
    };
    if status != "pending" {
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
        if status == "failed" {
            item.error = object
                .get("error")
                .and_then(Value::as_str)
                .map(|error| error.chars().take(2000).collect());
        }
    }
    Some(item)
}

fn read_queue(path: &std::path::Path) -> Option<Vec<QueueItem>> {
    let Value::Array(list) = crate::fs_util::read_json(path, 32 * 1024 * 1024)? else {
        return None;
    };
    let mut used_ids = HashSet::new();
    let mut nonterminal = HashSet::new();
    let mut items = Vec::new();
    for raw in list.iter().take(MAX_QUEUE_SIZE) {
        let Some(item) = normalize_item(raw, &mut used_ids) else {
            continue;
        };
        if item.status == "pending" && !nonterminal.insert(item.url.clone()) {
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

fn persist(items: &[QueueItem]) {
    let path = queue_path();
    let backup = backup_path();
    if path.exists() {
        let _ = std::fs::copy(&path, &backup);
    }
    match crate::fs_util::write_json(&path, &items) {
        Ok(()) => {
            let _ = std::fs::copy(&path, &backup);
        }
        Err(error) => crate::logging::error(&format!("Failed to persist queue: {error}")),
    }
}

/// Debounced (300 ms) background persistence.
fn schedule_persist() {
    static WORKER: OnceLock<()> = OnceLock::new();
    WORKER.get_or_init(|| {
        std::thread::spawn(|| loop {
            {
                let (lock, signal) = &PERSIST_SIGNAL;
                let mut pending = lock.lock().unwrap_or_else(|p| p.into_inner());
                while !*pending {
                    pending = signal.wait(pending).unwrap_or_else(|p| p.into_inner());
                }
            }
            std::thread::sleep(Duration::from_millis(300));
            {
                let (lock, _) = &PERSIST_SIGNAL;
                *lock.lock().unwrap_or_else(|p| p.into_inner()) = false;
            }
            let snapshot = state().items.clone();
            persist(&snapshot);
        });
    });
    let (lock, signal) = &PERSIST_SIGNAL;
    *lock.lock().unwrap_or_else(|p| p.into_inner()) = true;
    signal.notify_one();
}

pub fn flush() {
    {
        let (lock, _) = &PERSIST_SIGNAL;
        *lock.lock().unwrap_or_else(|p| p.into_inner()) = false;
    }
    let snapshot = state().items.clone();
    persist(&snapshot);
}

/// Load the persisted queue eagerly at startup.
pub fn init() {
    drop(state());
}

fn broadcast(items: Vec<QueueItem>) {
    crate::app_state::emit("queue-update", items);
    schedule_persist();
}

fn resolve_output_path(settings: &Settings) -> String {
    let configured = settings.download_folder.trim();
    if !configured.is_empty() {
        if let Ok(path) = validate_download_path(configured) {
            if !path.is_empty() {
                return path;
            }
        }
    }
    crate::app_state::downloads_dir()
        .to_string_lossy()
        .into_owned()
}

fn request_from_settings(url: &str, settings: &Settings) -> DownloadRequestOptions {
    DownloadRequestOptions {
        url: url.to_string(),
        output_path: resolve_output_path(settings),
        ffmpeg_path: Some(settings.ffmpeg_path.clone()).filter(|path| !path.is_empty()),
        convert_enabled: Some(settings.convert_enabled),
        convert_format: Some(settings.convert_format.clone()),
        keep_original: Some(settings.keep_original_after_convert),
        playlist: Some(PlaylistSelection {
            mode: "current".into(),
            start: None,
            end: None,
        }),
        profile_enabled: Some(settings.download_profiles_enabled),
        profile: Some(settings.download_mode.clone()),
        best_quality: Some(settings.best_quality),
        advanced_options: Some(settings.advanced_options),
        audio_only: Some(settings.audio_only),
        audio_output_format: Some(settings.audio_format.clone()),
        hook_browser: Some(settings.hook_browser),
        browser_choice: Some(settings.browser_choice.clone()),
        gpu_acceleration: Some(settings.gpu_acceleration),
        gpu_type: Some(settings.gpu_type.clone()),
        write_subtitles: Some(settings.write_subtitles),
        subtitle_langs: Some(settings.subtitle_langs.clone()),
        embed_thumbnail: Some(settings.embed_thumbnail),
        embed_metadata: Some(settings.embed_metadata),
        sponsorblock_remove: Some(settings.sponsorblock_remove),
        ..DownloadRequestOptions::default()
    }
}

fn build_request(
    url: &str,
    settings: &Settings,
    overrides: Option<&Map<String, Value>>,
) -> Result<DownloadRequestOptions, crate::ipc::IpcError> {
    let mut candidate = match serde_json::to_value(request_from_settings(url, settings)) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let preset_id = overrides
        .and_then(|map| map.get("presetId"))
        .and_then(Value::as_str)
        .map(str::trim);
    if let Some(preset) =
        preset_id.and_then(|id| settings.download_presets.iter().find(|p| p.id == id))
    {
        candidate.extend(crate::settings::preset_to_request_options(preset));
    }
    if let Some(overrides) = overrides {
        for (key, value) in overrides {
            if !value.is_null() {
                candidate.insert(key.clone(), value.clone());
            }
        }
    }
    candidate.insert("url".into(), Value::String(url.to_string()));
    // Always validate: a snapshot that cannot be re-validated later would be
    // silently discarded on reload and would never reach the activity log.
    validate_download_request(&Value::Object(candidate))
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
            request_from_settings(&item.url, &settings)
        }
    }
}

fn clear_attempt(item: &mut QueueItem) {
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
        size_bytes: None,
        format: None,
        error: (outcome == Outcome::Failed).then(|| message.to_string()),
        started_at: item.started_at.unwrap_or(now),
        completed_at: now,
    }
}

fn apply_completion(item: &mut QueueItem, completion: &DownloadCompletion) {
    item.status = match completion.outcome {
        Outcome::Success => "completed",
        Outcome::Failed => "failed",
        Outcome::Cancelled => "cancelled",
    }
    .to_string();
    item.request = Some(completion.request.clone());
    item.completed_at = Some(completion.completed_at);
    item.filename = completion.filename.clone();
    item.output_path = completion.output_path.clone();
    item.size_bytes = completion.size_bytes;
    item.error = (completion.outcome == Outcome::Failed).then(|| {
        completion
            .error
            .clone()
            .unwrap_or_else(|| completion.status_message.clone())
    });
}

/// Apply a completion to the matching item (if still present) and record it.
fn finish_item(item_id: &str, completion: DownloadCompletion) {
    let snapshot = {
        let mut queue = state();
        if let Some(item) = queue.items.iter_mut().find(|item| item.id == item_id) {
            apply_completion(item, &completion);
        }
        if queue.active_item_id.as_deref() == Some(item_id) {
            queue.active_item_id = None;
        }
        queue.items.clone()
    };
    crate::activity::record(&completion);
    broadcast(snapshot);
}

/// Record a cancelled outcome for an item the runner claimed but never
/// started, if the item is still in the queue (a cleared queue records nothing).
fn finish_unstarted_item(item: &QueueItem, request: &DownloadRequestOptions) {
    let completion = synthetic_completion(item, request, Outcome::Cancelled, "⏹️ Cancelled.");
    let snapshot = {
        let mut queue = state();
        if queue.active_item_id.as_deref() == Some(item.id.as_str()) {
            queue.active_item_id = None;
        }
        let Some(entry) = queue
            .items
            .iter_mut()
            .find(|entry| entry.id == item.id && entry.status == "downloading")
        else {
            return;
        };
        apply_completion(entry, &completion);
        queue.items.clone()
    };
    crate::activity::record(&completion);
    broadcast(snapshot);
}

fn run_queue() {
    loop {
        let next = {
            let mut queue = state();
            let next_index = queue.items.iter().position(|item| item.status == "pending");
            match next_index {
                Some(index) if queue.running && !queue.cancelled => {
                    let item = &mut queue.items[index];
                    clear_attempt(item);
                    item.status = "downloading".into();
                    item.started_at = Some(crate::app_state::now_ms());
                    let item = item.clone();
                    queue.active_item_id = Some(item.id.clone());
                    Some((item, queue.items.clone()))
                }
                _ => {
                    queue.running = false;
                    queue.cancelled = false;
                    queue.active_item_id = None;
                    queue.runner_alive = false;
                    let snapshot = queue.items.clone();
                    drop(queue);
                    broadcast(snapshot);
                    None
                }
            }
        };
        let Some((item, snapshot)) = next else {
            return;
        };
        broadcast(snapshot);

        let request = resolve_request(&item);
        let progress = {
            let mut queue = state();
            if let Some(current) = queue.items.iter_mut().find(|entry| entry.id == item.id) {
                current.request = Some(request.clone());
            }
            QueueProgress {
                completed_items: queue
                    .items
                    .iter()
                    .filter(|entry| {
                        matches!(entry.status.as_str(), "completed" | "failed" | "cancelled")
                    })
                    .count(),
                queue_total: queue.items.len(),
                queue_item_id: Some(item.id.clone()),
            }
        };
        if crate::app_state::main_window().is_none() {
            finish_item(
                &item.id,
                synthetic_completion(&item, &request, Outcome::Failed, "Window closed"),
            );
            continue;
        }
        let (sender, receiver) = std::sync::mpsc::channel::<()>();
        let item_id = item.id.clone();
        let on_complete: CompletionCallback = Box::new(move |completion| {
            finish_item(&item_id, completion);
            let _ = sender.send(());
        });
        let started = {
            let _guard = START_GUARD.lock().unwrap_or_else(|p| p.into_inner());
            let still_wanted = {
                let queue = state();
                queue.running
                    && !queue.cancelled
                    && queue
                        .items
                        .iter()
                        .any(|entry| entry.id == item.id && entry.status == "downloading")
            };
            if still_wanted {
                Some(downloader::start_download(
                    request.clone(),
                    Owner::Queue,
                    Some(progress),
                    on_complete,
                ))
            } else {
                None
            }
        };
        match started {
            // Cancelled or cleared before the download started: the runner
            // owns this item, so it records exactly one outcome for it.
            None => finish_unstarted_item(&item, &request),
            Some(Err(error)) => finish_item(
                &item.id,
                synthetic_completion(&item, &request, Outcome::Failed, &error),
            ),
            // The callback always runs exactly once per started session.
            Some(Ok(())) => {
                let _ = receiver.recv();
            }
        }
    }
}

pub fn is_running() -> bool {
    state().running
}

/// Stop the runner and any active download (window close / quit).
pub fn stop() {
    let _guard = START_GUARD.lock().unwrap_or_else(|p| p.into_inner());
    {
        let mut queue = state();
        queue.cancelled = true;
        queue.running = false;
        queue.active_item_id = None;
    }
    downloader::cancel_active_session(false);
    downloader::kill_all_processes();
}

#[derive(serde::Serialize)]
pub struct AddResult {
    added: usize,
    skipped: usize,
}

#[tauri::command(async)]
pub fn add_to_queue(urls: Value, options: Option<Value>) -> IpcResult<AddResult> {
    let Some(urls) = urls.as_array() else {
        return ipc::err(VALIDATION_ERROR, "URLs must be an array.");
    };
    let overrides = match &options {
        None | Some(Value::Null) => None,
        Some(Value::Object(map)) => Some(map),
        Some(_) => return ipc::err(VALIDATION_ERROR, "Queue request options must be an object."),
    };
    let settings = crate::settings::load();
    let mut queue = state();
    let nonterminal: HashSet<String> = queue
        .items
        .iter()
        .filter(|item| item.status == "pending" || item.status == "downloading")
        .map(|item| item.url.clone())
        .collect();
    let mut batch = HashSet::new();
    let mut pending = Vec::new();
    let mut valid = 0;
    let mut skipped = 0;
    for raw in urls {
        let Some(url) = raw.as_str().and_then(normalize_queue_url) else {
            skipped += 1;
            continue;
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
            status: "pending".into(),
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
        return ipc::err(VALIDATION_ERROR, "No valid URLs provided.");
    }
    if queue.items.len() + pending.len() > MAX_QUEUE_SIZE {
        return ipc::err(
            VALIDATION_ERROR,
            format!("Queue limit reached (max {MAX_QUEUE_SIZE} items)."),
        );
    }
    let added = pending.len();
    if added > 0 {
        queue.items.extend(pending);
        let snapshot = queue.items.clone();
        drop(queue);
        broadcast(snapshot);
    }
    ipc::ok(AddResult { added, skipped })
}

#[tauri::command(async)]
pub fn remove_from_queue(id: Value) -> IpcResult<()> {
    let id = match validate_queue_item_id(&id) {
        Ok(id) => id,
        Err(error) => return ipc::from_error(error),
    };
    let mut queue = state();
    let Some(index) = queue.items.iter().position(|item| item.id == id) else {
        return ipc::err(NOT_AVAILABLE, "Queue item not found.");
    };
    if queue.items[index].status == "downloading" {
        return ipc::err(
            VALIDATION_ERROR,
            "Cannot remove an actively downloading item.",
        );
    }
    queue.items.remove(index);
    let snapshot = queue.items.clone();
    drop(queue);
    broadcast(snapshot);
    ipc::ok(())
}

#[tauri::command(async)]
pub fn retry_queue_item(id: Value) -> IpcResult<()> {
    let id = match validate_queue_item_id(&id) {
        Ok(id) => id,
        Err(error) => return ipc::from_error(error),
    };
    let mut queue = state();
    let Some(item) = queue.items.iter_mut().find(|item| item.id == id) else {
        return ipc::err(NOT_AVAILABLE, "Queue item not found.");
    };
    if item.status != "failed" && item.status != "cancelled" {
        return ipc::err(
            VALIDATION_ERROR,
            "Only failed or cancelled queue items can be retried.",
        );
    }
    clear_attempt(item);
    item.status = "pending".into();
    let snapshot = queue.items.clone();
    drop(queue);
    broadcast(snapshot);
    ipc::ok(())
}

#[tauri::command(async)]
pub fn reorder_queue_item(request: Value) -> IpcResult<()> {
    let (id, up) = match validate_queue_reorder(&request) {
        Ok(parsed) => parsed,
        Err(error) => return ipc::from_error(error),
    };
    let mut queue = state();
    let Some(index) = queue.items.iter().position(|item| item.id == id) else {
        return ipc::err(NOT_AVAILABLE, "Queue item not found.");
    };
    if queue.items[index].status != "pending" {
        return ipc::err(
            VALIDATION_ERROR,
            "Only pending queue items can be reordered.",
        );
    }
    let pending: Vec<usize> = queue
        .items
        .iter()
        .enumerate()
        .filter(|(_, item)| item.status == "pending")
        .map(|(position, _)| position)
        .collect();
    let position = pending
        .iter()
        .position(|candidate| *candidate == index)
        .unwrap_or(0);
    let destination = if up {
        position.checked_sub(1)
    } else {
        Some(position + 1)
    }
    .and_then(|slot| pending.get(slot).copied());
    let Some(destination) = destination else {
        return ipc::err(
            NOT_AVAILABLE,
            format!("Queue item cannot move {}.", if up { "up" } else { "down" }),
        );
    };
    queue.items.swap(index, destination);
    let snapshot = queue.items.clone();
    drop(queue);
    broadcast(snapshot);
    ipc::ok(())
}

#[tauri::command(async)]
pub fn clear_queue() -> IpcResult<()> {
    let _guard = START_GUARD.lock().unwrap_or_else(|p| p.into_inner());
    let was_running = {
        let mut queue = state();
        let running = queue.running;
        if running {
            queue.cancelled = true;
            queue.running = false;
            queue.active_item_id = None;
        }
        running
    };
    if was_running {
        downloader::cancel_active_session(true);
    }
    let snapshot = {
        let mut queue = state();
        queue.items.clear();
        queue.items.clone()
    };
    broadcast(snapshot);
    ipc::ok(())
}

#[tauri::command(async)]
pub fn get_queue() -> Vec<QueueItem> {
    state().items.clone()
}

#[tauri::command(async)]
pub fn start_queue() -> IpcResult<Started> {
    let mut queue = state();
    if !queue.items.iter().any(|item| item.status == "pending") {
        return ipc::err(NOT_AVAILABLE, "No pending items in queue.");
    }
    if queue.running || queue.runner_alive {
        return ipc::err(VALIDATION_ERROR, "Queue is already running.");
    }
    if !downloader::can_start(Owner::Queue) {
        return ipc::err(NOT_AVAILABLE, "A manual download is already in progress.");
    }
    queue.running = true;
    queue.cancelled = false;
    queue.runner_alive = true;
    drop(queue);
    std::thread::spawn(run_queue);
    ipc::ok(Started { started: true })
}

#[derive(serde::Serialize)]
pub struct Started {
    started: bool,
}

#[tauri::command(async)]
pub fn cancel_queue() -> IpcResult<()> {
    let _guard = START_GUARD.lock().unwrap_or_else(|p| p.into_inner());
    let active = {
        let mut queue = state();
        queue.cancelled = true;
        queue.running = false;
        queue.active_item_id.clone()
    };
    if active.is_some() {
        // Completes the running session synchronously; its callback records
        // the item's single cancelled outcome.
        downloader::cancel_active_session(true);
    }
    // A "downloading" item without a session belongs to the runner, which
    // records it once it sees the cancel. Only untouched items are cancelled
    // here, so no item is ever recorded twice.
    let remaining: Vec<QueueItem> = state()
        .items
        .iter()
        .filter(|item| item.status == "pending")
        .cloned()
        .collect();
    let mut completions = Vec::new();
    for item in &remaining {
        let request = resolve_request(item);
        completions.push((
            item.id.clone(),
            synthetic_completion(item, &request, Outcome::Cancelled, "⏹️ Cancelled."),
        ));
    }
    let snapshot = {
        let mut queue = state();
        for (id, completion) in &completions {
            if let Some(item) = queue
                .items
                .iter_mut()
                .find(|item| &item.id == id && item.status == "pending")
            {
                apply_completion(item, completion);
            }
        }
        queue.active_item_id = None;
        queue.items.clone()
    };
    for (_, completion) in &completions {
        crate::activity::record(completion);
    }
    broadcast(snapshot);
    ipc::ok(())
}
