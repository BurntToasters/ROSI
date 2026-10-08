# Platform fixes: failure modes (written before the changes)

## Finding 14a: entitlements split (main app vs rosi-yt-dlp)

Decision: NOT implemented in the release pipeline. `entitlements.sidecar.plist` is
created with the two exceptions; `entitlements.plist` stays unchanged. Reasons
listed below are why a partial change is unsafe.

1. Changing `entitlements.plist` to minimal alone, without re-signing the
   sidecars, leaves `rosi-yt-dlp` (PyInstaller) signed without library
   validation exemption. It fails at launch with Team ID mismatch errors.
2. Re-signing the sidecar and then the `.app` after `tauri build` invalidates
   the updater `.tar.gz` and its minisign `.sig`. They must be regenerated from
   the re-signed `.app`, which means reimplementing part of the Tauri bundler.
3. Re-signing after notarization invalidates the notarization ticket and the
   staple. `scripts/zip-macos.js` runs `xcrun stapler validate` and `spctl`, so
   it fails. Re-signing must happen before notarization, which is inside
   `tauri build` when `APPLE_ID`/`APPLE_PASSWORD` are set. Splitting the build
   would require the pipeline to stop using `tauri build` notarization.
4. `scripts/zip-macos.js` (not owned here) asserts that every sidecar's signed
   entitlements deep-equal the host `entitlements.plist`. Any split makes that
   check fail, so it must change in the same commit as the signing step.
5. The DMG is built from the notarized `.app`, so it must be rebuilt after any
   re-sign. A stale DMG would carry the old signature.
6. A minimal main-app entitlement set with `hardenedRuntime: true` may still
   need `com.apple.security.cs.allow-jit` or others for WebKit. Those are not
   verified here and would need a signed-app test on hardware.

## Finding 14b: drop macos-private-api (splash transparency)

1. Removing `transparent(...)` from the splash builder: Tauri defaults to an
   opaque window, so the splash turns opaque. If the splash body background is
   not opaque, the window shows a white or black frame at startup. Mitigation:
   the splash html and body get a solid `--bg-gradient-mid` background.
2. Light/dark: `--bg-gradient-mid` is defined per theme in `01-base.css`. If
   `theme-init.js` does not set `data-theme` before paint, the splash may show
   the wrong solid color. This is the same risk as before the change, but now
   visible without transparency.
3. Removing the `macos-private-api` feature while `macOSPrivateApi` stays set:
   `tauri build` refuses the mismatch. Both must be removed together.
4. Some other source might use a private-API-only call (`set_background_color`,
   `transparent` on the main window, `titleBarStyle` overlay). A grep found none
   under `src-tauri/src`, but `cargo check` must confirm it.
5. The `e2e` feature (`tauri-plugin-wdio`) or the vendored updater plugin might
   require the feature. `cargo check --features e2e` and the default build must
   both pass.
6. The main window config in `tauri.conf.json` has no `transparent` key, so it
   is unaffected.
7. Linux: the old code forced `transparent(false)` on Linux. Removing the
   builder call makes all platforms opaque, which matches Linux behaviour.

## Finding 13: documentation

1. A stale backend module table hides modules that exist in `src-tauri/src`.
   Mitigation: list `src-tauri/src` at the end and add every module.
2. Other agents may add modules after this list is taken. Mitigation: re-list
   before reporting.
3. The frontend paragraph is wrong. Mitigation: read `src/main.ts`,
   `src/tauri-bridge.ts`, and `src/modules` before rewriting it.
4. The PATCHES.md file may not exist yet (another agent writes it). The link
   must point to the real path `src-tauri/vendor/tauri-plugin-updater/PATCHES.md`
   and be checked for existence at the end.
5. The dead `docs/FIXES-V5-AUDIT-2026-10-07.md` reference must be removed. The
   check is `grep` for the path, which must return nothing.
6. The evidence statement must match `.github/workflows/ci.yml` (`e2e-*`
   artifact name and `e2e/artifacts` path). Mitigation: grep before writing.
