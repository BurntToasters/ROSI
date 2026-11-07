# ROSI 5.1.0 audit and implementation plan

Audit date: 2026-11-06. Branch `next-5.1.0`, commit `6f244bd`, version `5.1.0-beta.1`.

**To the agent implementing this plan:** work the sections in the order given
in section 8 (A4, the full-gate evidence step, deliberately comes after A5 to
A7 and D0). Each workstream lists its failure-mode document, which must be
written before its code (AGENTS.md). Do not add unit tests after writing code;
prove each change with E2E scenarios that leave a report under `e2e/artifacts/`.
**Delete this file (`plan.md`) in the final commit of the implementation.** Do
not leave it in the repository once the work it describes has landed.

---

## 1. What the audit covered

Read in full or in large part: `ARCHITECTURE.md`, `CHANGELOG.md`,
`docs/ROADMAP-5.1.md`, `docs/IMPLEMENTATION-5.1.md`, `build-setup.md`,
`e2e/README.md`, `e2e/suites.json`, every `failure-modes.md` added for 5.1,
`src-tauri/src/{main,build,coordinator,queue,downloader,download_options,
sidecars,ipc,types,network_security,network_security_async,ffmpeg_guard,
media_info,platform}.rs`, `src-tauri/vendor/tauri-plugin-updater/PATCHES.md`,
`src/rosiEngine.ts`, `src/updater.ts`, `src/tauri-bridge.ts`, `src/commands.ts`,
`src/engine/*.ts` (core, formats, presets, playlist, url-actions, progress,
messages, settings-store, bind/backend-events, bind/settings-controls diff,
wizard diff, deno diff), `src/modules/downloads.ts`, `src/modules/activity.ts`,
`scripts/prepare-sidecars.js`, `scripts/zip-macos.js`, `scripts/pack-macos-updater-zst.js`,
`scripts/gpg-sign.js` (outline), `scripts/test-e2e.js` (outline),
`scripts/test-all.js`, `.github/workflows/ci.yml`, `run.rosie.rosi.yml`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `package.json`, and the
full `git diff --stat 352acee..HEAD` (5.0.2 to HEAD: 124 files, +13,755/-2,858).

Checks run on this Mac (arm64, macOS 27.2):

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` (eslint + comment lint, 777 files) | pass |
| `npm run format:check` | pass |
| `vitest run` | 6 files, 76 tests pass |
| `cargo clippy --locked --all-targets -- -D warnings` | pass |
| `cargo test --locked --all-targets` | 32 + 1 pass (includes `ts_bindings`, so `src/generated/ipc-types.ts` is current) |
| `npm run test:e2e` (full gate, run twice) | **fails** both times at `6f244bd`; details in 2.1 |
| `npm run test:e2e -- --group ...` and `ROSI_E2E_ONLY=...` for the passes the gate never reached | see 2.1, item 1c |

---

## 2. Findings

Severity: **B** = blocks a 5.1.0 stable, **H** = fix in 5.1.0, **M** = fix in
5.1.x, **L** = cleanup.

### 2.1 Evidence and release hygiene

1. **(B) The full E2E gate fails on the 5.1 tree, and no platform has a
   passing report.** Before the audit, the newest local report was from
   2026-10-22 (5.0.1, `onlySpec`). `gh run list --branch next-5.1.0` returns
   nothing (CI runs only for `main`/`beta` pushes and PRs to them; no PR
   exists), and the last three `beta` runs (2026-10-18/19) were failure,
   cancelled, failure. `docs/IMPLEMENTATION-5.1.md` records a Windows
   inventory that executed nothing. The audit ran `npm run test:e2e` twice on
   this Mac (macOS arm64, commit `6f244bd`, E2E binary
   `bdab121c3f62…`). Both runs failed. Three distinct causes:

   **1a. (B, deterministic) `e2e/state-updater-repairs.spec.js:1089` fails:**
   `expected 'darwin-beta-e2e-app', actual 'darwin-beta-aarch64-app-zst'`.
   The 5.1 updater (`src/updater.ts` `updateCheckTarget`) now calls
   `get_compact_updater_target` before `get_beta_updater_target`. The spec's
   `__ROSI_E2E__.updaterAdapter.invoke` stubs `get_beta_updater_target` but
   lets every other command fall through to the real `invoke`
   (`state-updater-repairs.spec.js:989-1008`). `platform::get_compact_updater_target`
   returns `Some` whenever Tauri reports bundle type `App`, and
   `tauri_utils::platform::bundle_type()` returns `App` for **any** macOS
   binary, including the unbundled E2E build (tauri-utils 2.10.1
   `platform.rs:370-371`). So the scenario written for 5.0 asserts the old
   target. The updater change in `a07a5a8` (2026-10-28) was never run through
   the gate. Fix in A5.

   **1b. (B, structural) One failing pass hides every later pass.**
   `scripts/test-e2e.js:1999-2070` runs the WebdriverIO passes in one `try`;
   `runPass` throws on failure, so after 1a the security pass, the
   `round2-renderer` pass, every `v5-fixes` area without a runner
   (`download-options`, `flatpak-updates`, `platform`, `queue-coordinator`,
   `typed-formats`, `ui-polish`, `upstream-proxy`) and `specs/main.spec.js`
   (82 of the 115 expected scenarios) never ran. The report lists them as
   "did not run" / "reported 0 times", which reads like a mass failure. The
   runner-owned suites (process repairs, round2 native, long-term, audit
   probes, async-proxy, deno, downloader, network, persistence) did run and
   passed in run 2. Fix in E2 (continue after a failed pass; report each pass
   on its own).

   **1c. (B, flaky on macOS, 2 of 3 runs) the shared overload probe resets.**
   `v5-fixes/async-proxy` and `v5-fixes/network` runners failed in run 1 and
   passed in run 2; in the group run, `specs/security-release-repairs.spec.js`
   failed its `bracketed-ipv6-classification` and
   `proxy-rejects-unreviewed-pipelined-destination` scenarios through the
   same `e2e_network_pipelining_probe`, with
   `could not read overload response: Connection reset by peer (os error 54)`.
   `network_security_async.rs:636-649` `reject_client` writes the 503,
   calls `shutdown()` and drops the socket while the client's CONNECT request
   is still unread in the receive buffer. macOS (BSD stack) then sends RST,
   and the probe's `read_to_end` after the status line fails. Linux keeps the
   sent bytes readable, which is why the Ubuntu CI job would not show it. Fix
   in A6: after `shutdown()`, read and discard client bytes until EOF or a
   short deadline before dropping the stream; the probe keeps its strict
   `read_to_end`.

   **1d. Results for the passes the gate never reached**, obtained with
   `ROSI_E2E_ONLY=<spec>` one spec at a time (reports are not release proof;
   they only show whether the code behind each pass works):

   | Pass | Result alone (macOS arm64, `6f244bd`) |
   | --- | --- |
   | `v5-fixes/queue-coordinator` | passed, 8 scenarios |
   | `v5-fixes/download-options` | passed, 2 |
   | `v5-fixes/platform` | passed, 3 |
   | `v5-fixes/typed-formats` | passed, 3 |
   | `v5-fixes/upstream-proxy` | passed, 9 |
   | `round2-renderer-repairs.spec.js` | **fails** at `:269`, same class as 1a: expects `darwin-beta-round2-app`, gets `darwin-beta-aarch64-app-zst` |
   | `v5-fixes/flatpak-updates` | **fails** 2 of 4, same class as 1a: the Flatpak adapter stubs `is_flatpak: true` but not `get_compact_updater_target`, so `checkTargets` is `darwin-aarch64-app-zst` instead of the beta/stable target |
   | `specs/main.spec.js` | **background mode (the local macOS default): fails** `settings-reset-all` ("confirming did not reset", `main.spec.js:3692`) and loses the WebDriver session in `close-flow`; **foreground (`ROSI_E2E_FOREGROUND=1`): passes**, 63 of 64 with the allowed `xdg-download-dir` skip |
   | `v5-fixes/ui-polish` | **fails in both modes**: background 4 of 8, foreground 5 of 8. Foreground failures: "effective options were not resolved for a valid URL" (`ui-polish.spec.js:333`, summary never reaches `data-state="resolved"`; the fresh profile has no download folder, so readiness stays at `destination`); modal focus not inside the section-reset prompt (`:423`); "reset button is not keyboard focusable" (`:478`); `execute/async` script timeout while adding a second queue item (`:586`); `settingsSearch` not focused after the theme and text-scale matrix (`:789`). Background mode also fails the focus-trap Tab check (`:485`) and "queue refresh stole focused action" (`:644`) |

   So, counting only passes the gate can reach today: the 5.1 backend work
   (coordinator, option resolution, typed formats, upstream proxy, platform)
   passes; the three updater-related specs are stale against the 5.1 target
   selection; the UI polish acceptance spec does not pass against the UI it
   was written for; and the macOS background-window mode is not a reliable
   way to run `main.spec.js`. Fixes: A5 (updater stubs, all three specs), A6
   (RST), A7 (background mode), D0 (ui-polish triage).

   The implementing agent must re-run the full gate after A5 to A7 and D0 and
   keep the passing report.
2. **(H) Tracked junk files.** `Microsoft/Windows/PowerShell/ModuleAnalysisCache`
   and `e2e/Microsoft/Windows/PowerShell/ModuleAnalysisCache` (binary
   PowerShell caches from a Windows VM) were committed in `6f244bd`. Remove
   them and add `Microsoft/` and `**/Microsoft/Windows/PowerShell/` to
   `.gitignore`.
3. **(H) CHANGELOG is incomplete for 5.1.0-beta.1.** It lists only the updater
   and packaging items. It omits: the queue/session coordinator, the async
   proxy relay (256 tunnels, bounded admission), typed format listing, shared
   download-option resolution (`resolve_download_options`), the effective
   options summary, settings-save feedback and retry, wizard error states, the
   Node.js 26 toolchain move, Rust 1.99.1 pin, and `e2e/suites.json` groups.
   `validate:changelog` only checks the version header, so this passes CI.
4. **(H) Docs are stale against the code.** `docs/ROADMAP-5.1.md` item 4 says
   "implementation not started" and item 5 says the blocking worker pool
   remains; both are implemented (`src-tauri/src/coordinator.rs`,
   `network_security_async.rs`). `ARCHITECTURE.md`'s module table lacks
   `coordinator.rs`, `download_options.rs`, `network_security_async.rs`.
   `docs/IMPLEMENTATION-5.1.md` carries a "Worker choice recorded: GPT-6 Luna
   max" line that has no place in a project document.
5. **(M) `resources/ffmpeg/README.md` says "use static builds"** but the Linux
   x64 binary is `ELF ... dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2`
   (`file` output). `scripts/check-linux-glibc.js` already exists because of
   this. Correct the README so the next FFmpeg bump does not "fix" it.
6. **(L) `package.json` scripts `u` and `u2` are identical.** Remove `u2`.

### 2.2 Roadmap items accepted for 5.1: status versus acceptance criteria

| Item | Done | Not done (evidence) |
| --- | --- | --- |
| 1 Renderer split | `src/rosiEngine.ts` is 454 lines; feature modules under `src/engine/` and `src/engine/bind/` | `initializeRenderer` still exists (`src/rosiEngine.ts:70`); `window.rosiModules` has 46 references; the IIFE modules in `src/modules/` still attach to `window` |
| 2 Typed commands | `src/commands.ts` + `src/generated/ipc-types.ts` + contract test | `window.api` has 104 references outside tests; `src/rosiEngine.ts:95-134` still holds a hand-written default `Settings` literal although `get_default_settings` exists |
| 3 Typed IPC structs | settings enums; `FalliblePayload<T>` for `download_video`, `add_to_queue`, `resolve_download_options` | 10 commands still take `serde_json::Value`: `get_formats`, `get_video_info` (`media_info.rs:462,484`), `open_external`, `open_file_location`, `show_notification` (`platform.rs:182,204,242`), `save_settings` (`settings.rs:620`), `log_error` (`logging.rs:145`), `remove_from_queue`, `retry_queue_item`, `reorder_queue_item` (`queue.rs:1215-1231`) |
| 4 Coordinator | `coordinator.rs` (one command thread, reply channels, revisioned `queue-update`); the condition variables are gone | `queue.rs:40` still has the global `QUEUE: OnceLock<Mutex<QueueState>>`; `downloader.rs:79-85` still has `ACTIVE`, `STARTUP`, `EVENT_PUBLISH` mutexes. Acceptance said "no global Mutex or Condvar" |
| 5 Async proxy | Tokio relay, 256 active / 128 pending, 503 on overload, E2E probe | Polling remains: `network_security_async.rs:37,174-185` (`EXTERNAL_CANCELLATION_POLL` 25 ms per client task), `:686-702` (DNS reply polled with `try_recv` + 25 ms sleep); the DNS pool is still blocking threads with a condvar (`network_security.rs:56,398-440`). Acceptance said "no polling sleep" and "no measurable idle CPU" |
| 6 E2E regroup | `e2e/suites.json`, `--group` selection, `scenarioGroups` in reports | 23 files in `e2e/` still named `round*`/`audit*`/`*repair*`; `scripts/test-e2e.js` is 2,430 lines (target < 800) |

The coordinator and relay are sound as read (see 2.4), so items 4 and 5 are
"delivered with residue", not failures. The residue is scheduled in section 4.

### 2.3 FFmpeg size: measurements that shape the "gzip before packaging" ask

Sizes measured on this machine from `resources/ffmpeg/` (FFmpeg 9.0.2 builds,
all already stripped per `file`):

| Binary | Raw | gzip -6 | zstd -19 |
| --- | ---: | ---: | ---: |
| mac arm64 ffmpeg | 50.2 MB | 22.4 MB | 17.1 MB |
| linux x64 ffmpeg | 144.9 MB | 56.0 MB | 44.8 MB |
| win x64 ffmpeg.exe | 143.9 MB | 55.0 MB | 43.8 MB |
| mac arm64 ffmpeg+ffprobe tar | 100.3 MB | 44.7 MB (gzip) | **19.6 MB** (zstd --long=27) |
| win x64 ffmpeg+ffprobe tar | 287.6 MB | 110.0 MB (gzip) | 85.4 MB (zstd --long=27) |

Published 5.0.2 assets (`gh release view v5.0.2`):

| Asset | Size | Raw payload it contains (approx.) |
| --- | ---: | ---: |
| ROSI-Windows-x64.exe (NSIS, solid LZMA) | 63.7 MB | ~320 MB |
| ROSI-Windows-arm64.exe | 54.6 MB | ~190 MB |
| ROSI-MacOS-universal.dmg | 146.9 MB | ~300 MB |
| ROSI-MacOS-universal.zip | 145.7 MB | ~300 MB |
| ROSI.app.tar.gz (universal updater) | 149.4 MB | ~300 MB |
| ROSI-Linux-x64.AppImage (squashfs) | 175.9 MB | ~345 MB |
| ROSI-Linux-x64.flatpak | 99.3 MB | ~345 MB |

Conclusions the implementer must not skip:

- Every shipped container already compresses. The Windows installer's solid
  LZMA gets the whole payload to 63.7 MB, which is smaller than the two
  pre-gzipped FFmpeg files alone (110 MB). **Pre-gzipping FFmpeg makes the
  Windows installer larger**, because gzip output is incompressible to LZMA
  and solid compression can no longer share data between ffmpeg and ffprobe.
- The macOS compact updater (`.app.tar.zst --long=27`) already dedupes
  ffmpeg against ffprobe (19.6 MB for the pair). Pre-gzipped members would
  cost about +25 MB per per-arch update, reversing the 5.1 updater gain.
- DMG (UDZO zlib), ZIP (deflate) and AppImage (squashfs gzip) are roughly
  neutral: they compress about as well as gzip, so a pre-gzipped payload
  neither shrinks nor grows them much.
- On disk after install, the extracted binaries are still needed to run, so
  "gzip in the bundle plus extracted copy in app data" is a larger installed
  footprint, not a smaller one. On macOS the bundle's copy cannot be deleted
  after extraction without breaking the code signature.

What does reduce download size, measured or known:

| Lever | Expected effect | Cost |
| --- | --- | --- |
| Drop `rosi-ffprobe` and probe with `ffmpeg -i` | halves raw FFmpeg payload: DMG/ZIP/AppImage about -40%; Windows about -5% (LZMA already dedupes) | yt-dlp calls ffprobe directly for some post-processors; `ffmpeg_guard.rs` already intercepts those calls, so a launcher that maps `ffprobe` onto `ffmpeg -i` is feasible but needs careful output parsing; largest risk item |
| AppImage with zstd squashfs (`APPIMAGE_COMP=zstd` / appimagetool `--comp zstd`) | AppImage about 176 MB to ~120 MB | verify Tauri's appimage script honours the env var; runtime must support zstd (type 2 runtime does since 2020) |
| DMG converted to `ULMO` (LZMA) after Tauri builds it | DMG about 147 MB to ~90 MB | re-sign and re-verify the DMG; `zip-macos.js` and `e2e-macos-native-packages.mjs` already own DMG verification |
| Native (per-arch) macOS DMG/ZIP, already shipped in 5.1 | about -40% for arm64/x64 downloads versus universal | done |

**Decision required before workstream C (section 4) starts.** The ask was
"gzip the FFmpeg binaries before packaging". The numbers above say that as
stated it increases the Windows installer and the macOS compact update and
reduces nothing else measurably. The plan therefore (a) keeps the requested
implementation fully specified in workstream C so it can be built if the goal
is something the numbers do not capture (for example, a size limit on an
intermediate artifact store or the Microsoft Store MSIX), and (b) puts a
mandatory measure-and-decide gate (C0) in front of it that produces a
before/after table per artifact from real builds. If C0 confirms the numbers
above, implement the "what reduces size" levers instead and record the
decision in `docs/IMPLEMENTATION-5.1.md`.

### 2.4 Code review notes on the new 5.1 code

Reviewed for races and lock discipline; no defect found that needs a code
change before beta.2, but record these so they are not re-derived:

- `coordinator.rs`: `evaluate_start` spawns `run_queue` while the queue guard
  is held. Safe: the runner's first action is a `ClaimNext` request, which the
  coordinator only handles after the current command returns and the guard
  drops. `register` is a non-blocking send made under the downloader lock, so
  a `Terminal` for the same session is always ordered after it.
- Cancel while the runner is between `ClaimNext` and `start_download`:
  `CancelBegin` sees `active_item_id`, `cancel_session` finds no session and
  returns via `await_finalized(None)`, the runner's `Attempt` answers false and
  `ItemUnstarted` records exactly one cancelled outcome. If the session became
  visible first, `SessionStarted` returns `Some(true)` and the runner cancels
  it. Matches failure-mode rows 1 and 9 in
  `e2e/v5-fixes/queue-coordinator/failure-modes.md`.
- `queue::stop()` (used on close/restart) cancels whatever session is active,
  including a manual one. That is the documented intent of `kill_all_processes`.
- `network_security_async.rs`: `ProxyShared::cancelled()` wakes every 25 ms
  per client because the downloader's cancellation is an `AtomicBool`
  (`downloader.rs` `network_cancellation`). With 256 tunnels that is about
  10,000 wakeups per second at idle. Not a correctness bug; it is the item 5
  residue (workstream B8).
- `download_options.rs` is the single precedence rule (settings < preset <
  explicit); the renderer still builds its own override map in
  `src/engine/presets.ts` `buildOnScreenPresetOverrides`. Two sources of
  truth; workstream B2 removes the renderer copy.
- `downloader.rs` is 3,207 lines (session start, yt-dlp exit handling,
  caption sidecars, conversion, publication). Not a 5.1.0 blocker; split is
  workstream B10.

---

## 3. Workstream A: hygiene and evidence (do first)

A1. Remove the two `ModuleAnalysisCache` files; add ignore rules; confirm
`git ls-files | grep -i ModuleAnalysisCache` is empty.

A2. Rewrite the `5.1.0-beta.1` section of `CHANGELOG.md` to cover every
user-visible change in `git diff 352acee..HEAD` (list in finding 3). Keep the
existing updater and packaging bullets. One bullet per feature, in the
established `**Area:** text` style. No em dashes (`validate:no-em-dash`).

A3. Update `docs/ROADMAP-5.1.md` statuses for items 4, 5, 6 to "implemented
with residue, see IMPLEMENTATION-5.1.md" and list the residue exactly as in
section 2.2. Add `coordinator.rs`, `download_options.rs`,
`network_security_async.rs` to the `ARCHITECTURE.md` module table. Remove the
"Worker choice" line from `docs/IMPLEMENTATION-5.1.md`. Fix the FFmpeg README
"static" claim. Delete the `u2` script.

A5. Fix the stale updater scenarios (findings 1a and 1d). In
`e2e/state-updater-repairs.spec.js`, `e2e/round2-renderer-repairs.spec.js`
and `e2e/v5-fixes/flatpak-updates/flatpak-update-notice.spec.js` make each
adapter's `invoke` return `null` for `get_compact_updater_target` so the
existing scenarios keep proving what they were written for (beta-target
generation fencing, single-flight downloads, Flatpak feed-only mode). Add one
scenario for the 5.1 compact path: the adapter returns
`darwin-beta-aarch64-app-zst` from `get_compact_updater_target`, `check()`
throws once for the compact target, and the renderer falls back to
`darwin-beta-aarch64-app` (`legacyTarget` in `src/updater.ts`) and emits
`available`; assert both feed records in `auditFeedRecords`. Keep this
scenario when B1 moves the updater to Rust (it becomes the Rust fallback
proof). Also give `scenarioNames` in `e2e/suites.json` the new name.

A6. Fix the macOS RST in the proxy overload path (finding 1c).
`reject_client` in `src-tauri/src/network_security_async.rs`: after
`write_all` and `shutdown()`, drain the client with a bounded read loop (for
example up to 64 KiB or 250 ms, whichever first) so the kernel does not reset
the connection with unread input, then drop. Run
`e2e/v5-fixes/async-proxy/run.mjs` ten times on macOS
(`for i in $(seq 10); do node e2e/v5-fixes/async-proxy/run.mjs || break; done`
after a gate build) and record the ten reports under the ledger. The same
drain applies to the "Proxy Admission Timeout" 503 in `run_proxy`.

A7. Decide the macOS window mode for release evidence (finding 1d,
`main.spec.js`). `e2e/README.md` makes background mode
(`ROSI_E2E_BACKGROUND=1`, accessory activation policy, window below other
apps) the local macOS default, but in that mode the Reset-All modal click is
not registered within the scenario's 300 ms settle and the close-flow
scenario loses the WebDriver session, while the same spec passes in
foreground. Either make background mode reliable (the modal confirm click in
`clickModalButton` and the close-flow wait at `main.spec.js:4382` are the two
places to instrument; an accessory-policy app may need an explicit
`activate` before synthetic clicks) or require `ROSI_E2E_FOREGROUND=1` for
release evidence on macOS and say so in `e2e/README.md` and
`docs/RELEASE-STABLE.md`. Do not leave the default in a state where the
documented local command fails on a clean tree.

A4. Produce real full-gate evidence for the current commit (after A5, A6,
A7, D0):

```sh
npm run test:all -- --require-clean-proof   # macOS, this machine
```

then the same on Windows x64 and Linux x64 release machines (Windows arm64 at
least `npm run test:e2e`). Open a PR from `next-5.1.0` to `beta` so CI runs the
six-job matrix; attach the `e2e-*` artifacts to the 5.1 ledger
(`docs/IMPLEMENTATION-5.1.md`, "Required support and proof matrix"). The
memory note for this repo says the macOS `download-process-repairs` scenario
flakes on execute/async timeouts: re-run once before debugging a failure
there.

Acceptance: a passing `fullSuite: true` report per required platform whose
`commit` equals HEAD, referenced from the ledger. Until then the beta stays
unpromotable by the stable runbook.

---

## 4. Workstream B: start of the Rust migration (non-UI code out of TypeScript)

Principle: the renderer keeps DOM, focus, and presentation. Policy, state
machines, parsing and validation move to Rust behind typed commands and
events. Each sub-item is one change with its own failure-mode note and E2E
scenario. Order is by value over risk.

### B1. Updater orchestration to Rust (biggest non-UI module: `src/updater.ts`, 572 lines)

Today `src/updater.ts` owns channel/target selection, the compact-feed
fallback, generation counters for check/download/install, cancellation
semantics ("the plugin cannot abort an in-flight download"), and the Flatpak
manual-install rule, all on top of `@tauri-apps/plugin-updater`'s JS API. The
vendored Rust plugin already exposes everything needed
(`UpdaterBuilder::target`, `timeout`, `on_before_exit`, `Update::download`
with a progress closure, `install`, `download_and_install`; see
`src-tauri/vendor/tauri-plugin-updater/src/{lib,updater}.rs`).

Plan:

1. Failure modes first: `e2e/v5-fixes/updater-engine/failure-modes.md`. Port
   every guard that `src/updater.ts` encodes today: stale check result after a
   channel change, download completing after cancel, install of a candidate
   that is not the downloaded one, channel save failing before revalidation,
   compact target failing over to the universal feed, retired Linux deb/rpm
   targets, Flatpak feed-only mode, dev-mode refusal, `restart_app` refusal
   keeping the identity for retry.
2. New module `src-tauri/src/updater.rs` with one state-owning thread (same
   pattern as `coordinator.rs`): commands `check_for_updates`,
   `download_update { candidate_id }`, `install_update { candidate_id }`,
   `cancel_update_download`, `set_update_channel { channel }`; events
   `updater-status` and `updater-progress` with the same payload shapes as
   `UpdaterStatusEvent` / `UpdaterProgressEvent` (add them to `types.rs` so
   `ts_bindings` generates them). Target selection reuses
   `platform::get_beta_updater_target` and `get_compact_updater_target`.
3. The e2e feature: add `e2e_configure_updater { endpoint, pubkey }` so the
   E2E media server can serve `latest-*.json` manifests signed with a test
   minisign key (vendored builder has `endpoints()` and `pubkey()`). This
   replaces the jsdom-only `round3-renderer-repairs/updater.cjs` checks with
   real app scenarios.
4. Renderer: `src/engine/updater-ui.ts` subscribes to the two events and calls
   the commands through `commands.ts`. Delete `src/updater.ts`, the
   `__ROSI_E2E__.updaterAdapter` seam, the `@tauri-apps/plugin-updater`
   dependency in `package.json`, and `updater:allow-check/download/install`
   from `src-tauri/capabilities/default.json`. `src/modules/updates.ts`
   `isPrereleaseVersion` becomes a `version` field in `updater-status`.
5. E2E: `e2e/v5-fixes/updater-engine/updater-engine.spec.js` covering the
   failure-mode rows; keep `state-updater-repairs.spec.js` passing unchanged.
   Then `npm run test:e2e:updater-zst` on macOS.

Acceptance: no `@tauri-apps/plugin-updater` import in `src/`; every
`UpdaterStatusEvent` variant is produced by a Rust path and observed by an E2E
scenario; the capability file no longer grants the updater plugin to the
webview.

### B2. One source of truth for download-option precedence

`download_options::resolve_value` is authoritative. Remove the renderer's
copy: `buildOnScreenPresetOverrides` and the field-by-field
`applyPresetToSettings` in `src/engine/presets.ts`. The renderer sends
`{ url, outputPath, presetId, formats, playlist, ...explicit on-screen
changes }` and renders what `resolve_download_options` returns, including
for the effective-options summary (`src/engine/messages.ts`) and the manual
Download button. Extend `e2e/v5-fixes/download-options/` with a scenario that
changes a preset's stored value after it was selected and checks that the
summary and the started download agree with Rust, not with the cached
renderer settings.

### B3. Default settings from Rust only

Replace the hand-written `Settings` literal in `src/rosiEngine.ts:95-134` with
`get_default_settings` (fall back to a minimal `{ settingsVersion, theme:
'system' }` only if that call also fails, and surface the error). Add an E2E
scenario that corrupts `settings.json` and checks the defaults the app
renders match the Rust defaults (compare the sidebar values to
`get_default_settings`). This closes the roadmap item 2 criterion "no
hand-written copy of `Settings`".

### B4. Typed IPC for the remaining `serde_json::Value` commands (roadmap item 3)

Convert the ten commands in section 2.2 to `FalliblePayload<T>` with typed
request structs (`QueueItemId`, `QueueReorder`, `NotificationRequest` already
exists in `types.rs`, `Url`, `FilePath`, `LogMessage`, `Settings` partial).
Keep the validators (`validation.rs`) running on the typed values so every
security rejection still fires; keep each error message string identical so
existing E2E expectations hold. Add the new structs to `ts_bindings` and
tighten `src/commands.ts`. E2E: the settings-rejection and security suites
already assert the error envelopes; run them (`--group settings,network-policy`)
then the full gate.

Acceptance: `grep -n "Value" src-tauri/src/*.rs | grep "tauri::command" -A2`
shows no command parameter typed as `Value`; `validation.rs` loses the
shape checks the types now enforce and keeps the policy checks.

### B5. Format labels in Rust

Add `display_label: String` to `FormatEntry` (built in `media_info.rs` from
the same rules as `formatFormatEntry`) and delete
`src/modules/downloads.ts` `formatFormatEntry`. `formatBytes` stays in the
renderer (it is presentation). Extend `typed-formats.spec.js` to assert the
option text equals `displayLabel`.

### B6. Renderer seams (roadmap items 1 and 2 residue)

Not a 5.1.0 blocker. After B1 to B5, count the remaining `window.api` and
`window.rosiModules` references and schedule their removal per feature in
5.1.x: convert `src/modules/*.ts` IIFEs to ES modules with explicit
dependency objects, then delete `src/renderer-globals.d.ts` entries as they
become unused. `tauri-bridge.ts` stays until the E2E specs that drive
`window.api` are migrated with it, as the roadmap already states.

### B7. Finish the coordinator ownership model (roadmap item 4 residue)

Target: `queue::state()` becomes private to the coordinator thread (no
`OnceLock<Mutex<QueueState>>` read outside `coordinator.rs`; `get_queue`
answers through a `Snapshot` request), and the downloader's session slot
(`ACTIVE`, `STARTUP`, `EVENT_PUBLISH`) is replaced by a `Session` owned by a
session thread that the coordinator starts and addresses by id. Write the
failure-mode rows for every transition in `downloader::cancel_session`,
`complete_session`, `start_download`, and `on_ytdlp_exit` before touching
them. This is the riskiest change in the plan; do it after B1 to B5 and only
with the full gate green on all platforms. If it does not fit 5.1.0, record it
as 5.1.x in the roadmap with the exact remaining globals listed.

### B8. Remove the relay's polling (roadmap item 5 residue)

- Replace `network_cancellation: Arc<AtomicBool>` with a
  `tokio::sync::watch::Sender<bool>` (or a `Notify`) created in
  `start_download` and set in `cancel_session`; `ProxyShared::cancelled()`
  then awaits the change instead of sleeping 25 ms.
- Replace the DNS reply polling in `network_security_async::resolve_destination`
  with a `tokio::sync::oneshot` reply from the resolver worker, or move system
  DNS to `tokio::task::spawn_blocking(lookup_host)` bounded by a semaphore of
  `DNS_RESOLVER_WORKERS`; keep cancellation and the answer-count cap.
- Keep `ip_policy.rs` as the only destination check.

Acceptance (from the roadmap): no `time::sleep`-based polling in the relay;
an idle guard with one open tunnel shows no measurable CPU over 60 s (record
with the existing `e2e_network_pipelining_probe`: add `idleWakeups` counted
from a debug counter behind `cfg(feature = "e2e")`); the 256-tunnel,
503-overload, cancel and drop scenarios in `e2e/v5-fixes/async-proxy/` pass
unchanged.

### B9. Queue URL extraction in Rust (optional)

`extractHttpUrls` / `normalizeHttpUrl` in `src/engine/core.ts` duplicate
`normalize_queue_url` in Rust. Add `extract_queue_urls { text }` returning
`{ urls, rejected }` and use it for the batch-paste path; keep the per-keystroke
`isValidUrl` in the renderer for instant feedback. Low value; do last or defer.

### B10. Split `downloader.rs` (no behaviour change)

Move conversion (`execute_ffmpeg`, `convert_one`, `run_conversion`,
`complete_conversion_batch`) to `conversion.rs` and publication
(`install_download_output*`, caption sidecars, `publish_*`, `retire_staged_source`)
to `publication.rs`. Pure move; the full gate is the proof. Do after B7 or
skip for 5.1.0.

---

## 5. Workstream C: FFmpeg compressed sidecars ("workers gzip before packaging")

Interpretation used here: "workers" are the release build machines
(`release:win`, `release:mac`, `release:linux` in `package.json`), which run
`prepare-sidecars` before `tauri build`. If "workers" meant something else
(for example a CDN worker), stop and ask before C1.

### C0. Measure-and-decide gate (mandatory, one day)

1. On each release machine, build the current artifacts and record sizes:
   `build:win:x64`, `build:win:arm64`, `build:mac:native` + `build:mac:updater-zst`,
   `build:linux:x64`, `flatpak:bundle`.
2. Build the same with the sidecar archive from C1 (behind
   `ROSI_COMPRESSED_SIDECARS=1` so both layouts can be produced from one tree).
3. Write both rows into `docs/IMPLEMENTATION-5.1.md` ("Performance and
   artifact acceptance" already demands before/after evidence) with sha256 and
   host identity, using `scripts/benchmark-51.mjs --compare`.
4. Decision rule: proceed with C2 to C5 only for platforms where the
   download size or an explicitly stated other goal improves. If no platform
   improves (section 2.3 predicts this), implement C6 instead and leave C1
   behind the environment flag, or remove it.

### C1. Build-side archive (release machines)

- `scripts/prepare-sidecars.js`: new option `--compressed-ffmpeg`. For the
  target triple, verify ffmpeg/ffprobe against `resources/ffmpeg/checksums.json`
  as today, **sign them first** (Windows: run the same `signCommand` from
  `src-tauri/tauri.windows.conf.json` via `scripts/windows-artifact-sign.ps1`;
  macOS: `codesign --force --timestamp --options runtime --sign "$APPLE_SIGNING_IDENTITY"`
  with `src-tauri/entitlements.plist`; Linux: none), then write
  `src-tauri/binaries/media-tools.tar.gz` containing exactly `ffmpeg` and
  `ffprobe` (plus `.exe` on Windows) and `src-tauri/binaries/media-tools.json`
  `{ triple, ffmpegVersion, archiveSha256, members: { ffmpeg: { sha256, size, mode } , ffprobe: {...} } }`.
  gzip level 6 by default; keep a `--format zstd` switch so C0 can compare
  (zstd dedupes the pair: 19.6 MB vs 44.7 MB on macOS arm64).
- The archive path is fixed, so each `build:*:prepared` step for a different
  triple must re-run `prepare-sidecars --target <triple> --compressed-ffmpeg`
  immediately before its `tauri build --target`. `package.json` already
  sequences prepare before each build; add the per-target call where two
  targets share one prepare today (`build:win:prepared`, `build:mac:native:prepared`).
- `src-tauri/tauri.conf.json`: remove `binaries/rosi-ffmpeg` and
  `binaries/rosi-ffprobe` from `externalBin`; add
  `"binaries/media-tools.tar.gz": "media-tools/media-tools.tar.gz"` and the
  JSON manifest to `bundle.resources`. `rosi-yt-dlp` stays an externalBin.
- `src-tauri/build.rs`: verify the archive's sha256 against the manifest, the
  manifest `triple` against `TARGET`, and refuse stub members in release
  profile (stub = a member under 4 KiB containing `ROSI-SIDECAR-STUB`).
- Flatpak (`run.rosie.rosi.yml`): copy the archive and manifest into
  `/app/lib/rosi/media-tools/`; the runtime path below reads them from the
  resource dir.

### C2. Runtime extraction (`src-tauri/src/sidecars.rs`)

- `media_tools_dir()` = `<app data>/media-tools/<archiveSha256[..16]>/`.
- `ensure_media_tools() -> Result<MediaTools { ffmpeg, ffprobe }, String>`:
  return at once when `<dir>/.complete` exists and both member hashes match
  the manifest (hash check once per process, cached in a `OnceLock`).
  Otherwise extract into `<dir>.tmp-<uuid>` with a bounded reader (member
  count exactly 2, regular files only, no links, name must equal the manifest
  entry, decompressed size capped by manifest size + 1 MiB, path confined),
  verify each member's sha256, `chmod 755`, fsync, rename the directory into
  place, write `.complete`. Serialize concurrent callers with a process
  mutex; a second process racing on the rename sees the winner's `.complete`.
  Remove older `<app data>/media-tools/*` directories on startup.
- Dependencies: `flate2` and `tar` (both already compiled for the vendored
  updater on macOS). Adding them to `src-tauri/Cargo.toml` needs the usual
  review: `npm run licenses:cargo:strict`, `cargo audit`,
  `check:cargo-update-policy`. If `--format zstd` wins C0, use the `zstd`
  crate the vendored updater already depends on.
- Callers: `bundled_ffmpeg()` becomes `ensure_media_tools().map(|t| t.ffmpeg)`;
  `verify_bundled` runs the extraction on the existing startup thread so the
  first download rarely waits; `start_download` sends a
  "Preparing media tools…" progress line if extraction is still running and
  fails closed with a clear message if it fails (never fall back to a PATH
  ffmpeg silently; `effective_ffmpeg`'s existing custom-path and PATH order
  stays). `ffmpeg_guard.rs` and `gpu.rs` resolve through the same function.
- Windows AppLocker or a non-executable app-data mount: extraction succeeds
  but spawn fails; report the path in the error and point at the custom
  FFmpeg path setting.

### C3. Signing and verification pipeline changes

- `scripts/zip-macos.js`: today it requires every `Contents/MacOS` sidecar's
  signed entitlements to equal the host's. Replace the ffmpeg/ffprobe checks
  with: extract the archive to a temp dir, `codesign --verify --strict` each
  member, check Developer ID team and timestamp, check `lipo -archs` and
  `minos` for the target arch (reuse `verifyMachOCompatibility`).
- `scripts/pack-macos-updater-zst.js`: remove ffmpeg/ffprobe from
  `THIN_MEMBERS`; add the archive and manifest to the members that must be
  present; keep yt-dlp in `MULTI_ARCH_MEMBERS`.
- Vendored updater `install_safety.rs`
  `macos_bundle_executable_supports_host_arch`: keep the check for `rosi`
  and `rosi-yt-dlp`; add a manifest `triple` check for the archive. Record
  the change in `PATCHES.md` and regenerate `ROSI.patch`.
- `scripts/gpg-sign.js` `assertNoStubSidecars` and `scripts/msstore-pack.js`
  `planSidecars`: read `media-tools.json` instead of the two sidecar entries.
- Notarization dry run (macOS): build, sign, submit with `notarytool`, and
  confirm the pre-signed members inside the archive do not fail the scan.
  Do this once on a throwaway build before changing the release chain.
- `scripts/e2e-macos-native-packages.mjs` and `verify-release-draft.js`: the
  bundle inventory and size comparison must include the archive.

### C4. E2E

`e2e/v5-fixes/media-tools/failure-modes.md` (write first), then
`media-tools.spec.js` and `run.mjs` (needs its own profile and env):

1. Fresh profile: first download extracts, verifies, and converts
   successfully; the report records the extracted hashes.
2. Corrupted archive (one flipped byte, via an e2e-only env override of the
   resource path): download fails closed with the documented message; no
   partial directory remains.
3. Manifest hash mismatch for one member: same as 2.
4. Tampered extracted binary (edit a byte in app data after extraction):
   re-extraction on next start replaces it.
5. Two concurrent operations on a cold profile (manual download + format
   fetch): exactly one extraction, both succeed.
6. Read-only app-data directory: fails closed; app stays usable for
   yt-dlp-only downloads that need no FFmpeg.
7. Upgrade: a stale `media-tools/<oldhash>/` directory is removed on start.
8. Custom FFmpeg path set: the archive is still verified but the custom path
   is used (existing behaviour).

Evidence: `e2e/artifacts/v5-fixes-media-tools/<timestamp>/report.json`.
Add the group to `e2e/suites.json`.

### C5. Docs

`ARCHITECTURE.md` ("Sidecars and releases"), `build-setup.md` ("Bundled
sidecars"), `resources/ffmpeg/README.md`, CHANGELOG bullet, and the
key-compromise doc if the macOS signing identity now signs files on the
worker before Tauri runs.

### C6. If C0 says no: the levers that do shrink downloads

Implement in this order, each with its own before/after row in the ledger:

1. AppImage zstd squashfs: set the compression in the Linux build step
   (Tauri honours `APPIMAGE_COMP`; verify in the installed `@tauri-apps/cli`
   version, otherwise post-process with `appimagetool --comp zstd`), confirm
   the AppImage still launches on Ubuntu 24.04 and the updater's
   `appimage_archive.rs` bounds still hold.
2. DMG as `ULMO`: convert after `tauri build`, re-sign the DMG, and run
   `e2e-macos-native-packages.mjs --require-real-builds`.
3. ffprobe removal study: measure how many yt-dlp code paths call ffprobe
   with the current argument set (`ffmpeg_guard.rs` can log them in the e2e
   feature), prototype an `ffprobe` launcher that runs `ffmpeg -i` and
   formats the JSON yt-dlp expects, and run the conversion and caption
   scenarios against it. Ship only if every scenario passes on all three
   platforms. This is the only lever that helps Windows.

---

## 6. Workstream D: UI improvements to finish for 5.1.0

`e2e/v5-fixes/ui-polish/failure-modes.md` lists 20 failure modes; the spec
covers rows 1 to 4, 6, 7, 10, 12 to 14, 17 to 20 in eight scenarios, and
five of the eight fail on macOS today (finding 1d). Start with:

D0. Triage each failing ui-polish assertion as "spec assumption" or "product
gap" and fix on the right side, one scenario per change:

- `:333` effective summary never resolves: the scenario starts on a fresh
  profile with no download folder. Either the scenario must set
  `downloadFolder` (spec) or the summary must resolve with the app default
  folder when `askDownloadLocation` is off (product; check
  `buildEffectiveOptionsReadiness` in `src/engine/bind/settings-controls.ts`,
  which returns `destination` for an empty folder even though
  `download_options::resolve_output_path` would fall back to the downloads
  directory). The product reading is the better one: the renderer should not
  block a preview that the backend can resolve.
- `:423` and `:478` section-reset focus: confirm that `showModal` moves focus
  into `#app-modal` and that the `[data-reset-section]` buttons are real
  `<button>` elements reachable by `focus()` while the sidebar is open; if the
  sidebar animation hides them at the moment of the call, the spec must wait
  for the sidebar transition.
- `:586` `execute/async` timeout on `addToQueue` for the second URL: find why
  the bridge promise does not settle (the queue was left running by an
  earlier scenario, or the e2e media URL is unreachable in ONLY mode); the
  coordinator spec adds items without this timeout, so compare the two.
- `:789` `settingsSearch` focus after the theme matrix: the sidebar is
  reopened right before the `focus()` call; wait for it to be visible.
- Background-only failures (`:485` focus trap, `:644` queue focus) follow A7.

Then finish the rest and the visible debt found in the audit:

D1. Row 5 (readiness): when the destination is missing, the runtime check
failed, or the format lookup failed, keep the reason and the next action
visible next to the Download button, not only in the summary line. Scenario:
missing folder with "ask each time" off.

D2. Row 8 (activity re-render): preserve keyboard focus on the focused row's
action across `download-activity-update`; announce new entries once (polite),
never per progress tick. Scenario: focus an activity action, trigger a
completion, assert `document.activeElement`.

D3. Row 9 (queue action errors): when `retry`/`remove`/`reorder`/`open
location` returns an error envelope, restore the control, show the message
inline on the row, and keep the row's other actions enabled. Scenario: remove
the downloading item (expected `VALIDATION_ERROR`) and check the row state.

D4. Row 11 (long content): very long paths, URLs, titles and error messages in
the queue, activity, console and the folder summary must wrap or truncate
without horizontal overflow at 900x560. Scenario: 400-character URL and path.

D5. Row 15 and 16 are implemented for the wizard (`wizard-folder-error`,
`wizard-error`, Deno states); add the same cancelled/failed folder feedback
to the sidebar "Change folder" button and to "ask each time" switching, and
reuse `UI_MESSAGES.wizard.*` strings.

D6. Move the `role`/`aria-live` attributes that `rosiEngine.ts` sets on
`#queueStatusMessage` at runtime into `src/index.html`, like the 5.1 markup
for `#settingsSaveFeedback` and `#downloadOutputSummary`.

D7. Screenshot matrix: the ui-polish spec must write screenshots for the
four themes at 900x560 and 1200x900 (row 18 to 20) into the report's
`screenshots` list so `verifyScreenshots` in `scripts/test-e2e.js` checks
them. Confirm they are produced in the full gate, not only in a group run.

Keep the layout and visual identity (ledger milestone 6). No new major
features.

---

## 7. Workstream E: E2E organisation (roadmap item 6 residue)

E1. Rename the round/audit/repair files to feature names with `git mv` and
update `e2e/suites.json` `owners.*.entrypoint`, `scripts/test-e2e.js`, the
`ROSI_REPAIRS_SPEC` references, and the failure-mode documents' titles.
Scenario names inside the files do not change, so `expectedScenarios` stays
identical and release evidence stays comparable. Target: no file name under
`e2e/` contains `round`, `audit`, or `repair`.

E2. Make the gate finish every pass before it fails (finding 1b): wrap each
`runPass` in `scripts/test-e2e.js:1999-2070` the way the `v5Passes` loop
already does (record `status`/`reason` per pass, continue, then fail at the
end with every pass's result in the report). `fullSuite` and release proof
semantics do not change: the gate still fails if any pass failed. Keep the
existing per-pass fresh profile. Then split `scripts/test-e2e.js` by runner kind: `scripts/e2e/manifest.js`
(validation, groups, inventory), `scripts/e2e/fixtures.js` (tone, page, DASH
fixtures), `scripts/e2e/runners/*.js` (one per runner owner), and
`scripts/test-e2e.js` as the orchestrator under 800 lines. Pure refactor;
`npm run test:e2e` must produce the same `expectedScenarios` and the same
pass/fail set before and after (compare reports with
`scripts/benchmark-51.mjs --compare`).

E3. Make the stability run (`test:e2e:stability`) part of the macOS
release-machine checklist in `docs/RELEASE-STABLE.md`, because of the known
`download-process-repairs` flake.

---

## 8. Order, gates and sequencing

1. A1 to A3 (half a day), A5 to A7 and D0 (two to three days), then A4 on
   this Mac. Nothing else merges until A4 has a passing full-gate report for
   HEAD on macOS. Do E2's "finish every pass" change together with A5 so one
   stale assertion can never again hide 82 scenarios.
2. B3, B5, B4 (typed IPC), B2: small, independent, each followed by the
   affected `--group` run and then the full gate. Tag `v5.1.0-beta.2` after
   these plus A4 evidence on Windows and Linux.
3. D1 to D7 in parallel with step 2 (renderer only).
4. B1 (updater engine). Needs the macOS release machine for
   `test:e2e:updater-zst --require-real-builds`. Tag `beta.3`.
5. C0 decision; then C1 to C5 or C6. Tag `beta.4`.
6. B8 (polling removal), E1 to E3. Tag `beta.5` and start the stable soak.
7. B7, B10, B6, B9: only if the soak clock has not started; otherwise move
   them to the 5.1.x roadmap with their exact residue listed.

Every step: failure-modes document first, code second, E2E report third,
docs and CHANGELOG in the same change. Run `npm run test:all --
--require-clean-proof` before each tag on all three platforms.

---

## 9. Acceptance summary for 5.1.0 stable

- Full-gate reports (`fullSuite: true`, `passed: true`, HEAD commit) retained
  for macOS 15+, Linux x64, Windows x64 and arm64, and referenced from
  `docs/IMPLEMENTATION-5.1.md`.
- `git ls-files` has no `ModuleAnalysisCache`; CHANGELOG lists every 5.1
  change; ROADMAP and ARCHITECTURE match the code.
- No `serde_json::Value` command parameter; no hand-written `Settings`
  default in `src/`; `src/updater.ts` and `@tauri-apps/plugin-updater`
  removed; the relay has no polling sleep.
- The FFmpeg size decision is recorded with measured before/after artifact
  sizes per platform, and whichever path was taken has its E2E report.
- UI rows 1 to 20 of the ui-polish failure modes each map to a scenario.
- No file name under `e2e/` contains `round`, `audit`, or `repair`;
  `scripts/test-e2e.js` is under 800 lines.
- `plan.md` is deleted.

---

## Appendix: commands used in the audit

```sh
npm run typecheck && npm run lint && npm run format:check && npx vitest run
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets
npm run test:e2e
gh release view v5.0.2 --json assets --jq '.assets[] | [.name, .size] | @tsv'
gh run list --branch next-5.1.0 --limit 6
file resources/ffmpeg/*/*/ffmpeg*; codesign -dv resources/ffmpeg/mac/arm64/ffmpeg
gzip -6 -c <binary> | wc -c; zstd -19 --long=27 -c <pair.tar> | wc -c
grep -rn "window\.api" src | grep -v src/tests | wc -l      # 104
grep -rn "rosiModules" src | grep -v src/tests | wc -l      # 46
ls e2e | grep -iE "round|audit|repair" | wc -l               # 23
wc -l scripts/test-e2e.js                                    # 2430
```
