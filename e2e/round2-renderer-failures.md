# Renderer round-two failure modes

These cases describe the failure paths to cover before changing production code.

- Cancelling a plugin update invalidates its result but does not abort its HTTP transfer. Releasing the renderer's single-flight lock early permits a second update transfer to overlap and accumulate buffers. The lock must stay held until the first promise settles; late attached bytes must still be closed.
- The selected update channel can change while an update is downloading or after it has downloaded. A beta identity must be retired when Stable becomes effective, and the effective target must be checked again immediately before installation.
- A same-target feed can return no update after bytes were already downloaded. The bytes and their `Update Ready` prompt must remain usable instead of being replaced by `Up to date`.
- Background feed errors should not interrupt the user with a modal. Manual feed errors and download/install errors must remain visible.
- Updater tests can observe an `available` event before its modal becomes visible. A previous dialog's hide animation must not hide the next updater dialog; close one dialog fully before triggering the next state and include the current modal title in timeout evidence.
- If Stable is selected while a beta transfer is active and the settings write
  has not committed, the beta identity must be retired immediately. Keep the
  transfer single-flight until it settles, then wait for the selected channel
  and recheck Stable before retaining bytes or installing.
- Clearing Activity can fail in the backend. Removing the legacy localStorage key before that result succeeds loses displayed history despite the failed clear.
- Activity migration may normalize JSON object key order while retaining the same records. Verify the parsed entries and their values, not their raw serialized key order.
- WebdriverIO serializes `browser.execute` callbacks without their Node-side lexical scope. Pass expected counters and IDs as explicit execute arguments so polling does not fail on an unresolved browser variable.
- `listen('prepare-for-close')` is asynchronous. Marking the renderer ready on `load` before that listener and startup settings are ready can expose a window whose close flush is not registered or uses unresolved defaults.
