//! Single owner of queue transitions and of session result routing.
//!
//! One thread receives every command in arrival order. It applies each queue
//! transition (admission, start, stop, cancel, clear, item results, claims)
//! to the queue state, publishes the queue, and answers the caller over a
//! reply channel. It also routes each session's terminal result to the sink
//! registered for that session id, at most once.
//!
//! The thread never waits on child processes, disk, settings, or another
//! thread's reply. Work that needs those stays with the caller:
//! - session cancellation runs on a helper thread (stop) or the caller's
//!   thread (cancel, clear), and reports back as a command;
//! - settings reads, request resolution, and activity records stay in the
//!   Tauri handlers and the runner thread;
//! - durable writes stay with the queue writer, which asks for snapshots here.
//!
//! Only this thread mutates `QueueState`. Readers take its lock briefly.

use crate::constants::MAX_QUEUE_SIZE;
use crate::downloader;
use crate::ipc::{self, IpcResult, INTERNAL_ERROR, NOT_AVAILABLE, VALIDATION_ERROR};
use crate::queue::{self, AddResult, QueueState, Started};
use crate::types::{
    DownloadCompletion, DownloadRequestOptions, Owner, QueueItem, QueueProgress, QueueSnapshot,
    QueueStatus,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// Longest a start waits for the previous runner to exit after its run drained.
/// The runner exits within a loop turn, so this only bounds a stuck runner.
const RUNNER_EXIT_WAIT: Duration = Duration::from_secs(2);

pub enum Command {
    Register {
        session_id: u64,
        sink: Sender<DownloadCompletion>,
    },
    /// The session's terminal result. Routing it finalizes the session and
    /// releases every await that was waiting on it.
    Terminal {
        session_id: u64,
        completion: Box<DownloadCompletion>,
    },
    /// Replies once the named session is finalized (`Some`), or once every
    /// session registered at the time of the request is finalized (`None`).
    /// A session that is not registered counts as already finalized.
    AwaitFinalized {
        session_id: Option<u64>,
        reply: Sender<()>,
    },
    Queue(QueueCommand),
}

pub enum QueueCommand {
    Admit {
        pending: Vec<QueueItem>,
        skipped: usize,
        reply: Sender<IpcResult<AddResult>>,
    },
    Remove {
        id: String,
        reply: Sender<IpcResult<()>>,
    },
    Retry {
        id: String,
        reply: Sender<IpcResult<()>>,
    },
    Reorder {
        id: String,
        up: bool,
        reply: Sender<IpcResult<()>>,
    },
    ClearFinished {
        reply: Sender<usize>,
    },
    Start {
        reply: Sender<IpcResult<Started>>,
    },
    /// Cancels the active session, then answers once the runner has exited and
    /// the interrupted item is back to pending.
    Stop {
        reply: Sender<()>,
    },
    /// The stop helper finished cancelling and killing processes.
    StopCancelSettled,
    /// Marks the queue cancelled. Replies whether an item is active, so the
    /// caller cancels its session before recording the pending items.
    CancelBegin {
        reply: Sender<bool>,
    },
    CancelApply {
        completions: Vec<(String, DownloadCompletion)>,
        reply: Sender<()>,
    },
    /// Marks a running queue cancelled. Replies whether it was running, so the
    /// caller cancels the session before the items are removed.
    ClearBegin {
        reply: Sender<bool>,
    },
    ClearItems {
        reply: Sender<()>,
    },
    Snapshot {
        bump: bool,
        reply: Sender<(u64, Vec<QueueItem>)>,
    },
    /// The runner's next item, or `None` when the run is over.
    ClaimNext {
        reply: Sender<Option<QueueItem>>,
    },
    Prepare {
        item_id: String,
        request: Box<DownloadRequestOptions>,
        reply: Sender<QueueProgress>,
    },
    /// Whether the runner may still start this item.
    Attempt {
        item_id: String,
        reply: Sender<bool>,
    },
    /// The runner's session is visible. Replies with the cancellation the
    /// runner must apply to it, if a cancel landed while it was starting.
    SessionStarted {
        reply: Sender<Option<bool>>,
    },
    ItemFinished {
        item_id: String,
        completion: Box<DownloadCompletion>,
        reply: Sender<()>,
    },
    /// Replies whether the item was still downloading and got the outcome.
    ItemUnstarted {
        item_id: String,
        completion: Box<DownloadCompletion>,
        reply: Sender<bool>,
    },
    RunnerExited,
}

#[derive(Default)]
struct StopState {
    waiters: Vec<Sender<()>>,
    interrupted: Option<String>,
    cancels_outstanding: usize,
}

#[derive(Default)]
struct Coordinator {
    sinks: HashMap<u64, Sender<DownloadCompletion>>,
    /// Sessions each pending await still waits on, with the reply to send once
    /// that set is empty.
    awaits: Vec<(HashSet<u64>, Sender<()>)>,
    starts: Vec<(Sender<IpcResult<Started>>, Instant)>,
    stop: StopState,
}

fn commands() -> &'static Sender<Command> {
    static COORDINATOR: OnceLock<Sender<Command>> = OnceLock::new();
    COORDINATOR.get_or_init(|| {
        let (sender, receiver) = channel();
        std::thread::spawn(move || run(receiver));
        sender
    })
}

fn run(receiver: Receiver<Command>) {
    let mut coordinator = Coordinator::default();
    loop {
        let next_deadline = coordinator
            .starts
            .iter()
            .map(|(_, deadline)| *deadline)
            .min();
        let received = match next_deadline {
            Some(deadline) => {
                receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            }
            None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match received {
            Ok(command) => coordinator.handle(command),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        coordinator.settle_starts(Instant::now());
    }
}

/// Send a command and wait for its reply. `None` means the coordinator is not
/// running. Never call this from the coordinator thread.
pub fn request<T>(build: impl FnOnce(Sender<T>) -> Command) -> Option<T> {
    let (reply, answer) = channel();
    commands().send(build(reply)).ok()?;
    answer.recv().ok()
}

/// `request` for Tauri handlers: a stopped coordinator is an internal error.
fn request_ipc<T: Serialize>(build: impl FnOnce(Sender<IpcResult<T>>) -> Command) -> IpcResult<T> {
    request(build).unwrap_or_else(|| ipc::err(INTERNAL_ERROR, "Queue coordinator is not running."))
}

/// Send a command with no reply.
pub fn submit(command: Command) {
    let _ = commands().send(command);
}

/// Register the caller for a session. Called before the session becomes
/// visible to cancellation, so its terminal result always finds the sink.
pub fn register(session_id: u64, sink: Sender<DownloadCompletion>) {
    submit(Command::Register { session_id, sink });
}

/// Deliver a session's terminal result to its caller, at most once.
pub fn terminal(session_id: u64, completion: DownloadCompletion) {
    submit(Command::Terminal {
        session_id,
        completion: Box::new(completion),
    });
}

/// Block until the session is finalized (`Some`) or until every session that
/// is registered now is finalized (`None`). Returns at once when there is
/// nothing to wait for. Never call this from the coordinator thread.
pub fn await_finalized(session_id: Option<u64>) {
    let _ = request(|reply| Command::AwaitFinalized { session_id, reply });
}

/// Publish the queue after a transition. The guard is released before the
/// event is emitted, so the emit never runs under the state lock.
fn commit(mut queue: MutexGuard<'_, QueueState>) {
    let (revision, items) = queue::revisioned_snapshot(&mut queue, true);
    drop(queue);
    publish(revision, items);
}

/// Only this thread commits, and it publishes each commit before the next
/// command, so `queue-update` revisions reach the renderer in increasing order.
fn publish(revision: u64, items: Vec<QueueItem>) {
    crate::app_state::emit("queue-update", QueueSnapshot { revision, items });
    queue::schedule_persist();
}

/// Whether `start_queue` should wait for a runner that is still exiting after
/// its run drained. A stop in progress is never waited on.
pub(crate) fn start_waits_for_exit(queue: &QueueState) -> bool {
    queue.runner_alive && !queue.running && !queue.stopping
}

/// Decide a start. `None` keeps the caller waiting for the runner to exit.
fn evaluate_start(queue: &mut QueueState, timed_out: bool) -> Option<IpcResult<Started>> {
    if !timed_out && start_waits_for_exit(queue) {
        return None;
    }
    if !queue
        .items
        .iter()
        .any(|item| item.status == QueueStatus::Pending)
    {
        return Some(ipc::err(NOT_AVAILABLE, "No pending items in queue."));
    }
    if queue.stopping {
        return Some(ipc::err(NOT_AVAILABLE, "Queue is stopping."));
    }
    if queue.running {
        return Some(ipc::err(VALIDATION_ERROR, "Queue is already running."));
    }
    if queue.runner_alive {
        return Some(ipc::err(
            NOT_AVAILABLE,
            "Queue is still finishing. Try again shortly.",
        ));
    }
    if !downloader::can_start(Owner::Queue) {
        return Some(ipc::err(
            NOT_AVAILABLE,
            "A manual download is already in progress.",
        ));
    }
    queue.running = true;
    queue.cancelled = false;
    queue.runner_alive = true;
    queue.run_started_at = crate::app_state::now_ms();
    std::thread::spawn(queue::run_queue);
    Some(ipc::ok(Started { started: true }))
}

fn admit(pending: Vec<QueueItem>, mut skipped: usize) -> IpcResult<AddResult> {
    let mut queue = queue::state();
    let nonterminal: HashSet<String> = queue
        .items
        .iter()
        .filter(|item| matches!(item.status, QueueStatus::Pending | QueueStatus::Downloading))
        .map(|item| item.url.clone())
        .collect();
    let mut batch = HashSet::new();
    let mut accepted = Vec::with_capacity(pending.len());
    for item in pending {
        if nonterminal.contains(&item.url) || batch.contains(&item.url) {
            skipped += 1;
            continue;
        }
        batch.insert(item.url.clone());
        accepted.push(item);
    }
    let added = accepted.len();
    if queue.items.len() + added > MAX_QUEUE_SIZE {
        return ipc::err(
            VALIDATION_ERROR,
            format!("Queue limit reached (max {MAX_QUEUE_SIZE} items)."),
        );
    }
    if added > 0 {
        let candidate: Vec<&QueueItem> = queue.items.iter().chain(accepted.iter()).collect();
        match crate::fs_util::encode_list(&candidate) {
            Ok(encoded) if encoded.len() <= queue::MAX_QUEUE_ADMISSION_BYTES => {}
            Ok(_) => {
                return ipc::err(
                    VALIDATION_ERROR,
                    "Queue storage limit reached. Remove items or shorten URLs before adding this batch.",
                )
            }
            Err(_) => {
                return ipc::err(
                    VALIDATION_ERROR,
                    "Could not encode the queue; no items were added.",
                )
            }
        }
        queue.items.extend(accepted);
        commit(queue);
    }
    ipc::ok(AddResult { added, skipped })
}

fn remove(id: &str) -> IpcResult<()> {
    let mut queue = queue::state();
    let Some(index) = queue.items.iter().position(|item| item.id == id) else {
        return ipc::err(NOT_AVAILABLE, "Queue item not found.");
    };
    if queue.items[index].status == QueueStatus::Downloading {
        return ipc::err(
            VALIDATION_ERROR,
            "Cannot remove an actively downloading item.",
        );
    }
    queue.items.remove(index);
    commit(queue);
    ipc::ok(())
}

fn retry(id: &str) -> IpcResult<()> {
    let mut queue = queue::state();
    let Some(item) = queue.items.iter_mut().find(|item| item.id == id) else {
        return ipc::err(NOT_AVAILABLE, "Queue item not found.");
    };
    if item.status != QueueStatus::Failed && item.status != QueueStatus::Cancelled {
        return ipc::err(
            VALIDATION_ERROR,
            "Only failed or cancelled queue items can be retried.",
        );
    }
    queue::clear_attempt(item);
    item.status = QueueStatus::Pending;
    commit(queue);
    ipc::ok(())
}

fn reorder(id: &str, up: bool) -> IpcResult<()> {
    let mut queue = queue::state();
    let Some(index) = queue.items.iter().position(|item| item.id == id) else {
        return ipc::err(NOT_AVAILABLE, "Queue item not found.");
    };
    if queue.items[index].status != QueueStatus::Pending {
        return ipc::err(
            VALIDATION_ERROR,
            "Only pending queue items can be reordered.",
        );
    }
    let pending: Vec<usize> = queue
        .items
        .iter()
        .enumerate()
        .filter(|(_, item)| item.status == QueueStatus::Pending)
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
    commit(queue);
    ipc::ok(())
}

fn clear_finished() -> usize {
    let mut queue = queue::state();
    let before = queue.items.len();
    queue
        .items
        .retain(|item| matches!(item.status, QueueStatus::Pending | QueueStatus::Downloading));
    let removed = before - queue.items.len();
    if removed > 0 {
        commit(queue);
    }
    removed
}

impl Coordinator {
    fn handle(&mut self, command: Command) {
        match command {
            Command::Register { session_id, sink } => {
                self.sinks.insert(session_id, sink);
            }
            Command::Terminal {
                session_id,
                completion,
            } => {
                match self.sinks.remove(&session_id) {
                    Some(sink) => {
                        let _ = sink.send(*completion);
                    }
                    None => crate::logging::warn(&format!(
                        "Ignored a terminal result for session {session_id} with no registered caller."
                    )),
                }
                self.release_awaits(session_id);
            }
            Command::AwaitFinalized { session_id, reply } => {
                let pending: HashSet<u64> = match session_id {
                    Some(id) if self.sinks.contains_key(&id) => HashSet::from([id]),
                    Some(_) => HashSet::new(),
                    None => self.sinks.keys().copied().collect(),
                };
                if pending.is_empty() {
                    let _ = reply.send(());
                } else {
                    self.awaits.push((pending, reply));
                }
            }
            Command::Queue(command) => self.handle_queue(command),
        }
    }

    /// Drop a finalized session from every pending await and acknowledge the
    /// awaits that now have nothing left to wait for.
    fn release_awaits(&mut self, session_id: u64) {
        let mut waiting = Vec::new();
        for (mut pending, reply) in std::mem::take(&mut self.awaits) {
            pending.remove(&session_id);
            if pending.is_empty() {
                let _ = reply.send(());
            } else {
                waiting.push((pending, reply));
            }
        }
        self.awaits = waiting;
    }

    fn handle_queue(&mut self, command: QueueCommand) {
        match command {
            QueueCommand::Admit {
                pending,
                skipped,
                reply,
            } => {
                let _ = reply.send(admit(pending, skipped));
            }
            QueueCommand::Remove { id, reply } => {
                let _ = reply.send(remove(&id));
            }
            QueueCommand::Retry { id, reply } => {
                let _ = reply.send(retry(&id));
            }
            QueueCommand::Reorder { id, up, reply } => {
                let _ = reply.send(reorder(&id, up));
            }
            QueueCommand::ClearFinished { reply } => {
                let _ = reply.send(clear_finished());
            }
            QueueCommand::Start { reply } => {
                let answer = evaluate_start(&mut queue::state(), false);
                match answer {
                    Some(result) => {
                        let _ = reply.send(result);
                    }
                    None => self.starts.push((reply, Instant::now() + RUNNER_EXIT_WAIT)),
                }
            }
            QueueCommand::Stop { reply } => self.stop(reply),
            QueueCommand::StopCancelSettled => {
                self.stop.cancels_outstanding = self.stop.cancels_outstanding.saturating_sub(1);
                self.finish_stop_if_ready();
            }
            QueueCommand::CancelBegin { reply } => {
                let mut queue = queue::state();
                queue.cancelled = true;
                queue.running = false;
                let active = queue.active_item_id.is_some();
                drop(queue);
                let _ = reply.send(active);
            }
            QueueCommand::CancelApply { completions, reply } => {
                let mut queue = queue::state();
                for (id, completion) in &completions {
                    if let Some(item) = queue
                        .items
                        .iter_mut()
                        .find(|item| &item.id == id && item.status == QueueStatus::Pending)
                    {
                        queue::apply_completion(item, completion);
                    }
                }
                queue.active_item_id = None;
                commit(queue);
                let _ = reply.send(());
            }
            QueueCommand::ClearBegin { reply } => {
                let mut queue = queue::state();
                let running = queue.running;
                if running {
                    queue.cancelled = true;
                    queue.running = false;
                    queue.active_item_id = None;
                }
                drop(queue);
                let _ = reply.send(running);
            }
            QueueCommand::ClearItems { reply } => {
                let mut queue = queue::state();
                queue.items.clear();
                commit(queue);
                let _ = reply.send(());
            }
            QueueCommand::Snapshot { bump, reply } => {
                let mut queue = queue::state();
                let snapshot = queue::revisioned_snapshot(&mut queue, bump);
                drop(queue);
                let _ = reply.send(snapshot);
            }
            QueueCommand::ClaimNext { reply } => {
                let mut queue = queue::state();
                let next = queue::claim_next_in_state(&mut queue);
                commit(queue);
                let _ = reply.send(next);
            }
            QueueCommand::Prepare {
                item_id,
                request,
                reply,
            } => {
                let mut queue = queue::state();
                if let Some(current) = queue.items.iter_mut().find(|entry| entry.id == item_id) {
                    current.request = Some(*request);
                }
                let progress = queue::progress_for(&queue, &item_id);
                drop(queue);
                let _ = reply.send(progress);
            }
            QueueCommand::Attempt { item_id, reply } => {
                let queue = queue::state();
                let wanted = queue.running
                    && !queue.cancelled
                    && queue.items.iter().any(|entry| {
                        entry.id == item_id && entry.status == QueueStatus::Downloading
                    });
                drop(queue);
                let _ = reply.send(wanted);
            }
            QueueCommand::SessionStarted { reply } => {
                let queue = queue::state();
                let cancel = queue.cancelled.then_some(!queue.stopping);
                drop(queue);
                let _ = reply.send(cancel);
            }
            QueueCommand::ItemFinished {
                item_id,
                completion,
                reply,
            } => {
                let mut queue = queue::state();
                queue::apply_completion_in_state(&mut queue, &item_id, &completion);
                commit(queue);
                let _ = reply.send(());
            }
            QueueCommand::ItemUnstarted {
                item_id,
                completion,
                reply,
            } => {
                let recorded = item_unstarted(&item_id, &completion);
                let _ = reply.send(recorded);
            }
            QueueCommand::RunnerExited => {
                queue::state().runner_alive = false;
                self.finish_stop_if_ready();
            }
        }
    }

    fn stop(&mut self, reply: Sender<()>) {
        let interrupted = {
            let mut queue = queue::state();
            queue.cancelled = true;
            queue.running = false;
            queue.stopping = true;
            queue.active_item_id.take()
        };
        if interrupted.is_some() {
            self.stop.interrupted = interrupted;
        }
        self.stop.waiters.push(reply);
        self.stop.cancels_outstanding += 1;
        // Process waits happen off this thread. The helper reports back once
        // the cancel and the kill are done.
        std::thread::spawn(|| {
            downloader::cancel_active_session(false);
            downloader::kill_all_processes();
            submit(Command::Queue(QueueCommand::StopCancelSettled));
        });
        self.finish_stop_if_ready();
    }

    /// A stop is acknowledged once its cancel has settled and the runner has
    /// exited. The interrupted item then goes back to pending.
    fn finish_stop_if_ready(&mut self) {
        if self.stop.waiters.is_empty() || self.stop.cancels_outstanding > 0 {
            return;
        }
        let mut queue = queue::state();
        if queue.runner_alive {
            return;
        }
        let interrupted = self.stop.interrupted.take();
        let requeued = interrupted.is_some_and(|id| {
            queue
                .items
                .iter_mut()
                .find(|item| item.id == id && item.status == QueueStatus::Cancelled)
                .map(|item| {
                    queue::clear_attempt(item);
                    item.status = QueueStatus::Pending;
                })
                .is_some()
        });
        queue.stopping = false;
        if requeued {
            commit(queue);
        } else {
            drop(queue);
        }
        for waiter in self.stop.waiters.drain(..) {
            let _ = waiter.send(());
        }
    }

    /// Answer deferred starts whose runner has exited, or whose wait timed out.
    fn settle_starts(&mut self, now: Instant) {
        if self.starts.is_empty() {
            return;
        }
        let mut still_waiting = Vec::new();
        for (reply, deadline) in std::mem::take(&mut self.starts) {
            let answer = evaluate_start(&mut queue::state(), now >= deadline);
            match answer {
                Some(result) => {
                    let _ = reply.send(result);
                }
                None => still_waiting.push((reply, deadline)),
            }
        }
        self.starts = still_waiting;
    }
}

/// Record a cancelled outcome for an item the runner claimed but never
/// started. Only an item still downloading takes it; a cleared queue records
/// nothing. Returns whether it was applied.
fn item_unstarted(item_id: &str, completion: &DownloadCompletion) -> bool {
    let mut queue = queue::state();
    if queue.active_item_id.as_deref() == Some(item_id) {
        queue.active_item_id = None;
    }
    let Some(entry) = queue
        .items
        .iter_mut()
        .find(|entry| entry.id == item_id && entry.status == QueueStatus::Downloading)
    else {
        return false;
    };
    queue::apply_completion(entry, completion);
    queue::end_run_if_drained(&mut queue);
    commit(queue);
    true
}

/// Admit already-built queue items. Duplicates of non-terminal URLs are
/// skipped here too, against the state as it is now.
pub fn admit_items(pending: Vec<QueueItem>, skipped: usize) -> IpcResult<AddResult> {
    request_ipc(|reply| {
        Command::Queue(QueueCommand::Admit {
            pending,
            skipped,
            reply,
        })
    })
}

/// Remove finished items. `None` means the coordinator is not running.
pub fn clear_finished_items() -> Option<usize> {
    request(|reply| Command::Queue(QueueCommand::ClearFinished { reply }))
}

pub fn remove_item(id: String) -> IpcResult<()> {
    request_ipc(|reply| Command::Queue(QueueCommand::Remove { id, reply }))
}

pub fn retry_item(id: String) -> IpcResult<()> {
    request_ipc(|reply| Command::Queue(QueueCommand::Retry { id, reply }))
}

pub fn reorder_item(id: String, up: bool) -> IpcResult<()> {
    request_ipc(|reply| Command::Queue(QueueCommand::Reorder { id, up, reply }))
}

pub fn start() -> IpcResult<Started> {
    request_ipc(|reply| Command::Queue(QueueCommand::Start { reply }))
}

pub fn stop() {
    let _ = request(|reply| Command::Queue(QueueCommand::Stop { reply }));
}
