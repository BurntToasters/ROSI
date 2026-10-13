# V5 beta 2 deep audit probes

These observational E2E probes drive the real unpackaged Tauri app with the
bundled yt-dlp and an isolated profile per mode. The failure modes in
`failure-modes.md` were written before the probe code. The probes do not
change production code or the user's real profile.

Run from the repository root on macOS or Linux, after a fresh E2E build, with
a real `ffmpeg` on PATH:

```sh
npm run test:e2e          # or any command that rebuilds the E2E binary
node e2e/audit-v5-beta2-deep/run.mjs
node e2e/audit-v5-beta2-deep/run.mjs --only close-newer-queue,queue-owner-race
```

Do not run `cargo build`, `cargo test` or `cargo clippy` between the E2E build
and the probes. Those commands replace `target/debug/rosi` without the E2E
feature, and the runner refuses a stale binary.

| Mode | What it checks |
| --- | --- |
| `close-newer-queue` | The window closes when the queue file has a newer `schemaVersion`, and the file keeps its bytes. |
| `close-newer-settings` | The window closes when settings.json has a newer `settingsVersion`, and the file keeps its bytes. |
| `close-invalid-folder` | A folder the backend rejects is refused at selection, unrelated settings still save, and the window closes. |
| `queue-owner-race` | Starting the queue and a manual download at the same moment never fails queue items with an owner conflict. |
| `staging-sweep-leak` | The startup sweep removes bookkeeping files and partial conversions from a stale staging folder. |
| `proxy-pool-exhaustion` | An HLS download whose 12 segments live on 12 keep-alive HTTPS origins requests every segment promptly. |

`proxy-pool-exhaustion` serves segments from loopback HTTPS origins that use
the test CA in `e2e/fixtures`, with a 10-minute keep-alive timeout. It
observes for 120 seconds and then cancels the download.

`close-invalid-folder` replaces only `window.api.selectDownloadLocation`, so it
returns a real folder outside the profile's HOME. That is what the native
folder picker returns when a user picks such a folder. Every backend path is
unchanged.

Results go to `e2e/artifacts/audit-v5-beta2-deep/<timestamp>/`. Each mode has
`observation.json`, `wdio.log` and the app's `rosi.log`. `report.json` holds
the commit, the binary hash, the probe source hashes and all observations.
`report.sha256` is the SHA-256 of `report.json`.

Exit zero means every observation completed. It does not mean ROSI passed.
Inspect each mode's `invariantPassed`; `false` is a reproduced product defect.
