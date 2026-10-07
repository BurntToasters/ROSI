# Round 2 native repair failure inventory

These scenarios were enumerated before the native production edits. The
corresponding E2E probe must launch the real ROSI E2E binary with an isolated
profile, record each observation, and write a repeatable JSON artifact.

1. **Download source ownership.** If a foreign file arrives in the selected
   download folder while yt-dlp is running, or replaces a just-downloaded
   source while FFmpeg is finishing, conversion cleanup must preserve the
   foreign bytes. Downloads must be staged per session, installed without
   replacing a collision, and cleanup must remove only that session's staging
   directory. Cancellation or process failure must leave the staged source
   out of the user-visible folder and preserve every unrelated file.
2. **Durable JSON replacement.** A write may fail while creating a parent,
   writing the temporary file, syncing it, renaming it, or syncing the
   containing directory. Failures must leave the previous complete JSON file
   readable and remove the temporary file when possible. A successful write
   must sync both file contents and the directory entry before it reports
   success.
3. **Durable conversion install.** A converted output may be empty, fail to
   sync, collide with an existing name, fail its no-replace move, or fail the
   containing-directory sync. ROSI must keep the original until a non-empty
   converted file and its installed directory entry are durable. A failure at
   any stage must preserve the original and any pre-existing destination.
4. **Windows process ownership.** A spawned helper may exit while a child or
   grandchild continues running and holds inherited output pipes. All
   descendants must be assigned to an app-owned kill-on-close Job Object
   before the helper can execute, then be killed on cancellation, timeout,
   normal leader exit, or owner drop. Failure to create/configure/assign the
   Job Object must fail closed without leaving an unowned child.
5. **Close acknowledgement and shutdown.** Renderer flush can complete near
   the 1.5-second acknowledgement deadline, while native helper shutdown takes
   longer. Once the current generation acknowledges flush, its renderer timer
   must no longer cancel the close; bounded shutdown must finish asynchronously
   and destroy the window only after durable queue persistence. A shutdown
   error or stale acknowledgement must leave the app open and permit a fresh
   close generation.
6. **Activity clear transaction.** If persisting an empty activity log fails,
   the in-memory list and emitted snapshot must retain the prior entries. A
   retry after the storage failure is repaired must clear both memory and disk.
7. **Activity size budget.** Repeated history plus a large playlist record
   must never serialize `download-activity.json` beyond the 16 MiB read limit.
   The newest completion and its useful detail must survive trimming; the
   activity file must remain parseable and reloadable after each write.
8. **Deno verification.** A file named `deno` can be corrupt, non-executable,
   unrelated, or hang. Detection must run a bounded `deno --version` probe and
   return false unless it exits successfully with a recognizable version;
   a valid executable discovered through the supported search paths must still
   return true.
9. **Windows media-tool forwarding.** The process builder creates suspended
   Windows children so ownership can be assigned before execution. A private
   FFmpeg/ffprobe launcher must use that managed spawn path too; calling
   `Command::status` directly leaves the real media tool suspended. During a
   real app download, snapshot the candidate temp roots before starting, find a
   newly created app-owned alias directory and its `launcher.json`, then execute
   that alias and require its `-version` probe to exit successfully within a
   bounded interval. Record the actual configured tool path; do not assume it
   matches the test wrapper or invoke the wrapper directly.
10. **Queue retry request variability.** HTTP clients may issue multiple GETs
    while one queued retry is succeeding, so a fixed total request count can
    reject correct behavior. Fail the first GET, allow later GETs, then require
    one failed queue activity, one successful retry activity, an existing final
    output in the selected folder, and no remaining private staging directory.
    Require at least two GETs without assuming exactly one request per attempt.

The E2E evidence is intentionally limited to observable app behavior and
filesystem state. It does not prove survival of real power loss or run the
Windows Job Object scenario when the host is not Windows.
