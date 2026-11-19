# Full audit A: licenses reopen, GPU select, update prompt, preview cancel: failure modes

Covers audit items U1, U2, U4, and C3 (renderer part). Written before the code
changes. Each numbered row is one way a fix could fail or regress. `full-audit-a.spec.js`
checks each row by the check name in the Check column. Rows marked "Not automated"
name the reason.

Test seams used, and what they do not prove:

- `window.__ROSI_E2E__.modules.overlays` and `.settings` expose the real overlay
  and settings modules. Focus and modal state are read from the DOM.
- `window.__TAURI__.event.emit("updater-status", ...)` drives the real updater
  listener in `updater-ui.ts`. It does not prove the Rust updater emitted it.
- `install_update` is intercepted through `window.__ROSI_E2E_IPC_STUBS__` in
  `call()` (E2E builds only). The stub records the call and never calls `next()`,
  so no real install runs.
- `api.saveSettings` and `api.getVideoInfo` are replaced on the bridge object. The
  renderer reads them at call time, so the stub is seen by every caller.

## U1: showLicenses is idempotent while open

1. **A second open overwrites the opener.** `licensesPreviousFocus` becomes the
   close button inside the overlay. Closing then sends focus to the URL field, not
   the opener. Check `licenses-reopen-keeps-opener`: with a temporary opener button
   focused, call `showLicenses()` twice. `licensesPreviousFocus` must still be the
   opener, and after `hideLicenses()` focus must be the opener.
2. **A second keydown trap leaks.** The first trap is never removed, so one Escape
   runs the close path twice. A leaked listener is not visible from the page. Check
   `licenses-reopen-keeps-opener`: one Escape on the overlay closes it once, and
   focus lands on the opener. The leak itself is not counted (not automated).
3. **The guard blocks the first open.** If the guard fires before the overlay is
   active, the first open never focuses the close button. Check
   `licenses-reopen-keeps-opener`: the first open puts focus on `#close-licenses`.
4. **The overlay stays latched after close.** If `.active` is not cleared, the next
   open takes the guard path and does nothing. Check `licenses-reopen-keeps-opener`:
   after the Escape close, a fresh `showLicenses()` makes the overlay active again,
   and focus moves to `#close-licenses`.

## U2: GPU type select after Convert is turned back on

5. **The GPU select stays hidden with GPU acceleration on.** Turning Convert off and
   on again leaves `#gpuTypeContainer` without `visible`. Check
   `convert-restores-gpu-type`: with `gpuAcceleration` on, toggle Convert off then
   on, and `#gpuTypeContainer` must have `visible`.
6. **The GPU select shows with GPU acceleration off.** The fix must follow the
   `gpuAcceleration` setting, not the Convert toggle. Check `convert-restores-gpu-type`:
   with `gpuAcceleration` off, Convert on leaves `#gpuTypeContainer` without `visible`.
7. **Convert changes the stored GPU setting.** The fix must only read the setting.
   Check `convert-restores-gpu-type`: `settingsStore.settings.gpuAcceleration` is the
   same value before and after the Convert toggles.
8. **Convert off no longer hides the GPU select.** Check `convert-restores-gpu-type`:
   after Convert off, `#gpuTypeContainer` has no `visible`.
9. **The shared profile keeps the changed toggles.** Check `convert-restores-gpu-type`
   and `shared-state-restored`: `convertEnabled`, `gpuAcceleration`, and
   `keepOriginalAfterConvert` are put back, and the backend (`getSettings`) agrees.

## U4: Update Ready prompt after a failed restart flush

10. **The prompt is lost after the flush returns false.** The user chose Keep
    Downloading or the save failed, and nothing offers Update Ready again. Check
    `update-ready-reoffered-after-failed-flush`: with `saveSettings` failing, press
    Restart Now. The modal must show `Update Ready!` with key `updater-downloaded`
    again.
11. **Install runs after a failed flush.** The guard is inverted, or the re-offer
    path falls through to `install_update`. Check
    `update-ready-reoffered-after-failed-flush`: the `install_update` stub records
    zero calls.
12. **The re-offered prompt cannot be retired by a later update status.** It must use
    the same key, so `retireModal('updater-downloaded')` and the status listener
    still find it. Check `update-ready-reoffered-after-failed-flush`: the displayed
    modal's `key` is `updater-downloaded`, and the status `checking` retires it.
13. **A prompt for a replaced candidate comes back.** If the candidate changed while
    the flush ran, the re-offer must not show. Check
    `update-ready-not-reoffered-for-stale-candidate`: hold the save, emit `checking`
    (which clears `updaterCandidateId`), then fail the save. No `updater-downloaded`
    prompt may appear.
14. **The happy path regresses.** A successful flush must still call `install_update`
    once, with the candidate id, and must not show the prompt again. Check
    `update-ready-restart-installs`.
15. **A throwing flush shows no error.** Not automated. `persistSettings` and
    `drainSettingsSaves` catch their own errors, so the `catch` branch in the
    updater is not reachable through the save stub. The branch is unchanged by this
    fix.
16. **The Keep Downloading choice takes a different path.** Not automated. That
    choice needs an active download, and the E2E seams cannot start one without a
    network fixture. It returns the same `false` as a failed save, so check 10
    exercises the same branch.

## C3 (renderer): cancel is detected by error code only

17. **A real failure that mentions "cancel" is hidden.** The card keeps `loading`,
    and no toast appears. Check `preview-failure-containing-cancel-shows-error`:
    `getVideoInfo` resolves `INTERNAL_ERROR` with a message containing "cancel". The
    manual preview must show a `Could not load preview.` error toast, and
    `#preview-card` must lose `visible` and `loading`.
18. **A backend cancel shows an error.** A `NOT_AVAILABLE` result must still return
    without a failure toast. Check `preview-not-available-stays-silent`: the toast
    count for `Could not load preview.` must not grow.
19. **The auto path loses its retry label.** An auto failure must still set
    `Retry preview`. Not automated. Auto runs only after the URL debounce, and the
    failure branch it shares with the manual path is checked by check 17.
20. **The card stays loading after a backend-only cancel.** The spec keeps the silent
    return, so `#preview-card` can stay `loading` when a `NOT_AVAILABLE` result
    arrives without a user cancel. Not automated: this is the behaviour the audit
    asked to keep, and it is recorded in the report.

## Shared profile

21. **A stub or temporary element survives the spec.** `getVideoInfo`,
    `saveSettings`, the `install_update` registry entry, the temporary opener, and
    the changed settings must all be put back. Check `shared-state-restored`: each
    bridge method is the original, the registry entry is gone, the opener is gone,
    and the settings match their starting values.
