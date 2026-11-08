# Queue ownership: failure modes

Written before the Rust change. This is roadmap B7 part A: `QueueState` moves
from the global `QUEUE` mutex (`src-tauri/src/queue.rs`) into a local value
owned by the coordinator thread (`src-tauri/src/coordinator.rs`). Every read
from another thread becomes a coordinator request answered over a reply
channel. `QUEUE` and `queue::state()` are removed.

Scenario names are the ones in `e2e/suites.json`. Where a scenario's spec
file is named, the test is the `it(...)` or `record(...)` call that proves it.
`queue-coordinator` is the v5-fixes area in `e2e/v5-fixes/queue-coordinator/`,
run by the `queue` and `lifecycle` groups.

## Deadlock

| # | Failure mode | Mechanism | Required behavior | Proof |
| --- | --- | --- | --- | --- |
| 1 | An in-thread handler asks the coordinator for a read (`items()`, `is_running()`, a Snapshot request) and waits. The coordinator sends to itself and hangs. | A helper called from a handler reaches a request function. | Code that runs on the coordinator thread takes `&mut QueueState` directly. Only code outside that thread calls `coordinator::request`. The handler set is reviewed for this. | The `queue`, `cancel`, `queue-management`, `queue-cancel`, and `queue-controls` scenarios each run start, cancel, remove, retry, reorder, and clear through their handlers. A self-request would hang them. |
| 2 | The coordinator waits on a child process, disk, settings, or another thread's reply. Every reader and writer then stalls. | Loading persisted items or reading settings on the coordinator thread. | Persisted items load on the first caller of `coordinator::init()` (the setup path in `queue::init`), not on the coordinator thread. The coordinator thread only changes state, sends replies, and submits to the writer or to helper threads. | `queue-coordinator` "runs queued items one at a time with exactly one outcome each" (every transition runs through the coordinator). `persisted-offline-queue` (offline-queue owner) reloads the queue at startup. |
| 3 | The main thread asks `is_running()` (window close) and waits while the coordinator publishes `queue-update`, and the publish waits on the main thread. | Blocking emit from the coordinator. | `app_state::emit` uses Tauri `emit_to` and does not wait for the webview. The main thread waits only on a reply that the coordinator sends without waiting on anything. | `close-flow` (dock-ui, main) covers the close path. No scenario forces a close while a run is publishing, so this rests on the emit contract. |
| 4 | Writer thread and coordinator wait on each other. The writer asks for a snapshot, and the coordinator waits for the writer. | Blocking send to the writer. | `schedule_persist` and `flush` only send on channels. The coordinator never waits on the writer. The writer waits on the coordinator. | `queue-latest-snapshot` (state-repairs) and `queue-flush-backup-failure` (state-repairs) run debounced writes and flushes during transitions. |

## Torn and stale snapshots

| # | Failure mode | Mechanism | Required behavior | Proof |
| --- | --- | --- | --- | --- |
| 5 | A reader gets items from one state and a revision from another. | Two separate reads. | Items and revision come back in one reply: `revisioned_snapshot` runs inside the coordinator, and `Snapshot` returns the pair. `items()` returns only the items from one Snapshot. | `queue-coordinator` "publishes strictly increasing revisions and never renders a stale snapshot". |
| 6 | A caller reads the queue after its own transition and does not see it. | Read answered before the commit. | A transition commits, then replies. A read sent after the reply sees the committed state, because the coordinator handles commands in arrival order. | `queue-coordinator` "keeps the persisted queue equal to the live queue after a run" (`getQueue` after the run, compared with the file). |
| 7 | `get_queue` returns an empty list while the queue exists. | The coordinator is not running (thread died), so the request returns `None`. | Readers return the empty value (`Vec::new()`, `false`). Writers keep returning `Queue coordinator is not running.` or `INTERNAL_ERROR`. This is a documented change: before, a poisoned mutex was recovered and reads still worked after a panic. | No scenario. Only reached after a coordinator panic (row 15). |

## Order of published revisions

| # | Failure mode | Mechanism | Required behavior | Proof |
| --- | --- | --- | --- | --- |
| 8 | The renderer gets `queue-update` revisions out of order. | Two threads publish. | Only the coordinator publishes, and each commit is published before the next command. Revisions still increase by one per commit. | `queue-coordinator` "publishes strictly increasing revisions and never renders a stale snapshot". |
| 9 | Commit order changes when the queue is read through a request. | A read bumps the revision. | Only commits bump the revision. Reads use `bump: false`. The writer's flush uses `bump: true` as before. | `queue-coordinator` revision test above. |

## Writer snapshot racing a transition

| # | Failure mode | Mechanism | Required behavior | Proof |
| --- | --- | --- | --- | --- |
| 10 | The writer persists an older snapshot after a newer one is durable. | A delayed debounced write. | `QueuePersistence::persist` keeps the `highest_attempted` and `last_persisted` rules. The snapshot and its revision come from one Snapshot reply. | `queue-latest-snapshot` (state-repairs) and the Rust test `flush_waits_for_the_serial_writer_and_leaves_primary_and_backup_at_latest_revision`, kept as is. |
| 11 | A flush (close or restart) acknowledges a revision that is not durable. | Flush skips a write that was superseded. | A flush acknowledges only when an equal or newer revision is durably committed. | `queue-flush-backup-failure` (state-repairs, lifecycle close path). |
| 12 | A debounced write sees a stale queue because the transition has not committed yet. | Debounce fires between the mutation and the commit. | Mutation and commit happen in one coordinator command, so the writer's snapshot always includes the full transition. | `queue-coordinator` "keeps the persisted queue equal to the live queue after a run". |

## Shutdown and flush while the coordinator is busy

| # | Failure mode | Mechanism | Required behavior | Proof |
| --- | --- | --- | --- | --- |
| 13 | Close or restart flushes while a stop is in progress, and the flush returns before the interrupted item is requeued. | Flush races `finish_stop_if_ready`. | The stop reply is sent only after the requeue and commit. The flush reads the state after that. | `close-pending-timeout` (state-repairs, lifecycle) and `close-flow` (dock-ui). |
| 14 | Stop or cancel leaves a child process running while the coordinator thinks the run ended. | Helper thread skipped or the state flips early. | Stop and cancel keep the existing order: flags set, helper cancels and kills, `StopCancelSettled` finishes the stop. Process waits stay off the coordinator. | `cancel` (main) waits for `yt-dlp` to exit. `queue-coordinator` "cancels a running item, retries it, and records one outcome per attempt". |

## Runner exit and coordinator panic

| # | Failure mode | Mechanism | Required behavior | Proof |
| --- | --- | --- | --- | --- |
| 15 | The coordinator panics in a handler. The thread unwinds and drops `QueueState` and every pending reply sender. Waiting callers get `None` and return. | Any panic in a handler. | No hang: a dropped reply makes `recv` fail, and a dropped receiver makes `send` fail. Command callers get `INTERNAL_ERROR`. Readers get an empty value (row 7). This matches today's coordinator-thread behavior. | No scenario forces a panic. Review rule. |
| 16 | The runner exits without telling the coordinator, so a later start waits on it. | Runner panic or early return. | `RunnerFinished` drops and submits `RunnerExited`, unchanged. | `queue-coordinator` "refuses manual downloads and queue starts while the other owner runs" and `download-again-quickly` (main) start the queue right after a run. |
| 17 | A start arrives while a stop waits for the runner, and replaces that runner. | Start evaluated during `stopping`. | `evaluate_start` keeps the `stopping` check and the "Queue is stopping." error. | `queue-coordinator` "cancels a running item, retries it, and records one outcome per attempt" (stop and restart). |
| 18 | A deferred start (waiting for an exiting runner) is answered only on the next command. | Deferred starts need a timer. | `run` uses `recv_timeout` to settle deferred starts. The loop keeps its timers. | `queue` (main) starts a queue right after a previous run ends. |

## Persistence objects

| # | Failure mode | Mechanism | Required behavior | Proof |
| --- | --- | --- | --- | --- |
| 19 | `PERSISTENCE` or `WRITER` stop being initialized after the move, so writes fail. | Lazy init order changes. | `PERSISTENCE` and `WRITER` stay as `OnceLock` holders. They are initialized on first use, as today. | `queue-flush-backup-failure` and `long-term-persistence` (persistence owner). |
| 20 | A newer-schema queue file is overwritten by an older build. | Flush path changed. | `queue::flush` keeps the `is_newer_schema_file` branch, which returns `Ok` with a warning. | `long-term-persistence` (persistence owner). |
| 21 | Corrupt primary file reads as empty, not as the backup. | Load moved to another thread. | `load_persisted` keeps the primary, then backup, order. Corrupt primary falls back to backup. | `persisted-offline-queue` (offline-queue owner) and the Rust test `corrupt_primary_reads_as_unreadable_so_backup_fallback_can_run`, kept as is. |

## Admission

| # | Failure mode | Mechanism | Required behavior | Proof |
| --- | --- | --- | --- | --- |
| 22 | Duplicate URL admitted because the duplicate check reads an older copy of the queue. | Check outside the coordinator. | `admit` checks against the coordinator's own state. `nonterminal_urls` only pre-filters before settings reads. | `queue-coordinator` "skips a duplicate of a URL that is already downloading" and `queue-paste-extraction` (main). |
| 23 | Queue start accepted while a manual session holds the slot. | `can_start` read at the wrong time. | `evaluate_start` calls `downloader::can_start` unchanged. The ACTIVE slot stays under its own lock (part B). | `queue-coordinator` "refuses manual downloads and queue starts while the other owner runs". |

## Test strategy

- The E2E gate for this change is `npm run test:e2e -- --group queue,persistence,downloads`, run twice in a row, with `ROSI_E2E_BACKGROUND=1`.
- The Rust tests in `queue.rs` (`run_drain_tests`, `persistence_tests`) and the `start_waits_for_exit` test are adapted to the new API and not weakened. No new unit tests are added.
- Rows 7, 15, and 18 have no direct scenario. They rest on review and on the existing scenarios that exercise the same paths.
