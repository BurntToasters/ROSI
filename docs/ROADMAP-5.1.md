# ROSI 5.1 roadmap

These are deferred, long-term items. None of them blocks 5.0.0 stable. Each
entry gives the problem with file and line evidence, a concrete plan, and
acceptance criteria. Line numbers were read on 2026-10-19 and will drift; search
for the named symbol when they do.

Items already covered by the current stable-readiness fixes are not listed
here. Keep each item's acceptance criteria as the definition of done, and check
them against the E2E evidence the change produces. Where a plan adds a
dependency, the change must be approved on its own; this roadmap does not add
one.

## 1. Split the renderer engine into feature modules

**Status (2026-10-20): done in 5.0.0-beta.4.** Feature logic lives in `src/engine/`, and per-feature event binding in `src/engine/bind/`. `src/rosiEngine.ts` (about 570 lines) loads settings, looks up the DOM, and calls the bind functions in their original order.


**Problem.** `src/rosiEngine.ts` is 5,943 lines. `initializeRenderer` starts at
`src/rosiEngine.ts:2370` and runs to about line 5927. It holds 66 nested
functions and 153 closure locals, so almost every feature reads and writes the
same shared state. `src/modules/` already has `settings.ts`, `downloads.ts`,
`queue.ts`, `dock.ts`, `activity.ts`, `icons.ts`, `ui.ts`, and `updates.ts`, but
they attach to `window.rosiModules` (`src/renderer-globals.d.ts`) rather than
taking explicit inputs.

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

**Status (2026-10-20): done in 5.0.0-beta.4.** `src/generated/ipc-types.ts` is generated from the Rust types (test-only `ts-rs`), `src/commands.ts` types every command call, and a contract test checks the command names against `build.rs` and the capability. `window.api` stays as the seam for vitest and E2E; removing it would mean rewriting those harnesses, which is not planned.


**Problem.** `src/tauri-bridge.ts:132` assigns `window.api`, a shim that copies
the v4 Electron contract onto Tauri. The renderer also depends on IIFE modules
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
3. Replace `window.api` with typed wrappers around `invoke` and event listeners.
   Migrate one command group at a time, and delete each `window.api` member once
   no caller uses it.
4. Replace the IIFE globals with ES module imports, as item 1 does.

**Acceptance criteria.**

- `window.api` and `window.rosiModules` no longer exist in `src/`.
- No hand-written copy of `Settings` or any other IPC type remains in `src/`.
- A stale generated file fails CI, and a Rust type change without a matching
  TypeScript change fails the type check.
- Every command in the generated list has at least one E2E scenario.

## 3. Serde enums for settings and typed IPC structs

**Status (2026-10-20): settings enums done in 5.0.0-beta.4** (`Theme`, `DockTab`, `DownloadProfile`, `GpuType`, `UpdateChannel`). Remaining: typed IPC structs in place of `serde_json::Value` plus hand validation.


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

**Problem.** `src-tauri/src/network_security.rs` is 1,917 lines. It starts
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
