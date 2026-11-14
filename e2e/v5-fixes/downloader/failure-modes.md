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

## Wave 1 A2: cancel ownership (queue and manual sessions)

Every cancel names the owner whose session it may end. `cancel_download` ends
only a manual session. Queue cancel and queue clear end only a queue session.
App stop and shutdown still end any session. A cancel that names an owner
never waits on a session it did not match: that session belongs to the other
owner, or has already left the slot and is routed by its own finish.

Before this change, every cancel used the current session, so the manual
Cancel button could end a queue item, and queue cancel or clear could end a
manual download that held the slot.

Failure modes:

C1. Manual Cancel (`cancel_download`) during a queue item: the queue item keeps
downloading and completes; no queue outcome is cancelled. Fails on the
pre-fix code (the queue item became cancelled). E2E: cancel-ownership
spec, case (a).
C2. Manual Cancel during a manual download: the manual download is cancelled
with outcome `cancelled`. Guards the positive case: a filter that matches
nothing would also pass C1. Fails if `cancel_download` does not end the manual
session (no `cancelled` outcome; the 60 s wait times out) or if the download
finishes first (outcome `success`; same timeout). E2E: case (a2).
C2a. The start reply is the IPC envelope `{ok, data: {started, sessionId}}`
(`renderer-globals.d.ts` `RosiIpcResult`; `ipc.rs` `IpcResult`). The check must
read `data`. Reading `value` gives `undefined` and fails at the start assertion
before any cancel is sent. That is a spec defect, not a product result; it is
the failure in the 2026-11-13 Windows run (spec line 185).
C2b. The check passes on leftover state only if an activity entry for the
manual URL already exists before the start. The check asserts that no such
entry exists before it starts the download, so a stale entry fails it.
C3. Manual Cancel with no session in the slot: returns at once and waits for
nothing (no await on the queue or on finished sessions). Covered by C1: the
command is fire-and-forget, and the queue run continues afterwards.
C4. Queue cancel while a manual download holds the slot: the manual download
keeps running and completes. E2E: case (b). Not discriminating: the queue
cannot start while a manual session is in the slot (`start` refuses through
`can_start`), and `download_video` refuses while the queue runs. The only
state where the pre-fix code could hit the manual session is the race at
`queue.rs` "A manual download that was accepted just before the queue
started" (the runner's `blocking_session` branch). IPC ordering cannot
reach that race deterministically, so the case is a regression guard.
C5. Queue clear while a manual download holds the slot: same as C4. E2E: case (b).
C6. Queue cancel or clear while the queue session is in the slot: that session
is cancelled, its item gets one outcome, and the call returns after the
terminal result is routed. Covered by the existing `cancels a running queue
    with one outcome per item` scenario in `e2e/specs/main.spec.js`.
C7. Queue cancel or clear with no session of any owner in the slot: returns
without awaiting every registered session (the pre-fix code awaited all of
them, so a manual download could block a queue cancel). Not reachable
deterministically through IPC; checked by code review only.
C8. A cancel that lands while the runner is starting its session
(`SessionStarted`) ends only that queue session. Race-dependent; checked by
code review only.
C9. App stop and shutdown (`cancel_active_session` with no owner filter,
`kill_all_processes`) still end whichever session is current. Unchanged by
this fix; not separately added. Checked by code review only.
C10. An owner-filtered cancel in the slot-empty case may let a queue session
that has already left the slot finish routing after a queue clear or cancel
snapshot. The item is removed or recorded by its own runner; no outcome is
lost. Accepted; checked by code review.
C11. Manual Cancel of a streamed manual download whose origin response is
delayed (`security-release-checks.spec.js`, "closes a delayed guarded HTTP
response promptly when its download is cancelled"): the origin socket closes
within 3 s, then the download must settle as `cancelled` with `completedAt`
within 10 s. When the manual session holds the slot, the owner-filtered cancel
builds the same `CancelPlan` as the pre-A2 cancel (same notify flags, same
termination order, same `await_finalized` on the session it matched). A2 must
not drop the kill, the reader wait, or finalization for that session. Fails
if the cancelled session never finalizes after yt-dlp is killed (no terminal
result, no `completedAt`). Covered by the security spec; not reproducible by
the cancel-ownership spec alone.
C12. Windows only. The reader thread waits on yt-dlp through
`ManagedChild::wait_timeout`, which holds the child's state lock for each
50 ms poll and retakes it at once after releasing it. Windows mutexes are
not fair, so the waiter can win every time and `terminate_tree`, which takes
the same lock before it kills the job, waits until yt-dlp exits by itself.
The network cancellation still closes the origin socket within milliseconds,
so the symptom is a cancel that closes sockets but settles seconds late or
never: C11 times out after 10 s with no activity entry, and
"cancels metadata and manual-download IPC during delayed connection DNS"
settles after about 3 s instead of under 1 s. Fix: `terminate_tree` kills the
Windows job before it takes the state lock (TerminateJobObject is safe to
call concurrently with a wait and is a no-op on an empty job), and the
Windows poll loop yields between polls so other lock users are not starved.
Proof: the security spec run alone five times in a row with both cases
passing, then the full gate.

## Wave 1 A4: post-install directory sync (Unix only)

`install_download_output_named` no-replace installs the file, then syncs the
download folder. Before this fix a sync error returned `Err`, so the caller
reported the download as failed with the now-missing staging path, and the
installed file was not recorded. The fix logs a warning and returns the
installed path. Conversion already treats a post-install sync failure as
installed (`publication.rs` `publish_staged_source`).

Failure modes:

D1. Sync fails after install (Unix): the download completes with the installed
path, `completedPaths` and `outputPath` name that file, a warning is logged,
and the staging directory is removed. NOT E2E-tested: there is no fault seam
for `fsync` on a directory, and `sync_directory` on Windows always returns
`Ok`, so this path cannot run on Windows. Unproven on Windows and on Linux
CI; needs a Unix run with a fault injected at the sync call (not available
without a new seam).
D2. Install itself fails (destination exists or no-replace refused): unchanged;
the staged original is preserved and the download fails. Covered by the
Finding 1 install-fallback case on exFAT.
D3. Caption sidecar install after a media sync failure: the media path is
recorded as installed, and caption handling runs as before. Covered by D1's
reasoning, not separately tested.

## Wave 1 A6: long paths on Windows

ROSI's output template is `%(title).150B [%(id)s].%(ext)s`. The staging
directory is `<download folder>\.rosi-download-<uuid>`, 52 characters after the
folder. The Windows binary has no `longPathAware` manifest (tauri-build's
default manifest only declares common controls), so Win32 calls on plain paths
are limited to MAX_PATH (260 UTF-16 units, including the terminator).

Reading the code: no `\?\` or verbatim conversion exists anywhere in
`src-tauri/src`. Paths reach `file_identity` (`CreateFileW`) and
`install_no_replace` (`MoveFileExW`) as they are resolved (`resolve_path` keeps
a prefix only when the input has one, and settings paths are plain). A
150-byte title plus `" [id].mp4"` in a 120-character folder gives a final path
near 282 characters (120 folder, a separator, 150 title bytes, " [page].mp4"), so `MoveFileExW` fails with `ERROR_FILENAME_EXCED_RANGE`.
The staged file path (about 335 characters) also fails `CreateFileW`, which
makes `snapshot_stage_entries` report "Could not verify staged entry". Both
calls therefore need a verbatim path when the path is long.

Failure modes:

L1. Final destination over 260 characters (current code): `install_no_replace`
fails and the download fails. This is the case the E2E discriminates on.
E2E: long-path spec, case (c). Expected to fail on the pre-fix code; not
run on Windows at the time of writing.
L2. Staged file over 260 characters (current code): `file_identity` returns
`None`, the stage snapshot fails, and the download fails. Fixed by the same
conversion. Covered by case (c).
L3. Path under 260 units: passed to the Win32 call unchanged (no prefix). Covered
by every existing downloader case that runs on Windows.
L4. Relative path: unchanged (a verbatim prefix needs an absolute path). Not
reachable from settings; code review only.
L5. UNC download folder (`\server\share\...`): converted to `\?\UNC\server\share`.
NOT E2E-tested: no network share in the gate. Unproven.
L6. Destination collision on a long path: the existing file keeps its bytes
and the new file takes a numbered name (no-replace semantics survive the
prefix). Code review only; the existing exFAT case covers the no-replace
behavior on macOS.
L7. yt-dlp itself cannot create a file over 260 characters (the sidecar may not
be long-path aware). If it fails, case (c) fails for a reason outside
ROSI's staging code. The activity error and rosi.log must show which side
failed; the spec records the activity error in its report.
L8. `hide_on_windows` on the staging directory uses a raw call too. The stage
directory is about 177 characters, so the call is below MAX_PATH; its
failure is already ignored. Not changed.
