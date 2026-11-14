# Queue labels, settings placement, ARIA markup, and Remove finished: failure modes

Written before the code changes. Each row names the way the fix could fail or
regress and the E2E check that must catch it. Checks drive the real renderer
(`src/index.html` and the bound modules) on the built E2E binary. Markup checks
read the live DOM; reset and queue checks drive the real buttons, modals and
backend commands.

## Cancel queue labels (C1, labels only)

1. **Cancel button text, title and aria-label differ.** The button still reads
   "Stop" or keeps "Cancel active queue" as its accessible name. Check: the
   `#cancelQueueBtn` visible text, `title` and `aria-label` are one identical
   string, "Cancel queue".
2. **Modal title does not match the button.** The modal still opens as "Cancel
   Queue". Check: after clicking `#cancelQueueBtn`, `#modal-title` text equals
   "Cancel queue".
3. **Modal message does not state the effect.** The old question wording stays,
   or the sentence drifts from the decision. Check: `#modal-message` text equals
   "Stops the active download and marks every pending item as cancelled."
4. **Confirm button label differs from the button string.** The confirm button
   stays "Cancel Queue" while the rest says "Cancel queue". Check: the danger
   button in `#modal-buttons` is "Cancel queue".
5. **Label change breaks behavior.** "Keep Running" must dismiss without calling
   `cancel_queue`, and confirming must still cancel. Check: with pending items
   seeded, Keep Running leaves every item pending; confirming marks the pending
   items cancelled in the backend queue state.

## Upstream proxy placement and reset (C5)

6. **Field stays in the Conversion section.** Check: `#upstreamProxyInput`'s
   nearest `.settings-section-body` is `#settingsSectionBodyApplication`.
7. **Field id changed.** Existing bindings and specs use `#upstreamProxyInput`.
   Check: the id resolves to exactly one element, and a typed value persists
   through the settings save path (`upstreamProxy` in `get_settings`).
8. **Conversion reset still clears the proxy.** The key list keeps
   `upstreamProxy` under `download`, or the move copies it instead of moving it.
   Check: set a proxy value, press Reset on Conversion, confirm; the proxy input
   and `get_settings.upstreamProxy` still hold the set value.
9. **Application reset does not clear the proxy.** The key is missing from the
   `application` list. Check: set a proxy value, press Reset on Application,
   confirm; the input and `get_settings.upstreamProxy` return to the default.
10. **Conversion confirmation text still implies the proxy.** Check: the
    Conversion reset modal title and message contain no "proxy" text and match
    the generic section wording.

## ARIA attribute fixes (C12)

11. **`#app-modal` has no accessible description.** Check: after a modal opens,
    `#app-modal`'s `aria-describedby` resolves to an element whose text is the
    modal message (non-empty).
12. **Destination strip keeps `aria-live`.** It holds the folder controls, so a
    live region would announce the whole strip. Check: `.download-destination`
    has no `aria-live` attribute.
13. **`role="alert"` and `aria-live="polite"` on one element.** Check: no element
    in the document has both attributes (playlist scope error and subtitle
    languages error both had the pair).
14. **Clear history title and aria-label differ.** Check: `#clearHistory`
    `title` equals `aria-label`.
15. **Update progress text still announces every tick.** Check: `#update-banner-info`
    has no `aria-live="polite"` and no `role="status"`, and the update banner
    still updates its text on progress.
16. **A state change is no longer announced at all.** Removing the live region
    must not remove the only announcement path for update state. Check: the
    updater state text still updates in the DOM after a status change (the
    visible text changes, so the check is a DOM check, not an announcement check).

## Remove finished (T5, no existing E2E)

17. **Remove finished removes pending items.** Check: seed completed, failed,
    cancelled and pending queue items; press `#clearFinishedQueueBtn`; pending
    items stay in the backend queue.
18. **Remove finished keeps finished items.** Check: after the press, the
    completed, failed and cancelled items are gone from the backend queue.
19. **Remove finished reports the wrong count.** Check: the queue status text
    matches the number of finished items actually removed.
20. **Remove finished is wired to the wrong action.** A press that clears the
    whole queue would also remove pending items. Covered by row 17.
21. **Check passes on leftover state.** The seeded queue must be cleared before
    seeding, and the checks must compare before and after counts, so a result
    from an earlier run cannot pass.
