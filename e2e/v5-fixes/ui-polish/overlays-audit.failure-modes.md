# Overlays audit: modal displacement, focus traps, async actions, licenses timer: failure modes

Written before the code changes (audit items F2, F8, F11 modal part, F12). Each
row names a way the fix could fail or regress and the check in
`overlays-audit.spec.js` that must catch it. Checks drive the real renderer
(`overlays.showModal`, the real `settings.confirmInterruptActiveWork`, the real
sidebar and licenses controls) on the built E2E binary. Modules come from
`window.__ROSI_E2E__.modules` (`overlays`, `ui`, `settings`). The spec only reads
that object; `src/e2e-hook.ts` is not changed. Waits are conditions, never fixed
sleeps.

## Modal displacement (F2)

1. **An unkeyed modal is dropped by a priority modal.** The old rule kept a
   displaced modal only when it had a `key`. Check: show an unkeyed modal
   (title "Plain A"), show a priority modal, close the priority modal with its
   button; "Plain A" is shown again.
2. **An unkeyed prompt with a promise hangs forever.** The probe builds the same
   shape as `confirmInterruptActiveWork` (priority, unkeyed, promise settled only
   by a button or `onDismiss`). A second priority modal pushes it aside. Check:
   after the second modal closes, the first is shown again, and pressing its
   button settles the promise with that button's value.
3. **The real interrupt confirm hangs after a displacement.** Check: start a
   queue download, call the real `confirmInterruptActiveWork("Restarting ROSI")`,
   show a priority modal on top, close it, wait for "Download in Progress", press
   Escape; the promise settles `false` and the download is still `downloading`.
4. **A keyed modal regresses.** Keyed prompts were already kept. Check: the same
   flow with a `key` still shows the displaced prompt again, exactly once (the
   re-queue must not duplicate it).
5. **A busy modal is re-queued.** A busy prompt has no way to close and is not
   displaced into the queue. Check: a busy priority modal pushed aside by another
   priority modal is not in the queue or on screen after the second one closes.
6. **Order is lost with several displacements.** Check: modal A, then priority B
   over it, then priority C over B; closing C shows B, closing B shows A.
7. **A displaced modal is dismissed instead of kept.** Re-queueing must not call
   `onDismiss`. Check: the dismissal counter of the displaced modal stays 0 while
   the priority modal is shown and closed.
8. **Dropped modals leave a promise unresolved.** When the modal DOM is missing,
   `displayNextModal` skips a modal without showing it. Not reachable from a
   running app (the markup is static), so this row is a source check: the skip
   path calls the modal's `onDismiss`. It is stated, not exercised natively.

## Sidebar focus trap (F8)

9. **The sidebar keeps its own focusable filter.** The old filter had no
   `checkVisibility` and no `[inert]` rule, and its selector drifted from the
   overlay trap. Check (source): `src/modules/ui.ts` has no
   `getSidebarFocusableElements`, imports `getFocusableElements` from
   `engine/overlays`, and `overlays.ts` has one `FOCUSABLE_SELECTOR` query.
10. **The shared helper keeps inert content.** Check: a scratch container (added
    to the document, removed afterwards) with a plain button and a button inside
    an `inert` wrapper; `getFocusableElements` returns only the plain button.
11. **Tab does not wrap past a collapsed last section.** A collapsed section body
    is `inert` and `aria-hidden` but its controls keep a layout box, so the old
    filter chose an inert control as the last stop. Check: open the sidebar,
    collapse the last settings section (real header click), confirm its body is
    inert and has controls, focus the helper's last stop, dispatch Tab on the
    sidebar; the event is default-prevented and focus lands on the first stop.
    The section is expanded again and the sidebar closed afterwards.
12. **Shift+Tab on the first stop stops wrapping.** Check: same sidebar state,
    Shift+Tab on the first stop lands on the helper's last stop, which is not
    inside an inert subtree.
13. **The overlay traps change behavior.** The licenses and modal traps use the
    same helper. Check: the dialogs spec rows C7-23 to C7-25 still pass (they run
    in the same gate); this spec asserts the licenses trap order still lists the
    close button before the frame.

**Native run note (row 11).** The first spec version asserted that the old
filter's last stop was inert. In the real window the last stop is the footer
`versionLink`, which sits after the last settings section, so the old filter did
not pick an inert control and that precondition failed. The old defect is not
reproduced in the real window. The precondition is dropped. The row now asserts
that no inert control is in the trap list while the last section is collapsed
(the old filter listed them; the count is recorded as `oldInertInList`), and
that Tab on the last stop wraps to the first and Shift+Tab on the first wraps to
the last.

## Async modal actions (F11, modal part)

14. **An async button action rejects unhandled.** The old code only caught
    synchronous throws. Check: a button whose action is an `async` function that
    throws; after the click, the page records no `unhandledrejection` event and
    the modal closes.
15. **An async `onDismiss` rejects unhandled.** Check: Escape on a modal whose
    `onDismiss` is an async function that throws; no `unhandledrejection` event
    and the modal closes.
16. **The modal is left stuck after a rejection.** Check: after rows 14 and 15 a
    queued second modal is shown, and `overlays.isModalActive` is true only for
    that second modal.
17. **A rejection is swallowed silently.** The catch must go through the existing
    `logError` path. Not asserted by content here: the spec does not wrap the
    shared `api` object. Static: `overlays.ts` calls `logError('Modal action
failed', ...)` for both the sync and the async path (source check).

## Licenses cleanup timer (F12)

18. **A pending cleanup removes the scroll lock after a reopen.** `hideLicenses`
    starts a 300 ms timer that clears `body.style.overflow` and the
    `licenses-open` class. Reopening inside that window left the overlay open
    with scrolling unlocked. Check: open, then hide and show in one task, wait
    (by a clock condition) until 450 ms have passed; the overlay is active,
    `body.style.overflow` is `hidden`, and `body` has `licenses-open`.
19. **The timer never runs after a normal close.** Check: after a plain close, the
    overflow and class are cleared once the timer has run (condition wait), and a
    later reopen locks scrolling again.
20. **Hide twice starts two timers.** Check: hide, show, hide in one task, then
    wait; the lock is cleared once and the overlay is closed.

## What WebDriver cannot prove (stated, not checked)

- Native Tab traversal. Rows 11 and 12 dispatch a synthetic Tab keydown and
  assert the handler's decision and `document.activeElement`.
- That the logged rejection text reaches the Rust log file (row 17 is static).
- Screen-reader announcements.
