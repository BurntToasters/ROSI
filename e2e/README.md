# E2E suites

`npm run test:e2e` (`scripts/test-e2e.js`) is the only E2E gate. It builds the
E2E binary once, runs every suite below against that binary, writes evidence to
`e2e/artifacts/`, and fails if any suite fails, skips without an allowance in
`ALLOWED_E2E_SKIPS`, or does not report. CI runs the same command.

`ROSI_E2E_ONLY=<spec>` runs one ad-hoc spec for debugging. Its verdict comes
from that spec alone, and its report sets `fullSuite: false` and `onlySpec`, so
release evidence rejects it. A blank value counts as unset.

`e2e/suites.json` is the canonical static scenario inventory and feature index.
It maps the existing files to their current runner owners; the files have not
been moved. To run selected feature groups, use `npm run test:e2e -- --group
settings,queue` or set `ROSI_E2E_GROUPS=settings,queue`. The selector expands to
the whole current runner owner, so a group that uses `main.spec.js` can report
scenarios from other features owned by that same pass. Reports include both the
requested groups and the expanded scenario list. Group runs set
`fullSuite: false`, use a fresh E2E binary, and are not release proof. A group
selection cannot be combined with `ROSI_E2E_ONLY`.

On a local Mac the gate runs ROSI in background mode (`ROSI_E2E_BACKGROUND=1`):
the E2E app has no Dock icon, never takes focus, and its window stays below
other apps. Native alert dialogs that specs open on purpose still appear. The
page keeps rendering in background mode: WebKit would otherwise report a window
behind other apps as occluded and mark the page hidden, which stops animation
frames and CSS transitions. The E2E build turns WebKit's occlusion detection
off for the main webview (`src-tauri/src/window.rs`, `e2e_occlusion`), and the
window's level, focus, and activation policy stay as described above. CI
runs in the foreground; set `ROSI_E2E_FOREGROUND=1` to do the same locally.
The gate report does not record the window mode. Release evidence from a Mac
uses the default background mode unless `ROSI_E2E_FOREGROUND=1` is set, and
the release record must state which mode produced the report. The
`settings-reset-all` and `close-flow` scenarios wait for their observable
effects (the reset bridge call, the "Main window closed." log line), not fixed
delays, so both modes use the same waits.

| Suite                                                                     | Area                                                                              | How the gate runs it                                                          |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `specs/legacy-import.spec.js`                                             | Legacy import                                                                     | WebdriverIO pass, twice: import and corrupt settings                          |
| `specs/main.spec.js`                                                      | Persistence, settings, UI, downloads, close flow                                  | WebdriverIO main pass                                                         |
| `specs/security-release-offline-queue.spec.js`                            | Security and network (offline queue)                                              | WebdriverIO pass                                                              |
| `specs/security-release-repairs.spec.js`                                  | Security and network                                                              | WebdriverIO pass                                                              |
| `state-updater-repairs.spec.js`                                           | Updater and state                                                                 | WebdriverIO pass                                                              |
| `round2-renderer-repairs.spec.js`                                         | Renderer                                                                          | WebdriverIO pass                                                              |
| `round2-native.spec.js` via `round2-native-run.mjs`                       | Download and process (native)                                                     | Runner, verified report                                                       |
| `long-term-v5-audit.spec.js` via `long-term-v5-audit-run.mjs`             | Persistence                                                                       | Runner, verified report                                                       |
| `download-process-repairs.spec.js` via `run-download-process-repairs.mjs` | Download and process                                                              | Runner, verified report (macOS and Linux)                                     |
| `audit3-native-targeted.spec.js` via `run-download-process-repairs.mjs`   | Download and process (captions, sidecars, GPU, playlists)                         | Same runner with `ROSI_REPAIRS_SPEC`, verified report (macOS and Linux)       |
| `audit4-repairs.spec.js` via `audit4-repairs-run.mjs`                     | Download and process (artwork, queue drain)                                       | Runner, `result.json` verified under `e2e/artifacts/audit4-repairs/`          |
| `audit-v5-beta2/audit.spec.js` via `run-probes.mjs`                       | Security (`--security`), renderer (`--ui`), process termination (`--termination`) | Four launches, one per mode, macOS only. Every `invariantPassed` must be true |
| `round3-renderer-repairs/run.cjs`                                         | Renderer and updater (jsdom, no app)                                              | Node runner, all 15 checks must pass                                          |
| `e2e/v5-fixes/<area>/*.spec.js` (no `run.mjs` in the area)                | Whatever the area covers                                                          | WebdriverIO pass per area, one fresh profile each                             |
| `e2e/v5-fixes/<area>/run.mjs` and the specs it drives                     | Whatever the area covers                                                          | Runner only, after the build; verified report (see below)                     |
| `e2e/v5-fixes/network/run.mjs`                                            | Security and network policy                                                       | Runner, `report.json` under `e2e/artifacts/v5-fixes-network/`                 |
| `e2e/v5-fixes/persistence/run.mjs`                                        | Persistence acceptance                                                            | Runner, `report.json` under `e2e/artifacts/v5-fixes-persistence/`             |
| `e2e/v5-fixes/downloader/run.mjs`                                         | Downloader (install fallback, orphan sweep, panic log)                            | Runner, `report.json` under `e2e/artifacts/v5-fixes-downloader/`              |

The report keeps the original flat `expectedScenarios` inventory for release
checks and adds `scenarioGroups` so outcomes can be read by feature. Existing
runner ownership, platform-specific skip allowances, fresh-report checks, and
the E2E binary hash checks are described in the manifest and runner.

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
- The gate passes `ROSI_E2E_ARTIFACT_DIR=e2e/artifacts/v5-fixes-<area>` to the
  runner. Each run writes its report into a timestamped child directory there,
  so earlier runs are kept and told apart by mtime.
- Runner specs run with `ROSI_E2E_SPECS=./v5-fixes/<area>/<spec>`. WebdriverIO
  resolves that pattern relative to `e2e/`, the directory of the config file.

### Manual and CI verifiers (not in the gate)

These scripts are not named `run.mjs`, so the gate ignores them. Run them by
hand or from CI. They need network access and do not start the app.

- `e2e/v5-fixes/ytdlp/verify.mjs`: yt-dlp provenance checks against upstream
  GitHub release data. Writes `e2e/artifacts/v5-fixes-ytdlp/<timestamp>/`.
  Usage: `node e2e/v5-fixes/ytdlp/verify.mjs`.
- `e2e/v5-fixes/ci-vendor/verify-ci-vendor.mjs`: CI and vendored-updater checks,
  some against crates.io. Writes `e2e/artifacts/v5-fixes-ci-vendor/<timestamp>/`.
  Usage: `node e2e/v5-fixes/ci-vendor/verify-ci-vendor.mjs`.

## Rules for new coverage

- Add coverage to an existing area suite, or to `e2e/v5-fixes/<area>/`. Do not
  add a per-audit-round runner.
- A `v5-fixes` spec must not contain `describe.skip`, `it.skip`, `.only`, `xit`
  or `this.skip()`. The gate fails the area if it does.
- A `v5-fixes` runner must be named `run.mjs`, write `report.json` under
  `e2e/artifacts/v5-fixes-<area>/<timestamp>/`, include `passed`, and exit
  nonzero on failure.
- A `run.mjs` area's specs must not also need the generic pass. Keep them in
  the area and let the runner set their env.
- Runners that start their own media server run after the gate's media server
  closes. Specs run inside the gate's pass, so they can use `ROSI_E2E_MEDIA_URL`.
- Do not run cargo between the E2E build and the gate, since that replaces the
  E2E binary. The gate checks the binary hash in each report.

## Suites not wired into the gate

None. Every suite in `e2e/` is wired, and none was judged obsolete. The
audit-round documents remain as failure-mode records. The `audit3-native-targeted`
caption enumeration and identity-race cases are not in `download-process-repairs.spec.js`,
so that suite is not a duplicate.
