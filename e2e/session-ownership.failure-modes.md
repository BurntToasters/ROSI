# Session ownership: failure modes

Written before the Rust change. This is roadmap B7 part B: the download session
slot moves out of the globals in `src-tauri/src/downloader.rs` (`ACTIVE`,
`ACTIVE_PRESENT`, `STARTUP`, `EVENT_PUBLISH`) into a session owner thread
(`src-tauri/src/downloader/session_owner.rs`). The owner holds the one
`Session` and runs its tasks in arrival order. Callers ask it over reply
channels. Process waits, process termination, stats, and coordinator waits stay
on caller threads.

Scenario names are the ones in `e2e/suites.json` groups `downloads`,
`conversion`, `queue`, and `persistence`, and the spec titles in
`e2e/queue-coordinator`, `e2e/download-process*.spec.js`,
`e2e/native-downloads.spec.js`, and `e2e/download-session.spec.js`.

## Deadlock

| # | Failure mode | Mechanism | Required behavior | Proof |
| --- | --- | --- | --- | --- |
| 1 | An owner task asks the owner for something and waits. The owner waits on itself. | A helper called inside a task calls `with_session`, `cancel_session`, or `complete_session`. | Tasks take `&mut Session` directly. Only caller threads send requests. `run` checks a thread-local flag and refuses a request from the owner with a logged error and `None`, so it cannot hang. | `queue-coordinator` "cancels a running item, retries it, and records one outcome per attempt" and "clears a running queue without recording an outcome for removed items" run cancel, stop, and clear through the owner. A self-request would hang them. |
| 2 | The owner waits on a child process, a reader thread, or the coordinator. Every session event stalls. | `terminate_tree` (up to 5 s), `await_finalized`, stats file IO, or a join on a reader inside a handler. | `Cancel` only marks the session and returns the children. The caller terminates them, then awaits the coordinator or calls `Finish`. `Finish` takes the session and emits. Stats and the terminal send happen on the caller after `Finish` returns. | `download-process` "process-tree-escalation-after-parent-exit" (kill escalation without a stalled owner). `download-process` "codec-probe-cancellation" (probe waits run off the owner). |
| 3 | The owner emits a taskbar update, the main thread is waiting on a request to the owner, and both wait on each other. | `apply_taskbar` blocks on the main thread. | The main thread never sends a request to the owner. It reads `is_busy()` from the atomic hint. Queue commands run on `spawn_blocking` threads (`clear_queue_blocking`, `cancel_queue_blocking`, `cancel_download`). | `close-flow` (dock-ui) and `queue-controls` (queue) run close, clear, and cancel while a download is active. |
| 4 | The owner waits on the coordinator, and the coordinator waits on the owner. | `await_finalized` inside a handler. Coordinator's `can_start` asks the owner. | The owner only calls `coordinator::register` and `coordinator::terminal`, which are non-blocking submits. The coordinator reads `can_start` from the atomic hint. It never sends a request to the owner. The stop helper runs `cancel_active_session` on its own thread. | `queue-coordinator` "refuses manual downloads and queue starts while the other owner runs" (coordinator checks ownership while a download runs). |
| 5 | A start waits for the previous session's finalization while the previous session waits for the start. | Same-owner `start_download` cancels the current session and awaits it. | The start caller awaits the coordinator with no owner state held. The previous session's exit path finalizes it through `Finish`, which does not depend on the start caller. | `queue-coordinator` "runs queued items one at a time with exactly one outcome each" (queue hands off session to session). `download-process` "concurrent-manual-start-cancellation". |

## Stale and racing sessions

| # | Failure mode | Mechanism | Required behavior | Proof |
| --- | --- | --- | --- | --- |
| 6 | Events from an old session are emitted after a new session started. | An old reader or conversion thread emits after `Install` of the next session. | `install` is accepted only into an empty slot, and `with_session` matches the current id. Once the old session is finished, its events find no match and are dropped. Events the owner emitted earlier were ordered before the next install. | `download-process` "stale-session-events-do-not-clear-active-operation". |
| 7 | Two starts race, and both install a session. | Two `start_download` calls run at once. | `Install` is one owner command. The first install wins. The second gets `Occupied` (same owner) or `Conflict` (other owner). `Occupied` cancels that exact session id and awaits it, then retries. | `download-process` "manual-queue-start-ownership" and "concurrent-manual-start-cancellation". |
| 8 | A cancel lands while a session is starting, before its child is registered. | `cancel_session` between `Install` and spawn. | Cancel sets `cancelled`. Registration checks `cancelled` under the owner (`with_session`) and terminates the new child. `active_not_cancelled` checks run before spawn. | `native-downloads` "download-cancel-cleans-staging". `queue-coordinator` "cancels a running item, retries it, and records one outcome per attempt". |
| 9 | A cancel targets a session that was already replaced. | Stop helper reads a session id, then another session installs. | `cancel_session` takes an optional target id. A target mismatch returns no plan, and the caller awaits that id. It never cancels the newer session. | `queue-coordinator` "runs queued items one at a time with exactly one outcome each". |
| 10 | Cancel and exit both finalize the same session. | `on_ytdlp_exit` and `cancel_session` race. | Cancel sets `ytdlp_exit_pending` when a child, a conversion, or an exit is pending, and the caller then awaits. Only `Finish` takes the session, so the first `Finish` wins. | `download-process-targeted` "playlist-ytdlp-cancel-preserves-complete-entry". |

## Completion, terminal results, and ordering

| # | Failure mode | Mechanism | Required behavior | Proof |
| --- | --- | --- | --- | --- |
| 11 | A completion is delivered twice. | Two `complete_session` calls for one session. | `Finish` takes the session out of the slot. Only the first call with a matching id gets `Some`. Later calls return with nothing sent. | `queue-coordinator` "runs queued items one at a time with exactly one outcome each". |
| 12 | A completion is never delivered. | Caller panics after `Finish`, before the terminal send. Or an await waits on a session whose exit path never runs. | Caller code after `Finish` is only stats and the terminal send, with no panicking calls. Exit paths for every wait case are listed in row 14. | `queue-coordinator` "keeps the persisted queue equal to the live queue after a run" (every queued item gets a terminal). |
| 13 | Terminal order changes: the coordinator sees the terminal before stats or before the completion events. | Terminal sent by the owner before the caller records stats. | `Finish` emits `complete`, `download-complete`, and idle `job-progress` on the owner. The caller records stats, then sends the terminal, which keeps the old order. | `native-downloads` "download-only-final-placement" (completion and activity records). `queue-coordinator` "publishes strictly increasing revisions and never renders a stale snapshot". |
| 14 | Exit or cancel path leaves the session without a finalizer. | Child exits before its wait thread starts, or cancel marks a conversion without a worker. | The wait thread starts after registration, so `on_ytdlp_exit` always sees the session. Conversion handoff sets `conversion_pending`, and cancel waits for it. | `download-process` "process-tree-escalation-after-parent-exit" and "conversion-attempt-ownership". |
| 15 | Setup failures finish without a terminal. | Early returns in `start_download` (invalid URL, folder, dependency, spawn) skip `complete_session`. | Each early return calls `complete_session` with its existing message. Messages stay the same. | `native-downloads` "download-failure-cleans-staging" and "download-retry-cleans-staging". |

## Owner thread failure

| # | Failure mode | Mechanism | Required behavior | Proof |
| --- | --- | --- | --- | --- |
| 16 | The owner thread panics and every later download fails. | A panic in a task. | The owner catches the panic per task and keeps running, like the old recovered mutex. The panicking caller gets no reply, and callers treat a missing reply as "session gone". `install` has no panicking step, so a missing reply there returns "Download session is unavailable." and is not expected in practice. | No scenario. Documented change: before, a poisoned lock was recovered and later downloads still ran. The same recovery now happens per command on the owner. |
| 17 | `can_start` or `is_busy` reads a stale hint. | Atomic hint set after the owner moved. | The hint is read-only. `Install` is the only authoritative check and returns `Conflict` or `Occupied` on the owner. The queue retries after `Conflict`. | `queue-coordinator` "refuses manual downloads and queue starts while the other owner runs". |

## Conversion and publication steps

| # | Failure mode | Mechanism | Required behavior | Proof |
| --- | --- | --- | --- | --- |
| 18 | FFmpeg registers after a cancel and keeps running. | `execute_ffmpeg` registers the child late. | Registration checks `cancelled`. A cancelled registration terminates the child and returns `Cancelled`. | `download-process` "codec-probe-cancellation" and `conversion` "conversion-attempt-ownership". |
| 19 | A codec probe leaves an owned child behind after cancel. | Probe clears `ffmpeg` after a cancel. | The probe clears its own child only if the slot still holds that child (`Arc::ptr_eq`). | `download-process` "codec-probe-cancellation". |
| 20 | Output is published after cancel and dropped from the batch result. | `install_conversion_output_for_session` and `publish_same_extension_for_session` record after a cancel. | Same as before: the record goes through the owner. A cancelled session still records what was installed, and the batch reports it. | `download-process-targeted` "same-extension-cancel-records-final-path" and `download-process` "playlist-cancel-retains-completed-entry". |
| 21 | A conversion failure is recorded after cancel and changes the batch status. | `record_conversion_failure` after cancel. | The `!session.cancelled` check stays inside the owner closure. | `download-process` "playlist-conversion-accounting". |
| 22 | Shutdown drops a claimed queue item. | `kill_all_processes` runs while a claimed item starts. | Shutdown uses the same cancel path with `ytdlp_first`. The coordinator's stop helper runs it off the coordinator thread. | `download-session` "shutdown drains a newly claimed queue item before final flush". |

## Ids

| # | Failure mode | Mechanism | Required behavior | Proof |
| --- | --- | --- | --- | --- |
| 23 | Two sessions get one id. | Id minted under contention. | `COUNTER` stays an `AtomicU64`. It mints ids before `Install` without a round trip, so an id is unique without owner state. | `queue-coordinator` "runs queued items one at a time with exactly one outcome each" (ids route terminals). |
