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
