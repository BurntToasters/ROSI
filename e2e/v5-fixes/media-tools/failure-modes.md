# Media tool failure modes

Record these before writing the verifier or changing product code.

## Destination codec selection

- A shared compatibility list treats AV1 (`av1` or `av01`) as copyable for MOV. FFmpeg 9 rejects AV1 in MOV, so conversion exits during muxer header creation and leaves no usable output.
- A broad fix that removes AV1 compatibility everywhere transcodes valid MP4 AV1 sources unnecessarily. MP4 AV1 copy must remain enabled.
- A destination check can accidentally miss mixed case or aliases, causing one of `av1` and `av01` to keep failing for MOV.
- MOV HEVC copy can lose its Apple-compatible `hvc1` tag; MP4/MOV HEVC output must keep that tag.
- Re-encoding MOV AV1 must use the selected H.264 encoder and safe pixel format where applicable, while compatible audio can still be copied and incompatible audio encoded as AAC.
- Caption mapping, attached-artwork detection, incomplete-probe original preservation, and audio-only MP3/M4A copy/transcode behavior can regress while changing video compatibility.
- The chosen output arguments can look correct but still fail in the bundled FFmpeg muxer, or produce an output whose actual video codec differs from the expected copy/transcode result.

## FFmpeg executable selection

- A custom bare `ffmpeg` found on the inherited PATH can be returned as a bare name. Conversion/GPU/codec processes then receive the enhanced PATH, whose prepended fallback directory may select a different executable.
- The per-operation guard and direct media probes can resolve the same bare setting in different orders and silently use different binaries.
- Explicit PATH entries must win over enhanced fallback entries for a configured bare command; an absent entry must not be mistaken for a found executable.
- A bare custom command that cannot be resolved must follow the existing missing-custom fallback policy: prefer a present bundled sidecar, then retain the system command fallback when no bundle exists.
- With no custom setting, the bundled FFmpeg remains preferred over a PATH executable.
- With no custom setting and no bundle, returning bare `ffmpeg` can make direct probes use enhanced PATH while the guard resolves explicit PATH. Resolve that system fallback to one absolute executable when available; keep the bare command only when neither search path has it.
- A valid custom absolute executable, a custom directory, and a symlinked custom executable must remain usable. FFprobe lookup must continue to prefer the FFprobe sibling of the selected custom FFmpeg, including when FFmpeg itself is reached through a symlink.
- Invalid custom basenames and nonexistent custom paths must continue to fall back safely instead of being launched as configured tools.
- Windows `.exe` discovery and path canonicalization must not make the path returned to conversion differ from the path installed in the guarded tool launcher.
- Process version, GPU encoder, codec-probe, conversion, and guarded yt-dlp FFmpeg calls must all use the centralized selected executable; fixing only one call site leaves the mismatch observable.

The manual verifier must compile the relevant production functions, exercise real bundled FFmpeg MOV and MP4 conversions, inspect resulting codecs with FFprobe, probe selected executable identities using PATH fixtures, and always write a SHA-256 manifest report. It must report that the native application was not launched.

## C4: leaked media-tool launcher directories

Not automated in E2E. Guard: `ffmpeg_guard::sweep_stale_launchers`. Checked by reading the code and the call site in `main.rs`.

- The sweep removes a launcher that a live operation still uses. Guard: only directories whose mtime is more than 24 hours old are removed. A single operation that runs longer than 24 hours could still lose its launcher.
- A symlink named `rosi-media-tools-<uuid>` is followed and the folder it points at is deleted. Guard: `symlink_metadata` plus a real-directory check.
- A link swapped in between the check and the removal is followed. Guard: `remove_dir_all` removes a top-level link as a link and does not descend into its target.
- A directory owned by another user in a shared temp folder is removed. Guard: unix uid must equal `geteuid()`.
- A lookalike name (`rosi-media-tools-` plus non-UUID text, or extra suffix) is removed. Guard: exact 8-4-4-4-12 hex shape check.
- Startup creates the launcher root on a fresh install. Guard: the sweep reads the root and never calls `create_dir_all`.
- Windows: a leaked directory holds a hard link to `ROSI.exe` that is still running in another ROSI process. Removal fails on the sharing lock; the error is logged and the directory is retried at a later start.
- Windows: no owner check. The roots are the per-user data folder and `%TEMP%`, both owned by the user, so this is accepted.
- Linux with a noexec temp folder: `executable_temp_dir()` can create `data_dir/tmp` as a side effect. That is the folder the launcher would use anyway.
- An unreadable entry, failed metadata call, or failed removal panics the startup thread. Guard: every fallible call is logged or skipped; no `unwrap`.
- The sweep blocks startup or a session. Guard: it runs on a spawned startup thread, never on the coordinator or session-owner threads.
- A future-dated mtime makes the directory look fresh and it is kept. This is the safe outcome.
- `Drop` for `FfmpegToolGuard` races the sweep. Both use `remove_dir_all`; a failure in either is ignored or logged, and neither corrupts another directory.
