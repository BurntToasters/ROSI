# Manual download lifecycle failure modes

Written before the lifecycle changes. Each row names a way the change could
fail or regress, and the check in `manual-lifecycle.spec.js` that must be able
to fail for it. Rows marked "not driven" have no E2E check; the reason is given.

The spec drives the real renderer through WebDriver. It wraps
`window.__ROSI_E2E__.api.downloadVideo` (to hold the start reply) and
`api.cancelDownload` (to count stops). It watches `#downloadBtn`,
`#progress-container`, `#progress-status`, and `#progress-details`, and reads
the activity log. Scenarios are `manual-lifecycle-cancel-before-reply`,
`manual-lifecycle-cancel-then-restart`,
`manual-lifecycle-cancel-after-reply-progress`, and
`manual-lifecycle-complete-clears-details`. Results go to
`e2e/artifacts/v5-fixes-ui-polish/<stamp>-manual-lifecycle-<pid>/report.json`.

## Cancel before the start reply (R1)

1. **Cancel is never sent for the started session.** The reply lands after the
   user cancelled, the UI is idle, and yt-dlp keeps running. Check
   `manual-lifecycle-cancel-before-reply`: the cancel wrapper records one call
   after the reply, the activity log has a `cancelled` entry for the URL, and no
   yt-dlp process for the URL survives 30 s.
2. **Cancel is sent before the reply.** A stop sent while no session exists is a
   no-op, so the download keeps running. Check
   `manual-lifecycle-cancel-before-reply`: the cancel wrapper records 0 calls
   while the start gate is closed, and its single call has `repliesBefore === 1`.
3. **Cancel is sent twice for one session.** A click stop plus a reply stop would
   send two stops. Check `manual-lifecycle-cancel-before-reply`: the cancel count
   is exactly 1 after the reply and a 2 s hold.
4. **The cancelled start completes as a success.** The backend keeps running and
   writes a `success` entry. Check `manual-lifecycle-cancel-before-reply`: the
   activity entries for the URL include `cancelled` and no `success`.
5. **The late reply flips the button back to loading.** `receiveManualDownloadStart`
   or the bind handler sets the loading state after the reply. Check
   `manual-lifecycle-cancel-before-reply`: after the gate opens and the 2 s hold,
   the Download button has no `loading` class.
6. **The late reply or its progress re-opens the progress bar.** Check
   `manual-lifecycle-cancel-before-reply`: `#progress-container` is not visible
   after the gate opens and the 2 s hold.
7. **Cancel before the reply leaves the bar or button in the running state.**
   Check `manual-lifecycle-cancel-before-reply`: right after the Cancel click
   (gate still closed) the button is not `loading` and the bar is hidden.
8. **Cancelled start N keeps running untracked after the user starts N+1.**
   Cancel while N's start is pending sends no stop, then Download again makes N+1,
   and N's reply (`started: true`) is dropped as stale, so nothing stops N's
   session. Check `manual-lifecycle-cancel-then-restart`: both starts are held
   behind the gate, released in order, and the cancel wrapper records exactly one
   stop. The two downloads use distinct URLs (`cancel-then-restart-first` and
   `-second`). N's activity entry must end `cancelled`, and N's process must be
   gone within 30 s. N+1 is accepted as started or refused as already in progress,
   and the outcome is recorded in the result. A `finally` block stops N+1 if it
   runs, and `afterEach` plus the `beforeEach` idle wait keep later cases clean. The stop is sent for the stale reply only when that
   operation is in `cancelledPendingOperations`, so a stale reply for an operation
   the user never cancelled sends nothing.
   8a. **The set grows, or a stale reply stops an unrelated session.** Not driven.
   Covered by: `failManualDownloadStart` deleting the operation's entry (a failed
   stale start leaves the set), `receiveManualDownloadStart` deleting it on every
   settled reply, the bounded set (`CANCELLED_PENDING_MAX`), and the rule that only
   a stale reply whose operation is in the set sends a stop. Residual: an IPC throw
   on a stale operation skips the stale branch, so its entry stays until the cap
   evicts it. Source review only.
9. **Replay ("Download again") keeps the old cancel path.** `replayActivityDownload`
   still calls `api.cancelDownload()` directly, so Cancel before the reply is a
   no-op there. Not driven: the spec would need an activity row and a gated
   replay, and the replay picker runs first. Covered by source review that
   `url-actions.ts` uses `showManualDownloadRunning`, the helper the Download
   button uses.
10. **Cancel after a normal reply leaves the button loading or sends no stop.**
    The shared running-state helper breaks the post-reply Cancel. Check
    `manual-lifecycle-cancel-after-reply-progress`: after the click the button is
    not `loading`, exactly one cancel is recorded, and the run ends as
    `cancelled`.

## Progress after a cancel (U5)

11. **Late progress for the cancelled session re-opens the bar.** Check
    `manual-lifecycle-cancel-after-reply-progress`: a MutationObserver on
    `#progress-container` counts every transition into `visible` from the Cancel
    click until the yt-dlp process is gone plus 1 s. The count must be 0. The
    check runs only as sensitive as the backend's emission timing: it fails only
    if the stopped session still emits a non-idle `job-progress` during that
    window. A run where none arrives passes without proving the guard, so the
    guard is also covered by source review of `bind/backend-events.ts`.
    Limit: the E2E hook does not expose the progress module, and the WebDriver
    capabilities allow `core:event:allow-listen` but not emit, so a spec cannot
    inject a progress event directly. The only probe (`e2e_emit_stale_download_events`)
    emits idle events only, which never show the bar.
12. **Queue progress stops showing.** The manual guard is widened to queue
    events. Check `primary-action-queue-refusal` in `primary-action.spec.js`
    (queue progress bar must still be visible). That spec is not changed here.
13. **A manual event with no session id passes while the session id is null.**
    Covered by requiring a non-null manual session id in the guard. Source review
    only; the same injection limit as row 11 applies.

## Details text (U8)

14. **Stale speed or ETA text stays after an event without details.** Covered by
    source review: `updateProgressBar` sets `details.textContent` to the details
    text, or to an empty string, on every call. Not driven as a stale-text case,
    for the same injection limit as row 11.
15. **Completion keeps the last speed or ETA text.** The "Complete!" update
    passes `''`, which the old code ignored. Check `manual-lifecycle-complete-clears-details`:
    a real 256 KiB clip (`clip-one.mp4`) reaches the Complete status with the bar
    visible, the `#progress-details` text is empty, and the activity log has a
    `success` entry. This does not prove the stale-text fix alone: the last
    progress event may already have had empty details. Row 14 stays
    source-reviewed.
16. **Other callers lose details.** Only `applyJobProgress` and the "Complete!"
    update call `updateProgressBar`. Source review: every caller passes the details
    it intends, and `setProgressIndeterminate` and `showProgressBar` clear details
    on their own.

## Types (L9)

17. **A type error appears in an untouched file.** `downloadState.isDownloading`
    and `previewState.isFetchingPreview` are now `boolean`. Check with
    `npm run typecheck`, which runs outside this spec.
