# UI polish failure modes

This inventory is written before UI behavior changes. E2E acceptance should drive
the real renderer and native bridge, and leave a JSON report plus screenshots
whose source revision, dirty-file hashes, platform, and E2E binary hash are
recorded. A static renderer helper passing is not full-app acceptance.

## Effective options and readiness

1. **Summary disagrees with the selected profile.** Changing compatible, best
   video, audio format, custom formats, or a saved preset can leave the summary
   stale. Keep `#downloadOutputSummary` synchronized with visible controls.
2. **Profile summary is mistaken for resolved backend options.** A renderer
   estimate cannot account for format availability, backend defaults, or
   normalization. Label it as a profile preview until an API returns resolved
   options; never imply it is the final command/options.
3. **Failed or delayed option resolution leaves old content visible.** A prior
   request can finish after the URL or profile changes. Surface unavailable or
   pending state and ignore stale responses.
4. **Invalid input has no actionable inline feedback.** Invalid URL, unsupported
   custom format, and invalid subtitle language input must identify the field,
   explain correction, expose `aria-invalid`/descriptions, and keep focus on
   the failing control when submission is blocked.
5. **Readiness appears successful when prerequisites fail.** Missing runtime,
   unavailable destination, or failed format lookup must not look like a
   ready-to-download state. Keep the reason and next action visible.

## Progress, outcomes, and queue

6. **A terminal failure looks like successful completion.** Exercise complete,
   failed, cancelled, and partial playlist success separately, including
   conversion failure after a source file was retained.
7. **Saved outputs have no usable action.** For one and multiple output paths,
   expose the right open/reveal action and report bridge failures without
   silently claiming success.
8. **Activity re-render loses the user's place.** Filters, new entries, and
   action completion must retain sensible keyboard focus and announce material
   updates without announcing every progress tick.
9. **Queue state/action mismatch.** Pending, downloading, completed, failed,
   and cancelled rows must present only valid actions; retry/requeue, remove,
   reorder, and open-location errors must restore controls and explain failure.
10. **Queue refresh drops focus or context.** After progress snapshots or action
    results replace rows, preserve focus by queue item/action identity when it
    still exists and explain why disabled actions cannot run.
11. **Long paths and source URLs break the layout.** Very long filesystem paths,
    URLs, titles, error messages, and multiple outputs must wrap or truncate
    without covering actions or expanding past the viewport.

## Settings and onboarding

12. **Settings save failure looks saved.** Rejected or thrown saves must retain
    the current values, show retryable feedback, and avoid false success; a
    successful retry must clear the failure state.
13. **Section reset changes values before confirmation.** Cancel leaves values
    untouched; confirm resets only that section; a save failure reports the
    failure and keeps a retry path.
14. **Dependent controls are silently disabled.** Disabled options (for
    example conversion under audio-only) explain the dependency in text that is
    available to keyboard and assistive-technology users.
15. **Folder selection is cancelled or fails during setup.** Preserve the
    existing destination, do not show a stale chosen path, and explain when
    asking for a destination before each download is selected.
16. **Deno check or install fails, or setup is skipped.** Distinguish checking,
    installed, unavailable, cancelled, and failed states; offer the right
    install instructions/action; do not imply setup persisted when the save
    failed; Skip must reset exactly its documented wizard settings.
17. **Modal/wizard exit loses keyboard control.** Escape confirmation, cancel,
    save failure, and completion must keep focus trapped while open and restore
    focus to the invoking control on close.

## Viewport, theme, and accessibility matrix

18. **Small window clips controls.** Exercise every theme at 900x560 and
    1200x900 with increased text scale; settings, queue actions, dialogs, and
    wizard navigation must remain reachable without horizontal overflow.
19. **Theme or reduced-motion state lowers contrast or motion access.** Check
    system, light, dark, and purple themes with keyboard focus, status/error
    states, and `prefers-reduced-motion`; reduced motion must suppress
    nonessential transitions while preserving state changes.
20. **Keyboard and screen-reader semantics regress.** Tab/Shift+Tab, Escape,
    modal focus return, settings search/reset, wizard navigation, live status,
    progress names/values, and action labels must remain operable and
    understandable without a pointer.

## Readiness hint, folder feedback, and long content (D1, D4 to D6)

These rows were written before the code for them. The download readiness hint
is `#downloadReadiness`, placed after the Download button. The folder "Change…"
button is in the destination strip of the main panel (`#changeDownloadFolderBtn`),
not in the settings sidebar, so the feedback sits in that strip.

5a. **Blocking readiness is silent next to Download.** With "Custom" formats and
no format selected, or an invalid playlist range, Download only shows a toast
or does nothing. The hint next to Download names the blocker and the next
action (select a format, fix the playlist range). Download stays enabled and
still refuses to start.
5b. **A failed runtime (Deno) check leaves no trace after startup.** The check
failure is a one-time modal. The hint next to Download keeps the reason and
the install-instructions next action until a later check succeeds. Not covered
by an E2E scenario: the check runs once at startup, and the harness cannot make
the bridge fail without a product test hook. The hint branch is therefore
unverified by E2E.
5c. **A failed effective-options lookup is shown only in the summary line.** The
hint repeats the reason and says Download still validates the options when it
starts, so the failure does not read as a ready state.
5d. **"Ask every time" off with no folder.** Decision: an empty folder is not a
blocker. `resolve_output_path` falls back to the Downloads directory, and the
readiness state is `ready` without `outputPath`. The Download button used to
open a folder picker in this case (`bind/download.ts`); it now sends no
`outputPath`, so Rust uses the Downloads directory, and the hint says so.
Scenario: `missing-folder-ask-off-uses-default`.
5e. **"Ask every time" on.** Decision: the folder is chosen per download, so the
hint says ROSI will ask where to save this download. It is informational,
not a blocker. Scenario: `ask-each-time-hint`.
5f. **Turning "Ask every time" off with no folder set gives no feedback.** The
switch changes nothing visible, and the next download's destination is not
explained. Decision: switching off with no folder opens the folder picker
(the same picker the old Download path used). A cancelled pick shows
`UI_MESSAGES.wizard.folderCancelled` in the folder strip, and a failed pick
shows `UI_MESSAGES.wizard.folderFailed`. The toggle keeps the user's choice.
Scenario: `ask-off-cancelled-folder-feedback`.
11a. **Long content overflows at 900x560.** A 400-character URL, output path,
title, and error text must wrap or truncate in the queue, activity, console,
and folder summary. No unclipped box may spill past its own width, clipped
boxes must stay inside their region, and the document must not scroll
horizontally. Scenario: `long-content-no-horizontal-overflow`.
15a. **Change folder cancel or failure is silent.** A cancelled pick returns
without feedback, and a thrown pick is an unhandled rejection. Both now show
the wizard strings (`folderCancelled` only while "Ask every time" is off,
matching the wizard, and `folderFailed` on a thrown pick). A successful pick
clears the feedback and updates the path, so no stale path is shown.
Scenario: `change-folder-cancelled-and-failed`.
D6. **`#queueStatusMessage` live-region attributes set at runtime.** The markup
in `src/index.html` already has `role="status"`, `aria-live="polite"`, and
`aria-atomic="true"`. The runtime copy in `src/rosiEngine.ts` is removed, so
the markup is the single source. Scenario: `queue-status-live-region-markup`
(checks the served `index.html` tag and the live DOM).

## Activity focus, queue row errors, and screenshot evidence (D2, D3, D7)

Written before the code for them. The D2 and D3 scenarios are in
`ui-polish-focus.spec.js` and drive a real queue item (`slow.mp4` holds it in
`downloading`; `clip-one.mp4` completes quickly). Where a scenario needs a
control that the renderer has already replaced, it clicks the detached element
the user had pressed, so the handler runs with the id it was rendered with.

8a. **Activity re-render drops focus.** `renderActivity` replaces every row, so a
focused row action falls back to BODY on each `download-activity-update`.
Expected: focus returns to the same row's action, matched by the row id
(`data-activity-id`) and the action (`data-activity-action`). Scenario:
`activity-focus-retained-on-update`.
8b. **Announcements are missing or repeated.** New entries must be announced
once through a polite live region (`#activity-live-status`). A re-sent update
with no new entry and real `job-progress` ticks must not change it. Scenario:
`activity-announces-new-entries-once`.
9a. **Remove of a downloading item fails silently.** The backend refuses it with
`VALIDATION_ERROR` ("Cannot remove an actively downloading item."), but the
row shows only a toast and a status line. Expected: the message appears on
the row, the row still says Downloading, the clicked control is enabled and
not busy, and the row's other controls stay enabled. The inline message
does not outlive the state it describes. Scenario:
`queue-row-remove-error-inline`.
9b. **Open location failure is silent on the row.** An `openFileLocation` error
envelope shows only a toast. Expected: the message appears on the completed
row, its Open folder and Remove controls stay enabled. Scenario:
`queue-open-location-error-inline`.
18a. **Screenshots never reach the gate report.** `ui-polish.spec.js` wrote its
PNGs under its own artifact folder, and the v5-fixes pass did not receive
`ROSI_E2E_SCREENSHOTS`, so `report.screenshots` and `verifyScreenshots` only
covered `ui-screenshots`. Expected: the 12 ui-polish shots (4 themes at
900x560 and 1200x900, plus 900x560 at 125% text) are written to
`e2e/artifacts/screenshots/<platform>-<arch>/`, attached to the
`v5-fixes/ui-polish` scenario, listed in `report.screenshots`, and counted by
the release check next to the `ui-screenshots` shots. Scenario:
`theme-viewport-keyboard-layout` (gate report).
18b. **A release check that counts one scenario's shots would accept a gate with
the ui-polish shots missing.** `verifyFullE2eEvidence` must count the shots
of every screenshot scenario, so a missing ui-polish shot fails the same
count and name checks that cover `ui-screenshots`. Scenario: the existing
`scripts/security-release-repairs.test.mjs` release fixture.

## E2E evidence requirements

- Keep existing suite ownership and platform skip allowances. Add a
  `ui-polish` feature group to `e2e/suites.json` without moving current specs.
- The UI group is targeted evidence (`fullSuite: false`); it cannot satisfy
  release proof. Full release evidence still requires the canonical complete
  suite and its fresh binary/report hashes.
- Capture screenshots for each required viewport/theme combination and a
  machine-readable report with per-scenario outcomes. Distinguish discovered
  cases from executed results and include failures rather than dropping them.
- Record source identity including dirty-file hashes as well as `HEAD`, the
  platform, runner/tool versions, and the exact tested binary hash.

## D0 triage of foreground failures (macOS, `ROSI_E2E_FOREGROUND=1`)

Each row names the assertion, the verdict (spec assumption or product gap),
the reason, and the fix. Product-gap rows were written before their code change.

| Row | Assertion                                                                                                 | Verdict                                            | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Fix                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | `effective-options-summary` (`:333`): summary never reaches `resolved` for a valid URL on a fresh profile | Product gap (rows 2 and 5)                         | `buildEffectiveOptionsReadiness` returns `destination` for an empty folder even when "Ask every time" is off. `resolve_output_path` (`download_options.rs`) falls back to the downloads directory in that case, and the renderer would still be blocked. Sending `outputPath: ""` would not work either: `resolve_value` lets a non-null override replace the fallback, and `validate_download_request` rejects an empty `outputPath`. Keep `destination` for "Ask every time" on, because the save location is chosen per download. | Renderer omits `outputPath` when the folder is empty and "Ask every time" is off, so Rust fills in the downloads directory. "Ask every time" on still reports `destination`.          |
| T2  | `settings-section-reset-confirmation` (`:423`): focus not inside the reset prompt                         | Spec assumption                                    | `showModal` moves focus into `#app-modal` in a `requestAnimationFrame` (`overlays.ts`). The spec reads focus in the first WebDriver round trip after `.active` is set, which can run before that frame. The product contract holds once the frame runs, so the spec must wait for focus, not assume it.                                                                                                                                                                                                                              | Spec waits for focus inside `#app-modal` (condition-based, 5 s). Product unchanged.                                                                                                   |
| T3  | `keyboard-reset-escape-focus` (`:478`): reset button not keyboard focusable                               | Spec assumption (cascade of T2)                    | T2 fails before Cancel, so the reset prompt stays open. Its focus-in handler then pulls focus back into the prompt, so `focus()` on the reset button cannot stick. The sidebar uses `transform`, not `visibility`, so focus does not depend on the sidebar transition.                                                                                                                                                                                                                                                               | Fixed by T2 and by the sidebar-in-view wait in T5.                                                                                                                                    |
| T4  | `dependent-controls-and-queue-focus` (`:586`): `execute/async` timeout on the first `addToQueue`          | Open. Not yet classified as spec or product        | The timeout is on the first add (`firstUrl`), not the second, so the plan's wording is off. `add_to_queue` waits for the coordinator, and admission does not start the queue (`startQueue` is explicit). The scenario uses live youtube.com URLs, and the earlier effective-options scenario typed a youtube URL that schedules an auto `getVideoInfo` (450 ms debounce) which the spec never cancels. That lookup is the leading hypothesis for the hang, not confirmed. `src-tauri/` is out of scope for this task.                | Not reproduced in the passing foreground run (`2026-11-07T05-44-49-412Z-26812`). No code change was made for it. Root cause unconfirmed, and the earlier timeout may be intermittent. |
| T5  | `theme-viewport-keyboard-layout` (`:789`): `settingsSearch` not focused                                   | Spec assumption (cascade of T2, plus a timing gap) | The prompt left open by T2 keeps focus trapped, so `settingsSearch.focus()` lands on a prompt button with no id. Separately, `setSidebarOpen(true)` returns once the `open` class is set, before the sidebar has finished sliding into view.                                                                                                                                                                                                                                                                                         | Spec waits for the sidebar to be fully in view, then focuses.                                                                                                                         |
| T6  | `queue refresh stole focused action` (`:644`) and focus trap Tab (`:485`)                                 | Background-only, see T8 and T9                     | Background mode only. The focus trap failure is explained by T8. The queue failure did not reproduce in the background run recorded under T9.                                                                                                                                                                                                                                                                                                                                                                                        | See T8 and T9.                                                                                                                                                                        |

## Background-mode triage (macOS, `ROSI_E2E_BACKGROUND=1`, the local default)

Background mode runs the E2E app below other windows, so the page is occluded.
The probe run (`e2e/v5-fixes/ui-polish/zz-diag-probe.spec.js`, deleted after
use) measured the page state in that mode: `document.visibilityState` is
`hidden`, `document.hasFocus()` is `false`, no `requestAnimationFrame` callback
ran within 2 s, and the sidebar's transform transition stayed `running` at
`currentTime` 0 with `getBoundingClientRect().left` at -372 while the `open`
class was set. `element.focus()` still updates `document.activeElement`, `focusin`
still fires, and a WebDriver `Tab` still arrives as a synthetic, untrusted
`keydown` that does not move focus natively.

| Row | Assertion                                                                                                                                                                                                                                                                           | Verdict                                                                | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Fix                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T7  | `settings sidebar did not finish opening` (`setSidebarOpen`, `:215`) in `settings-section-reset-confirmation`, `keyboard-reset-escape-focus`, `settings-save-retry`, `theme-viewport-keyboard-layout` (gate run `2026-11-07T06-05-11-941Z-57407`, repro `2026-11-07T06-24-04-258Z`) | Spec assumption (background mode only)                                 | The spec waits for the sidebar's 500 ms transform transition to rest. WebKit does not advance CSS transitions in a hidden page (probe above), so the rest check can only pass in foreground, where frames run. Nothing in the product is stuck: the `open` class is set and the transition would finish once the window is visible.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | The spec finishes the sidebar's running animations (`Animation.finish()`) before the rest check, only when `document.visibilityState` is not `visible`. The rest check and its 10 s timeout stay. Foreground still waits for the real transition. Product unchanged.                                          |
| T8  | `focus did not move into the open prompt` (`waitForModalFocus`) and `Tab moved focus out of the reset prompt` (`:485`); focus stays on BODY                                                                                                                                         | Product gap (frame dependency), reachable by users at sub-frame timing | `showModal` (`src/engine/overlays.ts`) moves initial focus into the prompt only inside `requestAnimationFrame`. A hidden page runs no frames, so focus stays on BODY. The Tab trap only moves focus when the active element is the first or last control, so with focus on BODY it does nothing. The gap also exists in a visible window: until the next frame, keys go to BODY and outside the prompt's keydown trap. Focus behavior does not depend on `hasFocus()`: `focus()` and `focusin` work in the probe, so the trap logic itself is not the problem. Control run (T7 spec fix kept, this product change reverted): both `waitForModalFocus` checks failed with "focus did not move into the open prompt", so the product change is required for this assertion. Not covered by this change: a click on non-focusable prompt text also leaves focus on BODY, where the modal's keydown trap does not see Tab. This was not reproduced here. | Product: `showModal` moves focus into the prompt synchronously once its buttons are in place. The `requestAnimationFrame` call stays as a fallback that only moves focus when focus is still outside the prompt, so it cannot steal focus from a control the user already reached. Spec assertions unchanged. |
| T9  | `queue refresh stole focused action` (`:644`)                                                                                                                                                                                                                                       | Cascade of T8, not a separate product gap                              | The earlier background run `2026-11-07T04-41-27-508Z-91968` failed the reset prompt checks (T8) before this check. The control run with T8 reverted failed it only after the reset prompt stayed open, which keeps the main content inert and blocks focus. With T8 in place it passed in every background run after the T7 fix (`2026-11-07T06-24-04-258Z` and the two that followed) and in the foreground run `2026-11-07T05-44-49-412Z-26812`. The queue render path has no frame-based focus restore (no `requestAnimationFrame` in `src/modules/queue.ts`).                                                                                                                                                                                                                                                                                                                                                                                    | No change of its own. The fix is T8. If it fails with the T8 fix in place, record the row here before changing code.                                                                                                                                                                                          |
