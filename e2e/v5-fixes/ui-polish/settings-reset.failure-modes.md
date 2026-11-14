# Settings reset, playlist toasts, Flatpak cookies, search, and copy: failure modes

Written before the code changes. Each row names the way the fix could fail or
regress and the E2E check that must catch it. Checks drive the real renderer
and the native bridge on the built E2E binary.

## Section reset and the update channel (B6)

1. **Application reset changes the channel without telling the backend.** The
   renderer shows `stable` while Rust still holds `beta`, so a candidate from the
   old channel stays installable. Check: switch to beta, reset Application, and
   observe the backend channel is `stable` (the `set_update_channel` call reached
   Rust).
2. **Channel notification fires when the channel did not change.** Resetting a
   section that keeps the channel (Download, Browser) must not call
   `set_update_channel`. Check: reset Browser while on beta and confirm the
   backend channel stays `beta`.
3. **Channel notification fires in Microsoft Store builds.** The change handler
   skips `msstore`; the reset path must skip it too. Check by code path only
   (the Store build is not E2E-able on this machine); the report records it as
   unverified on Windows x64.
4. **Reset Browser on Windows leaves the select blank.** Resetting to a default
   of `chrome` removes the only option the Windows select allows. Check: after
   Reset Browser the select shows `firefox` and `get_settings` reports
   `browserChoice: "firefox"`.
5. **Cancel still resets.** The confirm action must be the only path that
   writes defaults. Check: Cancel leaves the channel and browser choice
   unchanged.
6. **Reset Application saves but the UI keeps the old channel.** The select
   must show the reset value after `updateUIFromSettings`. Check: the update
   channel select reads `stable` after the reset.
7. **Reset Application breaks the "Check for updates on startup" row.** Its
   value must come from defaults and still be saved. Check: the persisted
   settings file has the default `checkUpdatesOnStartup`.

## Playlist validation (B8)

8. **Summary refresh toasts an invalid range.** Editing the range fields or
   refreshing the options summary must not show a toast. Check: enter an invalid
   range (for example start 5, end 2), change the field, and count toasts
   with a playlist warning: zero.
9. **Download reports nothing.** The invalid-range path must still show the
   warning from Download. Check: one warning toast after one Download click.
10. **Download shows two toasts.** A single click must not toast twice (for
    example once from the summary and once from Download). Check: exactly one
    warning toast after one Download click.
11. **Add to queue stops reporting.** The queue path keeps its warning. Check:
    the queue action with an invalid range shows one warning and adds no item.
12. **Silent validation changes the returned selection.** A valid range or the
    `current`/`all` modes must return the same selection as before. Check: the
    summary for a valid range still reads the range (`Playlist entries 2–4`).
13. **Hidden playlist scope is validated.** When the scope is hidden, the
    selection must stay `current` and never warn. Check: no toast and no
    playlist summary state for a single URL.

## Flatpak cookie toggle (B12)

14. **The Flatpak rule is applied before refs exist, then overwritten.** The
    toggle must be unchecked and disabled after startup, and stay so after
    every `updateUIFromSettings` call. Check: the cookie toggle is unchecked,
    disabled, and its browser choice is hidden after startup. The Flatpak build
    cannot run in the Windows E2E, so the check uses the bridge override for
    `is_flatpak` where the E2E build supports it; otherwise the report records
    the Flatpak path as code-only.
15. **A saved `hookBrowser: true` re-enables the disabled cookie toggle.** The
    Flatpak rule must win over the saved value. Check: same as row 14 with the
    saved value true.
16. **Non-Flatpak builds lose the cookie toggle.** The rule must not run unless
    `isFlatpakBuild` is true. Check: on Windows the toggle is enabled and
    follows the saved value.

## Settings search and aria state (C8)

17. **Search expands a section but its body stays `aria-hidden="true"`.**
    Check: after a search that matches a collapsed section, the expanded body
    has no `aria-hidden="true"`, and its header reads `aria-expanded="true"`.
18. **Clearing the search leaves the body inert or hidden out of sync.** After
    clearing, a section that was collapsed before the search is collapsed again
    with `aria-expanded="false"`, `aria-hidden="true"`, and `inert`.
19. **Clearing the search expands a section that was collapsed.** The restore
    must use the saved pre-search state for every section. Check: the collapsed
    set after clearing equals the set before the search.
20. **A section expanded before the search is collapsed by clearing.** Check:
    sections that were open before the search stay open.

## Copy and icon (C15)

21. **"Rosi will restart." remains.** Check: the reset modal text reads
    "ROSI will restart."
22. **The reset button keeps the text glyph.** Check: the confirm button has an
    SVG icon from the icon helper and no `⟳` character in its text.
23. **"Version unknown" stays a dead link.** When the version lookup fails the
    element is plain text: no `href`, no click handler, not a link role. Check
    by code path (the lookup failure is not E2E-injectable without a bridge
    override); the report records it as code-verified.

## Export and import cancel (A10)

24. **A cancelled export shows an error toast.** `{ exported: false }` must show
    no toast. Check: cancel the export dialog through the E2E dialog seam and
    count error toasts: zero.
25. **A cancelled import shows an error toast.** `{ imported: false }` must show
    no toast and must not claim success. Check: cancel the import dialog and
    count toasts: zero.
26. **A real export error shows no toast.** A `{ ok: false }` result must still
    show the error toast. Check: the error toast text is the backend message.
27. **A successful export or import shows no success toast.** Check: the
    success toast appears only for `exported: true` / `imported: true`.

## Regression guards

28. **Settings save revision breaks.** Reset must still go through
    `persistSettings`, so `settingsSavedRevision` catches up with
    `settingsRevision`. Check: after a reset the settings file on disk matches
    the reset values.
29. **Focus return after Cancel breaks.** Cancel returns focus to the reset
    button (existing behaviour). Check: focus is on the reset button after
    Cancel.

## Harness

30. **The IPC observer is never installed.** Tauri defines
    `window.__TAURI_INTERNALS__.invoke` as non-writable, so assigning to it does
    nothing and the recorded `set_update_channel` calls stay empty. Checks that
    read that record (rows 1 and 2) would then pass on an empty record. Tauri
    uses two transports, so the observer hooks both: `window.fetch` (custom
    protocol, macOS and Linux) and the native `window.ipc.postMessage`, or
    `window.chrome.webview.postMessage` when `ipc` is absent (Windows). Each hook
    is read back, and the case fails if no transport accepted it. Each check that
    depends on the observer first asserts that it saw at least one known call
    (`set_update_channel` with `beta`), so an uninstalled observer fails.

## Coverage

`settings-reset.spec.js` checks rows 1, 2, 4, 5, 6, 8, 9, 10, 11, 17, 18,
19, 20, 21, 22, 24, 25, 28, and 30. Each case lists its rows in `failureModes`.

Not checked in E2E on this machine:

- Rows 3 and 23: the Store build and the "Version unknown" fallback need a
  build or a failure that the E2E build cannot inject. Verified by code review.
- Rows 14 to 16: the Flatpak build reports `is_flatpak` from the platform with
  no E2E override, so the Flatpak cookie rule is verified by code review.
- Rows 12, 13, 26, 27, and 29: row 26 and 27 are covered by the backend
  transfer spec (`settings-transfer.spec.js`), which checks the result each
  dialog path returns; the renderer's error and success toasts are not checked.
