# Lifecycle and cleanup fixes (A8, A11, A12): failure modes

Written before the code. Each row names how the change could regress and how
it is checked. "Read" means checked by reading the diff and the call graph;
"cargo" means `cargo check`/`clippy` with and without `--features e2e`.

## A8: session owner comment

1. The corrected comment claims catch_unwind protects only unwinding builds.
   If that is wrong for dev or test builds, the comment misleads the next
   reader. Checked by reading `Cargo.toml` (`[profile.release] panic = "abort"`)
   and the owner code (`catch_unwind` runs in every profile that unwinds).
2. The comment must not change any behavior. Checked by reading: the diff
   touches only `//` lines in `session_owner.rs`.

## A8: Linux PR_SET_PDEATHSIG (DEFERRED)

Status: deferred. The Linux pre_exec and spawner-thread code was removed
(manager decision, retry 1) because it cannot be compiled or tested on this
Windows machine and there is no Linux proof for this beta. The spawn path is
back to its pre-change form. The gap is recorded in the comment at the unix
spawn site in `process_util.rs::command`.

3. Gap (deferred). Release builds abort on panic, so on Linux and macOS
   helpers (yt-dlp, FFmpeg) can outlive ROSI after an abort. Deferred until a
   Linux build can verify the fix. Checked by reading the comment and the diff:
   no Linux spawn code remains (`grep` for `pre_exec`, `PDEATHSIG`,
   `linux_spawner` returns nothing in `process_util.rs`).
4. Planned fix, not implemented: PR_SET_PDEATHSIG tracks the spawning thread,
   so it needs a process-lifetime spawner thread (a naive version would kill
   manual-download yt-dlp when its pool thread idles out). Recorded in the
   comment; a Linux run must prove it before it lands.
5. macOS has no PR_SET_PDEATHSIG equivalent. Recorded in the same comment; no
   code change.

## A11(a): flush pending activity at shutdown

10. A failed activity save is kept in memory and not retried. The pending flag
    must be set on every failed persist and cleared on every successful persist
    (record and clear). Checked by reading each `persist` call site in
    `activity.rs`.
11. Flush must take the lock before checking the flag, so a record that fails
    concurrently is not missed. Checked by reading `flush_pending`.
12. Flush runs off the coordinator and session-owner threads. `shutdown` already
    runs on a blocking thread (`notify_settings_flushed` uses spawn_blocking)
    or on the main thread for macOS quit/restart; the flush adds one bounded
    file write (the same as the queue flush). Checked by reading the callers.
    No timeout is added: a hung disk would hang the queue flush the same way.
13. A flush failure must not be reported as success. `shutdown` returns Err, so
    the close flow offers the existing "Close Without Saving" dialog. Checked by
    reading `shutdown_with_close_generation`.
14. Restart and forced close must not panic or block on activity. The forced
    close path logs a flush failure and continues, as the queue path does.
    Checked by reading `force_close`.
15. Idle flush cost: when nothing is pending, the flush takes the lock and reads
    a bool. Checked by reading.

## A11(b): sanitize_filename reserved names

16. Trimming must happen before the reserved-name test, so `con ` and `CON .txt`
    are reserved. The reserved test must still apply to the stem before the
    first dot, after trailing spaces are removed. Checked by reading the new
    order and by hand-tracing: `con ` -> `con` (reserved, cleared),
    `con.txt` -> cleared, `console` -> kept, `com1 ` -> cleared, `a.con` -> kept.
17. Existing behavior for non-reserved names must not change: the same
    character filter, all-dots clear, trailing-dot/space trim, 255-byte cap.
    Checked by reading that only the reserved check moved and gained a trim.

## A11(c): format listing output cap and truncation report

18. The format cap rises from `MAX_OUTPUT_BUFFER * 4` (2 MB) to
    `MAX_OUTPUT_BUFFER * 20` (10 MB), matching video info. Checked by reading
    the two call sites in `media_info.rs`.
19. Truncation must be reported, not silent. `process_util::drain` records
    whether bytes were dropped, `Output` carries `stdout_truncated`, and the
    format transform returns an error before parsing a cut buffer. Checked by
    reading `drain`, `wait_with_output`, and the format closure. The field is
    added to a pub struct whose only literal is in process_util.rs.
20. The drain change must not alter capture for non-truncated output. Checked
    by reading: `kept` receives the same bytes; only the flag is new.
21. Output consumers outside media_info (deno.rs, sidecars.rs, gpu.rs) use
    fields only; adding a field breaks none. Checked by cargo.
21a. Video info (`get_video_info`, cap 10 MB) reports truncation with the same
    check as format listing: a cut buffer returns an error before parsing,
    with the same wording pattern ("... larger than 10 MB and could not be
    read."). Only a successful exit (code 0) reaches the check, so a failing
    yt-dlp still reports its own exit message. Checked by reading the closure.

## A12: stale comment

22. The misplaced doc comment above `parse_status_code` describes a function
    that returns vetted addresses. No such function exists: `resolve_destination`
    does not apply policy, and the preflight function returns bool. Removing the
    comment must not change code. Checked by reading the diff: comment lines
    only.
23. Other A12 candidates (settings.rs save_settings comment, queue.rs
    end_run_if_drained comment, validation.rs notification branch,
    command_builders.rs subtitle and video branches, staging.rs caption branch)
    were checked by reading and found accurate or reachable. They are left
    unchanged and listed in the report.

## Not written in this pass

- No E2E spec was written for these rows. The worker brief says no new unit
  tests and lists cargo checks as the proof. The manager should decide whether
  a Windows E2E case (a `con ` download name and a failed-then-flushed activity
  save) is worth adding. Linux PDEATHSIG needs a Linux run.
