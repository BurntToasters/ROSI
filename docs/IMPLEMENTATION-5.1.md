# ROSI 5.1 implementation and evidence ledger

## Accepted delivery

The following six milestones are accepted for ROSI 5.1. Acceptance is scope,
not a completion claim. This ledger records evidence produced by the verification
foundation at the current worktree snapshot; other workstreams must update their
own status when they produce implementation and platform evidence.

| #   | Milestone                                                                 | Evidence status                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Baseline evidence and E2E organization                                    | The E2E manifest and feature-group selector are implemented. A current inventory capture is retained on Windows x64. It records discovered scenarios separately from execution. The initial full baseline report was overwritten while the shared artifact tree was changing; that report is unavailable and has not been reconstructed. Runtime measurements remain missing.                                                                 |
| 2   | Native macOS distribution and artifact verification                       | The native macOS artifact verifier is in progress in a separate workstream. No native macOS package build or size comparison is recorded here.                                                                                                                                                                                                                                                                                                |
| 3   | Typed formats, shared option resolution, structured lifecycle consumption | Structured format data and renderer consumption have changes in the current worktree. Shared option resolution, lifecycle acceptance, integration, and cross-platform proof remain outstanding.                                                                                                                                                                                                                                               |
| 4   | Queue/session coordinator migration                                       | Implemented with residue: `coordinator.rs` owns queue transitions and session results. Residue: the global `QUEUE` mutex and the `ACTIVE`, `STARTUP`, and `EVENT_PUBLISH` mutexes remain, and required-platform full-gate proof is still outstanding.                                                                                                                                                                                         |
| 5   | Async proxy migration                                                     | Implemented with residue: the Tokio relay in `network_security_async.rs` serves 256 active and 128 pending clients. The relay wakes on a cancellation watch channel and DNS replies arrive over oneshot channels, so it has no polling sleeps. Residue: the DNS pool still uses blocking threads with a condvar, the blocking caller outside the relay keeps a 25 ms reply check, and required-platform full-gate proof is still outstanding. |
| 6   | Full-app polish and integrated release candidate                          | Accepted; the integrated candidate and full required-platform E2E proof remain outstanding.                                                                                                                                                                                                                                                                                                                                                   |

Milestone 6 keeps ROSI's visual identity and layout while improving downloads,
queue management, settings, onboarding, and accessibility. It does not add the
major features listed as deferred below.

## Required support and proof matrix

ROSI 5.1 must retain the current supported platforms: macOS 15 and newer, Linux
x64, and Windows x64 and arm64. A Windows x64 inventory capture does not prove
the app or release artifacts on any platform.

| Platform      | Evidence from this foundation                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| macOS 15+     | Verifier changes are in progress; no build, app E2E, signing, notarization, or package comparison was performed for this capture. |
| Linux x64     | No build or app E2E performed.                                                                                                    |
| Windows x64   | Benchmark inventory captured on this host; no app E2E or release artifact verification performed.                                 |
| Windows arm64 | No build or app E2E performed.                                                                                                    |

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
