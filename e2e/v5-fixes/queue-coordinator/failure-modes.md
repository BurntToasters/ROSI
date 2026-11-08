# Queue/session coordinator migration: failure modes

Written before any Rust change. Current code references: `src-tauri/src/queue.rs`
(`QUEUE`, `START_GUARD`, `RUNNER_CHANGED`, `PERSIST_SIGNAL`, `run_queue`,
`stop`, `start_queue`, `cancel_queue_blocking`, `clear_queue_blocking`) and
`src-tauri/src/downloader.rs` (`ACTIVE`, `SESSION_CHANGED`, `FINALIZING`,
`FINALIZATION_CHANGED`, `STARTUP`, `EVENT_PUBLISH`, `CompletionCallback`,
`cancel_session`, `complete_session`, `start_download`, `download_video`).

Each row names the failure, the mechanism that could cause it after the
migration, and the guard that must hold. `queue-coordinator.spec.js` covers
every row that is observable through `window.__ROSI_E2E__.api` or the existing E2E hooks.
Internal rows are guarded by design rules and review.

## Races between commands

| # | Failure mode | Mechanism | Guard |
| --- | --- | --- | --- |
| 1 | Cancel lands between the runner's "still wanted" check and the session start, so the item starts after the user cancelled. | Runner claims an item, cancel arrives, start proceeds. | Coordinator orders cancel and start as commands on one queue. A start carries the item id and run generation; cancel bumps the generation, so a stale start is rejected and the item gets exactly one cancelled outcome. E2E: cancel during claim leaves the item `cancelled` with no completion event for it. |
| 2 | Start while stop is in progress replaces the runner that stop() is waiting for. | `start_queue` after `stop()` sets `stopping`. | Coordinator rejects Start while a stop is in flight with "Queue is stopping." Same status code as today. E2E: restart path after close. |
| 3 | Retry of an item still being finalized is accepted, then overwritten by the old completion. | Completion for session N arrives after retry set the item to pending. | Completion carries session id and attempt id; a completion whose attempt id is not the item's current attempt is dropped and logged. E2E: retry after cancel yields one terminal state. |
| 4 | Reorder during a running session moves the active item. | Pending-index math reads a stale snapshot. | Reorder is a coordinator command that only touches pending items. Existing "Only pending queue items can be reordered." error kept. E2E: reorder while a run is active. |
| 5 | Clear queue while running leaves a session that later records into a removed item. | Clear removes items; completion looks up by id. | Clear cancels the session first (notify), then removes items. A completion for a missing item records nothing (existing behaviour). E2E: clear during a download. |
| 6 | Remove of the downloading item races with its completion. | Remove sees a stale status. | Remove is decided from coordinator state; "Cannot remove an actively downloading item." kept. |
| 7 | Duplicate add of a URL already downloading. | Duplicate check reads state while the runner flips status. | Add is a coordinator command; the nonterminal URL set comes from coordinator state. Skipped-count semantics kept. |

## Stale and duplicate session events

| # | Failure mode | Mechanism | Guard |
| --- | --- | --- | --- |
| 8 | A progress line from session N is applied to session N+1. | Reader threads outlive the session that spawned them. | Every worker event carries its session id; the coordinator drops events whose id is not the active id. E2E: back-to-back queue items keep their own progress and completion. |
| 9 | Two terminal results are published for one session (cancel path and natural exit both finish it). | Cancel and exit both call completion. | The coordinator publishes a terminal result only when it moves the session out of Active; the second attempt is a no-op. E2E: cancel during post-processing yields exactly one `download-complete` per item. |
| 10 | Completion for session N clears the slot of session N+1. | Slot cleared without an id check. | Slot is cleared only when the terminal result's session id equals the active id. E2E: sequential queue of several items finishes every item. |
| 11 | Terminal result reaches the queue and the activity log through different paths and disagrees. | Two consumers of one completion. | One terminal message per session; queue apply and activity record both read that message. |

## Orphan processes and waits

| # | Failure mode | Mechanism | Guard |
| --- | --- | --- | --- |
| 12 | yt-dlp or ffmpeg survives cancel, stop, or close. | Child dropped without `terminate_tree`, or the coordinator publishes before the child exits. | Cancel and shutdown send Terminate to the session worker; cancel and stop publish their terminal result only after the worker acknowledges child exit. E2E: cancel leaves no child from the test profile. |
| 13 | Coordinator blocks on a child wait or disk write, freezing every command. | Waiting for exit inside the command loop. | Waits and file writes run on worker or writer threads. The coordinator only updates state and sends messages. Review rule; observable through the cancel scenario finishing within its timeout. |
| 14 | An ack never arrives, so close hangs. | Worker panics before acknowledging, or writer dies. | Every ack wait has a bounded timeout. On timeout the caller logs and takes the existing failure path. E2E: close-pending-timeout still reports the pending close. |
| 15 | Deadlock between coordinator and a caller holding a lock it needs. | Caller holds a window or settings lock while awaiting a reply. | Callers never hold a shared lock across send and recv. The coordinator never calls window, emit, or stats code while holding its own state. |

## Persistence

| # | Failure mode | Mechanism | Guard |
| --- | --- | --- | --- |
| 16 | Close reports success while the latest queue revision is not durable. | Writer acknowledges an older revision, or a debounced write is skipped. | Close, restart, and update request durable revision R and wait for the writer's ack for R or newer. E2E: queue-latest-snapshot. |
| 17 | Persistence failure during close is hidden, so the app exits and loses the queue. | Flush error swallowed on the shutdown path. | Both flushes in `shutdown_with_close_generation` keep their error returns; a failed flush keeps the app open. E2E: queue-flush-backup-failure and the blocked-backup close/restart scenario. |
| 18 | A failed flush blocks command processing or retries forever. | Writer retries inside the coordinator loop. | Writer is its own thread. A failed flush returns an error to the requester and state stays dirty; the existing 300 ms debounce and retry-on-next-change behaviour is kept. |
| 19 | A newer-schema queue file is overwritten by an older build. | Flush after migration skips the schema guard. | The `is_newer_schema_file` path in `queue::flush` is kept as is: it returns Ok with a warning. |
| 20 | Out-of-order writes leave an older snapshot on disk. | Two writer threads or a delayed debounced write. | A single writer owns `QueuePersistence`. The `highest_attempted` / `last_persisted` rule is kept. |
| 21 | Persisted file format changes with no migration path. | New session or attempt fields serialized into `download-queue.json`. | Persisted `QueueItem` shape is unchanged; revisions and attempt ids stay in memory. `long-term-persistence` must pass unchanged. |

## Admission: manual versus queue

| # | Failure mode | Mechanism | Guard |
| --- | --- | --- | --- |
| 22 | Manual download accepted while the queue runner is between items. | `download_video` checks the session slot, which is empty between items. | Coordinator admission checks both the active owner and the queue run state. `download_video` keeps "A queue download is already in progress." E2E: manual download during a queue run is refused. |
| 23 | Queue start accepted while a manual session holds the slot. | `start_queue` races a manual start. | Start command checks coordinator owner state and returns "A manual download is already in progress." |
| 24 | Queue runner stalls behind a manual download. | Old code slept 250 ms and retried. | Coordinator holds the queue start until the slot is free; the item stays pending. E2E: queue started right after a manual download completes. |
| 25 | Manual download recorded as a queue item, or the reverse. | Owner passed incorrectly. | Owner is part of the session identity and the terminal result; `download-complete` keeps its `owner` field. |

## Restart and update during an active download

| # | Failure mode | Mechanism | Guard |
| --- | --- | --- | --- |
| 26 | Restart during an active item leaves it cancelled instead of pending. | Stop's terminal result recorded as a user cancel. | Stop is an interruption: the item is requeued to pending as today. E2E: restart during an active item leaves it pending with a clean attempt. |
| 27 | Update install starts while a child still writes into the output folder. | Install proceeds before the exit ack. | The update path waits for the coordinator's idle-with-children-exited state, bounded by the existing timeout. |
| 28 | Window closed during a queue run. | Runner checks the main window per item. | Coordinator produces the same synthetic failed completion, "Window closed", and continues. |

## Ordering of published snapshots

| # | Failure mode | Mechanism | Guard |
| --- | --- | --- | --- |
| 29 | Frontend applies an older queue snapshot after a newer one. | Two emitters race. | The single coordinator publishes in revision order and each `queue-update` carries a monotonically increasing `revision`. The renderer's `queue-update` consumer (`src/engine/bind/backend-events.ts`) drops older revisions. |
| 30 | A poisoned lock makes queue events panic. | `lock().unwrap()` after a worker panic. | Poison recovery (`unwrap_or_else(|p| p.into_inner())`) on every lock the migration touches. |

## Test strategy

- Observable rows (1-10, 12, 16-17, 22-24, 26, 28-29) are covered by
  `queue-coordinator.spec.js` through `window.__ROSI_E2E__.api` and the existing E2E hooks.
- Internal rows (11, 13-15, 18-21, 25, 27, 30) are guarded by design rules and
  review. AGENTS.md forbids writing unit tests after code, so they are exercised
  through the observable scenarios above, not by isolated tests.
- Verification: targeted groups `queue`, `lifecycle`, `persistence`,
  `downloads`, then one full `npm.bat run test:e2e`.

## Stage 2: scenario map (current code)

`queue-coordinator.spec.js` runs against the unmigrated code and must pass
there. Rows not listed here are covered by existing scenarios, not by this spec.

| Spec scenario | Rows |
| --- | --- |
| runs queued items one at a time with exactly one outcome each | 8, 9, 10, 11 |
| skips a duplicate of a URL that is already downloading | 7 |
| refuses manual downloads and queue starts while the other owner runs | 22, 23 |
| cancels a running item, then retries it to one completed attempt | 1, 3, 9, 12 |
| rejects reorder and removal of the active item while the run continues | 4, 6 |
| clears a running queue without recording an outcome for removed items | 5, 12 |
| keeps the persisted queue equal to the live queue after a run | 16, 21 |
| publishes strictly increasing revisions and never renders a stale snapshot | 29 |

Rows not covered by this spec: 2 (stop during start), 13-15 (internal waits and
locks), 17-20 (persistence failure paths, covered by `queue-flush-backup-failure`
and `long-term-persistence`), 24 (queue waiting behind a manual download), 25,
26 (restart during an active item, covered by `close-pending-timeout` and the
lifecycle group), 27, 28, 30.

### Row 29 contract (status: implemented)

- `queue-update` carries `{ revision, items }`. `revision` is assigned by the
  coordinator on each commit and increases strictly.
- The renderer (`src/engine/bind/backend-events.ts`) drops a snapshot whose
  revision is older than the newest one it rendered. Bare-array payloads have
  no revision and are always applied.
- The startup `getQueue` read has no revision. It is applied only if no
  snapshot arrived while it was in flight. A snapshot emitted before the read
  but delivered after it can still be applied. That residual window is kept
  because `get_queue` must remain a bare array for existing E2E specs.
- Covered by the spec scenario "publishes strictly increasing revisions and
  never renders a stale snapshot", which injects a revision 0 snapshot through
  the e2e-only `e2e_emit_stale_download_events` probe.

## Stage 3: batched cancel activity (F7)

Written before the `activity::record_batch` change. `cancel_queue_blocking`
records one synthetic Cancelled row per pending item. Before the change each row
was a separate persist (encode plus fsync of `download-activity.json`) and a
separate `download-activity-update` emit with the full list.

| # | Failure mode | Mechanism | Guard |
| --- | --- | --- | --- |
| F7-1 | Batch is partly persisted: some rows on disk, others only in memory. | Persist called per row, or persist of a partial list. | One persist of the full resulting list after all rows are applied. E2E: after cancel, every pending item has exactly one Cancelled row from `getDownloadActivity`. |
| F7-2 | Batch order differs from sequential `record()` calls, so newest-first is wrong. | Rows appended instead of prepended, or batch reversed incorrectly. | Accepted rows are prepended in reverse batch order, which equals inserting each at the front. E2E: the cancelled rows for the five URLs, filtered from `getDownloadActivity`, are in the reverse of queue order. |
| F7-3 | The same completion id is recorded twice inside one batch. | Duplicate check only looks at the stored list. | Ids accepted earlier in the batch are also skipped. Matches the per-record duplicate rule. |
| F7-4 | One invalid completion aborts the whole batch. | Early return on normalize failure. | Invalid rows warn and are skipped; the rest of the batch is still applied. Matches the per-record warn-and-skip rule. |
| F7-5 | Truncation keeps a different set of rows than sequential calls. | Truncate once versus after each insert. | Both keep the newest `MAX_DOWNLOAD_ACTIVITY` rows of the same sequence, so the kept set is identical. |
| F7-6 | Persist failure drops the batch from memory, or leaves a stale list. | Error path keeps the old list. | On persist error the in-memory list still gets the accepted rows, as `record()` does today. The error is logged. |
| F7-7 | Cancel emits more than one `download-activity-update` (one per row again). | Emit inside the loop. | One emit after the lock is released, and none when no row was accepted. E2E: a listener on `onDownloadActivityUpdate` (reachable via `window.__ROSI_E2E__.api`) counts exactly one event during the cancel. |
| F7-8 | Disk writes or emits move onto the coordinator thread. | Batch call placed inside `CancelApply`. | `record_batch` stays in `cancel_queue_blocking` after the coordinator reply, so the coordinator thread does no disk work. Review rule. |
| F7-9 | Persist count (fsync count) is not observable from E2E. | No hook counts fsyncs. | Not covered by E2E. The one-persist rule is guarded by code review of `record_batch` only. No new hook was added. |

Scenario: "cancels every pending item with one Cancelled row each and one activity update".
Covers F7-1, F7-2, F7-7. F7-3 to F7-6 are covered by review of the shared rule
path (`record()` delegates to `record_batch`), not by a separate scenario.
