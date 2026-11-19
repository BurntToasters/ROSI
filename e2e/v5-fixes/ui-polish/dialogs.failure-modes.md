# Dialogs: Escape, dismissal, update errors, licenses focus: failure modes

Written before the code changes (plan items B4, B5, B10, C7). Each row names a
way the fix could fail or regress and the check in `dialogs.spec.js` that must
catch it. Checks drive the real renderer (`overlays.showModal`, the real
`settingsStore.confirmInterruptActiveWork`, the real updater listeners) on the
built E2E binary. Modal objects come from `window.__ROSI_E2E__.modules`; the
hook must expose `overlays` (overlays.ts) and `settings` (settings-store.ts)
(see the spec header).

Test seams used, and what they do not prove:

- `window.__TAURI__.event.emit("updater-status", ...)` drives the real updater
  listener in `updater-ui.ts`. It does not prove the Rust updater emitted it.
- `download_update`, `install_update`, and `check_for_updates` are intercepted
  in the renderer command layer. `call()` in `src/commands.ts` checks
  `window.__ROSI_E2E_IPC_STUBS__` (E2E builds only) before `invoke`. A stub is a
  function that resolves with the command result or rejects with its error, so
  the renderer's own resolve and reject paths run. Other commands pass through to
  Rust. The earlier fetch and postMessage hooks are gone: WKWebView (macOS) sends
  Tauri invokes through `window.ipc.postMessage` and never through `fetch`, so
  those hooks never fired there. The Rust decision is not exercised by these rows (the
  backend "still stopping" refusal is covered by the updater-engine suite once
  the backend change lands). A stubbed row fails when the stub was not reached:
  rows B5-14 to B5-18 assert `calls`, and B5-19 asserts the stub's own message,
  which only the stub can produce. A bypassed stub therefore fails the row
  instead of letting the real backend answer.

## Run verdicts (full gate log fg-full1, background mode)

Evidence for the verdicts:

- Tauri 2.12.2 defines `window.__TAURI_INTERNALS__.invoke` with
  `Object.defineProperty(..., { value })` (`scripts/core.js:81`), so it is
  non-writable and non-configurable. The object itself is defined the same way
  (`src/manager/webview.rs:175`). The previous spec's assignment
  `internals.invoke = ...` silently did nothing, so no stub was reached and
  `calls` stayed empty.
- With no pending backend candidate, Rust `download_update` returns
  `DownloadOutcome::cancelled()` (`updater.rs` `begin_download`). The renderer
  correctly hides the banner and shows no error for that outcome, so the real
  backend answered the rejected, refused, and install rows.
- Real `check_for_updates` returns `null` when a check starts, so no refusal
  modal appears (B5-19).
- Native run 3 (dialogs trace, fg-run3): no request reached the `window.fetch`
  wrapper (`seen` empty for every row), and the native `postMessage` wrap did not
  take (`nativeWrapped` false). The backend still answered: B5-19 showed the
  backend "Development Mode" refusal, and download_update returned cancelled. So
  Tauri invokes use a native postMessage path that the fetch wrapper does not see.
  The earlier theory (fetch is the transport) was wrong for this build.
- The Tauri IPC script calls `window.ipc.postMessage` (wry), and on Windows that
  forwards to `window.chrome.webview.postMessage`. The probe tries each of these
  and accepts a hook only when reading it back shows the wrapper.

Verdicts:

- **B5-14 (rejected download shows Update Error): spec defect.** The stub never
  ran; the real `download_update(9101)` returned cancelled. `updater-ui.ts`
  lines 273-286 are correct. Fix: intercept the native IPC postMessage (see the seam note above).
- **B5-15 (refusal message shown): spec defect.** Same root cause; the real
  outcome was cancelled, not the refusal with its message.
- **B5-16 (one Update Error for status and result): spec defect.** Same root
  cause; `download_update` never reached the probe, so the result half of the
  scenario never ran. The status half is real. The dedupe in
  `showUpdateError` is correct and is not yet exercised.
- **B5-17 (cancelled shows no error): spec defect, weak check that passed by
  accident.** The stub was bypassed and the real backend returned cancelled, so
  the check passed without the renderer doing anything. Fix: hold the download,
  assert the banner is up while it is pending, then release the cancelled
  outcome and assert the banner is hidden and no Update Error appears.
- **B5-18 (install rejection shows Update Error): spec defect.** Same root cause;
  `install_update` never reached the stub.
- **B5-19 (check refusal shows message and ends spinner): spec defect.** Same
  root cause; the real check returned `null`, so the refusal modal never
  appeared.
- **C7-26 (Tab and Escape in the frame stay trapped): the earlier "not proven in
  background mode" verdict was wrong. The cause is a product defect in
  `overlays.ts`, the hidden-link filter.** C7-25 shows parent focus works. C7-27
  and C7-28 show the frame-document keydown listener is attached and reaches the
  forwarder (Escape closes). The earlier native runs (fg-full1, fg-retry2) read
  `frameHasFocus: false` and were read as a background-window limit. A native
  diagnostic on 2026-11-18 found the real cause: of 565 elements that pass the
  `offsetParent !== null` filter in the frame, 550 are links inside closed
  `<details>`. WebKit and Chromium give them a layout box, but `checkVisibility()`
  is false and `focus()` is refused. The computed last stop was therefore a hidden
  link, so Tab from the real last stop never wrapped to `close-licenses`. The same
  diagnostic showed visible frame links take focus with `document.hasFocus()`
  false (15 of 15), so the Tab half is asserted in background and foreground runs
  alike. The `!hasFocus` not-proven branch is removed. Fix: rows 35-37.

`updater-ui.ts` is unchanged. `overlays.ts` has the licenses-frame defect in rows
35-37; that is the only product defect in these verdicts.

Outside this spec: `e2e/v5-fixes/ui-polish/settings-reset.spec.js` (around
lines 220-232, `installChannelCallLog`) assigns `internals.invoke` the same way.
Its `readChannelCalls` assertions are likely to see an empty list. Its owner
should move it to the same `fetch` interception.
- Keyboard events on modals are dispatched with `KeyboardEvent` in the page.
  Synthetic events do not run the browser's default action (focus traversal,
  scrolling), so Tab rows assert the handler's decision and the resulting
  `document.activeElement`, not native Tab traversal.

## Escape and busy modals (B4a)

1. **Escape closes a busy modal.** "Installing Deno..." is busy; Escape must not
   hide it or drop its `aria-busy`. Check: show a busy modal, press Escape on
   the page and on the modal, wait 400 ms; the modal is still `.active` with
   `aria-busy="true"` and the title is unchanged.
2. **Busy guard blocks the wrong thing.** Escape ignored on a busy modal must not
   fall through to close an overlay underneath (sidebar, licenses). Check: a
   busy modal over an open sidebar; Escape leaves the modal open and the sidebar
   state unchanged (the handler returns after the modal branch).
3. **Busy guard removed too broadly.** A non-busy modal with OK must still close
   on Escape. Check: a plain OK modal closes on Escape and the next queued modal
   (if any) appears.

## Escape runs the dismissal action (B4b)

4. **Escape does not settle the interrupt confirm.** `confirmInterruptActiveWork`
   waits on a button that Escape never presses, so the promise never resolves
   and the restart or update install waits forever. Check: start a queue run,
   call `confirmInterruptActiveWork("Restarting ROSI")` through the module, press
   Escape on the confirm; the promise resolves `false` within 5 s.
5. **Dismissal resolves the wrong value.** Escape must resolve "keep current
   work" (`false`), never `true` (which would stop the download). Check: the
   same promise from row 4 resolves `false` and the queue item is still
   `downloading` afterwards.
6. **Backdrop or Escape runs `onDismiss` twice.** Escape pressed again during the
   200 ms fade must not call `onDismiss` again. Check: count `onDismiss` calls
   after two Escape presses 50 ms apart; count is 1.
7. **`onDismiss` runs for a button press.** A button press must run only its own
   `action`, not `onDismiss`. Check: a modal with both; press a button; the
   action count is 1 and the dismiss count is 0.
8. **Dismissal with no `onDismiss` throws.** Modals without the option must still
   close on Escape. Covered by row 3.

## Button action timing (B4c)

9. **Action runs after the fade and is dropped by a priority modal.** A priority
   modal shown inside the 200 ms hide window calls `cancelModalHide`, so an
   action scheduled for the fade never runs. Check: press a confirm button, then
   within 200 ms show a priority modal; the button's action ran exactly once.
   The check asserts the gap is under 200 ms (otherwise the check is
   inconclusive and fails, so a slow host cannot produce a false pass).
10. **Action runs twice on double click.** The guard in the button handler must
    still stop the second press. Check: two clicks on the same button within
    100 ms; the action count is 1.
11. **A throwing action leaves the modal stuck.** The hide timer is scheduled
    before the action runs, so a throw must not skip the teardown. Check: an
    action that throws; the modal is no longer `.active` after 500 ms and a
    following modal displays.
12. **A priority modal re-displays the closing modal.** The closing modal's data
    is already `null` at press time, so it must not come back as "displaced".
    Check: after row 9's priority modal is dismissed, the confirmed modal does
    not reappear (its title is absent from `#modal-title`).
13. **Action sees a still-active modal.** An action that opens a non-priority
    modal must queue it (not drop it). Check: a button whose action calls
    `showModal` (non-priority) shows that second modal after the first closes.

## Update errors (B5)

14. **Rejected `download_update` leaves the banner up.** A rejected invoke leaves
    `#update-banner` `.active` with `aria-busy="true"`. Check: stub
    `download_update` to reject; after the action, the banner is not `.active`,
    `aria-busy` is `false`, and `#modal-title` reads "Update Error".
15. **Refusal with an error message is silent.** Backend "still stopping" returns
    `{ success: false, cancelled: false, error }`; the old code hid the banner
    and showed nothing. Check: stub resolves that shape; the banner is hidden and
    "Update Error" shows the exact message text.
16. **Real failure shows two error modals.** A real download failure emits an
    `error` status (the status handler shows "Update Error") and also returns the
    same error outcome. Check: emit the status error and resolve the outcome with
    the same message; exactly one "Update Error" modal is visible or queued.
17. **Cancelled outcome shows an error.** `cancelled: true` must hide the banner
    and show no "Update Error" (the `cancelled` status owns that message). Check:
    stub resolves `{ cancelled: true }`; no "Update Error" appears.
18. **Install rejection leaves the banner or the spinner.** `install_update` from
    "Update Ready!" rejects. Check: stub `install_update` to reject after a
    `downloaded` status; "Update Error" shows and the banner is not `.active`.
19. **Check refusal with a message is not shown or keeps the spinner.**
    `check_for_updates` resolves `{ reason: "message", message }`. Check: the
    "Update Check Failed" modal shows the message and `#checkUpdateBtn` is not
    `aria-busy`/loading afterwards.

## Settings save helper (B10)

20. **Removing the first parameter breaks callers that pass `(true, true)`.**
    Many callers in files this change does not own pass two arguments. Keeping
    the position (named `_silent`, unused) keeps every caller compiling. Check:
    `npm run typecheck` passes (static, manager re-run after all waves).
21. **Immediate flush changes meaning.** `persistSettings(_, true)` must still
    schedule an immediate drain. Check: the existing settings suites cover
    restart and reset flushes; the dialog spec's interrupt "Stop and Continue"
    path is not run (it would restart the app), so this row is covered by
    existing suites, not this spec.
22. **A stale reference to `settingsSaveErrorShownAt` or `silent` survives.**
    Check: `rg` finds no reads of either name in `src/` (static).

## Licenses focus trap (C7)

23. **The frame is missing from the trap order.** Tab from the close button wraps
    to itself and the frame cannot be reached by keyboard. Check: the list from
    `getFocusableElements(#licenses-overlay)` contains `#licenses-frame` after the
    close button.
24. **Shift+Tab from the close button does not wrap to the frame.** Check: call
    the trap with Shift+Tab on the close button; `document.activeElement` is the
    frame element.
25. **Tab on the frame element does not wrap to close.** Check: focus the frame
    element, dispatch Tab (no shift) at the trap; `activeElement` is the close
    button.
26. **Focus inside the frame document leaks the trap.** Once focus is in the
    frame's own document (its links), key events do not reach the overlay
    listener. Tab from the last link would leave the overlay, and Escape would
    not close it. Check: the frame document is same-origin (`contentDocument`
    is present); focus its last link, dispatch Tab on it, `activeElement` is the
    close button; dispatch Escape in the frame document, the licenses overlay
    is no longer `.active`.
27. **Frame forwarder attached twice or after close.** The forwarder is attached
    on each open; it must not run its action after close. Check: open and close
    the licenses three times; Escape in the frame then closes the overlay and
    leaves no stray prompt. Focus restore is not checked by this row.
28. **Escape in the frame closes licenses under an app prompt.** The forwarder
    must be inert when licenses is not the top overlay; the prompt owns Escape. Check: with an app modal open, Escape in the
    frame document does nothing to the licenses state (the modal branch owns it).

## Licenses frame tab stops (C7-26b, added before the code change)

35. **A closed-`<details>` link is chosen as the last tab stop.** The old filter
    (`offsetParent !== null`) keeps links inside a closed `<details>`, because
    WebKit and Chromium give them a layout box. They are not focusable
    (`checkVisibility()` is false, `focus()` is refused), so Tab from the real
    last stop never wraps to the close button. Check: C7-26 asserts the frame's
    last real tab stop is not inside a closed `<details>`, and that Tab on it moves
    focus to `close-licenses`.
36. **A `<summary>` is missing from the tab order.** Each `<details>` is reached
    through its `<summary>`, which the old selector did not include, so the first
    or last real stop can be a different element and the wrap happens at the
    wrong edge. Check: C7-26b asserts Shift+Tab from the frame's first real stop
    (a `summary` when the first details is closed) wraps to `close-licenses`, and
    the helper includes `summary` elements that toggle a details. A `summary` inside
    a closed outer details is excluded by the same rule.
37. **The WebKit fallback (no `checkVisibility`) keeps hidden links or drops
    reachable ones.** Linux WebKitGTK versions without `checkVisibility` use the
    fallback: exclude elements inside a closed `<details>`, except its own direct
    `<summary>`. A fallback that excludes an element in an open details, or keeps
    a link in a closed one, gives the wrong edge. Check: the spec's
    `frameFocusables` uses `checkVisibility` on macOS, so the fallback branch is
    not run natively here. Static review: the fallback rule matches the
    `checkVisibility` result for open, closed, and nested details. The fallback
    is stated as unproven natively; no Linux WebKitGTK run is part of this change.

## IPC stub seam and macOS shortcut (added before the seam change)

29. **The stub seam is not reached on a platform.** A platform whose invoke
    skips `call()` would let the real backend answer, and the update rows would
    then see the real outcome (for example "cancelled") and pass or fail for the
    wrong reason. Check: B5-14 to B5-18 assert the command is in `calls` and
    B5-19 asserts the stub's own message, so a bypassed stub fails the row. The
    `trace` op reports whether the registry is the one installed on `window`.
    Static: `commands.contract.test.ts` (mode 4) fails if any other renderer file
    calls `invoke()`.
30. **The seam leaks into a production build.** The stub lookup must sit inside
    an `import.meta.env.VITE_ROSI_E2E === '1'` branch in `call()`, so Vite folds
    the test to `"" === '1'` and Rollup drops the branch and its helper. Check:
    `npx vite build` into a scratch directory, then grep the output for
    `__ROSI_E2E_IPC_STUBS__`; the grep must print nothing.
31. **A stale stub survives the probe teardown.** A stub left on the registry by
    a failed row would answer the next row's command. Check: `restore` deletes
    `window.__ROSI_E2E_IPC_STUBS__` and settles any held promise as cancelled. The
    `beforeEach` install then asserts the new registry is empty (`stubs` is `[]`
    in `trace`) before the row runs.
32. **The macOS shortcut modifier mismatch.** `shortcuts.ts` reads `metaKey` on
    macOS and `ctrlKey` elsewhere. A probe that always sends `ctrlKey` never
    opens the sidebar on macOS, so B4-2 fails at "sidebar did not open" before the
    busy prompt is tested. Check: B4-2 asserts the sidebar is open before Escape
    is pressed. The probe sends `metaKey` on macOS and `ctrlKey` elsewhere.
33. **The probe's platform test drifts from the app's.** A different platform test
    (for example `userAgent`) could pick another modifier than `isMac()` on some
    hosts. Check: the probe uses `navigator.platform.toLowerCase().includes("mac")`,
    the same expression as `isMac()` in `src/modules/ui.ts`. Code review of the two
    expressions.
34. **The DOM loader cannot evaluate `import.meta`, or evaluates it as E2E.**
    `e2e/renderer-dom-checks/load-renderer.cjs` transpiles `src` to CommonJS and
    evals it in jsdom, so the `import.meta.env` in `commands.ts` is a syntax error
    and `run.cjs` fails. A loader that fixes this by reporting `VITE_ROSI_E2E` as
    `"1"` would switch the stub seam on in the DOM checks. Check: the loader
    replaces `import.meta.env.KEY` only for the known keys, with the non-E2E
    values (`VITE_ROSI_E2E` is `""`, `VITE_ROSI_CHANNEL` is `""`). An unknown KEY,
    or any `import.meta` left after that replacement, throws and names the file.
    `node e2e/renderer-dom-checks/run.cjs` passes.

## What WebDriver cannot prove (stated, not checked)

- Native Tab traversal: the browser moves focus into the iframe and out of its
  document. The check asserts the handler's decisions, not that the browser
  followed them.
- Keyboard scrolling of the licenses text (arrow keys inside the frame).
- Screen-reader announcement of the frame title or the modal change.
- Behavior on Microsoft Store and Flatpak builds (no change there).

## Final native result (run fg-run4, ROSI_E2E_ONLY=v5-fixes/ui-polish/dialogs.spec.js)

- Cause of the B5 failures: Tauri invokes travel over the native postMessage
  path on Windows. The probe now hooks window.ipc.postMessage (else
  window.chrome.webview.postMessage) and settles stubs through runCallback. The
  fetch hook remains for the custom-protocol path (macOS and Linux). With the
  hook, B5-14 to B5-19 pass, and each reached its stub (calls assertions).
- B5-17 was a vacuous pass before (the real backend answered); it now holds the
  download and asserts the banner is up while pending.
- C7-26 is recorded as not-proven (status "not-proven", invariantPassed null)
  on background runs, because document.hasFocus() is false. Superseded: see the
  C7-26 verdict above (hidden-link filter, rows 35-37). This historical result is
  kept as recorded.
- Spec result: 23 passed, 0 failed, 1 not-proven (C7-26). Report
  e2e/artifacts/v5-fixes-ui-polish/2026-11-13T07-45-43-258Z-dialogs-53720/report.json.
