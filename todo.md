# TODO

## Before the next release

- [ ] Commit the current working tree, then rerun `npm run test:e2e` on the clean tree. Release proof now rejects E2E evidence recorded from a dirty tree.
- [ ] Get Windows and Linux CI green on the release commit. Release preflight now requires a passing `ci-gate` check on HEAD.
- [ ] Re-sign each platform's release assets with the current `gpg-sign`. Drafts need one `build-commit-<platform>.json` per platform, and drafts built before this change don't have them.

## Needs Windows or Linux

- [ ] Compile and run the Windows changes: the merged `MoveFileExW` helper (`fs_util.rs`, `staging.rs`) and the NTSTATUS error for `NtResumeProcess` (`process_util.rs`). Cross-checking from macOS fails because `aws-lc-sys` needs the Windows SDK headers.
- [ ] Compile and test the Linux `PR_SET_PDEATHSIG` spawner thread (`process_util.rs`). Kill ROSI and confirm that yt-dlp and FFmpeg exit with it.
- [ ] Measure whether `install_executable_alias` (`ffmpeg_guard.rs`) copies the whole executable for every preview, format fetch and download on Windows. If it does, keep one alias pair for each app run.
- [ ] Check the near-opaque panels (settings, dialogs, toasts, wizard) in a real window on each platform, including WebKitGTK and Windows High Contrast.

## Known gaps

- [ ] macOS: yt-dlp and FFmpeg can outlive ROSI after an abort. macOS has no `PR_SET_PDEATHSIG` equivalent; a watchdog pipe is one option.
- [ ] Linux: processes that yt-dlp starts itself (for example its own FFmpeg) don't inherit `PR_SET_PDEATHSIG`.
- [ ] Pin the FFmpeg version CI installs on Windows (choco) once a known-good version is confirmed.

## Refactors (when the code is next touched)

- [ ] Split the longest functions:
  - `launchSetupWizard`: one function per step.
  - `on_ytdlp_exit`: classify the exit first, then one handler per outcome.
  - `start_download`, `run_conversion`, `initializeRenderer`, `initActivityPanel`, `bindSettingsControls` (by section), `validate_settings_patch`.
- [ ] Move the E2E-only probes out of `network_security.rs` and `network_security_async.rs` into `#[cfg(feature = "e2e")]` submodules.
- [ ] E2E specs:
  - Replace fixed sleeps with `waitUntil` on the state being waited for.
  - Share the remaining spec helpers. The `settle` and `modalState` copies differ by spec. `clickById` in `main.spec.js` and `deno-installer.spec.js` ignores a missing element, while the shared helper fails on one.
- [ ] Decide whether a small pixel-diff baseline for a few key screenshots per platform is worth having. Today screenshots are hashed but never compared.
