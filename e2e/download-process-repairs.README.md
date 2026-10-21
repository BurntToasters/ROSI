# Downloader and process repair E2E

The failure inventory is in `download-process-repairs.failures.md`. The probe
drives the real unpackaged Tauri application and bundled yt-dlp with deterministic
local media, real FFmpeg, an isolated Firefox cookie database, and test-owned
FFmpeg behaviors for tree escalation, bounded output, GPU failure fallback, and
probe cancellation. It records attempt-owned output paths, partial playlist
results, metadata settlement times, and stale-session event behavior.

Build a fresh E2E binary with the repository's `npm run test:e2e` gate, then run
the focused probe without rebuilding it:

```sh
node e2e/run-download-process-repairs.mjs
```

The probe currently requires macOS or Linux, Python 3, a real FFmpeg, and the
fresh binary at `src-tauri/target/debug/rosi`. It uses `ROSI_REPAIRS_FFMPEG`
(or `ROSI_E2E_FFMPEG`) when set, otherwise it resolves `ffmpeg` from PATH.
It leaves the profile evidence and a repeatable report under
`e2e/artifacts/download-process-repairs/`. The report hashes the application
binary, source probes, fixtures, isolated Firefox cookie database, and helper
wrappers. `retained-artifacts/manifest.json` indexes copies of the public
fixtures and helper scripts, downloaded output files, and the synthetic
Firefox cookie database by relative path, byte count, and SHA-256. The runner
clears this owned artifact directory before each run. It records authenticated
request decisions without saving real browser cookies.

Exit zero means every repair invariant passed. Exit nonzero means the report
contains the observations that failed; inspect `observations` and the retained
artifact manifest. The process probe only inspects and cleans up helpers whose
command lines carry its own fixture URL markers.
