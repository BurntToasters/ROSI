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

Commands return the same `{ ok, data } | { ok: false, error }` envelopes the v4
Electron IPC used, so the renderer contract is unchanged.

Persisted state lives in the Tauri app data directory for `run.rosie.rosi`
(`settings.json`, `download-queue.json`, `download-activity.json`,
`download-stats.json`, `logs/rosi.log`).

## Frontend (`src/`)

- `tauri-bridge.ts` implements the renderer API (`window.api`) on top of
  `invoke()` and Tauri events.
- `updater.ts` wraps `@tauri-apps/plugin-updater`. Stable checks use the default
  `latest-{target}-{arch}.json` endpoints; beta checks pass the
  `{os}-beta-{arch}-{installer}` target from `get_beta_updater_target`.
- `rosiEngine.ts` and `modules/*` are the renderer UI (unchanged from v4 apart
  from paths); `main.ts` loads the bridge first, then the engine.
- `public/` holds files served as-is: theme/splash init scripts, the licenses
  iframe, and generated license data.

## Sidecars and releases

`scripts/prepare-sidecars.js` verifies and stages the sidecars;
`src-tauri/build.rs` re-verifies them and rejects development stubs in release
builds. The release pipeline (`scripts/run-release.js`, `release-session.js`,
`gpg-sign.js`, `ensure-draft-release.cjs`, `verify-release-draft.js`,
`publish-release.cjs`) is shared with Zinnia; see [build-setup.md](build-setup.md).

The vendored `src-tauri/vendor/tauri-plugin-updater` carries install-safety
patches (see its README).

## Testing

- E2E (`npm run test:e2e`): WebdriverIO drives an unpackaged `--features e2e`
  build against a local media server, exercising real yt-dlp downloads, the
  queue, cancellation, and FFmpeg conversion, and writes an evidence report to
  `e2e/artifacts/`.
- Vitest + jsdom cover renderer contracts in `src/tests/`.
- `npm run test:all` is the full quality gate.
