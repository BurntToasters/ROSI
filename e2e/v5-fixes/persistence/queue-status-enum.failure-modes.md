# Queue status enum: failure modes

Written before the production change. `QueueItem.status` moves from `String`
to a `QueueStatus` enum with the same lowercase wire and disk strings. Each row
names a way the change could break behavior and the check that catches it.
Checks are Rust unit tests in `queue.rs` `persistence_tests` (they run through
the real `normalize_item`, `read_queue`, and `persist_queue_files`), or a review
check where a unit test cannot see the problem.

Current loader rules (the behavior to preserve):

- Accepted status strings from disk: `pending`, `completed`, `failed`,
  `cancelled`. Anything else (including `downloading`, unknown strings,
  wrong case, non-string, missing) becomes `pending`.
- `startedAt`, `completedAt`, `filename`, `outputPath`, `sizeBytes`, and
  `error` are read only when the normalized status is not `pending`. An
  interrupted `downloading` item therefore loses those fields.
- `error` is read only for `failed`.
- Duplicate URLs are dropped only among items whose normalized status is
  `pending`.
- `downloading` is written to disk while a run is active, so it is a real disk
  value that must reload as `pending`.

## Wire and disk shape

| #    | Failure mode                                                                | Guard                                                                                                  |
| ---- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1.1  | Enum serializes as `Pending` or `"Pending"` instead of `"pending"`          | `each_status_round_trips_through_the_item_json_unchanged` for all five values                                      |
| 1.2  | `downloading` serializes differently from the frontend string               | Same test, includes `downloading`                                                                      |
| 1.3  | A field gains or loses `skip_serializing_if`, changing key presence         | `each_status_round_trips_through_the_item_json_unchanged` compares the full JSON (keys and values) for every status and for a minimal pending item           |
| 1.4  | Renamed key (`added_at` vs `addedAt`) changes the envelope                  | Same key-set test                                                                                      |
| 1.5  | Persisted file gains or loses the `schemaVersion` / `items` envelope        | `persisted_file_keeps_envelope_and_lowercase_statuses_including_downloading` reads the bytes written by `persist_queue_files` |
| 1.6  | Disk gets a status other than the current string set                        | Same test: every status written to disk is one of the five lowercase strings                           |
| 1.7  | Enum adds a `#[serde(other)]` or default variant that changes disk output   | Review check: no `#[serde(other)]`; the round-trip tests fail on any new string                        |

## Legacy and persisted files that load today

| #    | Failure mode                                                                    | Guard                                                                                                       |
| ---- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 2.1  | Bare-array ROSI 4 file stops loading                                            | `legacy_bare_array_and_items_wrapper_load_with_per_status_fields` reads a bare array through `read_queue`                              |
| 2.2  | `{ items: [...] }` object shape stops loading                                   | `legacy_bare_array_and_items_wrapper_load_with_per_status_fields` also covers the `items` wrapper                                     |
| 2.3  | `downloading` on disk is restored as `downloading` or rejected                  | `interrupted_downloading_item_reloads_as_pending_without_attempt_fields` asserts `pending` and dropped attempt fields                    |
| 2.4  | Unknown status (`running`, `done`, empty) no longer maps to `pending`           | `unknown_and_odd_statuses_normalize_to_pending_and_keep_the_item` covers unknown, empty, wrong case, number, null, missing    |
| 2.5  | Case-insensitive match added (`Completed` now accepted)                         | Same test: `Completed` must become `pending`                                                                |
| 2.6  | A file that loads today fails to load after the change (whole file dropped)     | `read_queue` returns `Some` for each mixed-status file in the tests                                         |
| 2.7  | Non-string status makes the whole item or file fail deserialization             | `unknown_and_odd_statuses_normalize_to_pending_and_keep_the_item` includes number and null, and the item is kept              |

## Interrupted and per-status field handling

| #    | Failure mode                                                                    | Guard                                                                                                       |
| ---- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 3.1  | Interrupted `downloading` keeps `startedAt`/`filename`/`outputPath` after load  | `interrupted_downloading_item_reloads_as_pending_without_attempt_fields` asserts they are `None`                                        |
| 3.2  | `error` kept on `cancelled` or `completed` items                                | `legacy_bare_array_and_items_wrapper_load_with_per_status_fields` asserts `error` is `None` for cancelled and completed items  |
| 3.3  | `failed` item loses its `error`                                                 | Same test: failed keeps `error`                                                                             |
| 3.4  | Field read rule changed from normalized status to raw status                    | `interrupted_downloading_item_reloads_as_pending_without_attempt_fields` (a raw-status rule would keep `startedAt`)                     |

## Dedupe and item identity

| #    | Failure mode                                                                    | Guard                                                                                                       |
| ---- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 4.1  | Two `downloading` items with one URL both load (dedupe keyed on raw status)     | `duplicate_urls_dedupe_only_among_normalized_pending_items` expects one item                                         |
| 4.2  | `completed` plus `pending` with the same URL collapses to one                   | Same test: both kept (dedupe applies to `pending` only)                                                     |
| 4.3  | Dedupe is lost for `pending` items                                              | Same test                                                                                                   |

## Backup fallback and writer

| #    | Failure mode                                                                    | Guard                                                                                                       |
| ---- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 5.1  | Corrupt primary is not reported as unreadable, so backup fallback breaks        | `read_queue` returns `None` for a corrupt file (in `corrupt_primary_reads_as_unreadable_so_backup_fallback_can_run`)                                  |
| 5.2  | Backup written from the converted enum form differs from primary bytes           | `persisted_file_keeps_envelope_and_lowercase_statuses_including_downloading` checks primary and backup both parse with the same statuses |
| 5.3  | Existing flush tests break from helper changes                                  | Existing `flush_*` tests stay as they are, except the `item()` helper's status literal                     |

## Activity records and callers

| #    | Failure mode                                                                    | Guard                                                                                                       |
| ---- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 6.1  | `DownloadCompletion.outcome` (activity) is touched by the change                | Review check: `Outcome` and `activity.rs` are not edited; activity records keep their `outcome` strings     |
| 6.2  | Progress `status` (`JobProgressEvent`, progress.rs) is changed by mistake       | Review check: those fields stay `String`; `git diff` shows no edit there                                    |
| 6.3  | Legacy import (legacy.rs) starts parsing statuses                               | Review check: `legacy.rs` only copies files; no status code added                                           |
| 6.4  | A `match` over the status drops a variant after refactor                        | Compiler exhaustiveness plus `cargo clippy -D warnings`                                                     |
| 6.5  | Runtime comparison with `"downloading"` misses an in-memory item                | Compiler plus clippy; review check that no `"downloading"` or other status string comparison remains in queue.rs |
| 6.6  | Frontend sees a different string for a status                                   | Same as 1.1 and 1.2; `src/` is not edited                                                                   |
