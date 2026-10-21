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
