# Queue UI: progress hide, Start state, failure details, copy, run notification

Written before the code changes (findings B2, T2, B7, B13, C3, C4 queue part,
and the queue diagnostics copy). Each row names a way the fix could fail or
regress and the check in `e2e/specs/main.spec.js` that must catch it. Checks
drive the real renderer on the built E2E binary: real queue snapshots arrive
through `api.onQueueUpdate`, real job-progress events through
`api.onJobProgress`, and real settings import through `api.onSettingsImported`.
Where a row needs a backend event that the native queue cannot produce on
demand, the check says so and uses the renderer listener directly.

Test seams and what they do not prove:

- `window.__ROSI_E2E__.modules` exposes `progress`, `queueController`, and
  `settings` (see the spec header). Calling `queueController` functions or
  listeners checks renderer behaviour only; it does not prove the Rust queue
  runner emitted the same sequence.
- `api.showNotification` is observed with the same stub pattern as the
  `notifications` scenario (`stubApi` / `stubCalls`). A stub that is not reached
  makes the row fail (`calls` must be non-empty where a notification is
  expected).
- The yt-dlp process check uses `processesMatching`, which reads the process
  command lines (`Get-CimInstance` on Windows, `ps` elsewhere).

## B2: queue idle hides the main progress bar

| Row  | Failure or regression                                   | Check that must fail                                                                                                                                                                |
| ---- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B2-1 | Bar is never hidden after a queue run                   | After a queue `idle` event and no active work, `#progress-container` lacks `visible` within 5 s. The check first asserts the bar is visible, so a bar already hidden does not pass. |
| B2-2 | Bar hides while a queue item is still downloading       | Queue `idle` for item A, then a `downloading` snapshot for item B: after 2.5 s the bar is still visible.                                                                            |
| B2-3 | Bar hides while a manual download is active             | Manual `downloadState.isDownloading` set true around a queue idle: after 2.5 s the bar is still visible.                                                                            |
| B2-4 | A later progress event does not cancel the pending hide | Queue `idle`, then a non-idle queue progress event within 1 s: bar still visible at 2.5 s (the timer must be cancelled, not only re-checked).                                       |
| B2-5 | Hide runs immediately instead of about 2 s later        | Bar still visible 500 ms after the queue `idle` event.                                                                                                                              |
| B2-6 | Hide re-check uses a stale snapshot                     | A snapshot showing a downloading item arrives after the idle event but before the timer fires: bar stays visible.                                                                   |
| B2-7 | Manual idle or completion handling changed              | Manual-download completion still updates the bar and schedules its own hide (manual-download suite).                                                                                |

The B2-1 check uses a real queue run: the `queue-controls` scenario ends with
queue `idle` events, and the bar must be hidden within 5 s after the run ends.

## T2: cancel scenario waits for the yt-dlp process, not the bar

| Row  | Failure or regression                                          | Check that must fail                                                                                                                  |
| ---- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| T2-1 | Wait passes on the bar left visible by an earlier scenario     | The new wait is on `processesMatching` for this download; the bar is not used as the signal.                                          |
| T2-2 | Download never starts and the test still passes                | The wait times out with a message if no slow.mp4 process appears within 60 s; the scenario fails.                                     |
| T2-3 | A leftover process from an earlier scenario satisfies the wait | The scenario first asserts no slow.mp4 process exists before starting the download; a leftover fails the scenario instead of passing. |
| T2-4 | Cancel does not stop the process                               | Existing `waitForNoProcess("slow.mp4")` after cancel still fails the scenario.                                                        |

## B7: settings import clears "Settings are not saved"

| Row  | Failure or regression                                            | Check that must fail                                                                                          |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| B7-1 | Summary still says not saved after import                        | After a `settings-imported` event, the effective options summary no longer contains "Settings are not saved". |
| B7-2 | Saved revision set before reconcile, so reconcile bumps it again | `settingsSavedRevision === settingsRevision` after the import handler returns.                                |
| B7-3 | Import with a reconcile throw marks settings saved               | No fault seam exists. Not checked. The handler has no try around reconcile, so a throw skips the assignment.  |
| B7-4 | Save feedback shows a stale error after import                   | `#settingsSaveFeedback` does not show the not-saved error after import.                                       |

## B13: open "Failure details" survives a queue update

| Row   | Failure or regression                                  | Check that must fail                                                                                                                            |
| ----- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| B13-1 | Details collapse on the next queue update              | Open `details.queue-item-details` for a failed item; send another `onQueueUpdate` with the same items; the same row's details are still `open`. |
| B13-2 | Open state leaks to another row                        | Opening row A's details does not open row B's details after a re-render.                                                                        |
| B13-3 | Stale id keeps state after the item is removed         | After the item is removed, a new failed item with a different id starts closed.                                                                 |
| B13-4 | Open state lost when the item goes failed to cancelled | Same id key, so the state is kept. Not separately checked.                                                                                      |
| B13-5 | Focus restore broken by the change                     | Covered by existing queue focus checks in main.spec.js; the fix does not change focus code.                                                     |

## C3: Start disabled while the queue runs

| Row  | Failure or regression                       | Check that must fail                                                                               |
| ---- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| C3-1 | Start stays enabled while an item downloads | With a snapshot holding a `downloading` item and a `pending` item, `#startQueueBtn` is disabled.   |
| C3-2 | Start stays disabled after the run drains   | After the snapshot with no downloading item and a pending item, `#startQueueBtn` is enabled again. |
| C3-3 | Start disabled when nothing is pending      | With only completed items, Start stays disabled (existing rule).                                   |
| C3-4 | Action lock ignored                         | A busy lock still disables Start (existing `queueActionLocks` rule).                               |

## Diagnostics copy uses copyText

| Row  | Failure or regression         | Check that must fail                                                                                                                                                                      |
| ---- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP-1 | Copy success not reported     | With clipboard available, the queue status shows "Copied diagnostics to the clipboard."                                                                                                   |
| CP-2 | Copy failure shows success    | With `navigator.clipboard.writeText` rejecting and the textarea fallback failing, the warning toast "Could not copy diagnostics to the clipboard." appears and the success text does not. |
| CP-3 | Fallback path breaks the page | No exception escapes the click handler; the queue status still updates.                                                                                                                   |

The check stubs both clipboard routes, so it proves the renderer decision, not
the OS clipboard contents.

## C4 (queue part): one notification when a queue run drains

| Row | Failure or regression                                   | Check that must fail                                                                                               |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| N-1 | No notification after a drained run                     | Run starts (downloading snapshot), then a snapshot with completed items only: exactly one `showNotification` call. |
| N-2 | Two notifications for one run                           | Two identical drained snapshots produce one call total.                                                            |
| N-3 | Notification fires on user Cancel queue                 | After `noteQueueStoppedByUser()` during a run, the drain produces zero calls.                                      |
| N-4 | Notification fires on Clear                             | Clear is marked the same way; the drained run produces zero calls.                                                 |
| N-5 | Suppression sticks to the next run                      | After a suppressed run, the next run that drains naturally produces one call.                                      |
| N-6 | Counts wrong                                            | The body holds the completed and failed counts for this run only, not items completed before the run started.      |
| N-7 | Notifications setting ignored                           | With `settings.notifications` false, the drain produces zero calls.                                                |
| N-8 | Idle snapshots notify                                   | Snapshots with no prior downloading item (startup read, idle updates) produce zero calls.                          |
| N-9 | Flag set by Clear while idle is consumed by a later run | Clear with nothing running, then a natural run: that run notifies once (flag reset at run start).                  |

Known gap (documented, not checked): the flag is set on the Cancel click,
before the IPC call. If the Cancel IPC then fails, the run's natural drain is
still suppressed.
