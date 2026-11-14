# Network area failure modes

Written before the code changes for each section. Rows marked "Not E2E" are
verified by build commands or by review, because WebDriver cannot observe them.

## Wave 2 A7: preview and format cookie choice

Spec: `e2e/v5-fixes/network/preview-cookies.spec.js`, run by `run.mjs`. The spec
writes `preview-cookies.observations.json` into the runner's results directory.
Each check names the row it proves. In E2E builds with
`ROSI_E2E_YTDLP_ARGS_LOG` set, `get_formats` and `get_video_info` record their
yt-dlp argument list to that file, redact the `--proxy` value, and return before
yt-dlp starts. The spec clears the log before each call, so a check sees only
its own call.

Scope: `src-tauri/src/media_info.rs` (optional cookie choice on both commands,
E2E capture), `src-tauri/src/download_options.rs` (Windows coercion of a
per-request `browserChoice`, shared with the listing path),
`src/api.ts`, `src/commands.ts`, `src/engine/formats.ts`, and
`src/engine/preview-controller.ts`.

1. **Explicit choice is ignored, so listings use the global setting.** With
   global cookies off, a listing or preview given `{ hookBrowser: true,
browserChoice: "firefox" }` still passes no cookie arguments. Check
   `explicit-choice-reaches-listing-and-preview`: the recorded `get_formats` and
   `get_video_info` argument lists contain `--cookies-from-browser firefox`.
2. **Explicit `false` does not win over a global `true`.** With global cookies on,
   `{ hookBrowser: false }` still passes cookie arguments. Check
   `explicit-false-suppresses-global`: neither recorded call contains
   `--cookies-from-browser`.
3. **A partial choice ignores the saved flag.** `{ browserChoice: "firefox" }`
   without `hookBrowser` must keep the saved `hookBrowser` value. The spec sets
   the saved flag on, so a version that drops the flag fails. Check
   `partial-choice-keeps-saved-flag`.
4. **No-argument calls stop following the global setting.** Calls without the new
   argument are the old path: with global cookies on they pass the saved browser,
   with global cookies off they pass none. Check `no-argument-follows-global`.
   The global values differ from the choices used in rows 1 and 2, so a no-op
   fallback cannot pass by accident.
5. **Listing ignores the saved choice in the other direction.** Global on with
   choice off must not pass the saved browser, which is row 2. A partial choice
   that replaces the browser but keeps the saved flag is row 3.
6. **Windows per-request `chrome` reaches the listing path.** On win32 a preview
   given `browserChoice: "chrome"` passes `--cookies-from-browser firefox`. On
   other platforms it passes `chrome`. Check `windows-coerces-preview-browser`.
7. **Windows per-request `chrome` reaches downloads.** On win32
   `resolve_download_options` with `browserChoice: "chrome"` returns `firefox`; on
   other platforms it returns `chrome`. The download path copies this same
   resolved value. Check `windows-coerces-request-browser`.
8. **The coercion runs on every platform.** A Windows-only rule that also
   rewrites `chrome` on macOS or Linux breaks rows 6 and 7 there. Both checks
   compare against the platform value, not a fixed `firefox`.
9. **A recorded call comes from an earlier call.** Without clearing the log, a
   check reads a stale entry and passes. The spec deletes the log before each
   call and requires exactly one entry for that command.
10. **Nothing is recorded because validation rejects the URL first.** The capture
    runs after URL validation. The spec uses an `https` URL that passes the
    syntactic check. A missing entry fails the check, it does not pass.
11. **The log leaks proxy credentials into the retained artifact.** The
    ephemeral proxy URL is an argument after `--proxy`. Check `log-redacts-proxy`:
    every logged `--proxy` value is `<redacted>`.
12. **Capture runs in a production build.** The capture is compiled only under
    `feature = "e2e"`. Not E2E: `cargo check` and `cargo clippy` without
    `--features e2e` plus source review that every capture symbol is cfg-gated.
13. **Capture write failure hides the real result.** An unwritable log returns an
    error from the command, which is visible to the spec as a missing entry
    (row 10). Not E2E: review only.
14. **The renderer does not pass the next download's choice.** The renderer
    resolves its download overrides with `resolve_download_options` and passes
    the result. Not E2E: while the presets and the renderer download overrides
    carry no cookie fields, the resolved value equals the saved setting, so this
    cannot be told apart from row 4 in WebDriver. Covered by typecheck and review.
15. **Renderer resolve failure or a cancel during resolve starts an uncancelled
    fetch.** A failed resolve falls back to the saved setting. A cancel during
    the resolve must not start the listing or preview request. Not E2E: review of
    the `wasCancelled` and request-token checks before the second call.
16. **The IPC shape changes for existing callers.** The new arguments are
    optional and absent when not given, so older callers keep working. Row 4
    covers the no-argument call. Not E2E: `src/generated/ipc-types.ts` is
    unchanged, checked by `git diff`.
17. **The runner does not run the new spec.** The gate runs only
    `network/run.mjs`, which sets `ROSI_E2E_SPECS`. Run.mjs requires exactly 7
    passing preview-cookie observations, so a missing or skipped spec fails the
    area.
