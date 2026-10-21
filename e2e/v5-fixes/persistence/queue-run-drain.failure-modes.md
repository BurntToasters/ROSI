# Queue run drain: failure modes

Written before the production change. A run (`running == true`) ends in
`run_queue` only after the runner loops back and finds no pending item. In the
window between the last completion and that loop turn, a retry makes an item
`pending`, and the runner starts it although every item had already reached a
terminal state. The fix ends the run inside the same queue lock that applies
the last completion, and makes a start that follows a drain wait for the old
runner to exit.

Checks are Rust unit tests in `queue.rs` `run_drain_tests`. They drive the
extracted pure functions `apply_completion_in_state`, `claim_next_in_state`,
and `start_waits_for_exit` on a local `QueueState`, with no downloads. Rows
marked "review" cannot be seen without a window, runner thread, or emit.

Drain rule (the behavior to preserve): when a completion leaves no `pending`
and no `downloading` item and the run was live (`running == true`), set
`running = false` and clear `active_item_id`, in the same lock that applied the
completion. A completion while the run was already ended changes nothing.

## Retry and completion timing

| #   | Failure mode                                                                                  | Guard                                                                                  |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1.1 | Retry lands after the last completion; runner claims and downloads the retried item          | `retry_after_drain_stays_pending_and_is_not_claimed`                                   |
| 1.2 | Drain does not happen, so a retry after the last completion still sees `running == true`     | `last_completed_item_ends_the_run_in_the_same_state_update`                            |
| 1.3 | Retry while other items are pending is wrongly treated as a new run or dropped                | `retry_while_others_pending_joins_the_active_run`                                      |
| 1.4 | Drain fires while a pending item remains, stopping a run that still has work                  | `completion_with_pending_items_keeps_the_run_going`                                    |
| 1.5 | Drain fires while another item is still `downloading`                                         | `completion_with_another_downloading_item_keeps_the_run_going`                         |
| 1.6 | Drain leaves `active_item_id` pointing at a finished item                                     | `last_completed_item_ends_the_run_in_the_same_state_update` (asserts it is `None`)     |
| 1.7 | Retry of an item that is `failed` or `cancelled` but not yet applied is lost                  | Retry only accepts `failed`/`cancelled` (unchanged); review                            |

## Outcomes of the last item

| #   | Failure mode                                                                                  | Guard                                                                                  |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 2.1 | Last item `completed` does not end the run                                                    | `last_completed_item_ends_the_run_in_the_same_state_update`                            |
| 2.2 | Last item `failed` does not end the run                                                       | `last_failed_and_cancelled_items_end_the_run`                                          |
| 2.3 | Last item `cancelled` does not end the run                                                    | `last_failed_and_cancelled_items_end_the_run`                                          |
| 2.4 | Outcome applied to the wrong status (e.g. failed recorded as completed)                       | `last_failed_and_cancelled_items_end_the_run` asserts each status                      |

## Interaction with cancel, clear, stop

| #   | Failure mode                                                                                  | Guard                                                                                  |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 3.1 | Cancel during drain: completion of the cancelled item re-enables or re-ends the run wrongly   | `completion_after_the_run_ended_changes_nothing` (cancel sets `running` false first)  |
| 3.2 | `stop()` completions drain and clear `cancelled`, so the runner's cancel check is lost        | `completion_after_the_run_ended_changes_nothing` asserts `cancelled` is untouched       |
| 3.3 | Clear during drain: completion for an item already removed panics or changes the run         | `completion_for_removed_item_ends_only_a_drained_run`                                  |
| 3.4 | Completion for a removed item with other pending items wrongly ends the run                  | `completion_for_removed_item_ends_only_a_drained_run`                                  |
| 3.5 | Drain during `stop()` makes a start hijack the stop wait (stop waits on a new runner)         | `start_waits_only_while_an_exiting_runner_is_alive` (stop sets `stopping`); review     |
| 3.6 | `finish_unstarted_item` path skips the drain rule                                             | Shared `end_run_if_drained`; review of call sites                                      |

## Start after a drain

| #   | Failure mode                                                                                  | Guard                                                                                  |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 4.1 | Start right after a drain fails with "Queue is already running." (runner still alive)         | `start_waits_only_while_an_exiting_runner_is_alive` (drained state waits)              |
| 4.2 | Start proceeds while the old runner is still alive, so two runners share `running`            | Start only proceeds after the wait sees `runner_alive == false`; review                |
| 4.3 | Start waits on a live, running run and blocks instead of reporting "already running"          | `start_waits_only_while_an_exiting_runner_is_alive` (running state does not wait)       |
| 4.4 | Start waits forever on a runner that never exits                                              | Bounded `wait_timeout_while`; review                                                   |
| 4.5 | Start during `stop()` proceeds and the stop wait never ends                                   | `start_waits_only_while_an_exiting_runner_is_alive` (stopping state does not wait); review |

## Broadcast and persistence (review)

| #   | Failure mode                                                                                  | Guard                                                                                  |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 5.1 | Broadcast after drain still shows an item `downloading`                                       | Drain runs before `broadcast()` in `finish_item`; the snapshot has no pending or downloading item for a drained run; review |
| 5.2 | Drain happens outside `QUEUE`, so a retry can interleave                                      | Drain is in `apply_completion_in_state`, called under `state()`; review                |
| 5.3 | `RunnerFinished` drop no longer clears `runner_alive` or no longer notifies `RUNNER_CHANGED`  | Drop unchanged; review                                                                 |
| 5.4 | Persistence skips the drained state or writes a stale `running` value                         | `running` is not persisted; items are unchanged, so persistence tests still apply      |
