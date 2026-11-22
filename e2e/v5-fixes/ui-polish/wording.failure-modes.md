# Wording, notifications, and toast timing: failure modes

Covers audit items C2, C9, C11, C4 (manual part, decision D2), and B11. Each
numbered row is one way the change could fail or regress. `wording.spec.js`
checks each row by the check name in the Check column.

## C2: one invalid URL, one error line

1. **Summary and URL field both show the invalid-URL error.** The options summary
   keeps "Enter a valid http or https URL..." beside the URL field message. Check
   `invalid-url-one-error-line`: after typing `not a URL` and blurring, count the
   visible, non-empty error lines among `#urlValidationMessage`,
   `#downloadOutputSummary`, and `#downloadReadiness`. The count must be exactly 1,
   and the summary text must be empty.
2. **Empty summary still takes space or draws a stray line.** The empty summary
   paragraph must have zero rendered height. Check `invalid-url-one-error-line`:
   `#downloadOutputSummary` height is at most 1px while in the `invalid-url` state.
3. **Summary text sticks after the URL is fixed.** A later valid URL must leave the
   `invalid-url` state with non-empty summary text. Check `invalid-url-recovers`:
   after replacing the URL with a valid one, the summary state is not
   `invalid-url` and its text is not empty.
4. **The URL field message goes empty, so no error line is left.** The field must
   still carry the correction text. Check `invalid-url-one-error-line`: the
   `#urlValidationMessage` text is non-empty and `#url` has `aria-invalid="true"`.

## C9: the profile hint names only what is missing

5. **Hint still says "choose a save location" with a location already set.** With
   "Ask every time" off, the empty-URL hint must not mention a save location.
   Check `hint-names-only-missing-url`: text matches `/Enter a valid URL to see/`
   and does not match `/save location/`.
6. **Hint hides a missing location.** With "Ask every time" on and the URL empty,
   the hint must name both the URL and the location. Check
   `hint-updates-on-location-toggle`: text matches `/Enter a valid URL and choose a save location/`.
7. **Hint does not update when the location toggle changes.** The summary cache
   key does not include the location flag, so toggling "Ask every time" with an
   empty URL keeps the old hint. Check `hint-updates-on-location-toggle`: after
   toggling, the hint changes within 5 s with no URL edit.
8. **Newer-version case still blames an outside change.** The new key
   `settings.newerVersion` must hold "A newer ROSI version saved these settings.
   Changes made here are not kept." and `settings-store.ts` must use it for
   NEWER_VERSION. Check `newer-version-wording`: the key value equals the required
   sentence. This does not prove the wiring in `settings-store.ts`. The
   rendered text is not checked, because reaching NEWER_VERSION needs a newer
   settings file on disk. Wiring is reported to the manager.

## C11: no "effective options" in user-facing text

9. **A user-facing string still says "effective options".** Any string in
   `UI_MESSAGES` (including strings returned by its functions) that matches
   `/effective options/i` fails. Check `no-effective-options-in-messages`: walk
   `window.rosiMessages`, call every function with sample arguments, and collect
   every string.
10. **The rendered summary still says "effective options".** The resolved summary
    and the profile-preview summary must not match `/effective options/i`. Check
    `no-effective-options-in-messages`: read `#downloadOutputSummary` for a
    profile-preview state and a resolved state.
11. **A spec text match breaks silently.** `ui-polish.spec.js` (line 410 wait message)
    and `ui-polish-readiness.spec.js` text matches were updated. The run of the
    listed specs is the proof; this spec does not replace it.

## C4 (manual part): one notification on manual failure, none on cancel

12. **Manual failure sends no notification.** Check `manual-failure-one-notification`:
    a manual download of `missing.mp4` with notifications on sends exactly one
    `showNotification` call with title `Download Failed`.
13. **Manual failure sends two notifications.** An early completion and a normal
    completion could both notify. Check `manual-failure-one-notification`: the
    count is exactly 1 after a 2 s settle.
14. **Notifications off still notify on failure.** The gate is
    `settingsStore.settings.notifications`. Check `manual-failure-one-notification`:
    with notifications off, a second manual failure sends zero calls.
15. **Cancel sends a failure notification.** `cancelled` must not notify. Check
    `manual-cancel-no-notification`: a manual cancel of `slow.mp4` sends zero
    `Download Failed` calls and zero calls in total.
16. **Failure body is raw multi-line stderr or unbounded.** The body must be one
    line of at most 160 characters. Check `manual-failure-one-notification`: the
    body has no line break and length is at most 160 characters.
17. **Title drifts from "Download Failed".** Check `manual-failure-one-notification`:
    the title equals `Download Failed`.

## B11: error and warning toasts stay longer and pause on hover or focus

18. **Error toast still dismisses at 4 s.** Check `error-toast-timing`: the error
    toast is still visible (`visible`, not `hiding`) at 6 s after `showToast`.
19. **Error toast never dismisses.** Check `error-toast-timing`: the toast is gone
    (not connected) by 9.5 s.
20. **Warning toast still dismisses at 4 s.** Check `warning-toast-timing`: the
    same visible-at-6 s and gone-by-9.5 s checks for a warning toast.
21. **Explicit duration is ignored.** `{ type: 'error', duration: 1500 }` must go
    away by 3 s. Check `explicit-duration-wins`.
22. **Info toast default changed.** Info and success keep 4 s: gone by 5.5 s. Check
    `info-toast-unchanged`.
23. **Hover does not pause.** Dispatching `mouseenter` on the toast must stop the
    timer. Check `hover-pauses-toast`: the toast is still visible at 9.5 s while
    hovered.
24. **Leaving hover dismisses at once.** Resume must give at least 2 s. Check
    `hover-pauses-toast`: after `mouseleave`, the toast is still connected 1 s later.
25. **Focus inside the toast does not pause.** A focused dismiss button must pause
    the timer. Check `focus-pauses-toast`: focus the dismiss button, wait 9.5 s,
    the toast is still connected.
26. **Two live mechanisms announce each toast.** The toast element must not carry
    `role` or `aria-live`. Check `one-live-mechanism`: `role` and `aria-live` are
    absent on the toast, and the nearest `[aria-live]` ancestor is the container
    (not the toast).
27. **Error toasts announce in the polite region.** Error and warning toasts sit
    in `#toast-container-assertive` (aria-live assertive). Info sits in
    `#toast-container` (polite). Check `one-live-mechanism`: the nearest live
    region of each toast type has the expected value.

## Label capitalization: Title Case for every label

Rule: every label is Title Case. That covers button text, tab names,
segmented-control options, headings and section titles, dialog titles and dialog
buttons, settings row and checkbox/toggle labels, wizard step and card titles,
menu items, `aria-label` and `title` on controls, and popover titles. Sentences,
hints, descriptions, help text, placeholders, toasts, status lines, error
messages, console text, and file names keep their case. Minor words (a, an, the,
and, or, but, for, to, of, in, on, at, by, per, vs, via) stay lowercase unless
they are the first or last word. Product spellings stay exact: yt-dlp, FFmpeg,
ffprobe, SponsorBlock, GPU, URL, URLs, MP4, MP3, UI, Deno, ROSI, macOS. Words
after a hyphen are capitalized ("Built-In"). "Clear history" becomes "Clear
Activity".

1. **A missed label stays in sentence case.** For example "Convert after
   download" on a toggle. No spec checks case for every label, so the proof is
   the grep inventory of `src/index.html`, `src/engine/**`, `src/modules/**`, and
   `src/splash.html` for button, title, heading, and `aria-label` strings.
2. **A sentence or hint is capitalized.** For example "Choose a save location to
   see what this download will use." Check `hint-names-only-missing-url` and
   `hint-updates-on-location-toggle`: their regex matchers must still match the
   sentence text, which is unchanged.
3. **An E2E matcher stays on the old text.** Examples: `clickModalButton("Cancel
   queue")`, `clickModalButton("Reset section")`, `"Clear history"` in
   `markup.spec.js`, and the `Retry save` text in `ui-polish.spec.js`. Check: a
   case-insensitive grep of `e2e/` (excluding `e2e/artifacts/`) and `src/tests/`
   for each old string finds no label matcher left. Comments and fixture status
   text do not count.
4. **A matcher passes only because it is case-insensitive.** A regex with the
   `i` flag or a lowercased comparison still passes on the old text, so it proves
   nothing about the new label. Check: the updated matchers compare the exact
   Title Case text (for example `button.textContent === "Download Again"`).
5. **The aria-label diverges from the visible text.** The Clear Activity control
   has `title` and `aria-label` that must both read "Clear Activity". Check
   `markup.spec.js` (the `#clearHistory` title and ariaLabel assertions).
6. **The Deno action has two or three labels.** The same Deno action is labelled
   "Open Deno Instructions" in one dialog and "Open Install Instructions" in
   another. Check `deno-installer.spec.js`: every dialog and the failed-action
   assertion use the one label that `UI_MESSAGES.wizard.installInstructions` returns.
7. **A product spelling breaks.** For example "Yt-dlp", "Ffmpeg", "Mp4", "Macos",
   or "Ytdlp". Check: a grep of the changed lines for those spellings finds
   nothing.
8. **A hyphenated word is wrong.** For example "Auto-detect" stays lowercase
   after the hyphen. Check: "Auto-Detect" in `src/index.html` and the GPU select
   matchers use the same text.
9. **A visible label and its inline reference differ.** The wizard names the
   Skip button inside a `<strong>` in the description. Check: that `<strong>`
   reads "Skip Setup", the same as the button and the `Skip Setup?` prompt that
   `main.spec.js` clicks.
10. **A title attribute that is a tooltip sentence is changed.** Tooltip
    sentences such as "Choose exact source formats" are descriptions and keep
    their case. Check: the profile tooltips in `src/index.html` are unchanged.
