# WebDriver session start between wdio specs: failure modes

Written before the change in `e2e/wdio.conf.js`. Problem (flake F3): with the
default embedded provider, each spec file gets a fresh worker. The
`@wdio/tauri-service` (1.4.0) launcher checks `GET /status` on 127.0.0.1:4445 in
its `onWorkerStart` and restarts the app only if that probe fails. The
`after` hook of the previous spec asks the app to exit, waits a fixed 1 s, and
returns. If the previous app is still alive when the probe runs, the service
reuses it, then the app dies, and the next `POST /session` gets ECONNREFUSED.
WebdriverIO retries ECONNREFUSED only twice (`connectionRetryCount: 2`, about
0.5 s total), so the spec fails with "Failed to create a session".

Facts verified in `node_modules` (not from memory):

- Config `onWorkerStart` runs before the service's `onWorkerStart`
  (`@wdio/cli/build/index.js`, lines 1170-1171).
- Config `beforeSession` runs before the real `POST /session` (the runner
  `_startSession` at line 731 is a protocol stub). Config `after` also runs when
  session creation fails.
- Errors thrown from config hooks (`before`, `after`, `beforeSession`, `onWorkerStart`)
  are logged and swallowed (`@wdio/utils` `executeHooksWithArgs`). They do not fail
  the spec. A worker that exits non-zero is counted as a failed spec
  (`@wdio/cli` `_endHandler`). So a wait that must fail the run exits the worker
  with `process.exit(1)` after writing the reason to stderr.
- The service restart path (`restartEmbeddedServer`) already waits for readiness
  (`pollWebDriverStatus`, up to `startTimeout`) and detects an early app exit.
- A passing probe skips the restart. On Windows the service then runs three
  500 ms stability probes, which a still-dying app can also pass.
- `connectionRetryCount` retries only retryable codes (ECONNREFUSED is one),
  with backoff `250 * 2^n` ms, capped at 10 s. Raising it would also delay every
  real command failure against a crashed app, so it is not raised.

## Failure modes and the check that must catch each

| ID | Failure mode | How the fix handles it | Caught by |
| --- | --- | --- | --- |
| S1 | New app not yet listening when `POST /session` is sent | `beforeSession` polls `GET /status` (`value.ready === true`) for up to 30 s before the real session. On timeout it exits the worker with the reason and the captured-log directory. | Startup wait row (ui-polish run: all 7 files create sessions) |
| S2 | Previous app still alive and bound to 4445 when the next spec starts (session would go to the OLD app) | `after` waits after the exit request until a TCP connect to 127.0.0.1:port gets ECONNREFUSED, for up to 30 s. On timeout it exits the worker. Covers the window-closed branch on non-macOS too. | Release wait row (ui-polish run: no ECONNREFUSED, no spec attached to a stale app) |
| S3 | Wait hides a real startup crash (app exits before listening) | The wait is bounded at 30 s and then fails the worker. The service's restart path still reports an early exit with its own message. `captureBackendLogs: true` writes the app's stdout/stderr to the logs directory, and the timeout message names it. | Forced-timeout row: fail must be non-zero and name the logs directory (manual check on a crash, not run by default) |
| S4 | Wait slows every spec | The release wait returns on the first refused probe. The existing fixed 1 s sleep is kept, so the added cost is about 0 s when the app exits in time. The readiness probe answers immediately when the service already started the app. | Timing in the ui-polish report (per-spec durations compared with the previous run) |
| S5 | Port reused by an unrelated process: the release probe sees a non-ECONNREFUSED listener | Only ECONNREFUSED counts as released. Any other answer keeps polling until the 30 s bound, then the worker fails with the probe result. An unrelated HTTP server that answers `/status` with `ready: true` is NOT distinguishable from the app by this wait. That residual is listed below. | Release wait row (listener still open after 30 s fails the run) |
| S6 | Previous spec never requested exit (no session, or the Tauri process API is unavailable), so the app stays alive and the service reuses it | Not fixed by this change. No session means no exit request, and the wait is skipped by design. Under `bail: 1` the run stops at the first failed spec. | Residual; documented, not tested |
| S7 | macOS keeps the app alive after the last window closes (by design) | The release wait is skipped on darwin, as before. | Residual; the macOS run is not part of this change's proof |
| S8 | The new readiness wait fails on a healthy app because `/status` reports `ready: false` for a while | Same rule as the service's own `pollWebDriverStatus`: wait for `value.ready === true`, with the 30 s bound. | Startup wait row |
| S9 | `captureBackendLogs` breaks stdio handling or adds noise | Only the service's own capture path is used. Logs go to `<cwd>/logs`, which is gitignored. | Run completes and all 7 files create sessions |
| S10 | A process exit inside a hook is not reported as a spec failure | Checked in `@wdio/cli` `_endHandler`: a non-zero worker exit increments the failed count, so the gate fails. | Forced-timeout row (manual) |

## Residual risks, not covered

- S5 for an unrelated HTTP server that reports `ready: true`: only a PID check
  of the listening socket (netstat on Windows, lsof on macOS) would catch it. That
  is more code than this fix should add.
- S6 and S7: see the table.
- Forced-timeout evidence (S3, S10) is a manual check. The native runs prove only
  the normal path.
