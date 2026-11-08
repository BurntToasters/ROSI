# Critical Information - Do not modify this section, other sections below may be modified

- NEVER write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- If you must test a system in isolation, FIRST write all the ways it could fail, THEN write the code.
- Do not add agents as co-authors to commits.

# ROSI

ROSI is a desktop GUI for yt-dlp, built with Tauri 2, Rust, and plain TypeScript/Vite. It supports macOS, Windows, and Linux. Downloads use bundled yt-dlp, FFmpeg, and ffprobe sidecars. The renderer uses DOM modules, not a component framework.

## Start here

- Read `package.json` for runnable workflows, `rust-toolchain.toml` for the pinned Rust toolchain, and `src-tauri/tauri.conf.json` for application and bundle configuration.
- `npm run tauri:dev` starts the native app with the Vite development server. It also synchronizes version metadata, generates license notices, and prepares sidecars.
- `npm run dev` and `npm run build` serve/build the frontend only. They do not prove native behavior.
- `npm run workspace:bootstrap` installs/prepares the toolchain, dependencies, and sidecars; inspect its steps before running it in an existing workspace.
- Preserve existing staged, unstaged, and untracked work. Do not commit or push unless requested.

## Application map

Paths in the next two tables are relative to their named source directory.

### Frontend: `src/`

| Area | Entry points and ownership |
| --- | --- |
| Startup and windows | `index.html`, `main.ts`, and `rosiEngine.ts` load the API, icons, bindings, settings, and readiness handshake. `splash.html` and `splash.ts` own the splash renderer. |
| IPC boundary | `api.ts` exposes the shared renderer API and event subscriptions. `commands.ts` defines typed Rust command calls. `generated/ipc-types.ts` contains generated Rust payload types. |
| Event bindings | `engine/bind/` connects DOM controls and backend events to feature behavior: downloads, queue, settings, activity, presets, playlist, URL input, shortcuts, and app shell. |
| Downloads and media | `engine/manual-download.ts`, `progress.ts`, `preview.ts`, `preview-controller.ts`, `formats.ts`, `playlist.ts`, `presets.ts`, and `url-actions.ts` coordinate requests and visible state. |
| Settings and onboarding | `engine/settings-store.ts` owns revisions and serialized saves; `settings-view.ts` applies settings to the UI. `wizard.ts`, `theme.ts`, and `deno.ts` handle onboarding, appearance, and Deno setup. |
| Queue and updates | `engine/queue-controller.ts` coordinates queue UI/actions. `engine/updater-ui.ts` owns update interactions and listeners. |
| Shared UI | `engine/refs.ts`, `core.ts`, `constants.ts`, `messages.ts`, `overlays.ts`, and `ui-helpers.ts` provide DOM references, common types, messages, dialogs, and helpers. |
| Rendering modules | `modules/` contains activity, dock, queue, downloads, settings, icons, UI, and update presentation helpers. |
| Styling and assets | `css/` separates base, sidebar, main, panels, overlays, responsive, queue, wizard, controls, and splash styles. `fonts/` contains bundled fonts. |
| Test bridge | `e2e-hook.ts` exposes the real renderer API/modules for E2E builds. `tests/` holds existing frontend contracts and DOM checks. |

### Native backend: `src-tauri/src/`

| Area | Entry points and ownership |
| --- | --- |
| Application setup | `main.rs` registers commands/plugins and initializes native services. `app_state.rs` resolves app/user directories and provides the shared event sink. |
| Window lifecycle | `window.rs` owns readiness, close/flush, and restart behavior. `app_menu.rs`, `platform.rs`, and `notices.rs` handle menus, OS operations, and native notices. |
| Command contracts | `ipc.rs` defines command inputs/errors; `types.rs` defines shared payloads; `constants.rs` holds common limits/default versions. |
| Download sessions | `downloader.rs` coordinates execution; `downloader/session_owner.rs` serializes session ownership; `conversion.rs` and `publication.rs` in that directory handle conversion and final output publication. |
| Queue ownership | `coordinator.rs` owns queue transitions and routes terminal session results. `queue.rs` handles queue commands, persistence, and the runner. |
| Media execution | `download_options.rs` resolves request/preset options, `command_builders.rs` builds tool arguments, `media_info.rs` fetches formats/metadata, and `progress.rs` reports structured progress. |
| Processes and files | `process_util.rs` manages child processes/termination. `sidecars.rs` resolves tools; `ffmpeg_guard.rs` guards media-tool execution; `staging.rs` reserves staging/output paths; `fs_util.rs` provides persistence helpers. |
| Network boundary | `validation.rs` checks URLs/paths, `ip_policy.rs` defines destination policy, and `network_security.rs` with `network_security_async.rs` handles vetted connections, proxies, and cancellation. |
| Durable state | `settings.rs`, `activity.rs`, `stats.rs`, and `legacy.rs` own settings, download history/statistics, and legacy migration. |
| Updates and dependencies | `updater.rs` manages update state/download/install. `deno.rs` and `gpu.rs` handle Deno and encoder detection. `logging.rs` owns logs and panic reporting. |

### Supporting directories

- `src-tauri/build.rs`: build-time command/ACL setup and sidecar validation. `capabilities/` and `permissions/` define Tauri access boundaries; `gen/schemas/` contains generated schemas.
- `src-tauri/vendor/`: vendored native dependencies, including the updater plugin. Inspect local patches before changing dependency behavior.
- `assets/`: yt-dlp assets, checksums, and notices. `resources/ffmpeg/`: FFmpeg distributions, checksums, licenses, and source offers. `scripts/prepare-sidecars.js` prepares `src-tauri/binaries/`.
- `public/`: frontend public assets and generated license notices. `dist/` and `src-tauri/target/` are build outputs.
- `scripts/`: E2E orchestration, dependency updates, license generation, platform packaging, and release automation. `testdata/` contains legacy/updater fixtures.
- `.github/workflows/ci.yml`: hosted quality/native gates. `.github/workflows/ytdlp-watch.yml`: yt-dlp monitoring. `.githooks/` contains local commit hooks; it does not provide full E2E coverage.

## Data flow and ownership

1. DOM bindings call the shared `api` object, which uses typed calls in `commands.ts` to reach Rust handlers registered in `main.rs`.
2. Rust validates inputs and resolves effective download options before starting media tools. The downloader session owner and queue coordinator serialize their respective state transitions.
3. Backend events return through `app_state.rs` and renderer API subscriptions. Bindings/controllers update the rendering modules.
4. Rust persists settings, queue, activity, and statistics under the resolved app data directory. E2E builds use temporary profiles instead of the user's data.
5. Close/restart waits for the renderer settings flush and backend durability checks. Keep the readiness and close handshakes intact.

Preserve session IDs, queue revisions, and settings revisions when changing asynchronous behavior. They prevent stale events/responses from overwriting newer work. Keep process waits and disk work outside the coordinator/session owner threads, following their module-level ownership notes.

Network policy is defined in `docs/NETWORK-POLICY.md`. A URL pre-check alone is insufficient: media requests and redirects must retain the per-operation destination checks. Keep E2E loopback exceptions and probe commands behind the E2E feature/configuration.

## Verification workflows

| Command | Purpose |
| --- | --- |
| `npm run test:e2e:core` | Fast local feedback: selected existing main scenarios plus complete state/updater, renderer, offline queue, and renderer DOM suites. Requires working FFmpeg and ffprobe. |
| `npm run test:e2e` | Full native E2E gate, including specialized network, process, recovery, platform, and feature regressions. |
| `npm run test:e2e:core -- --repeat 3` | Repeated core runs with retained stability evidence; each invocation still uses the normal incremental build path. |
| `npm run test:e2e:stability` | Five full E2E runs for stability investigation. |
| `npm run test:all` | Aggregate frontend, tooling/policy, Rust, and full E2E gate. |
| `npm run typecheck`, `npm run lint`, `npm run format:check` | Static checks. These do not replace E2E verification. |
| `npm run test:cargo-safe-update` | Existing script/policy integration checks, including E2E selector/report checks. |
| `npm test`, `npm run test:rust` | Existing frontend and Rust checks. Follow the critical testing instructions above when adding coverage. |

The canonical E2E inventory is `e2e/suites.json`. The orchestrator is `scripts/test-e2e.js`, with selection/build/runner/stability helpers under `scripts/e2e/`. WebdriverIO configuration lives in `e2e/wdio.conf.js`. Read `e2e/README.md` for coverage, runner ownership, platform allowances, focused selectors, and measured local runtimes.

- Core is partial feedback, not full-suite or release proof. Do not replace the full CI or `test:all` gate with core.
- Full reports use `e2e/artifacts/e2e-report-<platform>-<arch>.json`. Core reports/screenshots use unique directories under `e2e/artifacts/core/<platform>-<arch>/<run-id>/`, with a separate `latest-report.json`.
- Retain verifiable reports, source/binary identity, hashes, screenshots, and timings. Missing, duplicated, failed, or unallowed skipped scenarios fail the gate; repeat runs must reject stale evidence.
- Add regression coverage to the existing feature suites or `e2e/v5-fixes/<area>/` according to `e2e/README.md`. Keep failure inventories beside relevant coverage; avoid per-audit runners.
- The gate builds the E2E binary once per invocation. Do not run Cargo concurrently with native E2E: it can replace the binary being tested.
- Local macOS E2E defaults to background mode. `ROSI_E2E_FOREGROUND=1` enables foreground behavior. A sandbox loopback/display restriction is not automatically an application defect; preserve the failure and distinguish environment limitations from product failures.

## Contracts and generated files

- Change Rust payload definitions in `src-tauri/src/types.rs`, then regenerate `src/generated/ipc-types.ts` with `ROSI_UPDATE_IPC_TYPES=1 cargo test --locked --manifest-path src-tauri/Cargo.toml ts_bindings` after preparing Rust test sidecars. Do not hand-edit the generated types.
- For command changes, keep `src/commands.ts`, `src/api.ts`, Rust handlers, the command registrations in `main.rs`/`build.rs`, and Tauri permissions consistent.
- `npm run sync-version` updates version metadata. License scripts generate notices consumed by the app; strict release license verification is separate from development notice generation.
- Sidecar checksums/provenance and bundled license/source-offer files are part of packaging. Development stubs are not release binaries.

## Build and release navigation

- `npm run tauri:build` creates a native build. Platform workflows are named `build:mac:*`, `build:win:*`, `build:msstore:*`, and `build:linux:*`; inspect their preparation, signing, and packaging steps before use.
- Release entry points are `scripts/run-release.js` and the `release:*` package scripts. `scripts/release-session.js` binds proof/session identity; `release-preflight.js` checks release prerequisites.
- The current `release:prepare` intentionally invokes `test:all -- --require-clean-proof --skip-e2e`. This release-specific exception does not mean full native E2E passed and does not change the normal full gate.
- `npm run b`, `npm run r`, and `release:finalize` contain destructive Git reset/clean operations. They are release/sync workflows, not routine build or validation commands.
- Use `docs/RELEASE-STABLE.md` for stable promotion, `docs/DEPENDENCY_UPDATES.md` for dependency changes, and `docs/KEY-COMPROMISE.md` for signing-key incidents. `docs/ROADMAP-5.1.md` and `docs/IMPLEMENTATION-5.1.md` describe planned/completed product work; verify behavior in source rather than treating roadmap items as shipped features.
