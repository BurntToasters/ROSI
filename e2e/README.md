# E2E suites

`npm run test:e2e` (`scripts/test-e2e.js`) is the full E2E gate. It builds the
E2E binary once, runs every suite below against that binary, writes evidence to
`e2e/artifacts/`, and fails if any suite fails, skips without an allowance in
`ALLOWED_E2E_SKIPS`, or does not report. Every allowance names a platform and a
non-empty `reason`. Allowances live in `e2e/suites.json`, except three hard-coded in
`scripts/e2e/runners/native.js` (see "Skip allowances" below). CI runs the same
command.

`ROSI_E2E_ONLY=<spec>` runs one ad-hoc spec for debugging. Its verdict comes
from that spec alone, and its report sets `fullSuite: false` and `onlySpec`, so
release evidence rejects it. A blank value counts as unset.
`npm run test:all` refuses to start while `ROSI_E2E_ONLY`, `ROSI_E2E_GROUPS` or
`ROSI_E2E_REUSE` holds a non-blank value, unless `--skip-e2e` is given. A leftover
selector would otherwise turn the gate into a partial run that exits 0.

`e2e/suites.json` is the canonical static scenario inventory and feature index.
It maps the existing files to their current runner owners. Files are named by
feature; the owner ids and scenario names are unchanged from the earlier round
and audit names. To run selected feature groups, use `npm run test:e2e -- --group
settings,queue` or set `ROSI_E2E_GROUPS=settings,queue`. The selector expands to
the whole current runner owner, so a group that uses `main.spec.js` can report
scenarios from other features owned by that same pass. Reports include both the
requested groups and the expanded scenario list. Group runs set
`fullSuite: false`, use a fresh E2E binary, and are not release proof. A group
selection cannot be combined with `ROSI_E2E_ONLY`.

For faster local feedback, `npm run test:e2e:core` runs the `core` profile. It
uses exact, escaped Mocha full titles to select the existing main scenarios
listed in `e2e/suites.json`, preserving their source order and the existing
suite hooks. It also runs the complete state-updater, offline-queue,
renderer-updates, and renderer DOM suites through their existing profiles.
Core requires working FFmpeg and FFprobe binaries; conversion and media-probe
scenarios cannot be silently skipped. It does not run the other main scenarios,
legacy import, security release checks, native process-repair runners,
platform probes, or v5-fixes runners.

Core reports are partial evidence with `fullSuite: false` and
`profile: "core"`. Each invocation keeps its report and screenshots under
`e2e/artifacts/core/<platform>-<arch>/<run-id>/`; the latest report for that
host is `e2e/artifacts/core/<platform>-<arch>/latest-report.json`. Older core
run directories are retained. The report records source and binary identity,
fixture and screenshot hashes, expected scenarios, and monotonic timings for
the build, fixtures, every WebdriverIO pass, every runner, and total elapsed
time. The command prints the slowest stages. Three consecutive warm runs on the
local Mac arm64 machine took **165.632 s**, **162.064 s**, and **165.769 s**;
their incremental builds took **7.080–9.530 s**. Each run passed all 42
expected scenarios and retained 14 hashed screenshots. The stability summary was
`e2e/artifacts/core/darwin-arm64/stability-2026-11-08T06-20-16-991Z-43959-b2e36bde-1908-498d-baea-8bb007076916/runs/stability-report.json`, with the first, second, and third run
reports beside it as `run-1.json`, `run-2.json`, and `run-3.json`. The
`e2e/artifacts/` tree is git-ignored, so those files exist only on the machine
that produced them. These measurements reflect that machine and its local caches; they
do not predict runtimes on other hardware or operating systems. Core reports
cannot be used as full release proof.

Background mode (`ROSI_E2E_BACKGROUND=1`) is the local default on macOS and
Windows. CI and Linux do not use it; set `ROSI_E2E_FOREGROUND=1` to keep the
foreground behavior locally. On macOS the E2E app has no Dock icon, never takes
focus, and its window stays below other apps. WebKit's occlusion detection is
turned off for the main webview (`src-tauri/src/window.rs`, `e2e_occlusion`) so
the page keeps rendering. On Windows the window is shown without activation and
kept at the bottom of the z-order (`e2e_windows`). Native alert dialogs that
specs open on purpose still appear and still take focus.
The gate report does not record the window mode. Release evidence from a Mac
uses the default background mode unless `ROSI_E2E_FOREGROUND=1` is set, and
the release record must state which mode produced the report. The
`settings-reset-all` and `close-flow` scenarios wait for their observable
effects (the reset bridge call, the "Main window closed." log line), not fixed
delays, so both modes use the same waits.

| Suite                                                               | Area                                                                              | How the gate runs it                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `specs/legacy-import.spec.js`                                       | Legacy import                                                                     | WebdriverIO pass, three times: import, corrupt settings, preserved ROSI 5 data  |
| `specs/main.spec.js`                                                | Persistence, settings, UI, downloads, close flow                                  | WebdriverIO main pass                                                           |
| `specs/security-release-offline-queue.spec.js`                      | Security and network (offline queue)                                              | WebdriverIO pass                                                                |
| `specs/security-release-checks.spec.js`                             | Security and network                                                              | WebdriverIO pass                                                                |
| `state-updater.spec.js`                                             | Updater and state                                                                 | WebdriverIO pass                                                                |
| `renderer-updates.spec.js`                                          | Renderer                                                                          | WebdriverIO pass                                                                |
| `native-downloads.spec.js` via `native-downloads-run.mjs`           | Download and process (native)                                                     | Runner, verified report                                                         |
| `long-term-persistence.spec.js` via `long-term-persistence-run.mjs` | Persistence                                                                       | Runner, verified report                                                         |
| `download-process.spec.js` via `run-download-process.mjs`           | Download and process                                                              | Runner, verified report (macOS and Linux)                                       |
| `download-process-targeted.spec.js` via `run-download-process.mjs`  | Download and process (captions, sidecars, GPU, playlists)                         | Same runner with `ROSI_REPAIRS_SPEC`, verified report (macOS and Linux)         |
| `download-session.spec.js` via `download-session-run.mjs`           | Download and process (artwork, queue drain)                                       | Runner, `result.json` verified under `e2e/artifacts/audit4-repairs/`            |
| `platform-probes/probes.spec.js` via `run-probes.mjs`               | Security (`--security`), renderer (`--ui`), process termination (`--termination`) | Four launches, one per mode, macOS only. Every `invariantPassed` must be `true` |
| `renderer-dom-checks/run.cjs`                                       | Renderer and updater (jsdom, no app)                                              | Node runner, all 15 checks must pass                                            |
| `e2e/v5-fixes/<area>/*.spec.js` (no `run.mjs` in the area)          | Whatever the area covers                                                          | WebdriverIO pass per area, one fresh profile each                               |
| `e2e/v5-fixes/<area>/run.mjs` and the specs it drives               | Whatever the area covers                                                          | Runner only, after the build; verified report (see below)                       |
| `e2e/v5-fixes/network/run.mjs`                                      | Security and network policy                                                       | Runner, `report.json` under `e2e/artifacts/v5-fixes-network/`                   |
| `e2e/v5-fixes/persistence/run.mjs`                                  | Persistence acceptance                                                            | Runner, `report.json` under `e2e/artifacts/v5-fixes-persistence/`               |
| `e2e/v5-fixes/downloader/run.mjs`                                   | Downloader (install fallback, orphan sweep, panic log)                            | Runner, `report.json` under `e2e/artifacts/v5-fixes-downloader/`                |

The report keeps the original flat `expectedScenarios` inventory for release
checks and adds `scenarioGroups` so outcomes can be read by feature. Existing
runner ownership, platform-specific skip allowances, fresh-report checks, and
the E2E binary hash checks are described in the manifest and runner.

### Skip allowances, timeouts, and orphaned apps

- Skip allowances live in `e2e/suites.json` (`allowedSkips` and
  `allowedCaseSkips`), with three exceptions hard-coded in
  `scripts/e2e/runners/native.js`: `windows-job-object-leader-exit` (any
  platform), and `source-identity-preserves-replacement` and
  `deno-version-probe` (Windows only). Each exception still needs a non-empty
  skip reason.
- A runner that times out is stopped with its whole process tree
  (`scripts/e2e/process-tree.js`: `taskkill /T` on Windows, a process-group kill
  elsewhere). Each outer timeout is larger than the inner budgets it wraps. The
  long-term runner makes 15 launches with 180 s budgets, so its outer budget is
  15 x 180 s plus 120 s. The persistence runner makes 13 launches with 180 s
  budgets, so its outer budget is 13 x 180 s plus 120 s.
  `scripts/e2e-runners.test.mjs` checks these counts against the runner files.
- Before each WebdriverIO pass and each runner stage, the gate waits up to 15 s
  for the embedded WebDriver port (127.0.0.1:4445, or `TAURI_WEBDRIVER_PORT`) to
  stop accepting connections. If it does not, the stage
  fails, so an app orphaned by an earlier pass cannot answer the next one.
- The report records the SHA-256 of the E2E binary and of the sidecars beside
  it (`rosi-yt-dlp`, `rosi-ffmpeg`, `rosi-ffprobe`), checked again at the end
  of the run. `reusedBinary` records whether the build step was skipped.

### Windows skips for the process-repair suites

`download-process-repairs` and `audit3-native-targeted` are both owned by
`process-repairs`, and both may skip on `win32` (`allowedSkips` in
`e2e/suites.json`). The reason is in the code. `scripts/e2e/runners/native.js`
(`runDownloadProcessRepairs`) reports both as skipped on Windows before it starts
anything. `e2e/run-download-process.mjs` also throws on Windows, because its owned
helper wrappers need a Unix host. Those wrappers are Python 3 and POSIX shell
scripts (`#!/usr/bin/env python3`, `#!/bin/sh`), and the probes stop processes
with `SIGKILL` and process groups (`process.kill(-pid, "SIGKILL")`). No Windows
port of these probes exists, and no decision to port them to Job Objects is
recorded. Their behavior on Windows is unproven.

## ROSI 5.1 baseline capture

`node scripts/benchmark-51.mjs --label current --snapshot <snapshot-directory>`
records the current source revision and dirty-file hashes, platform, tool
versions, evidence artifact and sidecar sizes, static and dynamic scenario
inventory, and references to reports already under `e2e/artifacts/`. Native
package sizes are recorded separately; when packages are absent, their size is
`not-measured` rather than zero. Frontend `dist/` size is also separate from
native packages. The command writes a timestamped JSON report and `.sha256`
sidecar; it does not execute scenarios. The inventory counts discovered cases,
while execution evidence remains `not-run` for the benchmark capture.

The first full baseline report created during ROSI 5.1 foundation work was
overwritten while the shared artifact tree was changing. That report is not
retained or verifiable, and its contents are not reconstructed. A later
current-only capture does not stand in for that lost baseline.

To compare a later capture, run:

```sh
node scripts/benchmark-51.mjs --label candidate \
  --compare path/to/baseline.json \
  --runtime-metrics path/to/runtime-metrics.json
```

The default output includes a timestamp and refuses to replace an existing
file. An explicit `--out <path>` also refuses to overwrite; pass `--force` only
when replacement is intentional. The runtime metrics input uses
`schemaVersion: 1`, the measured `platform` and
`arch`, a `method` description, and a `measurements` object. Supported fields
are `startupMs` (`ms`), `idleCpuPercent` (`percent`), `peakMemoryBytes`
(`bytes`), `queueLatencyMs` (`ms`), and `proxyThroughputBytesPerSecond`
(`bytes_per_second`). Each value is an object with a numeric `value` and exact
`unit`; optional `samples`, `method`, and `evidence` fields preserve measurement
context. Missing values stay `not-measured`; comparisons produce a delta only
when both reports contain a compatible measurement. No historical runtime
result is inferred from existing E2E report files.

### v5-fixes areas and `run.mjs`

- An area with no `run.mjs` gets one WebdriverIO pass per area. Its specs run
  inside the gate's pass with a fresh profile.
- An area with `run.mjs` is owned by that runner. The gate runs only the runner,
  after the E2E binary build, and never rebuilds. The runner drives its own
  specs with whatever env and profile they need. The default WebdriverIO glob in
  `e2e/wdio.conf.js` skips runner-owned areas, so their specs never run twice.
- The gate fails the area when the runner exits nonzero, or when no report was
  written by this run. A report counts when its `report.json` lives under
  `e2e/artifacts/v5-fixes-<area>/<timestamp>/`, its mtime is at or after the
  gate start, it parses, and it has `passed: true` (or `allPassed: true`).
  It must also carry `binarySha256` equal to the hash of the E2E binary the
  gate launched, and `startedAt` and `finishedAt` timestamps with `startedAt`
  not before the gate invocation started.
- A case a runner skips still has to be allowed. The gate reads skipped cases
  (`status: "skipped"`) and skipped checks (`skipped: true`) from the report.
  Each needs an entry in `allowedCaseSkips` in `e2e/suites.json` naming the
  scenario (`v5-fixes/<area>`), the case (`<case>` or `<case>/<check>`), the
  platform, and a non-empty `reason`. A skip without an entry fails the area.
  Allowed skips are listed as `skippedCases` in the scenario.
- The gate passes `ROSI_E2E_ARTIFACT_DIR=e2e/artifacts/v5-fixes-<area>` to the
  runner. Each run writes its report into a timestamped child directory there,
  so earlier runs are kept and told apart by mtime.
- Runner specs run with `ROSI_E2E_SPECS=./v5-fixes/<area>/<spec>`. WebdriverIO
  resolves that pattern relative to `e2e/`, the directory of the config file.

### Manual verifiers and probes (not in the gate)

The gate runs the suites in `e2e/suites.json` and the `*.spec.js` and `run.mjs`
files under `e2e/v5-fixes/<area>/`. It does not run the scripts below. Run them
by hand. Their reports are not gate evidence.

- `e2e/v5-fixes/ytdlp/verify.mjs`: yt-dlp provenance checks against upstream
  GitHub release data. Needs network access. Writes
  `e2e/artifacts/v5-fixes-ytdlp/<timestamp>/`.
  Usage: `node e2e/v5-fixes/ytdlp/verify.mjs`.
- `e2e/v5-fixes/ci-vendor/verify-ci-vendor.mjs`: CI and vendored-updater checks,
  some against crates.io. Needs network access. Writes
  `e2e/artifacts/v5-fixes-ci-vendor/<timestamp>/`.
  Usage: `node e2e/v5-fixes/ci-vendor/verify-ci-vendor.mjs`.
- `e2e/v5-fixes/media-dispatch/verify.mjs`: Windows integration check of private
  FFmpeg and FFprobe alias dispatch. It launches the built app through the
  bundled yt-dlp and writes a SHA-256 report under `e2e/artifacts/`.
- `e2e/v5-fixes/media-tools/verify.mjs`: manual integration check for the media
  findings. It compiles production functions with small stand-ins, runs the
  bundled FFmpeg, and writes a hashed report. It does not launch the app.
- `e2e/v5-fixes/persistence/queue-publication-verify.mjs`: reads
  `src-tauri/src/queue.rs` and writes a hashed report under
  `e2e/artifacts/v5-fixes-persistence/`. Retired: the functions it greps for have
  moved, so it checks nothing now. Do not cite its output.
- `e2e/v5-fixes/proxy-sockets/verify.ps1`: PowerShell check of the proxy socket
  code. It extracts exact Rust functions from the source and checks them. Run it
  on Windows. Retired: the functions it extracts have moved, so it no longer
  checks the proxy code. Do not cite its output.
- `e2e/webview2-lockout-probe.mjs`: temporary Windows probe for the WebView2
  lockout workaround. It is removed with that workaround. See
  `e2e/webview2-lockout.failure-modes.md`.
- `e2e/deep-probes/run.mjs`: observational V5 beta 2 probes that drive the real
  app with an isolated profile per mode. Run on macOS or Linux after a fresh E2E
  build. See `e2e/deep-probes/README.md`.

## Screenshots are evidence, not visual tests

E2E screenshots are evidence only. The gate records each one with a hash and
re-hashes it on verification to confirm the file was not changed after the run.
It never compares a screenshot against a baseline image, so a visual regression
(layout, color, or text drift) passes the gate. Review screenshots by hand when
a UI change is in scope.

## Rules for new coverage

- Add coverage to an existing area suite, or to `e2e/v5-fixes/<area>/`. Do not
  add a per-audit-round runner.
- A `v5-fixes` spec must not contain `describe.skip`, `it.skip`, `.only`, `xit`
  or `this.skip()`. The gate fails the area if it does.
- A `v5-fixes` runner must be named `run.mjs`, write `report.json` under
  `e2e/artifacts/v5-fixes-<area>/<timestamp>/`, include `passed` (or
  `allPassed`), `binarySha256`, `startedAt`, and `finishedAt`, and exit nonzero
  on failure.
- A `run.mjs` area's specs must not also need the generic pass. Keep them in
  the area and let the runner set their env.
- Runners that start their own media server run after the gate's media server
  closes. Specs run inside the gate's pass, so they can use `ROSI_E2E_MEDIA_URL`.
- Do not run cargo between the E2E build and the gate, since that replaces the
  E2E binary. The gate checks the binary hash in each report.
- E2E builds never open informational native alerts (profile recovery, refused
  settings save, newer data, missing FFmpeg, quit failures), since WebDriver
  cannot dismiss them. `src-tauri/src/notices.rs` logs and records them instead;
  assert one with the `e2e_native_notices` command. New alerts with only an OK
  button go through `notices::show`. See `e2e/native-notices.failure-modes.md`.

## Suites not wired into the gate

Every suite listed in `e2e/suites.json` is wired into the gate. Eight verify or
probe scripts are not: the two verifiers under "Manual verifiers and probes"
that were documented before this change (`ytdlp/verify.mjs` and
`ci-vendor/verify-ci-vendor.mjs`), and six that were not documented here
(`media-dispatch/verify.mjs`, `media-tools/verify.mjs`,
`persistence/queue-publication-verify.mjs`, `proxy-sockets/verify.ps1`,
`webview2-lockout-probe.mjs`, and `deep-probes/run.mjs`). The gate does not
check that they ran. The audit-round documents remain as failure-mode records. The `audit3-native-targeted`
caption enumeration and identity-race cases are not in `download-process.spec.js`,
so that suite is not a duplicate.

Two of the six are retired. `persistence/queue-publication-verify.mjs` and
`proxy-sockets/verify.ps1` no longer check anything, because the functions they
look for have moved. Their files stay unedited as records. Do not cite their
output as evidence.
