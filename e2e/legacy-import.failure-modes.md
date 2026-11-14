# Legacy import: failure modes (written before the fix)

Goal: `src-tauri/src/legacy.rs` never overwrites an existing ROSI 5 data file,
on a first pass or a retry. When the import marker records a finished import,
a later pass restores settings only and leaves every other ROSI 5 file alone.
A genuine first-time import keeps its current behavior.

Defect (finding A1): with ROSI 5 `settings.json` missing and a ROSI 4 folder
present, the import ran again and copied the ROSI 4 queue, queue backup, stats,
and activity over the ROSI 5 files. The "preserve existing data" check only ran
on a retry (`retry.is_some() && destination.is_file()`).

## Failure modes

Each row names the guard that prevents it and the E2E proof. "Not proven" means
no E2E case in this change reaches that path; the report lists them.

- F01: A fresh first import (no ROSI 5 files, no marker) copies the four data
  files and `settings.json` and records outcome `imported`. Guard: unchanged
  copy loop. Proof: `legacy-v4-import` (existing).

- F02: `settings.json` missing, no marker, and ROSI 5 queue, backup, stats, or
  activity files present. A fresh pass must skip each of them. Guard: the
  existence check runs before every copy, not only on a retry. Proof: not
  proven separately. The new case seeds a marker, so this exact path is not
  reached. The same guard covers it, but it needs a second seed without a
  marker.

- F03: Finished marker (outcome `imported`, no retry files), `settings.json`
  missing, ROSI 5 data files present. The data files keep their bytes and
  content, the ROSI 4 values (queue, stats, activity) do not come back, and
  `settings.json` is restored from ROSI 4. Guard: `Carry::Finished` skips the
  data-file copy entirely. Proof: `legacy-v4-preserve-v5` (new case).

- F04: Finished marker, and the ROSI 4 `settings.json` is corrupt. Settings
  import fails, outcome becomes `failed`, and no ROSI 5 data file is touched.
  Guard: the settings result is unchanged, and the data copy is skipped for
  finished imports. Proof: not proven.

- F05: Retry marker (outcome `partial`, retry files listed) and a ROSI 5 file
  now exists at that destination. The file is preserved and recorded in
  `skipped` with a reason; it does not stay in `retryFiles`, so the recovery
  notice does not claim it failed. Guard: regular-file check on the retry path.
  Proof: not proven.

- F06: Retry marker and the destination is absent. The component is written and
  imported as before. Guard: retry semantics unchanged. Proof: not proven
  (existing retry behavior has no E2E case; regression risk only).

- F07: A destination that is a directory or a dangling symlink counts as
  occupied. The import must not write through it. It is a copy failure, so it
  stays in `retryFiles` until the user removes it. Guard: `symlink_metadata`
  check, not `exists()`. Proof: `long-term-persistence` migration-failure (a
  directory at the queue destination).

- F08: The journal written before copying lists only destinations that do not
  exist. A preserved file never appears in `retryFiles` or the recovery notice,
  and a crash mid-import does not later resume into an existing file. Proof:
  `legacy-v4-preserve-v5` asserts `retryFiles` is empty after the rerun.

- F09: A marker from a different ROSI 4 source is neither resumed nor treated
  as finished. The pass is fresh, and the existence check still protects
  existing ROSI 5 files. Proof: not proven.

- F10: ROSI 5 `settings.json` present. The import does nothing at all.
  Guard: existing early return. Proof: `legacy-v4-preserve` in
  `specs/main.spec.js` (existing).

- F11: ROSI 4 folder changes. The import only reads it. Proof: the snapshot
  assertion in `legacy-v4-import` and `legacy-v4-preserve-v5`.

- F12: Early V5 recovery (an OS-error skip with an absent destination) still
  re-imports that one file from a finished marker. This creates a missing file;
  it never overwrites one. Guard: existing recovery block, unchanged. Proof:
  not proven.

- F13: An atomic write failure on a copy still records the file in
  `retryFiles` and reports outcome `partial`. Guard: existing
  `inspect_err` path, unchanged. Proof: not proven.

- F14: A non-regular entry (directory, FIFO, socket, device) at a ROSI 5
  destination is treated as preserved data. The copy is hidden: the marker
  says `imported`, `retryFiles` is empty, and the ROSI 4 queue item never
  arrives. Guard: only an existing regular file counts as preserved
  (`regular_file`). Any other entry is a copy failure: the file goes into
  `retryFiles`, the outcome is `partial`, and a later launch retries it. Proof:
  `long-term-persistence` migration-failure (outcome and legacy queue item) and
  migration-retry (the queue item imports after the directory is removed).

- F15: An old finished marker (outcome `imported`, no `retryFiles`, a skip
  reason of "preserved") while the destination is now blocked. `Carry::Finished`
  skips the copy, so the blocked file is never retried. Guard: the early-marker
  recovery block also queues a file for retry when the destination is not a
  regular file and the skip is an OS error, or a "preserved" skip with a
  non-regular entry present. A missing destination with a "preserved" skip is
  not re-imported. Proof: `long-term-persistence` migration-old-marker.

- F18: A new skip reason (`BLOCKED_REASON`, a non-regular entry at the
  destination) that the old-marker recovery does not recognise. An old finished
  marker with that skip and `retryFiles` deleted stays `imported`, so the
  blocked file is never retried and the queue item never arrives. Guard: the
  recovery block also re-queues a `BLOCKED_REASON` skip when the destination is
  not a regular file and the source is valid. Proof: `long-term-persistence`
  migration-old-marker and migration-source-corrupt (the blocked file is in
  `retryFiles` and the outcome is not `imported`), and migration-retry (after the
  directory is removed, the queue item imports and `download-stats.json` stays
  at 42).

- F16: A retry overwrites ROSI 5 data written after the first attempt, for
  example `download-stats.json` written by ROSI 5 between the two launches.
  Guard: the regular-file check runs before every copy on every pass, and a
  regular file is never written. Stats are not in `retryFiles` after a
  successful first copy, so they are never copied again. Proof:
  `long-term-persistence` migration-retry (stats stay at 42).

- F17: A symlink at a ROSI 5 destination is followed (its target is read or
  overwritten) or replaced by the copy. Guard: `symlink_metadata` never follows
  a link. A symlink is a non-regular entry, so it is a copy failure: nothing is
  written through it or over it, and it stays in `retryFiles` until the user
  removes it. Proof: not proven (no E2E case; a symlink seed may need Windows
  privileges).

## Scope note

`legacy-v4-preserve-v5` needs a profile that already holds ROSI 5 data and a
finished marker before the app launches. The spec cannot seed that itself, since
the import runs at startup. The seed must come from the pass builder in
`scripts/e2e/runners/wdio-passes.js` and a helper in `e2e/helpers/legacy-v4.js`.
Neither file is in this change's list, so the case is not wired yet.
