# Architecture

ROSI is a [Tauri 2](https://tauri.app) app: a vanilla TypeScript + HTML + CSS
frontend driving a Rust backend that runs bundled yt-dlp and FFmpeg sidecars.

```
frontend (src/, TS)  ──invoke()──▶  Rust commands (src-tauri/src/)  ──spawn──▶  rosi-yt-dlp / rosi-ffmpeg
        ▲                                   │
        └────────── events ────────────────┘   (progress, job-progress, queue-update, …)
```

## Backend (`src-tauri/src/`)

`main.rs` is glue only (plugins, command registry, run-loop events). Logic is
split into focused modules:

| Module                | Responsibility                                                                     |
| --------------------- | ---------------------------------------------------------------------------------- |
| `validation.rs`       | Security boundary: URL safety (no private/loopback hosts), path allow-lists, IPC payloads |
| `settings.rs`         | Settings model, lenient migration/sanitization, import/export                      |
| `legacy.rs`           | First-launch import of ROSI 4 data from `<config dir>/rosi`                        |
| `downloader.rs`       | Single active download session: yt-dlp, optional FFmpeg conversion, cancellation   |
| `queue.rs`            | Persistent queue (`download-queue.json` + backup) and its sequential runner        |
| `command_builders.rs` | yt-dlp / FFmpeg argument builders and codec probing                                |
| `progress.rs`         | yt-dlp JSON / FFmpeg `-progress` parsing, phase and queue weighting, throttling    |
| `media_info.rs`       | Format listing (`-F`) and metadata previews                                        |
| `activity.rs`, `stats.rs` | Persisted download activity and lifetime statistics                             |
| `sidecars.rs`         | Sidecar location and effective FFmpeg resolution                                   |
| `process_util.rs`     | Scrubbed environment, process groups, tree termination, bounded output capture     |
| `platform.rs`         | Platform queries, beta updater target, OS handoffs (open URL, reveal, notify)      |
| `window.rs`           | Splash, deferred main-window reveal, close flow (confirm, settings flush), restart |
| `app_menu.rs`         | Native macOS menu                                                                  |
| `app_state.rs`        | Process-wide handles: app handle, resolved user directories, background event sink |
| `constants.rs`        | Limits and allow-lists shared by validation, settings, and the downloader          |
| `deno.rs`             | Deno runtime detection and optional install for yt-dlp's JavaScript extractors     |
| `ffmpeg_guard.rs`     | Per-operation FFmpeg/ffprobe launchers that restrict yt-dlp to local inputs        |
| `fs_util.rs`          | Atomic, private file writes and bounded reads for persisted JSON state             |
| `gpu.rs`              | Hardware encoder detection by probing FFmpeg (cached for five minutes)             |
| `ip_policy.rs`        | Shared destination rules for IP literals, used by URL pre-checks and the outbound proxy |
| `ipc.rs`              | `{ ok, data } \| { ok: false, error }` envelopes shared with the frontend           |
| `logging.rs`          | Rolling local diagnostics log (`logs/rosi.log`)                                    |
| `network_security.rs` | Per-operation outbound proxy that pins each destination to a vetted IP, optionally reached through the user's upstream HTTP proxy |
| `staging.rs`          | Startup sweep of stale ROSI scratch entries in the download folder (no symlink following) |
| `types.rs`            | Shared data model, serialized as camelCase to match the v4 bridge shapes          |

Commands return the same `{ ok, data } | { ok: false, error }` envelopes the v4
Electron IPC used, so the renderer contract is unchanged.

Persisted state lives in the Tauri app data directory for `run.rosie.rosi`
(`settings.json`, `download-queue.json`, `download-activity.json`,
`download-stats.json`, `logs/rosi.log`).

When that directory has no `settings.json`, `legacy.rs` looks for ROSI 4's
Electron `userData` folder (`%APPDATA%\rosi`, `~/Library/Application
Support/rosi`, or `$XDG_CONFIG_HOME/rosi`; also the Microsoft Store package
folder on Windows). It copies the queue, stats, and activity files, then
settings last, so an interrupted import retries on the next launch. The
normal loaders validate everything, and the result is recorded in
`legacy-v4-import.json`. ROSI 4's files are never modified.

## Frontend (`src/`)

- `commands.ts` is the typed map of the Rust commands the renderer calls, with
  argument and result types from `generated/ipc-types.ts`. It is the only place
  that calls `invoke()`; `src/tests/commands.contract.test.ts` checks its names
  against `src-tauri/build.rs` and the main window capability.
- `tauri-bridge.ts` implements the renderer API (`window.api`) on top of
  `commands.ts` and Tauri events. `window.api` stays the seam that the vitest
  DOM tests and the E2E specs drive.
- `updater.ts` wraps `@tauri-apps/plugin-updater`. Stable checks use the default
  `latest-{target}-{arch}.json` endpoints; beta checks pass the
  `{os}-beta-{arch}-{installer}` target from `get_beta_updater_target`.
- `main.ts` is the entry point. It imports the bridge first, then the renderer
  modules, then `rosiEngine.ts`. After the renderer reports startup readiness it
  calls `mark_main_window_ready`, which lets the backend close the splash.
- `rosiEngine.ts` is the renderer controller's startup: it loads settings,
  looks up the DOM, and calls the `engine/bind/*` functions in order, which bind
  each feature's controls and the backend events. It calls the same `window.api` contract the v4 Electron preload
  exposed, which `tauri-bridge.ts` implements.
- `engine/*` are ES modules split out of the controller by feature:
  `settings-store.ts` (settings state and serialized saves), `settings-view.ts`,
  `queue-controller.ts`, `manual-download.ts`, `preview-controller.ts`,
  `presets.ts`, `playlist.ts`, `url-actions.ts`, `formats.ts`, `overlays.ts`
  (modals and licenses), `updater-ui.ts`, `wizard.ts`, `deno.ts`, `theme.ts`,
  `progress.ts`, and shared helpers in `core.ts` and `ui-helpers.ts`. Startup
  DOM elements are registered in `refs.ts`; mutable state lives in one exported
  state object per module.
- `generated/ipc-types.ts` holds the IPC shapes (settings, queue items,
  completions, progress events). The `ts_bindings` test in
  `src-tauri/src/types.rs` renders it from the Rust types and fails when it is
  stale; refresh it with `ROSI_UPDATE_IPC_TYPES=1 cargo test ts_bindings`.
- `modules/*` are self-contained IIFE modules that attach to `window` and
  are loaded by `main.ts`. `ui.ts` holds toasts and shared UI helpers, `queue.ts`
  renders the queue, `dock.ts` the queue, activity, and console tabs,
  `downloads.ts` parses yt-dlp progress lines, `updates.ts` shows updater
  progress, `settings.ts` binds external links, and `icons.ts` swaps Lucide
  icon placeholders for SVG markup.
- `e2e-hook.ts` is compiled only into unpackaged E2E builds. Production
  bundles drop it.
- `public/` holds files served as-is: theme/splash init scripts, the licenses
  iframe, and generated license data.

## Sidecars and releases

`scripts/prepare-sidecars.js` verifies and stages the sidecars;
`src-tauri/build.rs` re-verifies them and rejects development stubs in release
builds. The release pipeline (`scripts/run-release.js`, `release-session.js`,
`gpg-sign.js`, `ensure-draft-release.cjs`, `verify-release-draft.js`,
`publish-release.cjs`) is shared with Zinnia; see [build-setup.md](build-setup.md).

The vendored `src-tauri/vendor/tauri-plugin-updater` carries install-safety
patches, documented in `src-tauri/vendor/tauri-plugin-updater/PATCHES.md`.

### Compact macOS updates

Fresh installs use the universal DMG/ZIP. In-app updates on macOS download a
per-arch `ROSI-{aarch64,x86_64}.app.tar.zst` instead of the universal
`ROSI.app.tar.gz` (141.5 MB to about 60 MB):

- `release:mac:continue` also runs `tauri build --target {aarch64,x86_64}-apple-darwin --bundles app`.
  `scripts/pack-macos-updater-zst.js` then repacks each per-arch `.app.tar.gz` with
  `zstd --long=27` and signs the result (`tauri signer sign --app-version`). The long
  window dedupes `rosi-ffmpeg` against `rosi-ffprobe`. The tar bytes are unchanged, so
  the bundle signature and staple survive.
- `scripts/gpg-sign.js` publishes them under `latest-darwin[-beta]-{arch}-app-zst.json`
  and never collects the per-arch builds' arch-less `.app.tar.gz`.
- Packaged macOS apps ask for that target (`get_compact_updater_target`). If the
  compact feed is missing they fall back to the universal feed, which stays published
  for clients older than 5.1.0.
- `rosi-yt-dlp` is upstream's universal2 binary and already compressed, so about
  36 MB of every update is yt-dlp.

Failure modes: `e2e/updater-zst.failure-modes.md`. Check: `npm run test:e2e:updater-zst`
(report in `e2e/artifacts/updater-zst-report.json`).

### macOS entitlements for sidecars (planned, not implemented)

Today `src-tauri/entitlements.plist` grants `disable-library-validation` and
`allow-unsigned-executable-memory` to the whole app. Tauri signs the app binary
and every externalBin sidecar (`rosi-yt-dlp`, `rosi-ffmpeg`, `rosi-ffprobe`)
with that one file. Only the PyInstaller `rosi-yt-dlp` needs the two exceptions.
`src-tauri/entitlements.sidecar.plist` already holds them and is not yet used.

Applying it is a release-pipeline change, not a one-file edit, because:

- `scripts/zip-macos.js` requires each sidecar's signed entitlements to equal
  the host `entitlements.plist`. It must check `rosi-yt-dlp` against
  `entitlements.sidecar.plist` and the others against the minimal host file.
- Re-signing after `tauri build` invalidates the updater `.app.tar.gz` and its
  `.sig`, the notarization staple, and the DMG built from the app.
- Re-signing after notarization breaks `xcrun stapler validate` and `spctl`.

Ordered plan (confirm each Tauri step with a dry run before changing the pipeline):

1. Run `tauri build` with the signing identity and hardened runtime, and with
   `APPLE_ID`/`APPLE_PASSWORD` unset, so Tauri signs but does not notarize.
   Confirm the `.app.tar.gz` and `.sig` are still produced; if not, plan to
   create them in step 4.
2. Re-sign inside out, with `--timestamp --options runtime` and no `--deep`:
   `codesign --force --entitlements src-tauri/entitlements.sidecar.plist --sign "$ID" Contents/MacOS/rosi-yt-dlp`,
   then `rosi-ffmpeg`, `rosi-ffprobe`, and `rosi` with `src-tauri/entitlements.plist`
   (minimal), then the `.app` with the same minimal file. Check with
   `codesign --verify --deep --strict`.
3. Notarize the re-signed app (`ditto -c -k --keepParent`, then
   `xcrun notarytool submit --wait`), then `xcrun stapler staple` the `.app`.
4. Regenerate the updater bundle from the stapled `.app` (same archive name and
   layout that `tauri build` produces), sign it with the Tauri updater key
   (`tauri signer sign`), and update the `signature` fields in the
   `latest-*.json` / beta manifests.
5. Rebuild the DMG from the stapled `.app` using the step the pipeline uses today.
6. Update `scripts/zip-macos.js` (entitlement expectations per sidecar) and
   insert steps 2 to 5 into `scripts/release-session.js` or `run-release.js`
   between `tauri build` and checksum/GPG signing in `scripts/gpg-sign.js`.
7. Regenerated artifacts to re-check before publish: the `.app`, `.app.tar.gz`,
   the per-arch bundles and their `.app.tar.zst` (repack after re-signing),
   `.sig`, the `latest-*.json` manifests, the DMG, the ZIP, checksums, and
   GPG signatures. `verify-release-draft.js` must pass on the final set.

Until steps 1 to 7 land together, keep `entitlements.plist` unchanged so the
release gate stays consistent.

## Deno end of life (planned risk)

yt-dlp uses Deno as its default JavaScript runtime for YouTube. Deno is
expected to shut down around October 2027 after its acquisition, and yt-dlp
has not chosen a replacement yet; follow
[yt-dlp#17799](https://github.com/yt-dlp/yt-dlp/issues/17799). ROSI's Deno
code is `src-tauri/src/deno.rs` (detection and winget/Homebrew install), the
Deno entries in `process_util::enhanced_path`, the startup reminder and the
setup wizard step in `rosiEngine.ts`. Keep new runtime work generic until
yt-dlp decides, and replace these pieces when it does.

The Flatpak sandbox cannot use a host Deno, so the Flatpak installs the
node24 SDK extension's Node.js at `/app/lib/rosi/js-runtime/node`.
`build_ytdlp_runtime_args()` in `command_builders.rs` adds
`--js-runtimes node:<path>` only in Flatpak when that file is a runnable
regular file. yt-dlp's other runtimes stay enabled, so this works the same
after Deno changes.

## Testing

- E2E (`npm run test:e2e`): WebdriverIO drives an unpackaged `--features e2e`
  build against a local media server, exercising real yt-dlp downloads, the
  queue, cancellation, and FFmpeg conversion, and writes an evidence report to
  `e2e/artifacts/`.
- Vitest + jsdom cover renderer contracts in `src/tests/`.
- `npm run test:all` is the full quality gate.

## Roadmap

- [ROADMAP-5.1.md](docs/ROADMAP-5.1.md) lists the deferred long-term work, with
  the problem, plan, and acceptance criteria for each item.
- [KEY-COMPROMISE.md](docs/KEY-COMPROMISE.md) inventories the release secrets
  and the response for each one if it leaks.
