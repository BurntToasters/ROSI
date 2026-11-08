# ROSI 5.1 implementation and evidence ledger

## Accepted delivery

The following six milestones are accepted for ROSI 5.1. Acceptance is scope,
not a completion claim. This ledger records evidence produced by the verification
foundation at the current worktree snapshot; other workstreams must update their
own status when they produce implementation and platform evidence.

| #   | Milestone                                                                 | Evidence status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Baseline evidence and E2E organization                                    | The E2E manifest and feature-group selector are implemented. A current inventory capture is retained on Windows x64. It records discovered scenarios separately from execution. The initial full baseline report was overwritten while the shared artifact tree was changing; that report is unavailable and has not been reconstructed. Runtime measurements remain missing. A macOS arm64 full-suite E2E report at `9e60f970d2a62d636a019d7b15975c9814364dde` passed 120 expected scenarios (see the proof matrix). |
| 2   | Native macOS distribution and artifact verification                       | The native macOS artifact verifier is in progress in a separate workstream. No native macOS package build or size comparison is recorded here. On macOS arm64, `npm run test:e2e:updater-zst` (without `--require-real-builds`) passed 12/12 on 2026-11-07 using derived per-architecture archives; the commit for that run is not recorded here. The signed per-architecture `--require-real-builds` run, signing, notarization, and package size comparison have not run.                                           |
| 3   | Typed formats, shared option resolution, structured lifecycle consumption | Typed formats, shared option resolution, and preset preview are implemented: format lists are built from structured backend data, and preset Apply resolves through the backend (`resolve_preset_options`). The macOS arm64 full gate passed at `9e60f970d2a62d636a019d7b15975c9814364dde`. Lifecycle acceptance, integration, and cross-platform proof remain outstanding.                                                                                                                                           |
| 4   | Queue/session coordinator migration                                       | Implemented with residue: `coordinator.rs` owns queue transitions and session results. Residue: the global `QUEUE` mutex and the `ACTIVE`, `STARTUP`, and `EVENT_PUBLISH` mutexes remain. The full gate passed on macOS arm64 at `9e60f970d2a62d636a019d7b15975c9814364dde`; full-gate proof on the other required platforms is still outstanding. See [ROADMAP-5.1.md](ROADMAP-5.1.md) (B7).                                                                                                                         |
| 5   | Async proxy migration                                                     | Implemented with residue: the Tokio relay in `network_security_async.rs` serves 256 active and 128 pending clients. The relay wakes on a cancellation watch channel and DNS replies arrive over oneshot channels, so it has no polling sleeps. Residue: the DNS pool still uses blocking threads with a condvar, the blocking caller outside the relay keeps a 25 ms reply check, and required-platform full-gate proof is still outstanding.                                                                         |
| 6   | Full-app polish and integrated release candidate                          | Accepted; the integrated candidate and full required-platform E2E proof remain outstanding. The macOS arm64 full gate passed at `9e60f970d2a62d636a019d7b15975c9814364dde`. No other platform has a build or app E2E run.                                                                                                                                                                                                                                                                                             |

Milestone 6 keeps ROSI's visual identity and layout while improving downloads,
queue management, settings, onboarding, and accessibility. It does not add the
major features listed as deferred below.

## Required support and proof matrix

ROSI 5.1 must retain the current supported platforms: macOS 15 and newer, Linux
x64, and Windows x64 and arm64. A Windows x64 inventory capture does not prove
the app or release artifacts on any platform.

| Platform      | Evidence from this foundation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS 15+     | Apple silicon (arm64), macOS 27.2. Full gate `npm run test:all -- --require-clean-proof` passed at commit `9e60f970d2a62d636a019d7b15975c9814364dde`, completed 2026-11-08T00:01:02Z. Every check passed. The full-suite E2E report passed with 120 expected scenarios and 26 screenshots, and a release quality-gate proof was recorded. Window mode was background (`ROSI_E2E_BACKGROUND=1`). Report: `e2e/artifacts/e2e-report-darwin-arm64.json`, SHA-256 prefix `687e91abd3249ec8`. `npm run test:e2e:updater-zst` passed 12/12 on 2026-11-07 using derived per-architecture archives, without `--require-real-builds`. Not run: the `--require-real-builds` updater run with signed per-architecture builds, signing, notarization, and native package size comparison. No macOS x64 result is recorded. |
| Linux x64     | No build or app E2E performed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Windows x64   | Benchmark inventory captured on this host; no build, app E2E, or release artifact verification performed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
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

The current inventory has 103 static scenarios and 8 dynamic `v5-fixes` areas.
These are discovered counts, not passed scenario counts. The first full
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
