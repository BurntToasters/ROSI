# Renderer actions audit failure modes

Written before the renderer-actions changes. Each row names a way the change
could fail or regress, and the check in `renderer-actions-audit.spec.js` that
must be able to fail for it. The spec drives the real renderer through the E2E
hook and WebDriver clicks. It stubs `api` methods on the shared bridge object,
restores them after every check, and writes a hashed `report.json` under
`e2e/artifacts/v5-fixes-ui-polish/`. Nothing waits on a fixed sleep: every wait
polls a state that the code under test sets.

## Toast durations (F1)

1. **Error toasts keep the 4 s duration.** The helper in `engine/ui-helpers.ts`
   passed `duration = 4000` on every call, so the 8 s default for errors never
   applied. Check `renderer-actions-toast-default-duration`: an error toast
   raised through the helper with no caller duration must stay on screen for at
   least 6 s. A 4 s toast fails the check.
2. **An explicit duration stops working.** A caller that passes `duration`
   must still win. Covered by the existing `rendererModules` toast test with
   `duration: 0`; the helper change only drops the default.

## Download again from the activity list (F3)

3. **A download started during the folder dialog loses its session identity.**
   The replay checked the busy state, awaited the dialog, then called
   `beginManualDownloadOperation()` without checking again. Check
   `renderer-actions-replay-recheck`: with Ask every time on and the dialog
   held open, a manual download starts and stays running. When the dialog
   returns, the replay must send no second `downloadVideo` request, must show
   the wait warning, and the running download keeps its session id (the Download
   button stays in its loading state).
4. **A failing folder dialog leaves the button stuck or throws unhandled.**
   Check `renderer-actions-replay-dialog-failure`: the dialog rejects, no
   `downloadVideo` request is sent, an error toast appears, and the Download
   button is not loading.
5. **Replay asks for a folder when the normal path would not, or skips it when
   it would ask.** Check `renderer-actions-replay-ask-setting`: with Ask every
   time off the dialog is never called and the request is sent; with it on the
   dialog is called once and its folder is the request's `outputPath`.
6. **Replay sends a request before pending settings reach disk.** Rust reads
   settings from disk when a download starts. The replay now flushes first.
   Check `renderer-actions-replay-ask-setting`: Ask every time is set on and
   saved, then turned off by a change event that is not awaited. The replay
   starts while that change is pending. The `saveSettings` call that carries
   `askDownloadLocation: false` must be recorded before the replayed
   `downloadVideo` call. If no such save is recorded, the row fails.
7. **A cancelled dialog starts the download anyway.** Check
   `renderer-actions-replay-ask-setting`: a dialog that returns null leaves the
   button idle, and then a second replay (dialog returns a folder) is the only
   `downloadVideo` call recorded. Exactly one request, with the second replay's
   folder as `outputPath`, proves the cancelled run sent none.

## Startup activity fetch (F5)

8. **The startup read overwrites a newer activity event, or its failure is
   silent.** The race needs the fetch to resolve after an event, which the
   stubbed bridge cannot arrange before startup runs. Not covered by E2E for the
   race itself; proven by code review of the `activityUpdatesSeen` guard in
   `engine/bind/activity.ts` and its increment in `engine/bind/backend-events.ts`.
   Check `renderer-actions-activity-startup`: after a renderer reload the sorted
   activity row ids equal the sorted ids from `getDownloadActivity`, so the guard
   does not drop the normal startup read. A non-empty list alone is not enough.

## Preset save and delete (F10)

9. **A failed save keeps the new preset in memory.** Check
   `renderer-actions-preset-rollback`: `saveSettings` fails, the settings store
   holds the same presets as before, the select lists no new option, and the
   status says the preset could not be saved.
10. **A failed delete keeps the preset removed in memory.** Same check: after a
    real save, a failing delete leaves the preset in the store and in the
    select, and the status says it could not be deleted.
11. **A double click submits twice.** Same check: two synchronous `click()`
    calls on Save while `saveSettings` is held produce exactly one
    `saveSettings` call, and the button is disabled during the wait and enabled
    after.

## External links (F11)

12. **A rejected or refused `openExternal` is unhandled or silent.** Check
    `renderer-actions-open-external-failure`: a real `updater-status` error
    event raises the Update Error prompt (the same route `dialogs.spec.js`
    uses). With `openExternal` stubbed to reject, then to return `ok: false`,
    a click on Get Latest Version must leave the page with no unhandled
    rejection and show the error toast "Could not open the ROSI website.". The
    Deno and Microsoft Store buttons use the same helper but their dialogs are
    not reachable on Windows E2E; that part is proven by code review of
    `openExternalLink` callers in `engine/deno.ts` and `engine/updater-ui.ts`.

## Shared formatting helpers (F13)

13. **`formatBytes` prints `NaN undefined` for bad input.** One helper in
    `modules/format.ts` serves the activity list, the queue, the stats dialog
    and the update progress text. Check `renderer-actions-format-helpers`:
    `getStats` stubbed with a `NaN` total makes the Download Statistics dialog
    show neither `NaN` nor `undefined`, and a valid total still reads
    `1.5 KB` for 1536 bytes. The unit-level shape stays covered by the existing
    `rendererModules` test through `modules/downloads`.
14. **Dropping a second copy changes the queue row.** The queue row now uses the
    shared helper. Check `renderer-actions-format-helpers`: a queued item row
    still shows its host in the `Remove <host> from queue` label.
15. **A removed `lastDownloadedFilePath` breaks a reader.** Typecheck covers it;
    no runtime reader exists.
