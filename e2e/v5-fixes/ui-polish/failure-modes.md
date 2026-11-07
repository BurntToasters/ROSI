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
