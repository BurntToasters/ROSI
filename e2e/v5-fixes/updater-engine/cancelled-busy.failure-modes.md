# Updater engine: cancelled download still stopping (failure modes)

Written before the code change (finding A3, `src-tauri/src/updater.rs`).

Cause: the update plugin cannot abort a transfer. `cancel_download` marks the
active download cancelled and keeps `active` set until the transfer ends, which
can take up to the 30 minute download timeout. While it is set, a check
answered `null` (the renderer reads that as "started", spins 30 s, then shows
"Update Check Timed Out"), and a download answered "A download is already in
progress.".

Target behaviour: only when the sole holder of the engine is a cancelled transfer
that is still stopping, `check_for_updates` returns a `CheckRefusal` with
`reason: "message"` and `download_update` returns a `DownloadOutcome` error. Both
carry the same message, and both answer at once. A live (not cancelled) transfer
keeps its old answers.

The scenario in `cancelled-busy.spec.js` holds the artifact response, cancels,
asserts the stopping-window rows, releases the response, and asserts recovery.
Each row below is one `checks` entry in its report with `invariantPassed`.

| ID   | Failure mode                                                                                                                   | Guard                                                                                | Proof                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CB1  | `check_for_updates` answers `null` while only a cancelled transfer holds the engine, so the button spins 30 s                  | `begin_check` returns a message refusal when the only holder is a cancelled download | Check during the held window returns `{reason: "message"}` in under 5 s                                                                                         |
| CB2  | The refusal message is empty or generic, so the user cannot tell why                                                           | One shared message constant that says the previous download is still stopping        | The refusal and the download error both contain "still stopping"                                                                                                |
| CB3  | The refused check or download emits `checking`, `error`, or any status, so the renderer shows a started check or a stray error | Refusal paths return before `emit_status` and before any feed request                | No new `engineStatuses` entry and no new `/latest-` request during the held window                                                                              |
| CB4  | `download_update` during the stopping window still says "A download is already in progress." or answers cancelled (silent)     | `begin_download` returns `DownloadOutcome::error` with the stopping message          | Download returns `{success: false, cancelled: false, error: <stopping message>}` in under 5 s                                                                   |
| CB5  | The refused download starts a second transfer (second `/artifacts/` request, second active download)                           | The refusal happens before generation and `active` are set                           | `/artifacts/` request count is unchanged while the first transfer is held                                                                                       |
| CB6  | The refusal aborts, releases, or re-labels the held transfer, so it is reported as downloaded or never settles                 | Refusal paths do not touch `active`, `pending`, or `downloads`                       | After release the held download resolves `{success: false, cancelled: true, error: null}`, no `downloaded` status, no open modal                                |
| CB7  | After the transfer settles the engine stays refused (stuck `active`) or the cancelled candidate stays pending                  | `finish_download` takes `active` and releases the cancelled candidate                | After release a manual check requests the feed and offers 9.0.7 ("Update Available!")                                                                           |
| CB8  | A live (not cancelled) transfer changes its answers: check now refused with the new message, or the old download text changes  | The refusal applies only when `active.cancelled` is set                              | While a live transfer is held: check returns `null` with no feed request, download returns "A download is already in progress."                                 |
| CB9  | The refusal is wrongly returned while an install holds the engine (not a stopping download)                                    | Refusal requires `!installing` and `active.cancelled`                                | Not proven by E2E: an install cannot start while a transfer is active, so this state is unreachable from the flow. Covered by reading `busy()`/`begin_install`. |
| CB10 | A channel change during the stopping window loses its later check, so the new channel's update is never offered                | `finish_download` still spawns a check when `recheck_target` is set (unchanged)      | Existing: `e2e/state-updater.spec.js` generation scenario (`waitForAvailable("9.0.0")` after the held B settles). Not changed by this scenario.                 |

## A5: options commands off the main thread

`resolve_download_options` and `resolve_preset_options` (`src-tauri/src/download_options.rs`)
become `#[tauri::command(async)]`. The signatures stay the same, so the renderer
contract must not change.

| ID   | Failure mode                                                                                  | Guard                                            | Proof                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A5-1 | The async change breaks argument decoding or the envelope the renderer reads                  | Signatures unchanged; only the attribute changes | `resolve_download_options` with a URL returns `{ok: true, data: {url, ...}}`; `resolve_preset_options` with an unknown preset returns `{ok: false, error: {...}}` |
| A5-2 | The command still runs on the main thread, so a slow download folder still freezes the window | `async` attribute on both commands               | Not observable from the renderer. Checked by reading the attribute and `cargo check`/`cargo clippy`.                                                              |
