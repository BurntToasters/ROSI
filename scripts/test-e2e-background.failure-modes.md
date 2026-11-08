# E2E background mode: failure modes

`scripts/test-e2e.js` sets `ROSI_E2E_BACKGROUND=1` for local macOS runs so the
E2E app never takes focus and its window stays below other apps
(`src-tauri/src/window.rs` `e2e_background`, `main.rs` activation policy).

1. CI runs in background mode. CI must keep the normal foreground behavior,
   because hosted runners have no user to disturb and evidence must match the
   shipped window behavior.
2. A maintainer cannot opt out. `ROSI_E2E_FOREGROUND=1` must disable background
   mode even on a local Mac.
3. An explicit `ROSI_E2E_BACKGROUND` value is overwritten. A value the caller
   set (`1` or `0`) must win over the default.
4. Windows or Linux runs get the flag. Only macOS implements the mode; Linux
   already has the Xvfb path, and Windows is unchanged.
5. `CI` set to an empty string is treated as CI. An empty `CI` means not CI.
6. `CI=false` or `CI=0` is treated as CI. Those values mean not CI.
7. The flag reaches only the WebdriverIO passes. It must be in the gate's own
   environment before any app launch, so runner-owned areas (`run.mjs`),
   process-repair runners and probes inherit it too.
8. Background mode changes what the specs observe. Hidden or occluded windows
   can pause rendering. The E2E build disables WebKit background throttling,
   and any spec that still depends on focus must be reported, not skipped.
9. Native alert dialogs still appear. Some specs open native warning dialogs on
   purpose; background mode cannot hide those. This is documented, not a bug.
10. The release build gets the behavior. All Rust changes are behind the `e2e`
    Cargo feature, which production builds never enable.
11. A hidden page freezes frames and transitions. With the window behind other
    apps, WebKit reports the page occluded: `document.visibilityState` is
    `hidden`, requestAnimationFrame never fires and CSS transitions stop. The
    background-mode fix turns WebKit's window occlusion detection off for the
    main webview, so the page stays `visible`. The probe in the change record
    checks `visibilityState`, rAF ticks and transition progress before and after.
    If a future WebKit still reports `hidden`, specs that wait on frames time
    out again (see the ui-polish sidebar workaround in T7).
12. The private selector is missing on some macOS or WebKit version. The setter
    is private (`_setWindowOcclusionDetectionEnabled:`). The code checks
    `respondsToSelector:` first and logs a warning when the selector is absent,
    so the call is skipped. The window then behaves as before (no crash); the
    background specs may show the T7 to T9 symptoms again, and the macOS
    default must not change on that basis alone.
13. The selector is sent off the main thread. WKWebView must be touched on the
    main thread. The code reaches the view only through `WebviewWindow::with_webview`,
    which runs its closure on the main thread, and it is called from `build_main`
    (the main thread). The Objective-C runtime is never called from a spawned thread.
14. The webview does not exist yet, or no longer exists. The call runs after
    `build()` returns. `with_webview` runs its closure only while the webview is
    still alive when the main-thread message is processed. A main window that is
    closed and rebuilt goes through `build_main` again, so it gets its own call.
    The splash window is always on top and only exists in packaged builds, so
    it is not covered and does not need the call.
15. The window becomes visible or takes focus as a side effect. The change only
    sets one WebKit flag. It does not call `show`, `set_focus`, or change the
    window level, and `set_always_on_bottom` and the Accessory activation policy
    stay in place. The probe records `document.hasFocus()` after the change.
16. The setter is accepted but `visibilityState` stays `hidden`. The change does
    not claim the fix works from the call alone. If the probe shows no change,
    the work stops and reports this, and the macOS default is left for the
    manager to decide.
