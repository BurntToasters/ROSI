# E2E background mode: failure modes

`scripts/test-e2e.js` sets `ROSI_E2E_BACKGROUND=1` for local macOS and Windows
runs so the E2E app never takes focus and its window stays below other apps
(`src-tauri/src/window.rs` `e2e_background` and `reveal`, `main.rs` activation
policy on macOS).

1. CI runs in background mode. CI must keep the normal foreground behavior,
   because hosted runners have no user to disturb and evidence must match the
   shipped window behavior.
2. A maintainer cannot opt out. `ROSI_E2E_FOREGROUND=1` must disable background
   mode even on a local Mac.
3. An explicit `ROSI_E2E_BACKGROUND` value is overwritten. A value the caller
   set (`1` or `0`) must win over the default.
4. Linux runs do not get the flag; macOS and Windows local runs do. Linux keeps
   its Xvfb path and has no background implementation, so `e2eBackgroundValue`
   returns null there. macOS hides the window through its window level and
   WebKit. Windows reveals the window without activation (rows 17 to 27 and 35).
   A Windows or macOS run with CI or `ROSI_E2E_FOREGROUND=1` keeps the old
   foreground path.
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

Windows rows. The Windows reveal is `e2e_windows::reveal_without_activation`
in `window.rs`. tao references are to tao 0.37.1 under the Cargo registry.

17. The window activates when revealed. tao's own `show` (`set_visible(true)`)
    calls `ShowWindow(SW_SHOW)`, which activates. tao removes its no-activate
    marker (`MARKER_DONT_FOCUS`) at the end of window creation (`window.rs`
    1415-1420), so the no-activate branch in `window_state.rs` 457-468 is never
    taken for a window created hidden. The reveal calls
    `ShowWindow(SW_SHOWNOACTIVATE)` and never calls `set_focus`, tao `show`, or
    `unminimize`. Probe: the foreground window handle is the same before and
    after the launch, and the focus monitor records no ROSI activation.
18. The window appears above other windows. `ShowWindow` can place a newly shown
    window at the top of the z-order. The reveal moves the window to
    `HWND_BOTTOM` while it is still hidden, shows it without activation, and
    moves it to `HWND_BOTTOM` again. Probe: after the reveal the window is below
    the foreground window in the z-order, and the foreground window is unchanged.
19. A later tao flag change shows the window with `SW_SHOW` and activates it. In
    tao's `apply_diff`, when the VISIBLE flag is set and any other flag changes,
    tao calls `ShowWindow(SW_SHOW)` (`window_state.rs` 457-468). Setting tao's
    VISIBLE flag would therefore make every later tao setter activate the
    window. The background path never sets VISIBLE and never calls tao's
    `set_always_on_bottom`, which goes through `apply_diff`. Probe: the focus
    monitor during specs that call tao setters.
20. A later tao flag change hides the window. While VISIBLE is clear, tao's
    `apply_diff` calls `ShowWindow(SW_HIDE)` on any flag change
    (`window_state.rs` 406). A tao setter that runs after the Windows reveal
    (a Window-menu minimize, a fullscreen or maximize toggle, `unminimize` from
    a minimized state) would hide the window, and the page would stop
    rendering. The background path makes no such calls after the reveal. Specs
    use `setSize` and `setPosition`, which do not change tao flags. Residual:
    user-driven menu actions can hide the window. A spec that checks visibility
    then fails loudly and is not a silent pass.
21. `is_visible` reported to specs disagrees with the real window. Tauri's
    `is_visible` calls tao's `is_visible`, which reads `IsWindowVisible`
    (`util.rs` 203) and not tao's VISIBLE flag. It reports true after the reveal.
    tao's VISIBLE flag is used only for tao's `set_focus` gating and
    `apply_diff`, and it stays clear by design. Probe: `is_visible` equals
    `IsWindowVisible` for the main window.
22. The window never becomes visible to WebView2, or stays at zero size, so the
    page stops rendering. The WebView2 child window follows the parent's show
    state. The WebView2 controller's visibility comes from the webview's own
    `visible` attribute (wry `webview2/mod.rs` 619), which Tauri leaves true,
    not from the window. The reveal does not change the size, and
    `fit_to_work_area` sizes the window before the reveal. Probe:
    `document.visibilityState` is `visible` and requestAnimationFrame advances
    after the reveal. If `hwnd()` fails, the reveal logs a warning and returns.
    The window then stays hidden, the ready wait times out, and the run fails
    loudly.
23. WebView2 reports the covered window as occluded. Chromium-based WebView2 can
    mark a window that other windows fully cover as hidden, which stops
    animation frames. The e2e build sets `background_throttling(Disabled)`, but
    wry implements that policy only for WKWebView (`wry` `lib.rs` 2598 and
    `wkwebview/mod.rs` 525), so it has no effect on Windows. This change does not
    address occlusion. Probe: the row 22 visibility and frame check with the
    window at the bottom and covered. If it fails, the fix is an e2e-only
    WebView2 browser argument, which is a separate change.
24. `unminimize` activates the window. In tao, `set_minimized(false)` with the
    MINIMIZED flag set calls `ShowWindow(SW_RESTORE)`, which activates, and then
    `ShowWindow(SW_HIDE)` because VISIBLE is clear. The Windows reveal does not
    call tao's `unminimize`. It uses `SW_SHOWNOACTIVATE`, which should restore a
    minimized window without activating it. Probe: a minimized window restored
    by the reveal is restored and not activated. tao's MINIMIZED flag can stay
    stale after a Win32 restore. Only later tao minimize or restore calls read
    it, and the background path makes none.
25. `show_main_window` activates the window. The second-instance callback
    (`main.rs` 226), the reopen event (`main.rs` 341), and the 15-second
    fallback all call `reveal`, so they share the background path. The only
    `set_focus` on this path is on the splash, which exists only in packaged
    builds. Probe: a second launch during an E2E run leaves focus unchanged.
26. A size or position change after the reveal activates the window. tao's
    `set_inner_size` uses `SetWindowPos` with `SWP_NOACTIVATE` (tao `util.rs`
    114), and `set_outer_position` does too (tao `window.rs` 212). The specs'
    `setSize` calls (`e2e/specs/main.spec.js` 323, 2218, 2230) therefore do not
    activate the window. Probe: the focus monitor during those specs.
27. Native dialogs that specs open on purpose still take focus. A parented
    message dialog (close confirmation, forced-close, save-pending) is shown
    and activated by the OS. Documented, not fixed; same as row 9.
28. The Windows code reaches release builds. The reveal is compiled only with
    `feature = "e2e"` and `target_os = "windows"`. The `windows-sys` feature
    `Win32_UI_WindowsAndMessaging` is enabled for every build, but only code
    behind `feature = "e2e"` uses it, so the release binary is unchanged.
29. CI or foreground runs change behavior. With CI set to a non-empty value other
    than `false` or `0`, or with `ROSI_E2E_FOREGROUND=1`, `e2eBackgroundValue`
    returns null. The variable is then unset, `e2e_background()` returns false,
    and `reveal` runs the original `unminimize`, `show`, and `set_focus` path.
    Probe: the Node tests cover the value; the Rust path is unchanged when the
    variable is absent.
30. The variable does not reach Windows child processes. The gate sets
    `process.env.ROSI_E2E_BACKGROUND` before any launch (`scripts/test-e2e.js`
    256). `e2eChildEnv` copies the environment to every spawn, and the Windows
    `cmd` wrapper (`usesWindowsCmdShell`) inherits it. Probe: the WebdriverIO
    and runner logs show the value; the gate report does not record it.
31. The taskbar button appears. A window shown without activation still gets a
    ROSI taskbar button, and the button does not flash. This is not focus.
    Documented, not fixed.
32. The `.focused(!e2e_background())` builder argument has no effect on Windows.
    tao removes its no-activate marker after creation, so a hidden window ignores
    `focused`. The reveal path is the only thing that prevents activation on
    Windows. The argument stays because it still applies on macOS.
33. The gate's config check passes but the window still activates. The Node test
    checks only the environment default. Activation, z-order, visibility, and
    rendering are proven only by the manager's focus-monitor E2E run.
34. A rebuilt main window is revealed with activation. `show_main_window` builds
    the window again after it was closed, and the reveal runs again on that
    window. The background check lives in `reveal`, which every path uses, so a
    rebuilt window gets the same non-activating reveal. Probe: the focus monitor
    during any spec that closes and reopens the main window.
35. `hwnd()` fails, or the reveal runs on a window that was destroyed. Tauri
    returns an error only when the window is gone. The reveal logs a warning and
    returns. Nothing is shown, and the run fails at the ready wait (row 22), not
    silently.
