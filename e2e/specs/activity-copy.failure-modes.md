# Activity copy failure modes

Written before the change to the "runs each Activity row action" scenario in
`e2e/specs/main.spec.js`. No main-suite failure-mode file covered Activity row
actions, so this file holds them. Each row names a way the Copy source check
could fail or regress, and the assertion that must be able to fail for it.

The product path is `src/modules/activity.ts` (Copy source calls `copyText`, then
shows "Source link copied." or "Could not copy the source link.") -> `copyText`
in `src/modules/clipboard.ts`: `navigator.clipboard.writeText` first, then a
hidden textarea with `document.execCommand('copy')`. WebView2 refuses both routes
while the document lacks focus. In background mode on Windows the window is shown
without activation, so `document.hasFocus()` is false.

The scenario checks `document.hasFocus()` before the click and picks a route:

- `clipboardRoute: "real"` when the page has focus (foreground runs,
  `ROSI_E2E_FOREGROUND=1`). The real clipboard is written and read back from the
  OS.
- `clipboardRoute: "recorded-unfocused"` when it does not (background mode).
  `navigator.clipboard.writeText` is replaced for this one click only with a
  recorder that stores the text and resolves. The real clipboard is not used.

Rows:

1. **Copy is refused because the page is unfocused.** This must not happen on the
   recorded route, because the recorder replaces the refusing call. On the real
   route the check fails with the toast text in the message. Nothing in the
   scenario changes product behavior or the toast.
2. **The recorder hides a product failure that only happens with the real
   clipboard.** The recorder proves the product passes the right text to
   `writeText`. It does not prove the OS clipboard receives it, nor that the
   fallback path works. The real route is proven only in foreground runs. The
   report must show `clipboardRoute`, so a background pass is never read as a
   real-clipboard pass.
3. **The product passes the wrong text.** The recorded text must equal the row's
   `target.url` (the source URL read from the activity log). A different value
   fails the check.
4. **The product never calls the clipboard.** If the product shows success
   without calling `writeText` (or uses only the fallback), the recorder list is
   empty. The check must fail on an empty list, not pass on a toast alone.
5. **The product shows the failure toast.** The success toast must be
   "Source link copied." and no toast may match `/could not copy/i`. A failure
   toast fails the check even if the recorder captured the text.
6. **The recorder leaks into later scenarios.** The original `writeText` (own
   property or prototype) must be restored in a `finally` block, whether the
   click passed or failed. A later scenario must see the original function.
7. **Focus detection is wrong.** If `document.hasFocus()` reports true on a
   background run, the real route runs and fails with the toast text. If it
   reports false on a foreground run, the recorder replaces a working clipboard
   and the real route is not tested. The report records `hasFocus` and
   `clipboardRoute`, so the mismatch is visible.
8. **Stale clipboard text passes the real route.** On the real route, a sentinel
   is written to the OS clipboard before the click. After the click the spec
   reads it back (PowerShell `Get-Clipboard` on Windows, `pbpaste` on macOS). The
   check fails if the text still equals the sentinel, is empty, or differs from
   `target.url`. A read-back that cannot run on Windows or macOS fails the check.
   Platforms without an entry in `OS_CLIPBOARD_TOOLS` (Linux) have no read-back,
   and the report leaves `clipboardOsText` null.
