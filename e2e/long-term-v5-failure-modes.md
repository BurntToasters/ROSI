# Long-term V5 audit failure modes

Written before the observational probes. These probes do not change production code. Each application launch uses an isolated profile; all data loss is confined to generated fixtures.

1. An older V5 binary loads a settings file from a newer schema, silently normalizes its version, and destroys unknown fields on the next ordinary settings save. Expected safety: preserve the newer file or reject writes with an actionable compatibility error.
2. A valid V4 queue cannot be copied because its V5 destination is temporarily unwritable. Settings import nevertheless completes and prevents all future migration retries. Expected safety: retry recoverable copy failures after the destination becomes available without touching V4 source files.
3. A syntactically corrupt V5 settings file produces defaults, then an ordinary save replaces the only copy. Expected safety: retain the damaged bytes for recovery and tell the user that recovery occurred.
4. A queue with no more than 500 accepted URLs exceeds the 32 MiB loader budget. Both primary and backup become unreadable to the next launch. Expected safety: reject additions before exceeding the serialized byte budget, or use a storage format whose writer and reader limits agree.
5. A normal current-schema profile still supports settings saves and queue persistence. This control separates probe setup failures from compatibility defects.
6. Resetting statistics fails because the destination is unwritable, but the renderer still announces success. Expected safety: show success only after a successful durable backend response.

7. Screenshot generation succeeds but omits the main controls while a display is locked or animations are paused. Expected evidence safety: record visibility and layout separately, and do not treat a nonempty PNG as visual acceptance.

For each case, retain source hashes, application binary hash, timestamps, before/after profile files, structured observations, and native WebDriver logs. Failures must be reported independently. A completed observational runner is not release acceptance. Real packaged upgrades, Windows/Linux runs, signed sidecars, assistive technology, and soak testing remain separate gates.

## Repair acceptance extensions (before production edits)

8. Rejecting an oversized batch must preserve an existing normal queued item, both in memory and after restart. A separate 500-short-URL control must still be accepted and reload fully. Queue writes must share the reader byte budget and leave room for terminal metadata.
9. A resumed V4 import must copy only failed components. It must not overwrite V5 statistics changed after the first launch, or modify any V4 source file. A repaired destination must allow the missing queue to appear on restart.
10. A failed statistics reset must show an error, while an ordinary durable reset must still show success. Record both native results and actual renderer feedback.
11. Future-schema protection must preserve the original file bytes. Damaged settings recovery must preserve the original bytes before a defaults-based save; an unreadable destination must reject writes instead of replacing it.
12. A failed HTTP-404 transfer must retire a verified empty owned stage. Completed media and uncertain ownership must continue preserving recoverable files; explicit cancellation may discard verified owned unfinished `.part` files once helper diagnostics have drained; the existing native process suites cover those distinctions.

13. If the migration journal destination is unwritable, importing V4 settings must not commit a completed V5 profile and prevent future retry. An intent journal must be durable before component writes.

14. A pending V4 component retry must survive a temporarily corrupt legacy settings file after valid V5 settings already exist. Repairing the component destination must still resume without replacing V5 settings. Bookkeeping files in an otherwise empty failed-download stage must not be classified as recoverable media.

15. Existing version-1 V4 import markers lack retryFiles and can already record an imported profile with a failed destination copy. Derive a bounded retry only for known components with OS errors, valid legacy source data, and no existing regular V5 destination. Never overwrite V5 changes or retry terminal malformed-source skips.
