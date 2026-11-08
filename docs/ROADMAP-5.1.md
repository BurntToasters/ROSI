# ROSI 5.1 roadmap

This status ledger separates work already present in the repository, scope
accepted for ROSI 5.1, and work deferred beyond 5.1. “Accepted” is a planning
status, not evidence that implementation or platform verification is complete.
The accepted delivery plan and proof gaps are in
[IMPLEMENTATION-5.1.md](IMPLEMENTATION-5.1.md). The required stable matrix is
macOS 15 and newer, Linux x64, and Windows x64 and arm64. Linux arm64 remains
deferred. Each entry gives the problem with file evidence, a concrete plan, and
acceptance criteria. Line numbers were read on 2026-10-19 and will drift; search
for the named symbol when they do.

Check acceptance criteria against evidence from the change that produces it.
Where a plan adds a dependency, the change must be approved on its own; this
roadmap does not add one.

## 1. Split the renderer engine into feature modules

**Status (2026-11-07): partial implementation present.** Feature logic lives in
`src/engine/`, and per-feature event binding in `src/engine/bind/`.
`src/rosiEngine.ts` is 439 lines and still defines `initializeRenderer`
(line 101). No `window.rosiModules` reference remains in `src/`; the modules are
ES imports (see B6). The extraction is useful existing work, but
the acceptance criteria below are not all met. No completion is claimed here.

**Problem.** `src/rosiEngine.ts` is 5,943 lines. `initializeRenderer` starts at
`src/rosiEngine.ts:2370` and runs to about line 5927. It holds 66 nested
functions and 153 closure locals, so almost every feature reads and writes the
same shared state. `src/modules/` already has `settings.ts`, `downloads.ts`,
`queue.ts`, `dock.ts`, `activity.ts`, `icons.ts`, `ui.ts`, and `updates.ts`, but
before B6 part A they attached to `window.rosiModules` rather than taking
explicit inputs. The problem statement describes that earlier state.

**Plan.**

1. List the shared state each closure local touches, and group the locals by
   feature (settings, downloads, queue, activity, dock, updates, setup wizard,
   licenses, splash).
2. For each feature, make the module export a factory that receives its
   dependencies as a typed object. Move one feature per change.
3. Move the remaining glue last. `initializeRenderer` should only build the
   dependency objects and start the modules.
4. Remove each `window.rosiModules` entry when its module no longer needs the
   global.

**Acceptance criteria.**

- `initializeRenderer` is gone, and `src/rosiEngine.ts` is under 1,000 lines.
- No feature module closes over another feature's locals. Each dependency is
  listed in its factory's parameter type.
- Every existing Vitest renderer test and E2E scenario passes without changing
  its expectations.
- Each module has a failure-mode note next to its tests.

## 2. Typed command layer and generated IPC types

**Status (2026-11-06): partial implementation present.**
`src/generated/ipc-types.ts`, `src/commands.ts`, and the command contract check
exist. The renderer API is now the `api` module in `src/api.ts` (B6 part B),
not `window.api`. Only the E2E hook exposes it, as `window.__ROSI_E2E__.api`
in E2E builds. The method list is still hand-written, so this item is not done.

**Problem.** The API object (formerly `src/tauri-bridge.ts`, now `src/api.ts`)
copies the v4 Electron contract onto Tauri. The renderer also depends on IIFE modules
exposed as window globals. The settings shape is written twice by hand:
`src-tauri/src/types.rs:59` (`struct Settings`) and the TypeScript copy in
`src/rosiEngine.ts:39` (`theme: 'system' | 'light' | 'dark' | 'purple'`). They
can drift without a compile error. Neither `tauri-specta` nor `ts-rs` is in
`src-tauri/Cargo.toml`.

**Plan.**

1. Choose `tauri-specta` (command and event types) or `ts-rs` (plain structs).
   Compare their Tauri 2 support and how they fit the build. Choose one.
2. Generate a TypeScript file from the Rust command and type definitions during
   the build. Commit the generated file and have CI fail if it is stale.
3. Replace the hand-written API methods with typed wrappers around `invoke` and
   event listeners. Migrate one command group at a time. The `api` module exists;
   the wrappers inside it are still per-method.
4. Replace the IIFE globals with ES module imports, as item 1 does.

**Acceptance criteria.**

- `window.api` and `window.rosiModules` no longer exist in `src/` (met: the API
  is the `api` module, and the E2E seam is `window.__ROSI_E2E__.api`).
- No hand-written copy of `Settings` or any other IPC type remains in `src/`.
- A stale generated file fails CI, and a Rust type change without a matching
  TypeScript change fails the type check.
- Every command in the generated list has at least one E2E scenario.

## 3. Serde enums for settings and typed IPC structs

**Status (2026-10-20): settings enums done in 5.0.0-beta.4** (`Theme`, `DockTab`, `DownloadProfile`, `GpuType`, `UpdateChannel`). Remaining: typed IPC structs in place of `serde_json::Value` plus hand validation.

**Status (2026-11-06): partially implemented; typed IPC structs remain open.**
The settings enums are present in `src-tauri/src/types.rs`. `serde_json::Value`
still appears in backend helpers and command/probe code; no claim is made that
the old acceptance criteria are complete.

**Problem.** Several settings are free-form strings: `theme`
(`src-tauri/src/types.rs:61`), `dock_tab` (`:63`), `download_mode` (`:65`),
`gpu_type` (`:82`), and `update_channel` (`:88`). `src-tauri/src/validation.rs`
is 1,057 lines and checks them by hand. There are 12 `serde_json::Value` uses in
`src-tauri/src/`, which bypass the struct types.

`validation.rs` is the security boundary for URLs, paths, and command input.
Migration must stay lenient: ROSI 4 and older ROSI 5 settings files can hold
values this version does not know, and the CHANGELOG promises that those fall
back to defaults rather than failing the import.

**Plan.**

1. Convert each string setting to a `#[serde(rename_all = "...")]` enum. Give
   each enum a fallback variant, marked with `#[serde(other)]` where the
   format allows it, or a custom deserializer that maps unknown values to the
   default and logs once.
2. Replace the `serde_json::Value` IPC arguments with typed request structs.
   Keep the existing validators, and run them after deserialization on the
   typed values.
3. Keep `validation.rs` for security checks only (URLs, paths, command
   arguments). Remove checks that the type system now enforces.

**Acceptance criteria.**

- Unknown setting values from a v4 or ROSI 5 file still import as defaults, and
  the import E2E scenarios pass unchanged.
- Every security-relevant rejection in `validation.rs` still has a test that
  fails without the check.
- No `serde_json::Value` remains in an IPC command signature.
- `validation.rs` is smaller, and its remaining functions are listed in its
  failure-mode note.

## 4. Replace the downloader and queue locks with a state thread

**Status (2026-11-07): implemented, see [IMPLEMENTATION-5.1.md](IMPLEMENTATION-5.1.md).**
`coordinator.rs` owns queue state and transitions: one command thread with reply
channels and revisioned `queue-update`. Session state lives on the session owner
thread (`downloader/session_owner.rs`). The `QUEUE`, `ACTIVE`, `STARTUP`, and
`EVENT_PUBLISH` globals are gone, and `queue.rs` and `downloader.rs` have no
global `Mutex` or `Condvar` outside tests. The remaining statics are
configuration, a channel sender, or an atomic id counter (see B7). Full-gate
proof at HEAD is still outstanding.

**Problem.** The download and queue state uses global locks and condition
variables. `src-tauri/src/downloader.rs:78` holds `ACTIVE: Mutex<Option<Session>>`
with `SESSION_CHANGED` (`:82`), `FINALIZING` (`:83`), and
`FINALIZATION_CHANGED` (`:84`). `src-tauri/src/queue.rs:34` holds `QUEUE`, with
`START_GUARD` (`:45`), `RUNNER_CHANGED` (`:46`), and `PERSIST_SIGNAL` (`:56`).
Correct ordering depends on lock discipline that is written down in comments
rather than enforced by types.

**Plan.**

1. Create one state thread per subsystem that owns the session and queue state.
   Other code sends commands over an `mpsc` channel and receives snapshots or
   events.
2. Port one transition at a time: start, cancel, finalize, persist, and
   reorder. Keep each transition's failure modes in a failure-mode note before
   the port.
3. Replace each condition variable wait with a channel receive or a reply
   channel.

**Acceptance criteria.**

- `downloader.rs` and `queue.rs` have no global `Mutex` or `Condvar`.
- Queue updates still reach the UI in the order they happen (the beta.3 fix).
- Cancel, start, and restart races have E2E scenarios that pass repeatedly.
- The state thread can be stopped cleanly on app exit, with no leaked child
  process.

## 5. Async proxy relay on the Tauri runtime

**Status (2026-11-07): implemented with residue, see [IMPLEMENTATION-5.1.md](IMPLEMENTATION-5.1.md).**
The Tokio relay in `network_security_async.rs` serves 256 active and 128
pending clients, and answers 503 on overload. Client cancellation uses a
`tokio::sync::watch` channel, and DNS replies arrive over oneshot channels, so
the relay has no polling sleep. The E2E probe is in place. Residue:

- The DNS pool is still blocking threads with a condvar (`DnsResolverPool` in
  `network_security.rs`, 4 workers).
- Its blocking caller, `resolve_system_dns_with_cancel`
  (`network_security.rs:808-845`), checks the reply every 25 ms
  (`DNS_RESOLUTION_POLL_INTERVAL`, `:843`). The relay's own lookups await the
  reply and do not poll.
- Acceptance (no blocking worker pool and no polling sleep in the relay, no
  measurable idle CPU) is not met while the DNS pool and its 25 ms reply check
  remain.

**Problem.** The text below describes the 5.0 relay, before the 5.1 migration.
Its constants and workers (`PROXY_WORKERS`, `RELAY_MAX_IDLE_SLEEP`, `proxy_worker`)
no longer exist. `src-tauri/src/network_security.rs` was 1,917 lines in 5.0. It starts
`PROXY_WORKERS: usize = 32` blocking workers (`:35`). Each `proxy_worker`
(`:604`) takes one client at a time, so the worker count caps concurrent
tunnels. Its relay polls: the idle
sleep is `RELAY_MAX_IDLE_SLEEP = 25 ms` (`:41`), and DNS resolution uses a 25 ms
poll interval (`:47`) across `DNS_RESOLVER_WORKERS = 4` (`:43`) threads. Threads
are spawned at several sites (`:147`, `:543`, `:555`, `:1625`, `:1724`), and an
idle relay still wakes up on its sleep.

**Plan.**

1. Decide between `tauri::async_runtime` and a direct `tokio` dependency. Tauri 2
   runs on tokio internally, but `src-tauri/Cargo.toml` does not list tokio as a
   direct dependency.
2. Replace the listener and each worker with async tasks: `TcpListener` accept
   loops, `copy_bidirectional` for the relay, and `lookup_host` with a timeout
   for DNS.
3. Keep the destination policy in `ip_policy.rs` as the only check. Every
   resolved address must still pass it before a connection is made.
4. Remove the polling sleeps.

**Acceptance criteria.**

- No blocking worker pool and no polling sleep remain in the relay.
- An idle relay uses no measurable CPU over a 60-second window.
- At least 256 concurrent CONNECT tunnels succeed in an E2E scenario, where the
  current cap is 32.
- The private-network and redirect block scenarios from
  `docs/NETWORK-POLICY.md` still pass unchanged.

## 6. Regroup E2E suites by feature

**Status (2026-11-07): implemented with residue, see [IMPLEMENTATION-5.1.md](IMPLEMENTATION-5.1.md).**
`e2e/suites.json`, `--group` selection, and `scenarioGroups` in reports are in
place. No file name under `e2e/` contains `round`, `audit`, or `repair`. Residue:

- No residue in the file layout or suite list: `scripts/test-e2e.js` is 764
  lines (target < 800), reads `e2e/suites.json` through `scripts/e2e/manifest.js`,
  and runs the runners from `scripts/e2e/runners/`. Whether the gate still
  produces the same results after the move is not re-proved at HEAD.

**Problem.** `e2e/` holds about 95 files and roughly 25,000 lines. 35 of the
file names refer to audit rounds or repair passes (for example
`round2-native.spec.js`, `audit4-repairs.spec.js`, and
`download-process-repairs.spec.js`). Suites are hard to find by feature, and the
names say nothing about what they cover. `scripts/test-e2e.js` is 2,165 lines.

**Plan.**

1. Map each scenario to a feature: downloads, queue, settings, updater, network
   policy, conversion, dock and UI, and packaging.
2. Move scenarios into one folder per feature, with its failure-mode document
   next to its tests. Rename files by feature, not by round.
3. Replace the hard-coded suite list in `scripts/test-e2e.js` with a manifest
   that each feature folder provides.
4. Keep the evidence report format. Group the evidence artifacts by feature.

**Acceptance criteria.**

- No file name in `e2e/` contains `round`, `audit`, or `repair`.
- Every feature folder has a failure-mode document, and its scenario count
  matches the count before the move.
- `scripts/test-e2e.js` is under 800 lines and reads its suite list from the
  manifests.
- `npm run test:e2e` produces the same pass and fail results as before the move.

## 7. Centralize user-facing strings

**Status (2026-11-06): deferred beyond ROSI 5.1.**

**Problem.** User-facing text is written inline in the renderer and the Rust
backend. `src/rosiEngine.ts` has about 56 lines that call a toast helper, and the Rust
backend has about 225 `format!` string literals, not all of them user-facing. Wording differs between the two sides, and no one
can translate or review the full set in one place.

**Plan.**

1. Create one string table per side: a TypeScript module for the renderer and a
   Rust module for backend status messages. Use keys, not English sentences, at
   call sites.
2. Move messages in the same order as the feature modules in item 1, so each
   move is reviewed with its feature.
3. Add a lint that rejects new user-facing literals outside the table files.
4. Only after the tables exist, decide on locale files. This item does not add
   a translation library.

**Acceptance criteria.**

- Each user-visible message is in a table with a key, and call sites use the
  key.
- The lint fails on a new inline user-facing literal, and it passes on the
  current tree once the migration is done.
- The text the user sees is unchanged in English.

## 8. macOS sidecar entitlements

**Status (2026-11-06): entitlement redesign deferred beyond ROSI 5.1.** The
current signing model remains part of platform verification; this roadmap item
does not authorize a pipeline or entitlement change.

**Problem.** Today `src-tauri/entitlements.plist` grants the whole app, including
every sidecar, `disable-library-validation` and `allow-unsigned-executable-memory`.
Only the PyInstaller `rosi-yt-dlp` needs them. The fix is already planned in
[ARCHITECTURE.md](../ARCHITECTURE.md), under "macOS entitlements for sidecars
(planned, not implemented)".

**Plan.** Follow the seven ordered steps in that section. Confirm each Tauri step
with a dry run before changing the pipeline.

**Acceptance criteria.**

- Each sidecar's signed entitlements match the expectation in
  `scripts/zip-macos.js`.
- `codesign --verify --deep --strict` and `spctl` pass on the notarized app.
- The updater `.app.tar.gz` and its `.sig` verify after the re-sign.
- `src-tauri/entitlements.plist` changes only in the same change as the
  pipeline update.

## 9. Signed yt-dlp-only update channel

**Status (2026-11-06): deferred beyond ROSI 5.1.** This is the independent
yt-dlp update channel explicitly excluded from the accepted 5.1 milestones.

**Problem.** yt-dlp is bundled. `assets/ytdlp-checksums.json` is the committed
manifest (`scripts/fetch-ytdlp.cjs:37`), and `.github/workflows/ytdlp-watch.yml`
updates it from the GPG-verified upstream `SHA2-256SUMS`. A YouTube break
therefore needs a full three-platform ROSI release, with its QA and signing
work, even though only one binary changed.

**Plan.**

1. Publish a small channel manifest as a release asset. It lists the yt-dlp
   version, each platform's binary name, and its SHA-256, and it is signed with
   the release GPG key (`.asc`).
2. At runtime, ROSI fetches the manifest and its `.asc`, verifies the GPG
   signature against the public key embedded in the app, then downloads the
   binary and checks its SHA-256.
3. Install the verified binary in the app data directory. Sidecar resolution
   uses it only when it verifies and is newer than the bundled copy.
4. Decide the OpenPGP verifier before implementation. Pure Rust verification
   needs a new crate, which must be reviewed and approved on its own.

**Acceptance criteria.**

- A manifest with a bad signature, a binary with a bad hash, or a version
  downgrade is rejected, and the bundled yt-dlp keeps working.
- The E2E suite covers the update against a local channel server, using a test
  key and not the release key.
- The release pipeline produces the manifest and its signature, and
  `verify-release-draft.js` checks them.
- The update can be turned off in settings, and the app then uses the bundled
  binary only.

## 10. Dual-key updater support

**Status (2026-11-06): deferred beyond ROSI 5.1.**

**Problem.** The vendored updater trusts one Minisign public key, set in
`src-tauri/tauri.conf.json:115` as `plugins.updater.pubkey`. A rotation needs a
release signed with the old key, and a compromised old key can publish such a
release too. [KEY-COMPROMISE.md](KEY-COMPROMISE.md) describes this limit.

**Plan.**

1. In `src-tauri/vendor/tauri-plugin-updater`, accept a list of public keys.
   Each signature is checked against the list, and a key can be marked as
   retired.
2. Ship the new key alongside the old one in one release, signed with the old
   key. Remove the old key in a later release.
3. Document the rotation sequence and the retirement rule in
   `docs/KEY-COMPROMISE.md`.

**Acceptance criteria.**

- An update signed by either accepted key installs, and a signature from a key
  that is not in the list is rejected.
- A retired key is rejected, and the rejection shows in the updater's error
  message.
- An E2E scenario covers a two-key rotation from a beta to a stable build.
- The vendored patch file (`PATCHES.md`) lists the change.

## 11. Deno end of life (about October 2027)

**Status (2026-11-06): deferred beyond ROSI 5.1.**

**Problem.** yt-dlp uses Deno as its default JavaScript runtime for YouTube.
Deno is expected to shut down around October 2027, and yt-dlp has not picked a
replacement. ROSI finds Deno by path in `src-tauri/src/deno.rs:19` to `:48`, and
no `--js-runtimes` argument is built in `src-tauri/src/`. Deno-specific code is
spread across `deno.rs`, `process_util.rs`, the startup reminder, and the setup
wizard in `src/rosiEngine.ts`. See also the "Deno end of life" section of
[ARCHITECTURE.md](../ARCHITECTURE.md).

**Plan.**

1. Until yt-dlp chooses, keep new runtime work generic. Pass the runtime to
   yt-dlp through one setting, not a Deno-specific code path.
2. When yt-dlp announces a replacement, add it as a runtime entry in one table.
   Remove the Deno entries from `process_util.rs`, the reminder, and the wizard.

**Acceptance criteria.**

- All runtime detection and installation sits behind one module and one table.
- Adding or removing a runtime changes that table only.
- With no supported runtime installed, the reminder shows the generic message,
  and downloads that do not need a runtime still succeed.

## 12. Flathub or a hosted Flatpak repository

**Status (2026-11-06): new Flatpak hosting and Linux arm64 deferred beyond
ROSI 5.1.** Existing Flatpak packaging remains in the required Linux x64
verification scope.

**Problem.** The Flatpak is a single-file bundle, `ROSI-Linux-x64.flatpak`, on
the GitHub release. The in-app updater does not apply to Flatpak, so Flatpak
users update only by downloading the new file by hand. The stable runbook's
updater gate requires a manual reinstall for the same reason.

**Plan.**

1. Choose between Flathub (submission, review, and its update flow) and a repo
   that ROSI hosts, built with `flatpak build-update-repo`. Compare the release
   cost, the review time, and who controls the signing key.
2. Publish each release to the chosen repository from the release pipeline, and
   sign the repository with a key that is part of [KEY-COMPROMISE.md](KEY-COMPROMISE.md).
3. Verify the published repository summary in `verify-release-draft.js` or a
   published-release check.

**Acceptance criteria.**

- `flatpak update` from the repository installs the new version on a clean
  machine.
- The release pipeline fails if the repository is not updated for a stable
  release.
- The runbook's Flatpak updater step is replaced by a `flatpak update` check.

## Deferred to 5.1.x

These items are not required for 5.1.0. They are planned for 5.1.x and have not
started. The proof gaps for the accepted milestones are in
[IMPLEMENTATION-5.1.md](IMPLEMENTATION-5.1.md).

### Open follow-ups from the 5.1 audit plan

These items came from the audit plan that previously lived in `plan.md`. Each
was checked against source at HEAD `8e32e90`. Items already done in source were
dropped, and no results from these checks are claimed as passing evidence.

- **Full-gate evidence at HEAD.** Run `npm run test:all -- --require-clean-proof`
  on macOS arm64, Windows x64, Windows arm64, and Linux x64. Each required
  platform needs a passing `fullSuite` report whose `commit` equals HEAD, and the
  report belongs in the ledger. The recorded macOS pass (`9e60f97`) predates HEAD.
  The updater specs' expectations against the 5.1 target selection have not been
  re-proved at HEAD. The macOS `download-process-repairs` scenario flakes on
  execute/async timeouts, so re-run it once before debugging a failure.
- **macOS window mode for release evidence.** `e2e/README.md` still makes
  background mode (`ROSI_E2E_BACKGROUND=1`) the local macOS default. In that
  mode the Reset-All modal click and the close-flow scenario in `main.spec.js`
  have failed. Either make background mode reliable, or require
  `ROSI_E2E_FOREGROUND=1` for release evidence and state that in `e2e/README.md`
  and `docs/RELEASE-STABLE.md`.
- **ui-polish triage (workstream D0).** The audit recorded 4 of 8 failing
  assertions in background mode and 5 of 8 in foreground mode on `6f244bd`
  (`e2e/v5-fixes/ui-polish/ui-polish.spec.js`). Classify each as a spec
  assumption or a product defect before fixing either. Workstream D1 to D7 depend
  on that triage and have not been re-verified.
- **DNS resolver pool (roadmap item 5 residue).** The DNS pool in
  `network_security.rs` uses blocking threads with a condvar, and
  `resolve_system_dns_with_cancel` checks its reply every 25 ms
  (`DNS_RESOLUTION_POLL_INTERVAL`). Replace both with a wait that does not poll,
  then measure idle CPU over a 60-second window.
- **Renderer fallback settings (workstream B3).** `src/rosiEngine.ts`
  (`MINIMAL_SETTINGS_VERSION` and the object beside it) keeps a hand-written
  settings object used only when `get_default_settings` fails. Keep it as a
  documented fallback or remove it.
- **Downloader split (workstream B10).** `src-tauri/src/downloader.rs` is 1,676
  lines, down from 3,207. Conversion, publication, and session ownership already
  live in `downloader/`. The rest of the split is not a 5.1.0 blocker.

### B7: Finish coordinator ownership (roadmap item 4)

**Precondition.** The full gate, `npm run test:all -- --require-clean-proof`,
must be green on every required platform (macOS 15 and newer, Linux x64,
Windows x64, and Windows arm64) before this change starts. Today it is green
only on macOS arm64. Before the port, write failure-mode rows for
`cancel_session`, `complete_session`, `start_download`, and `on_ytdlp_exit`
(`src-tauri/src/downloader.rs`). Part B's rows are in
`e2e/session-ownership.failure-modes.md`.

**Remaining globals** in `src-tauri/src` at this snapshot:

| Symbol                                                    | File and line                 | Role                                                                                                                                                            |
| --------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUEUE`: `OnceLock<Mutex<QueueState>>`, read by `state()` | `queue.rs:42`, `queue.rs:197` | **Done (B7 part A).** Removed. `QueueState` is a local in `coordinator::run`; reads are `Snapshot` and `IsRunning` requests.                                    |
| `PERSISTENCE` (inside `persistence()`)                    | `queue.rs:188`                | **Kept.** Configuration only: file paths and the writer's channel. Revision state lives on the writer thread, not behind a lock.                                |
| `WRITER` (inside `writer()`)                              | `queue.rs:328`                | **Kept.** A `OnceLock` holding the writer's channel sender, not shared state.                                                                                   |
| `ACTIVE`: `Mutex<Option<Session>>`, read by `lock()`      | `downloader.rs` (was `:82`)   | **Done (B7 part B).** Removed. The session lives on the session owner thread (`downloader/session_owner.rs`). Reads and changes are tasks run in arrival order. |
| `ACTIVE_PRESENT`: `AtomicBool`                            | `downloader.rs` (was `:85`)   | **Done (B7 part B).** Replaced by the owner's read-only `SLOT_OWNER` hint, which `is_busy` and `can_start` read. The install task decides.                      |
| `STARTUP`: `Mutex<()>`                                    | `downloader.rs` (was `:87`)   | **Done (B7 part B).** Removed. `install` makes the one authoritative check. A same-owner start cancels the occupant by id, awaits it, and retries.              |
| `EVENT_PUBLISH`: `Mutex<()>`                              | `downloader.rs` (was `:88`)   | **Done (B7 part B).** Removed. The owner runs every event emit in arrival order, so a replaced session's events are dropped.                                    |
| `COUNTER`: `AtomicU64`                                    | `downloader.rs:94`            | **Kept with reason.** Mints session ids before install, so no owner round trip is needed. It is an atomic counter, not shared state.                            |

The `downloader/conversion.rs` and `downloader/publication.rs` modules declare no
statics. Test-only statics (`SERIAL` at `downloader.rs:1631`) are excluded.
Outside this list: `coordinator.rs` `COORDINATOR` holds a channel sender, not
state, and `activity.rs` `state()` is outside the queue and downloader scope.

**Acceptance.** Item 4's criteria apply: no global `Mutex` or `Condvar` in
`downloader.rs` or `queue.rs`, queue updates keep their order, and the cancel,
start, and restart E2E scenarios pass repeatedly. The `OnceLock` and atomic
statics above are listed so the port accounts for them too.

### B6: Renderer seams (roadmap items 1 and 2)

**Status: done (part A and part B).** Not a 5.1.0 blocker, as the
implementation plan states.

- Part A: `window.rosiModules` is removed. The modules are ES module imports
  (commit 17d0dea).
- Part B: `window.api` is removed. The API object is `api` in `src/api.ts`.
  Renderer callers import it and call `api.method(...)` at call time. The
  E2E hook sets `window.__ROSI_E2E__.api` to the same object, inside the
  `VITE_ROSI_E2E` branch only. `src/tauri-bridge.ts` is deleted. The vitest
  DOM suite mocks `../api`, and the renderer DOM checks pass the module to
  their loader. Failure modes: `src/api.failure-modes.md`.

**Remaining.** The method signatures in `RosiRendererApi` (`src/api.ts`) are
still written by hand. They use the generated payload types, but the method
list is not generated from `commands.ts`. That is outside this item and can be
done later.

**Removal order (done).** Part A converted the modules to ES imports. Part B
moved the API into `src/api.ts`, switched every caller to `api.method(...)`
at call time, and removed the old global.

**Acceptance (met, except the hand-written method list under Remaining).**
`window.api` and `window.rosiModules` no longer exist in `src/`, and the E2E
specs read `window.__ROSI_E2E__.api`.
