# V5 beta 2 audit probes

These observational E2E probes drive the real unpackaged Tauri app, bundled yt-dlp, real FFmpeg, and an isolated local media server. Failure modes were written before probe implementation. They do not modify production code or the user's application profile.

Run from the repository root on macOS with Node dependencies installed and a real `ffmpeg` on PATH:

```sh
npm run test:e2e
node e2e/audit-v5-beta2/run-probes.mjs
node e2e/audit-v5-beta2/run-probes.mjs --security
node e2e/audit-v5-beta2/run-probes.mjs --ui
node e2e/audit-v5-beta2/run-probes.mjs --termination
```

The first command builds the E2E binary. Its existing suite may fail while the candidate's audit findings remain unresolved. The custom probes can still run if the build completed. Do not run Cargo build, test, or clippy between building the E2E binary and these probes; those commands can replace it without the E2E feature. Rebuild after production source changes.

The security probe disables the E2E loopback exception. It relies on public DNS for `localtest.me`, which must resolve to loopback, and downloads only from the audit's own isolated local server. It includes a control proving that a literal loopback URL is rejected. No external private service is contacted.

The process ownership probes inspect macOS `ps` output and kill only helper processes with the current fixture server's URL and an audit marker. Windows process inspection would need a platform-specific adapter before these ownership probes can run there. The existing main suite remains the cross-platform gate.

The termination probe requires macOS `/usr/bin/python3`. It puts a synthetic executable named `ffmpeg` inside the isolated fixture directory. Codec probes delegate to real FFmpeg; conversion deliberately starts a descendant that ignores SIGTERM while its parent exits. Only this test-owned descendant is forcefully stopped during cleanup. The probe tests native cancellation and signal escalation, not conversion quality.

Results are written to `e2e/artifacts/audit-v5-beta2/`, with separate `security-probe/` and `ui-probe/` directories. Reports include the commit, application binary hash, FFmpeg hash, probe source hashes, fixture hashes, timestamps, raw observations, and request traces. Isolated profile snapshots and screenshots remain after the temporary profile is removed.

Exit zero means the observations completed. Inspect every `invariantPassed` field; false is a reproduced product defect. The UI diagnostics intentionally record styles and focus state without treating an unfocused or animation-frozen webview as accepted visual evidence. Screenshots require human review. Full candidate acceptance still requires the existing suite, hosted checks, and packaged update/install verification.

For report integrity, remove `reportSha256` from the parsed report, serialize the remainder with `JSON.stringify(report, null, 2)`, and hash those UTF-8 bytes using SHA-256. Generated evidence is intentionally ignored by Git; preserve or attach the entire artifact directory before rerunning probes, which replace their reports.
