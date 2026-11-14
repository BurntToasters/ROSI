# ROSI 5.1 implementation and evidence ledger

## Accepted delivery

The following six milestones are accepted for ROSI 5.1. Acceptance is scope,
not a completion claim. This ledger records evidence produced by the verification
foundation at the current worktree snapshot; other workstreams must update their
own status when they produce implementation and platform evidence.

The only full-gate pass recorded for this milestone set is macOS arm64 at commit
`9e60f970d2a62d636a019d7b15975c9814364dde`. That commit predates HEAD
`8e32e90`, so it is not evidence for the current tree. No platform has full-gate
E2E evidence at the current HEAD yet. Windows x64 has E2E evidence on an
uncommitted tree based on `8e63cd8`; see the 5.1 audit section.

| #   | Milestone                                                                 | Evidence status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Baseline evidence and E2E organization                                    | The E2E manifest and feature-group selector are implemented. A current inventory capture is retained on Windows x64. It records discovered scenarios separately from execution. The initial full baseline report was overwritten while the shared artifact tree was changing; that report is unavailable and has not been reconstructed. Runtime measurements remain missing. A macOS arm64 full-suite E2E report at `9e60f970d2a62d636a019d7b15975c9814364dde` passed 120 expected scenarios (see the proof matrix).                                                                                                                 |
| 2   | Native macOS distribution and artifact verification                       | The native macOS artifact verifier is in progress in a separate workstream. No native macOS package build or size comparison is recorded here. On macOS arm64, `npm run test:e2e:updater-zst` (without `--require-real-builds`) passed 12/12 on 2026-11-07 using derived per-architecture archives; the commit for that run is not recorded here. The signed per-architecture `--require-real-builds` run, signing, notarization, and package size comparison have not run.                                                                                                                                                           |
| 3   | Typed formats, shared option resolution, structured lifecycle consumption | Typed formats, shared option resolution, and preset preview are implemented: format lists are built from structured backend data, and preset Apply resolves through the backend (`resolve_preset_options`). The macOS arm64 full gate passed at `9e60f970d2a62d636a019d7b15975c9814364dde`. Lifecycle acceptance, integration, and cross-platform proof remain outstanding.                                                                                                                                                                                                                                                           |
| 4   | Queue/session coordinator migration                                       | Implemented: `coordinator.rs` owns queue state and transitions (one command thread, reply channels, revisioned `queue-update`), and `downloader/session_owner.rs` owns session state. The former `QUEUE`, `ACTIVE`, `STARTUP`, and `EVENT_PUBLISH` globals are removed, and `queue.rs` and `downloader.rs` have no global `Mutex` or `Condvar` outside tests. The macOS arm64 full gate that passed at `9e60f970d2a62d636a019d7b15975c9814364dde` predates HEAD; full-gate proof at HEAD is outstanding on every platform. See [ROADMAP-5.1.md](ROADMAP-5.1.md) (B7).                                                                 |
| 5   | Async proxy migration                                                     | Implemented with residue: the Tokio relay in `network_security_async.rs` serves 256 active and 128 pending clients. The relay wakes on a cancellation watch channel and DNS replies arrive over oneshot channels, so it has no polling sleeps. Residue: the DNS pool (`network_security.rs`, `DnsResolverPool`) still uses blocking worker threads with a condvar, and its blocking caller, `resolve_system_dns_with_cancel` (`network_security.rs:808`), checks the reply every 25 ms (`DNS_RESOLUTION_POLL_INTERVAL`). The relay's own DNS lookups await the reply instead. Required-platform full-gate proof is still outstanding. |
| 6   | Full-app polish and integrated release candidate                          | Accepted; the integrated candidate and full required-platform E2E proof remain outstanding. The macOS arm64 full gate passed at `9e60f970d2a62d636a019d7b15975c9814364dde`. No other platform has a build or app E2E run.                                                                                                                                                                                                                                                                                                                                                                                                             |

Milestone 6 keeps ROSI's visual identity and layout while improving downloads,
queue management, settings, onboarding, and accessibility. It does not add the
major features listed as deferred below.

## Required support and proof matrix

ROSI 5.1 must retain the current supported platforms: macOS 15 and newer, Linux
x64, and Windows x64 and arm64. A Windows x64 inventory capture does not prove
the app or release artifacts. Windows x64 E2E results on the uncommitted tree
are in the 5.1 audit section below.

| Platform      | Evidence from this foundation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS 15+     | Apple silicon (arm64), macOS 27.2. Full gate `npm run test:all -- --require-clean-proof` passed at commit `9e60f970d2a62d636a019d7b15975c9814364dde`, completed 2026-11-08T00:01:02Z. Every check passed. The full-suite E2E report passed with 120 expected scenarios and 26 screenshots, and a release quality-gate proof was recorded. Window mode was background (`ROSI_E2E_BACKGROUND=1`). Report: `e2e/artifacts/e2e-report-darwin-arm64.json`, SHA-256 prefix `687e91abd3249ec8`. `npm run test:e2e:updater-zst` passed 12/12 on 2026-11-07 using derived per-architecture archives, without `--require-real-builds`. Not run: the `--require-real-builds` updater run with signed per-architecture builds, signing, notarization, and native package size comparison. No macOS x64 result is recorded. |
| Linux x64     | No build or app E2E performed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Windows x64   | Benchmark inventory captured on this host. E2E on the uncommitted tree based on `8e63cd8`: core three runs passed 3 of 3, and `test:all` passed with 120 E2E scenarios passed and 4 allowed platform skips. Not a clean release proof. See the 5.1 audit section. No release artifact verification performed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Windows arm64 | No build or app E2E performed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Existing archived reports are recorded as references only. This work does not
claim that historical baseline runs passed or that their results correspond to
the saved clean snapshot.

## Baseline artifact

The retained current-only inventory is
`e2e/artifacts/benchmark-51-current-final-win32-x64.json`, with its adjacent
`.sha256` file. It records the source revision and dirty-file hashes, the saved
clean-snapshot identity, host and tool versions, evidence artifact and sidecar
sizes, the static and dynamic suite inventory, and references to existing
reports. Native release packages are `not-measured` when no packages are
present; frontend `dist/` is recorded separately. The benchmark records that no
scenarios were executed by that command.

The older schema 1 file named `benchmark-51-baseline-win32-x64.json` is a
current-only capture made after the initial report was overwritten. It is not
the retained baseline and is not a valid comparison input for the current
schema.

The retained inventory file records 103 static scenarios and 8 dynamic
`v5-fixes` areas at its capture. The tree on 2026-11-14 has 111 static scenarios
in `e2e/suites.json` and 13 dynamic `v5-fixes` areas, counted by the same rule
the gate uses. These are discovered counts, not passed scenario counts. The first full
baseline report produced during this work was overwritten while the shared
E2E artifact tree was changing. It is unavailable as a verifiable report; no
historical count or report content is reconstructed. The saved clean snapshot
still identifies `010d9faf5fd0ff1284b5a26be20f8c05c14fc690` and contains 522
tracked-file hashes with empty staged and unstaged patches. It does not contain
runtime observations.

Runtime data for startup, idle CPU, peak memory, queue latency, and proxy
throughput is **missing, not measured**. The initial runtime baseline cannot be
reconstructed from the saved source snapshot.

To provide real measurements later, pass a versioned runtime metrics JSON file
to `scripts/benchmark-51.mjs --runtime-metrics <file>`. The tool records the
input hash, method, host, units, and sample counts, and compares a metric only
when both reports contain compatible measured values. Missing inputs remain
explicit; the tool does not derive runtime values from artifact sizes or old
report references.

## Performance and artifact acceptance

There is no numeric performance target. Before and after evidence must show
smaller native macOS package artifacts. Startup, CPU and memory use, queue
latency, proxy throughput, and other agreed runtime measures must show no
regression. The retained current capture has no runtime values and no native
package measurements, so this acceptance is still open. An absent package
inventory is not a zero-byte package or evidence of a saving.

Each comparison must identify its source revision, platform, architecture, tool
versions, measurement method, and report hash. Do not compare measurements from
different hosts as if they were like-for-like.

## Deferred beyond 5.1

These items remain outside the accepted delivery: an independent yt-dlp update
channel, updater key rotation, macOS entitlement redesign, new Flatpak hosting,
Linux arm64 support, and major product features. Existing Flatpak packaging and
current supported platforms remain in the required release-verification scope.

## Named Windows gaps

- **Windows Job Object leader exit (not proven).** The record
  `windows-job-object-leader-exit` in `e2e/specs/native-downloads.spec.js` is
  skipped on every platform and reports `invariantPassed: null`. The suite does
  not force a real app helper leader to exit while a descendant keeps an
  inherited pipe open. The native gate requires the record to stay skipped with
  a reason. The Job Object kill-on-close in `src-tauri/src/process_util.rs` is
  therefore unproven for helper-leader exit ordering. Out of reach for 5.1.
- **Process-repair probes skip on Windows.** `download-process-repairs` and
  `audit3-native-targeted` skip on `win32` because their wrapper helpers are
  POSIX and Python shims. Signal and oversized-output handling is not exercised
  on Windows. See `e2e/README.md`.
- **Termination probes run on macOS only.** `audit-v5-beta2` skips on Linux and
  Windows.

## 5.1 audit: fixed findings and Windows x64 proof

Finding IDs refer to the 5.1 audit plan, which is not in the repository. The
fixes are uncommitted on top of `8e63cd8`. Waves 1 to 3 are verified by the
Windows x64 runs below. Each fix has its own failure-mode file and E2E spec.

- **Backend:** A1 (legacy v4 import never overwrites ROSI 5 data), A2 (manual
  cancel, queue cancel, and clear act only on their own owner), A3 (a cancelled
  update transfer refuses Check and Download while it stops), A4 (a failed
  directory sync after install is a warning), A5 (option resolution commands are
  async), A6 (long Windows paths use verbatim paths), A7 (preview and format
  listing use the request's cookie choice; presets and request overrides carry
  no cookie fields yet, so the renderer wiring is review-only), A10 (cancelled
  export and import dialogs return `ok` without an error).
- **Renderer, downloads and queue:** B1 (Enter starts a download only from the
  idle Download state), B2 and T2 (the queue run hides the progress bar; the
  cancel scenario waits for the yt-dlp process), B3 (Download and Activity replay
  are gated during a queue run), B4 (Escape ignores busy prompts), B5 (updater
  modal actions catch errors), B6 (Windows browser choice defaults to Firefox;
  channel changes reach the backend on reset and import), B7 (import marks the
  settings saved), B8 (an invalid playlist range warns only on Download and Add
  to queue), B9 (the result button handles a failed open), B10 (dead settings
  parameter and field removed), B11 (error toasts stay 8 s), B12 (Flatpak cookie
  toggle), B13 (failure details stay open across queue renders), C3 (Start is
  disabled while the queue runs), C4 (one notification after a drained queue and
  one after a manual failure).
- **UI and wording:** C1 (one name for Cancel queue), C2 (one message for an
  invalid URL), C5 (proxy field moved to Application), C6 (modal height limit),
  C7 (licenses frame in the focus trap), C8 (settings search clears
  `aria-hidden`), C9 (profile hint and newer-version wording), C10 (status text
  tokens meet contrast in all themes), C11 (plain wording), C12 (ARIA fixes),
  C13 (queue textarea and toast placement), C14 (`--url-actions-width` defined),
  C15 (wording, icon helper, and version fallback).
- **Tests and harness:** T5 (E2E seams for export, import, and Remove finished),
  F1 (updater arch from `process.arch` in the state spec), F2 (root of B6),
  F3 (WebDriver port wait between specs), F4 (clipboard fallback when the window
  is unfocused).
- **Security cancel:** a yt-dlp kill could be starved by the waiter's lock on
  Windows, so cancel left yt-dlp running. Fixed in `process_util.rs` (failure-mode
  row C12 in `e2e/v5-fixes/downloader/failure-modes.md`; that row ID is not the
  audit finding C12).
- **Package 10 (this change):** T3 (win32 skip reasons recorded), T6 (skipped
  native records report `invariantPassed: null`), T7 (WebDriver-unprovable checks
  recorded as not proven, exact window size where the window resizes), T12
  (persistence row corrected), T13 (doc drift).

Not done in this tree: A8, A11, A12, C16, and T8 (the rest of package 9). Deferred
owner decision: A9 and T4 (renames) are deferred; T10 is done (`core.hooksPath`
points at `.githooks`); T11 is declined for now (the yt-dlp notice stays tracked). Still needs a Mac run: A13, and the macOS paths of A4 and A8.

Windows x64 proof before the audit commit (uncommitted tree on `8e63cd8`):

- `npm run test:e2e:core -- --repeat 3` after wave 3: 3 of 3 passed, no flaky
  runs.
- `npm run test:all` after wave 3: all checks passed. E2E: 120 passed, 4
  allowed platform skips. SHA-256
  `8bf5ae682b4af58cc64e43f0de0888d055fc377575dcb02b15dec679e9712440`.
- `npm run test:all` after wave 4: every non-E2E check passed; E2E 119 passed,
  4 allowed skips, 1 failed (`round2-native`: its Deno assertion still required
  `true` from a probe that T6 now reports as skipped with `null` on Windows).
  The assertion was fixed; `npm run test:e2e -- --group downloads` then passed.
- The release proof for the audit commit comes from
  `npm run test:all -- --require-clean-proof` on the committed tree.
- Not run at this tree: macOS arm64, Linux x64, Windows arm64.
