# Flatpak update notice: failure modes (written before the changes)

Goal: a Flatpak build checks the feed like other builds, and when a newer
version exists it shows a manual-install prompt that opens the GitHub release
page. Download and install never run in Flatpak.

## Feed check in Flatpak

F1. `check()` with no target on a `--no-bundle` Linux binary: the vendored
plugin uses `tauri::utils::platform::bundle_type()`, which is `None` here
(the bundle type placeholder is never patched). The target list becomes
`linux-x86_64` only. The stable manifest `latest-linux-x86_64.json` has that
key, so the check succeeds. If the key were missing, `check()` would throw
`TargetsNotFound` and surface as a feed error (not silent).
F2. Beta channel: `get_beta_updater_target` returns `linux-beta-x86_64` (no
installer suffix because bundle type is `None`). The explicit target is used
as the manifest key. Covered by the existing manifest list in
`scripts/gpg-sign.js`.
F3. Feed returns a newer version but the manifest has no entry for the picked
key: `check()` throws, reported as a feed error. Same as other builds.
F4. `is_flatpak` invoke fails: the check reports a feed error and emits nothing
to the UI besides the existing error path.
F5. Channel changed while the Flatpak check is in flight: the existing
generation fence in `checkForUpdates` discards the stale result.
F6. Dev mode (`is_packaged` false) in Flatpak: the dev-mode error returns before
the Flatpak branch, as before.

## Prompt behavior

P1. No newer version: emits `not-available`. A manual check shows "up to date",
a startup check is silent. Same as other builds.
P2. Newer version in Flatpak: `available` carries `manualInstall: true`. The
modal offers "Open Release Page" (primary) and "Later". No "Download &
Install" button is shown.
P3. "Open Release Page" calls `window.api.openExternal` with exactly
`https://github.com/BurntToasters/ROSI/releases/tag/v<version>`.
P4. The release URL is built from the feed version with `encodeURIComponent`,
so a version string cannot change the host or path. Semver versions
encode unchanged.
P5. `openExternal` rejects the URL (Rust validation): the error is logged and
the modal closes. The prompt must not crash or re-show.
P6. Stale candidate: the candidate id changed before the button is clicked; the
action does nothing (same guard as the download button).
P7. Startup check in Flatpak (`checkUpdatesOnStartup` true): the prompt is not
priority, as for other builds.
P8. Manual check in Flatpak with an available update: the prompt is priority,
as for other builds.

## Refusals

R1. `downloadUpdate` in Flatpak, even with a candidate present: returns
`{ error }`; `update.download` is never called.
R2. `installUpdate` in Flatpak: returns without calling `update.install` or the
`restart_app` command, and emits an install error.
R3. Download button not rendered in Flatpak (so the UI cannot reach R1 in
normal use).

## Non-Flatpak and msstore (must not change)

N1. Non-Flatpak `available` with `manualInstall: false` shows the existing
"Download & Install" and "Later" buttons, and clicking it calls
`download`.
N2. The `downloaded` and install path is unchanged in non-Flatpak builds.
N3. msstore channel: `checkForUpdates` in the UI returns at the store modal
before any updater call. Unchanged.
N4. Existing jsdom tests in `src/tests/updater-races.test.ts` use
`is_flatpak` false and assert on `available` via `toMatchObject`, so an
extra field does not break them.

## E2E spec risks

E1. The E2E adapter (`window.__ROSI_E2E__.updaterAdapter`) is only read when
`VITE_ROSI_E2E === '1'`. Without it the spec would hit the real feed. The
spec asserts the adapter is installed before it clicks the check button.
E2. Startup check race: the profile sets `checkUpdatesOnStartup: false`, so no
startup check races the spec's prompt.
E3. `openExternal` is replaced by a recorder, so no real browser opens. Every
scenario reloads the renderer, which drops the replacement before the next
scenario starts.
E4. Modal text can match leftover modals. Each scenario reloads the renderer so
the updater module state starts clean.
E5. The mock `check()` does not run the real plugin target logic (F1, F2). The
spec records the target it receives, which confirms the channel logic, but
not the plugin's manifest lookup. The real Flatpak feed check must be
confirmed on a Flatpak build (assumption for the E2E run).
E6. Evidence goes to a timestamped directory under
`e2e/artifacts/v5-fixes-flatpak-updates/`, with a JSON report and a
screenshot. The directory is new per run, so earlier runs are kept.
