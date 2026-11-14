# Settings transfer and Windows browser default: failure modes

Written before the code changes. The E2E spec
`settings-transfer.spec.js` checks each row that names a check. Rows marked
"not E2E" are verified by build commands or by review, because WebDriver cannot
observe them.

Scope: `src-tauri/src/settings.rs` (browser default, export/import cancel, the
E2E-only dialog seam) and `src-tauri/src/media_info.rs` (preview cookie choice,
A7). The native file dialogs cannot be driven by WebDriver, so the E2E seam
answers them from a file in the profile data directory.

## Windows browser default (B6 root)

1. **Default stays `chrome` on Windows.** A corrupt `settings.json`, a section
   reset, or an import yields `browserChoice: "chrome"`. The sidebar select only
   offers Firefox there, so it shows blank, and downloads pass
   `--cookies-from-browser chrome`. Check `windows-default-browser`:
   `get_default_settings` and `get_settings` report `firefox` on win32.
2. **The Windows rule reaches other platforms.** macOS and Linux change their
   default or their stored `chrome` value. Check `windows-default-browser`: the
   non-Windows default stays `chrome`.
3. **An imported non-Firefox value survives on Windows.** Import and load both go
   through `read_browser_choice`, so a file that says `chrome` must load as
   `firefox` on Windows. Check `windows-import-coerces-browser`: the import
   answer on win32 is `firefox`; elsewhere it stays `chrome`.
4. **Save path leaves `chrome` in the file.** `save_patch` runs the merged
   settings through the same migration, so the stored value is coerced even
   though validation accepts `chrome`. Not E2E: covered by the same code path
   as row 3.
5. **Per-request browser override still sends `chrome` on Windows.**
   `download_options.rs` takes `browserChoice` from the request. Outside this
   worker's files; reported, not changed.

## Export and import cancel (A10)

6. **A cancelled export returns an error.** The envelope is `ok: false` with
   `INTERNAL_ERROR`, and the renderer shows a red toast. Check
   `cancelled-export-returns-ok-false`: `ok: true`, `exported: false`.
7. **A cancelled export still writes a file.** Check
   `cancelled-export-returns-ok-false`: the spec's target path does not exist
   after the cancel.
8. **A cancelled import changes settings or announces them.** Check
   `cancelled-import-leaves-settings`: `get_settings` is unchanged after the
   cancel, and no `settings-imported` event arrives (counted through
   `api.onSettingsImported`).
9. **A real failure is reported as success.** An export whose target directory
   does not exist, or an import whose file is a JSON array, must return an error
   envelope with no `exported`/`imported: true`. Check
   `real-failures-still-error`.
10. **A real import failure changes settings.** The invalid import leaves the
    stored settings as they were. Check `real-failures-still-error`.

## E2E dialog seam (T5)

11. **The seam runs in production.** Production builds must not contain the
    seam: the answer file is read only under `#[cfg(feature = "e2e")]`. Not E2E:
    `cargo check` without `--features e2e`, plus a source review that every
    seam symbol is cfg-gated.
12. **A non-E2E build warns about unused seam items.** The answer enum and
    helper exist only under the feature. Not E2E: the plain `cargo check` and
    `cargo clippy` output contain no new warnings for `settings.rs`.
13. **A leftover answer file answers a later dialog.** The command removes the
    file before it acts, and the spec removes any stale file before writing and
    in `finally`. Check `settings-export-flushes-pending-change`,
    `settings-import-restores-sidebar` and the cancel checks: the file is
    absent after each call.
14. **A malformed answer file opens the native dialog.** WebDriver would hang
    on it. The command returns an error for an unparsable or ambiguous answer.
    Check `malformed-seam-answer-errors`: the export returns an error envelope
    promptly.
15. **The seam answer is read by the wrong command.** The spec writes one answer
    per click, immediately before that click, so the next command consumes it.
    Check `settings-export-flushes-pending-change`,
    `settings-import-restores-sidebar` and the cancel checks.

## Round trip (export, change, import)

16. **The export captures a stale snapshot.** The renderer's unsaved changes
    must be flushed before the export reads disk. Check
    `settings-export-flushes-pending-change`: the value changed just before the export is
    the value in the exported file.
17. **Import restores the backend but not the sidebar.** The `settings-imported`
    handler must update the controls. Check `settings-import-restores-sidebar`: the
    `notificationsToggle` checkbox shows the restored value.
18. **The check passes without proving anything.** If the value after the
    change equals the exported value, a no-op import would pass. The spec
    asserts the three values are distinct before comparing.
19. **The import confirm modal is skipped or the wrong button is pressed.** The
    spec clicks the modal's `Import` button and checks the modal closed. Check
    `settings-import-confirm-gates-import`.
20. **The spec leaves the profile changed for later specs in this pass.** The
    round trip ends with `notifications` at the changed value: the import
    re-applies it, and the Windows browser import re-applies the export taken
    after the round trip. The restore to the seeded value must run inside the
    spec before the final check reads the profile. The `after` hook is only a
    backstop: it runs after every check has been recorded, so it cannot make
    `profile-setting-restored` pass. Check `profile-setting-restored`: after the
    restore, `get_settings.notifications` and `notificationsToggle` equal the
    seeded value, and no seam file is queued.
21. **Timing flakes.** The spec waits on observable state (the settings file,
    the checkbox, the event count) and never on fixed delays. Not E2E: review.

## Preview and format listing (A7)

22. **Preview and format listing use the global cookie choice while downloads
    use the preset or request choice.** Fixed in wave 2: `get_formats` and
    `get_video_info` take optional `hookBrowser` and `browserChoice`. Covered by
    `e2e/v5-fixes/network/preview-cookies.spec.js` and the "Wave 2 A7" rows in
    `e2e/v5-fixes/network/failure-modes.md`. No check in this spec.
23. **A partial fix changes the download path.** The download command builder
    is not edited; the only download-path change is the Windows coercion of a
    per-request `browserChoice` to Firefox, covered by the same network spec.
