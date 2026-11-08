//! Single owner of the download session slot.
//!
//! One thread holds the current `Session`. Every operation on it is a task
//! that the thread runs in arrival order: install, cancel, finish, process
//! registration, progress, and event emission. Callers send a task and wait
//! for its reply. Only this thread touches the session.
//!
//! The thread never waits on child processes, on the coordinator, or on
//! another thread's reply. Work that does (terminating process trees,
//! awaiting finalization, recording stats) stays with the caller, which asks
//! for a plan first and acts after the reply. Tasks never send a request to
//! the owner. `run` refuses that case with a logged error, so it cannot hang.
//!
//! `SLOT_OWNER` mirrors which owner holds the slot, so the coordinator and
//! the main thread can ask without a reply. It is a read-only hint. The
//! install task is the authoritative check.

use super::Session;
use crate::types::{DownloadCompletion, Owner};
use std::cell::Cell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::OnceLock;

const NO_OWNER: u8 = 0;

/// Owner of the slot, as read by `can_start` and `is_busy`. Written only by
/// the owner thread after each task.
static SLOT_OWNER: AtomicU8 = AtomicU8::new(NO_OWNER);

type Task = Box<dyn FnOnce(&mut Option<Session>) + Send>;

thread_local! {
    static ON_OWNER: Cell<bool> = const { Cell::new(false) };
}

fn owner_code(owner: Owner) -> u8 {
    match owner {
        Owner::Manual => 1,
        Owner::Queue => 2,
    }
}

fn sender() -> &'static Sender<Task> {
    static OWNER: OnceLock<Sender<Task>> = OnceLock::new();
    OWNER.get_or_init(|| {
        let (sender, receiver) = channel();
        std::thread::spawn(move || run_owner(receiver));
        sender
    })
}

fn run_owner(receiver: Receiver<Task>) {
    ON_OWNER.with(|flag| flag.set(true));
    let mut slot: Option<Session> = None;
    for task in receiver {
        // A panicking task drops its reply, so its caller sees `None`. The
        // owner keeps serving, as the old recovered mutex did.
        if catch_unwind(AssertUnwindSafe(|| task(&mut slot))).is_err() {
            crate::logging::error("Download session task panicked.");
        }
        let owner = slot
            .as_ref()
            .map_or(NO_OWNER, |session| owner_code(session.owner));
        SLOT_OWNER.store(owner, Ordering::SeqCst);
    }
}

/// Run a task on the owner and wait for its result. `None` means the owner
/// did not answer: it was asked from its own thread, or the task panicked.
pub(super) fn run<R: Send + 'static>(
    task: impl FnOnce(&mut Option<Session>) -> R + Send + 'static,
) -> Option<R> {
    if ON_OWNER.with(Cell::get) {
        crate::logging::error("Download session owner asked itself for a result.");
        return None;
    }
    let (reply, answer) = channel();
    sender()
        .send(Box::new(move |slot| {
            let _ = reply.send(task(slot));
        }))
        .ok()?;
    answer.recv().ok()
}

/// Result of asking the owner to install a session.
pub(super) enum Installed {
    Accepted,
    /// Another owner holds the slot.
    Conflict {
        session_id: u64,
    },
    /// The same owner holds the slot. The caller cancels and awaits that
    /// session, then installs this one with the returned values.
    Occupied {
        session_id: u64,
        session: Box<Session>,
        completion: Sender<DownloadCompletion>,
    },
}

/// Make `session` current. Registration with the coordinator happens in the
/// same task, so a cancel or finish that sees the session always finds its
/// sink. `None` when the owner did not answer.
pub(super) fn install(
    session: Box<Session>,
    completion: Sender<DownloadCompletion>,
) -> Option<Installed> {
    run(move |slot| {
        let existing = slot.as_ref().map(|current| (current.id, current.owner));
        match existing {
            Some((session_id, owner)) if owner != session.owner => {
                Installed::Conflict { session_id }
            }
            Some((session_id, _)) => Installed::Occupied {
                session_id,
                session,
                completion,
            },
            None => {
                crate::coordinator::register(session.id, completion);
                *slot = Some(*session);
                Installed::Accepted
            }
        }
    })
}

/// Read-only hint: whether `owner` may take the slot. `install` decides for
/// real, so a stale answer only costs a retry.
pub fn can_start(owner: Owner) -> bool {
    let hint = SLOT_OWNER.load(Ordering::SeqCst);
    hint == NO_OWNER || hint == owner_code(owner)
}

/// Read-only hint: whether any session holds the slot.
pub fn is_busy() -> bool {
    SLOT_OWNER.load(Ordering::SeqCst) != NO_OWNER
}
