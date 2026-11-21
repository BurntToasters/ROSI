# TODO

## Before the next release

- [ ] Get Windows and Linux CI green on the release commit. Release preflight requires a passing `ci-gate` check on HEAD, and it now refuses the green `ci-gate` posted by the weekly scheduled run.
- [ ] Re-sign each platform's release assets with the current `gpg-sign`. Drafts need one `build-commit-<platform>.json` per platform, and drafts built before that change don't have them. `gpg-sign` has no re-sign-only mode, so this means a rebuild per platform.
- [ ] Re-review the npm dev-audit advisories before 2026-12-01 (`scripts/npm-dev-audit.cjs`). After that date `audit:dev-reviewed` warns; five dev-only advisories are still unreviewed.
- [ ] Re-review the RustSec ignore list before 2027-03-01 (`scripts/check-rustsec-ignore-policy.mjs`). `security-audit` fails after that date until it is reviewed.
- [ ] Check the moderate Dependabot alert on the default branch.

## Verify in CI (written on Windows, not run on macOS or Linux)

- [ ] POSIX process watchdog (`process_watchdog.rs`): kill ROSI during a download on macOS and Linux and confirm yt-dlp, FFmpeg and the watchdog exit. The `download-process` suite has a scenario for this.
- [ ] Linux: the warning logged when a child is spawned without `PR_SET_PDEATHSIG` (`process_util.rs`).
- [ ] POSIX "no process left" checks now require the process listing to stay empty for `ABSENCE_HOLD_MS` (`download-process.spec.js`, `platform-probes/probes.spec.js`), and the preview case waits for all ten requests to settle first.
- [ ] macOS and Linux: `v5-fixes/media-dispatch` now records a `launcher-reuse` skip that needs its `allowedCaseSkips` entry; confirm the gate reports it under `skippedCases`.
- [ ] macOS: close and quit stop active work on a background thread (`window.rs`). `request_quit` (macOS only) runs its shutdown on a spawned thread.
- [ ] POSIX-only specs whose fixed sleeps were replaced with state waits: `e2e/download-process.spec.js`, `e2e/platform-probes/probes.spec.js`, `e2e/deep-probes/probes.spec.js`. The deep-probes queue-owner race now waits for an empty queue, not for the backend slot release.
- [ ] Windows CI installs FFmpeg 9.0.2 from Chocolatey (`ci.yml`). Confirm that version exists there and that the E2E fixtures resolve the Chocolatey shim to the real binary.

## Manual checks

- [ ] Near-opaque panels (settings, dialogs, toasts, wizard) in a real window on WebKitGTK.
- [ ] Windows High Contrast and `prefers-contrast: more`: toggles, progress fills and the selected wizard card stay visible. The E2E WebView2 cannot be switched into forced colours, so `high-contrast.spec.js` only proves the rules exist and target the right selectors.

## Known gaps

- [ ] A few E2E sleeps remain because nothing observable marks their end. Each is a named constant with a reason:
  - `AUTO_PREVIEW_SETTLE_MS` in `full-audit-a.spec.js` and `full-audit-b.spec.js` needs the preview controller's pending or in-flight state in `src/e2e-hook.ts`.
  - `PAST_SYNTHETIC_DNS_MS` (`security-release-checks.spec.js`) and `DNS_DRAIN_WINDOW_MS` (`download-process.spec.js`) need a Rust counter of finished synthetic DNS lookups.
  - `STALE_EVENT_WINDOW_MS` (`download-process.spec.js`) needs a renderer counter of ignored stale events.
- [ ] `scripts/round2-release-updater.test.mjs` imports `audit4-release.test.mjs`, so `npm run test:scripts` runs those tests twice.
- [ ] Several ui-polish specs keep private bridge-stub registries, and `transitionsSettled` is repeated in three of them. Moving them to `e2e/helpers/ui.js` needs each spec's registry reads moved too.

## Decided

- No pixel-diff screenshot baseline for 5.1. It would need image dependencies, per-platform and per-scale baselines, and masking of carets, timestamps and spinners. Screenshots stay hashed evidence.
