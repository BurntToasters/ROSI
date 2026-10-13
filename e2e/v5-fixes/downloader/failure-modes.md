# Downloader audit fixes: failure modes (written before production code)

## Finding 1: no-replace install on filesystems without rename flags

Fallback is used only when the flagged rename reports Unsupported. ENOTSUP,
EOPNOTSUPP and ENOSYS are unsupported on their own. EINVAL is not: renameat2
and renamex_np also return it for unrelated errors, so EINVAL falls back only
when a probe confirms the flag itself is rejected. Other errors still
propagate unchanged.

Probe (EINVAL only): create an empty `.rosi-probe-<uuid>` in the destination
folder, then rename it to a fresh unused name with the same flag. If that
flagged probe succeeds, the flag works and the original EINVAL is a real error
(returned unchanged, no fallback). If the probe fails with EINVAL, ENOTSUP,
EOPNOTSUPP or ENOSYS, the flag is unsupported and the fallback runs. The probe
file is removed on every path; if it cannot be created, the original error is
returned.

Probe failure modes:
P1. Flag works and original EINVAL was unrelated: no fallback, original error.
P2. Flag rejected (exFAT-like): probe EINVAL, fallback installs the file.
P3. Probe cannot create its file (read-only folder): original error, no fallback.
P4. Probe succeeds but cleanup fails: the probe name is left; it is a
ROSI-prefixed hidden name, and the error is logged, not returned.
P5. Probe name collision: create_new fails with AlreadyExists; a new UUID is
tried, up to 8 times, then the original error is returned.

1. The flagged rename works on ext4/APFS: fallback must not run (no behavior change).
2. ENOTSUP on exFAT/FAT/SMB (macOS): fallback must still install the file.
3. EINVAL on NFS/FUSE (Linux): same as 2.
4. Destination already exists as a regular file: create_new fails with
   AlreadyExists; the existing file must be untouched; callers retry names.
5. Destination exists as a dangling symlink: create_new fails with AlreadyExists
   (O_EXCL does not follow symlinks), nothing is written through it.
6. Destination exists as a directory: create_new fails with AlreadyExists.
7. Source is a file and the placeholder is reserved, then rename fails
   (for example ENOENT because the temp vanished): the placeholder must be
   removed so no empty file is left behind; the error is returned.
8. Source is a directory: reservation uses create_dir (exclusive). rename onto an
   empty directory replaces only the empty placeholder. If the placeholder got
   content (non-empty), rename fails with ENOTEMPTY/EEXIST and user data is not
   touched; the placeholder is then removed only if still empty (remove_dir).
9. Source directory rename onto a directory that is not ours: impossible because
   create_dir reserved it; if a race swaps in content, rename fails (non-empty).
10. Placeholder is replaced by another process between reservation and rename:
    residual race. The fallback cannot be made atomic without renameat2 flags.
    Accepted risk: documented; the window is a few microseconds and the name is
    a UUID-suffixed ROSI name for staging, or a user-visible media name for
    final outputs (the final output case is the residual risk, documented here).
11. Windows: the fallback is not used (MoveFileExW without replace already fails
    with ERROR_ALREADY_EXISTS on existing names). Verified by code path only.
12. Non-unix platforms with the generic hard_link path: unchanged.
13. Concurrent downloads reserving the same name: exactly one create_new wins;
    the loser gets AlreadyExists and callers pick another candidate.
14. A name containing NUL bytes: path_cstring returns InvalidInput before any
    filesystem call (unchanged behavior).

E2E acceptance (macOS only, exFAT image via hdiutil): a download completes into
the exFAT folder, and a pre-existing same-named file keeps its original bytes
(sha256 unchanged). The runner mounts the image and records the case. On
Linux/other, the case is recorded as `skipped` with a reason unless
ROSI_V5_FIX_EXFAT_MOUNT supplies a mount.

## Finding 4: crashes leave no trace (panic hook)

1. Hook runs before app_state::init: data_dir falls back to a temp dir; the
   message must still be written somewhere, or at least stderr.
2. Panic while LOG_LOCK is held by the same thread: logging::write_line would
   deadlock on lock(); the hook must use try_lock and write without the lock
   when it fails.
3. Panic while another thread holds LOG_LOCK: try_lock fails, the hook writes
   without the lock; a torn line is acceptable, a deadlock is not.
4. Panic inside the hook itself: must not recurse; a re-entrancy guard is used
   and the hook returns.
5. Panic message is a non-string payload: message falls back to "<non-string panic payload>".
6. Panic in a thread without a name: thread name shows "<unnamed>".
7. Previous/default hook still runs so stderr output and abort behavior stay the same.
8. Release builds use panic = "abort": the hook runs before abort, so it is
   still invoked. Verified by reading the hook sequence only.
9. Lock poisoning in logging: existing code returns early on poisoned lock; the
   hook path must not panic on poisoned lock either (try_lock returns Err).
10. Log file is unwritable: hook ignores I/O errors and never panics.
11. `.expect("download paths validated")` at on_ytdlp_exit: replaced with an
    error path; a missing final path must not panic the callback thread and must
    still complete the session with a failure outcome.
12. Empty downloaded list at that point: the session completes as failed with
    a message; no panic and no completion callback is lost.

E2E acceptance: not reliably drivable through WebDriver (panic aborts the app).
The spec verifies that after the app starts, the log file exists and contains
the startup line (proves logging path), and a unit-level check is NOT written
(per AGENTS.md). The panic path is covered by the hook code review plus a
deliberate-panic debug command only if one exists; none is added here.

## Finding 5: orphaned staging entries

Policy:

- Only top-level entries of the download folder are considered (read_dir, no
  recursion).
- Entry type is read with symlink_metadata. Symlinks are never followed and never
  deleted through (a symlink named like ROSI staging is left and logged).
- Names must match exactly one ROSI prefix and a UUID-shaped suffix:
  `.rosi-download-*`, `.rosi-convert-*`, `.rosi-retire-*`,
  `.rosi-source-retire-*`, `.rosi-caption-publish-*` (directories) and
  `.rosi-path-*.txt` (files).
- Age: mtime older than 24 hours. Newer entries are left (may belong to a
  session that is still running, or a second ROSI instance).
- Sweep runs on a background thread after startup, and skips entirely when a
  download session is active (downloader::is_busy()). A download that starts
  later creates new names; the sweep only touches entries older than 24h, so the
  race with a new session is limited to entries it did not create.
- Directory contents: a staging directory is not deleted recursively blindly.
  Inside it, regular files are inspected:
  - yt-dlp intermediates are discarded, the same as `.part`: `*.part`,
    `*.ytdl` (yt-dlp resume/control files), `*.part-Frag<N>` (fragment
    temp files) and `*.temp.<ext>` (postprocessor temp output).
  - `*.f<digits>.<ext>` format streams are discarded ONLY when the same staging
    directory also holds a complete merged file with the same stem (for example
    `clip.mp4` beside `clip.f137.mp4`). Without that sibling a stream is the only
    copy of downloaded media: a merge that failed after both streams completed
    leaves a playable video-only and audio-only track, and ROSI retained that
    staging for recovery on purpose. Such streams are recovered, never deleted.
  - Empty directories and empty files: deleted.
  - Recoverable media files (non-empty, not an intermediate, not bookkeeping):
    moved to the download folder under a non-overwriting name
    (`<stem> (recovered N).<ext>`, created with create_new), then the emptied
    directory is removed.
  - The intermediate rules only apply inside a stale ROSI staging directory
    (or as a top-level staging file); a user file such as `clip.f2.mp4` in the
    download folder itself is never touched.
  - Subdirectories or symlinks inside: left in place and logged (not recursed).
- `.rosi-path-*.txt` files: deleted only if they are regular files, size under
  64 KiB, and older than 24h (bookkeeping only). Their content is not parsed.
- If the download folder cannot be read, the sweep logs and exits.
- Settings are read without requiring app_state init to finish; if the folder
  cannot be resolved, the sweep is skipped and logged.

Failure modes:

1. Symlink named `.rosi-download-x` pointing at a user folder: must not be
   followed or removed recursively. Left and logged.
2. Entry deleted between read_dir and metadata: ignored (NotFound).
3. Permission denied on a child: logged, sweep continues with other entries.
4. Media recovery name collision: create_new loop with counter; never overwrite.
5. Recovered media move fails (cross-device): fall back is not attempted; the
   media is left in place and the directory retained, logged.
6. A running session's staging dir that is older than 24h (very long download):
   skipped while downloader::is_busy() is true; if not busy, a stale dir is
   only what a crash left behind.
7. Sweep races a new download reserving a fresh name: new names are fresh mtime,
   so they are skipped.
8. Windows: directories/files created by ROSI get FILE_ATTRIBUTE_HIDDEN; the
   sweep still matches on names, so older unhidden leftovers are still swept.
9. Download folder equals the app data dir or is `/`: the sweep only matches
   ROSI prefixes; no other entries are touched.
10. Hidden-attribute call failing (for example on a network share): ignored,
    logged once, staging still works.
11. Non-UTF-8 names: compared through OsStr prefix/suffix; non-matching names skipped.
12. Staging holds `clip.f137.mp4` plus `clip.f251.webm` and a complete `clip.mp4`:
    both streams discarded; only `clip (recovered).mp4` appears.
    12a. Staging holds only `song.f137.mp4` and `song.f251.webm` (merge failed, no
    merged sibling): both streams are recovered with identical bytes; deleting
    them would destroy the only copy of completed downloads.
13. Staging holds `clip.temp.mp4` (postprocessor temp) or `clip.mp4.part-Frag2`
    (fragment) or `clip.ytdl`: discarded.
14. Staging holds a complete `clip.mp4` next to `clip.f137.mp4`: `clip.mp4` is
    recovered with identical bytes, the stream is discarded.
15. A stale `.rosi-path-<session>-<uuid>.txt` whose session part is not digits
    is not bookkeeping and is left in place (name never produced by ROSI).
16. A top-level `.rosi-path-<session>-<uuid>.txt` that is a real ROSI name (numeric
    session) is deleted; the fixture must use that exact shape.

E2E acceptance: create a stale `.rosi-download-<uuid>/` with a `.part` file, a
stale `.rosi-path-<uuid>.txt`, a stale media file inside a staging dir, and a
symlink named like staging. After startup, the spec waits for the sweep marker
and asserts: `.part` and bookkeeping gone, media recovered under a new name with
identical sha256, symlink target untouched, and fresh entries untouched.

## Finding 12: split downloader.rs into staging.rs

1. Moved item visibility not widened beyond pub(crate) / pub(super).
2. Drop order of DownloadStage and ConversionTemp unchanged.
3. Lock discipline comments stay with the code that uses them.
4. In-file #[cfg(test)] module still compiles and passes.
5. No behavior change: a diff of moved bodies must be identical apart from
   module paths and visibility.
6. Missing `use` after move causes compile errors, not silent changes.

## Sweep coverage (re-audit, written before the change)

17. A download saved to a per-download or per-preset folder crashes. Its staging
    leftovers live outside the default folder and are never swept. Expected: the
    sweep also covers folders that recorded activity (output, failed and request
    output paths) and queued requests point at.
18. A recorded folder no longer passes download-path validation (moved, now a
    system folder, or tampered activity file). Expected: it is skipped; the sweep
    never reads a folder that a new download could not use.
19. Many records name the same folder, or hundreds name different folders.
    Expected: folders are deduplicated and capped, so startup cost stays bounded.
20. A stale empty `.rosi-probe-<uuid>` file is left when the app dies during a
    rename-flag probe. Expected: removed like other bookkeeping; a non-empty file
    with that name is retained.
