# Persistence fixes: failure modes (findings 2, 3, 15, 16)

Written before the production changes. Each row names the way a fix could
fail and the check that catches it (E2E spec mode in
`persistence-acceptance.spec.js`, or a review check where E2E cannot see it).

## Finding 2: stats and activity wiped when damaged

| #   | Failure mode                                                                | Guard                                                                                                       |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 2.1 | Damaged download-stats.json is replaced by defaults without a recovery copy | `stats-damaged`: resetStats leaves a `download-stats.recovery-*.json` with the original bytes               |
| 2.2 | Unreadable download-stats.json (directory, EACCES) is overwritten           | `stats-unreadable`: resetStats returns an error and the path is still the directory                         |
| 2.3 | Oversized stats file (over 4 MB) is treated as damaged and replaced         | Review check: guard uses the loader bound (`MAX_STATS_FILE_BYTES`); the spec covers only the directory case |
| 2.4 | Damaged download-activity.json is replaced without a recovery copy          | `activity-damaged`: clearDownloadActivity leaves a recovery copy with original bytes                        |
| 2.5 | Unreadable download-activity.json is overwritten                            | `activity-unreadable`: clearDownloadActivity returns an error and bytes are unchanged                       |
| 2.6 | Recovery copy overwrites an earlier recovery copy (same name)               | Names carry a fresh uuid; review check on the name format                                                   |
| 2.7 | Recovery copy write fails but the primary is still replaced                 | Guard returns Err before the primary write; review check on `?` ordering                                    |
| 2.8 | A valid file is copied to a recovery file on every save                     | `stats-damaged`: a second save leaves exactly one recovery copy                                             |
| 2.9 | Logged error missing when a save is refused                                 | Review check: refusals go through the existing `logging::error` path                                        |

## Finding 3: schema versions and previous-generation backup

| #    | Failure mode                                                               | Guard                                                                                                                                                    |
| ---- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | Writer emits an envelope the reader cannot parse                           | `queue-legacy-array` and `queue-envelope-roundtrip` add an item and reload                                                                               |
| 3.2  | Legacy bare-array queue is rejected after upgrade                          | `queue-legacy-array` loads a bare array and sees its items                                                                                               |
| 3.3  | Legacy bare-array activity or stats is rejected                            | `activity-legacy-array` and `stats-legacy-object` (review: loaders accept both shapes)                                                                   |
| 3.4  | Newer schema file (`schemaVersion: 2`) is rewritten                        | `queue-newer-schema`, `activity-newer-schema`, `stats-newer-schema`: bytes unchanged after writes                                                        |
| 3.5  | Newer schema file is silently accepted for writes with no logged error     | Review check: guard error reaches `logging::error`                                                                                                       |
| 3.6  | Backup is still an identical copy of the primary                           | `queue-backup-previous`: after two saves, backup holds the first generation                                                                              |
| 3.7  | Damaged primary is copied over the good backup                             | `queue-damaged-primary`: backup still parses and holds the last good generation                                                                          |
| 3.8  | Backup rotation runs when the primary is missing and leaves a stale backup | `queue-backup-previous` second scenario: primary removed, save, backup unchanged                                                                         |
| 3.9  | Writer and reader disagree on the size limit                               | Review check: writer and reader use the same constant and the same envelope encoder                                                                      |
| 3.10 | Admission check measures bare-array size while the file is an envelope     | Review check: admission uses `encode_list`, the same encoder as the writer                                                                               |
| 3.11 | Backup rotation fails silently and the primary is still replaced           | Review check: rotation error returns before the primary write                                                                                            |
| 3.12 | Legacy import (legacy.rs) copies a file the new reader rejects             | Review check: legacy.rs is unchanged; v4 bare arrays are accepted by `list_items`, and `queue-legacy-array` and `activity-legacy-array` seed bare arrays |
| 3.13 | Stats `schemaVersion` leaks to the renderer as a changed shape             | Review check: `DownloadStats` is unchanged, the version is added only on write                                                                           |
| 3.14 | Existing in-file Rust tests break                                          | `cargo test` run by the caller; the flush test asserts backup = previous generation (documented change)                                                  |

## Finding 15: unreadable settings has no recovery path

| #    | Failure mode                                                             | Guard                                                                                                                |
| ---- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 15.1 | Oversized or unreadable settings.json shows defaults with no explanation | `settings-unreadable`: getSettings succeeds and saveSettings returns an error; review: the Err branch sets `problem` |
| 15.2 | Message is logged on every call instead of once per launch               | Review check: uses the existing `REPORTED` OnceLock                                                                  |
| 15.3 | Message lacks the path or the action                                     | Review check: message names the path, the reason and the fix                                                         |
| 15.4 | Save proceeds over an unreadable file                                    | `settings-unreadable`: settings.json (directory) unchanged after saveSettings                                        |
| 15.5 | The dialog cannot be observed in E2E                                     | Known gap: only the logged warning and the refused save are checked automatically                                    |

## Finding 16: broadcast parameter

| #    | Failure mode                                                | Guard                                                                                                              |
| ---- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 16.1 | A call site still passes a snapshot                         | Compile error (`cargo check`)                                                                                      |
| 16.2 | A caller broadcasts while holding the queue lock (deadlock) | Review check: every call site drops the guard first                                                                |
| 16.3 | Emitted queue-update is stale                               | `queue-backup-previous`: the queue read back after each add contains the new item, the state the broadcast carries |

## Refused writes must be visible (re-audit, written before the change)

R1. A newer ROSI version wrote the queue, activity or stats file. This build
refuses to overwrite it, but the refusal is only logged, so queue edits made
in this session silently vanish on restart. Expected: the first refusal per
file kind shows one warning dialog naming the file and the remedy (reopen the
newer version), and the log records that the user was told.
R2. Every later edit in the same session raises the dialog again. Expected: one
dialog per file kind per launch; later refusals are logged only.
R3. The dialog fires from the background queue writer while a modal is already
open or before the window exists. Expected: the dialog is non-blocking and
the write path never waits on it.
R4. A refused write is reported for a file that was not newer (damaged or
unreadable). Expected: those keep their own handling (recovery copy or the
unreadable-file refusal); only the newer-version case uses this dialog.
