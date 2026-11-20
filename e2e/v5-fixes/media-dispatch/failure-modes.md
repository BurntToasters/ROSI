# Media dispatch failure modes

Record these before writing the verifier or changing product code.

## Windows alias dispatch

- Windows can resolve an extensionless command such as `.../ffmpeg` to the on-disk `ffmpeg.exe` while preserving the extensionless command token as the child process `argv0`. Comparing only against `ffmpeg.exe` returns `None`, so ROSI enters normal Tauri startup instead of forwarding the tool call.
- Windows paths are case-insensitive, and a caller may preserve a mixed-case alias in `argv0`. Exact case-sensitive role matching can miss a valid `FFMPEG.EXE` or `FfPrObE` alias.
- Recognizing a filename must still use the private launcher directory next to `argv0`; canonicalizing the hard-linked ROSI image can resolve it back to `rosi.exe` and lose the alias role.
- A recognized alias with a missing, malformed, unsafe, or incomplete private config must exit with failure before GUI startup. Returning `None` on a dispatch error would fall through to the GUI and violate the fail-closed behavior.
- FFmpeg and FFprobe aliases must select only their corresponding configured path. FFmpeg argument restriction and FFprobe protocol restriction must remain in the existing forwarding path.
- Fixing the Windows filename rule must not change Unix's explicit `--rosi-private-media-tool` protocol or platform fallback behavior.

## Verification requirements

- Use the built ROSI executable copied as private launcher aliases and invoke those aliases through the actual bundled yt-dlp, whose Windows FFmpeg command uses an extensionless `argv0`.
- Exercise `.exe`, extensionless, and case-varied filenames where the Windows filesystem permits them, and verify that the expected configured helper receives the call.
- Exercise missing and malformed config through recognized aliases and verify a refusal exit rather than Tauri startup.
- Run only against local fixtures, isolate the profile and clean temporary files, and emit a timestamped JSON report with a SHA-256 manifest. State that helper-mode aliases were launched and that GUI state is not independently instrumented; do not claim an unobserved GUI result.

## R2: launcher location and reuse (Windows)

Recorded before the change. Spec: `launcher-reuse.spec.js` (needs the area mapped in `e2e/suites.json`).

- The launcher root sits in Roaming app data. A synced or roaming profile copies it, and every operation adds and removes a directory there. Guard: the root is `app_state::local_data_dir()/media-tools`. E2E builds derive it from `ROSI_E2E_DATA_DIR/local`, so tests never leave the temp profile.
- A fresh directory per operation makes two hard links (or two full copies of ROSI) per preview, format fetch and download. Guard: one directory per run per distinct config, keyed by the exact config bytes. Operations with equal config share it.
- A short hash key could merge two different configs and run the wrong ffmpeg. Guard: the key is the full config content, not a hash.
- Two operations with different ffmpeg or ffprobe paths must not share. Guard: different config bytes give different directories.
- One operation ending removes a directory that another still uses. Guard: shared directories are never removed by `Drop`. They live for the whole run.
- Two operations start together and both build aliases in one directory. Guard: lookup and creation run under one lock.
- A directory deleted or damaged during the run (config changed, alias missing) is handed out again. Guard: reuse checks the config bytes and the alias files, and rebuilds when they do not match.
- The startup sweep removes the current run's shared directory. Guard: the sweep skips every registered directory, checked under the same lock that creation uses. A directory is registered before anything can use it.
- The sweep leaves launchers from earlier runs. Guard: in the local root any unregistered `rosi-media-tools-<uuid>` directory is removed regardless of age (ROSI is single instance in production). The old Roaming root and the temp root keep the 24 hour age rule.
- Lookalike names, symlinks and files are removed. Guard: unchanged exact name shape, `symlink_metadata`, real-directory check.
- Hard link fails (other volume, FAT, policy) and the copy fallback hides it. Guard: the error is logged once per run (`Could not hard-link the media-tool launcher`) before the copy.
- The local root cannot be created. Guard: fall back to the temp directory as before.
- Unix behaviour changes. Guard: Unix keeps one script directory per operation and removes it on `Drop`.

Observable check: after two `getFormats` calls with identical settings, no more than one new launcher directory appears, and its `ffmpeg.exe` shares a file index with the ROSI binary, or the log names the hard-link error.
