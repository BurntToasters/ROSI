# Settings patch save failure modes

The renderer keeps a baseline of the settings the backend last confirmed
(`backendSettings` in `src/engine/settings-store.ts`). Each save sends only the
top-level keys that differ from that baseline, and `save_settings` merges the
patch into the stored file. Values the renderer did not change are never sent,
so a value written to disk by another path survives an unrelated save.

| #   | Failure mode                                                                                      | Required behavior                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `downloadPresets` (or another key) changes on disk after load, then an unrelated setting is saved | The disk value survives. The stale renderer copy is not sent.                                                                                                                |
| 2   | The renderer changes one key and the others match the baseline                                    | The patch holds only the changed key.                                                                                                                                        |
| 3   | The snapshot equals the last confirmed state (edit reverted or no real change)                    | An empty patch is still sent, so the backend keeps every value. Waiters settle as saved, feedback shows saved for the latest revision, and `settingsSavedRevision` advances. |
| 4   | A save succeeds                                                                                   | The returned settings become the new baseline. Reconcile runs as before, only when the snapshot is still the newest revision.                                                |
| 5   | A save fails by error, exception, or `NEWER_VERSION`                                              | The baseline does not move, so the changed keys are sent again on the next save.                                                                                             |
| 6   | `VALIDATION_ERROR` refuses some keys                                                              | The baseline becomes the disk state from `getSettings`. Refused keys are restored as before. A newer edit to a refused key stays and is sent on the next save.               |
| 7   | A structured value is copied to a new object with equal contents                                  | It is not sent. Equality is deep through `settingsValuesMatch`.                                                                                                              |
| 8   | A key is missing from the renderer snapshot                                                       | It is not sent and not deleted. The backend keeps the stored value.                                                                                                          |
| 9   | Imported settings are reconciled in place                                                         | The imported values become the baseline, so they are not sent again as changes.                                                                                              |
| 10  | No baseline was recorded                                                                          | The full snapshot is sent, as before.                                                                                                                                        |

The E2E scenario `settings-patch-preserves-backend-values` changes
`downloadPresets` in `settings.json` behind the renderer, saves an unrelated
toggle through the UI, and checks the file on disk and the keys the renderer
sent. Its recorded observation is the repeatable proof artifact.
