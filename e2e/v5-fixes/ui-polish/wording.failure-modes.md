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
