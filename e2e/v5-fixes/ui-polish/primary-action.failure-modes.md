# Primary action failure modes

Written before the primary-action changes. Each row names the way the change
could fail or regress, and the check in `primary-action.spec.js` that must be
able to fail for it. The spec drives the real renderer with typing, clicks and
Enter through WebDriver, and records a hashed `report.json` under
`e2e/artifacts/v5-fixes-ui-polish/`.

## Enter in the URL field (B1)

1. **Enter cancels a running download.** While a manual download runs, the
   Download button is the enabled Cancel control. Enter must not click it.
   Check `primary-action-enter-keeps-download`: yt-dlp is still running and the
   button is still in its loading state 4 s after Enter, and no cancelled
   activity entry appears in that window. The test then stops the run through
   the same Cancel control, and the one activity entry must be `cancelled`.
   Completion is not proven by this check. `slow.mp4` is 32 MB served at 16 KB
   per 250 ms (about 8.5 minutes), so a completion wait would not fit the gate.
   The process check matches the query marker `primary-action=enter` in process
   command lines, not `slow.mp4`, so another run of the same fixture elsewhere
   on the machine cannot satisfy or block it. This relies on yt-dlp's command
   line containing the URL verbatim.
2. **Enter opens the folder after a download.** In the result state
   ("Open File Location") Enter must do nothing. Check
   `primary-action-enter-keeps-download`: during the result window, Enter
   records no `openFileLocation` call.
3. **Enter during a queue run starts a manual download.** Enter goes through the
   same click path as the button, so the queue gate in row 6 must also apply to
   Enter. Check `primary-action-queue-refusal`: Enter with a single link during a
   queue run sends no `downloadVideo` request.
4. **Enter stops validating invalid input.** In the idle disabled state Enter
   must still show the invalid-URL message. The existing `ui-polish.spec.js`
   invalid-URL checks cover this path; this change must not alter it.

## Download during a queue run (B3)

5. **Click clears the console or progress bar before refusing.** The refusal
   must happen before `outputEl` is cleared, before `setButtonLoading`, and
   before `hideProgressBar`. Check `primary-action-queue-refusal`: a console
   sentinel survives the click, the queue progress bar is still visible, and no
   `downloadVideo` request is sent.
6. **Refusal has no reason.** The reason must appear in `#downloadReadiness`
   with a `blocked` tone. Check `primary-action-queue-refusal`: the hint is
   visible and names the queue.
7. **Refusal gate blocks queue additions.** A multi-link paste during a queue
   run is a queue add, not a manual download. Check
   `primary-action-queue-refusal`: two links pasted during the run are added to
   the queue.
8. **Gate sticks after the queue ends.** Once no item is downloading, Download
   must start normally. Check `primary-action-queue-refusal`: after the queue is
   cancelled, a click sends a `downloadVideo` request.
9. **Stale refusal reason stays visible.** The refusal reason must clear after
   its timeout, unless the readiness summary has rewritten the hint. Check
   `primary-action-queue-refusal`: the reason is gone after the timeout.
10. **Activity "Download again" bypasses the gate.** Replay during a queue run
    must be refused before the console is cleared and before the output
    location is requested. Check `primary-action-queue-refusal`: the reason
    appears, the console sentinel survives, and no new activity entry is made.

## Result state of the Download button (B9)

11. **Failed open is silent.** A rejected or thrown `openFileLocation` must show
    a message through `revealFileLocation`. Check `primary-action-result-open-failure`:
    after a refused open, the toast text reaches the page.
12. **Open uses the wrong path or the wrong call.** The result action must open
    the completed output path via `openFileLocation`. Check
    `primary-action-result-open`: the recorded path equals the activity entry's
    `outputPath`.
13. **Completion without a path starts a new download.** The "Download complete"
    state must not send `downloadVideo` on click. Check
    `primary-action-result-no-path`: the click sends no request, and the button
    is disabled for that state.
14. **Blur relabels the result button.** Focus leaving the button must keep the
    label and icon of the result state. Check `primary-action-result-open`: the
    label is still "Open File Location" after blur, and the click still opens.
15. **A sync relabels the result button, or typing never clears it.**
    `syncPrimaryActionState` must leave the result state alone. Only
    `clearDownloadResult` (called by a new link being typed) returns the button
    to Download. Check `primary-action-result-open`: the label survives a
    sync that is not a typed edit, and a typed new link returns it to
    "Download" with the download handler.
16. **Result state survives into the next operation.** A download started while a
    result shows (for example, Download again from the activity list) must
    replace the result. Not covered by an E2E check yet: the open-failure check
    only covers a click after expiry, so this row is a known gap to close.
17. **Result clear leaves a stale handler.** When the result expires, the label,
    icon, disabled state, and click handler must all return to the idle
    Download state together. Check `primary-action-result-open-failure`: after the
    timer, the label is "Download" and no open call is recorded on click.

## Copy source (clipboard)

18. **Copy fails when the window is unfocused.** `navigator.clipboard.writeText`
    rejects, and the fallback must copy the URL. Check
    `primary-action-copy-source`: the toast reads "Source link copied." and the
    copied text (read from the textarea during `execCommand('copy')`) equals
    the source URL. The check picks its route from `document.hasFocus()`:
    - `clipboardRoute: "real"` (page focused, foreground runs): the real
      `writeText` and the real `execCommand` run.
    - `clipboardRoute: "recorded-unfocused"` (background runs): for the normal
      copy, `writeText` is replaced for that click only with a recorder that
      stores the text and resolves. The check requires the recorded writes to
      equal `[url]`. For the fallback, `execCommand('copy')` is replaced with a
      recorder that stores the textarea value and returns true. This proves the
      fallback logic (textarea content, success mapping, removal, focus). It
      does not prove the OS clipboard. The real fallback is proven only in
      foreground runs.
      The report records `clipboardRoute` and `pageFocused`.
19. **Fallback failure is reported as success.** If both copy routes fail, the
    toast must say the copy failed. Check `primary-action-copy-source`: with
    both routes refused, the toast reads "Could not copy the source link." This
    check runs on both routes, because it forces both refusals itself.
20. **Fallback leaves a hidden textarea or moves focus.** The temporary textarea
    must be removed, and focus must return to the Copy button. Check
    `primary-action-copy-source`: no textarea remains, and focus is on the row's
    copy action.
21. **Native clipboard path regresses.** When `writeText` works, it must still be
    used. Check `primary-action-copy-source`: the first copy with the API
    available shows "Source link copied.". On the recorded route the recorder
    must receive the URL, so a product that skips `writeText` fails here. The
    recorder hides a failure that only happens with the real clipboard, such as
    a wrong encoding in the OS write. Only foreground runs (`clipboardRoute:
"real"`) prove the real clipboard.

## Check design

22. **The check waits on the activity log for a running download.** Activity is
    written only when a run ends (`downloader.rs` records the completion
    channel's result), so a running download has no entry yet. A wait on the log
    for a slow fixture times out by design. Check
    `primary-action-enter-keeps-download` waits on the yt-dlp process and the
    loading state instead, and then on the entry that the Cancel control writes.
23. **A check passes on leftover state.** The copy check asserts the recorder's
    writes equal `[url]` and that the textarea is gone, so a clipboard left over
    from an earlier scenario, or a textarea left in the page, fails the check.
    `restoreStubs` in `afterEach` and the copy check's own `finally` restore the
    overrides.
