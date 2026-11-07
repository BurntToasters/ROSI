# Native notices in E2E builds: failure modes

Scope: the informational native alerts the backend raises (title, message, one
OK button), routed through `src-tauri/src/notices.rs`. WebDriver drives only the
webview, so it cannot see or dismiss a native alert. Fault scenarios (a corrupt
or newer `settings.json`, a refused save, a missing FFmpeg) raised one alert per
launch, and on macOS these piled up over the developer's screen during every
local run.

Required behavior: production builds show every notice exactly as before. E2E
builds (`--features e2e`) never open the alert; they log it and record it in a
bounded in-memory list that `e2e_native_notices` returns, so a scenario can assert
the notice instead of a person dismissing it.

| #   | Failure mode                                                                                  | Required behavior                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The suppression leaks into a production build                                                 | The E2E branch is compiled only with `feature = "e2e"`. The release build has no `e2e_native_notices` command and always shows the alert.                         |
| 2   | A suppressed notice disappears without a trace, so a regression that stops raising it passes  | Every suppressed notice is logged (`logs/rosi.log`) and recorded; a scenario asserts the recorded title and message.                                              |
| 3   | A notice with a callback (for example the missing yt-dlp alert that exits the app) is skipped | Only notices without a callback go through `notices.rs`. Alerts whose dismissal does something keep their own dialog code.                                        |
| 4   | Confirmation dialogs (close with a running download, close without saving) are suppressed     | Out of scope: they choose between actions and stay native. E2E scenarios already avoid them.                                                                      |
| 5   | File and folder pickers are suppressed                                                        | Out of scope: pickers are not notices.                                                                                                                            |
| 6   | A fault scenario raises notices without end and the record grows without bound                | The record keeps the newest 64 notices.                                                                                                                           |
| 7   | The record is read by a window other than the main window                                     | `e2e_native_notices` refuses any window but the main window, like the other E2E commands.                                                                         |
| 8   | A notice raised before the app handle exists is lost                                          | Same as before: a production build with no app handle shows nothing. An E2E build still logs and records it.                                                      |
| 9   | Notices from an earlier scenario are mistaken for the current one                             | Scenarios read the record length first and assert only on entries added after it. A once-per-process notice (profile recovery) is matched anywhere in the record. |

Proof: `e2e/state-updater.spec.js` scenario "renders the Rust defaults when
settings.json is corrupt at startup" asserts that the "ROSI Profile Recovery"
notice was recorded, and a full local E2E run on macOS opens no native alert.
