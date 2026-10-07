# State and updater repair failure modes

Enumerate these cases before changing production code. The E2E spec covers
renderer-visible contracts; temporary-directory native tests cover filesystem
replacement rules that cannot be exercised safely against an installed app.

## F02: settings revisions and save callers

1. A save response for revision A arrives after the user changes a control to
   revision B but before B's debounce fires. The live control and final disk
   settings must both retain B.
2. Several control changes coalesce while a timer is pending. Every caller
   awaiting the superseded save must settle with the final save result.
3. Backend responses arrive out of order. An older snapshot must never become
   the last persisted state or replace newer in-memory settings.
4. A backend response normalizes or adds fields. It may reconcile those fields
   only when its saved revision is still current; newer edits and presets must
   survive reconciliation.
5. Close, import, setup completion, reset, preset save/delete, queue submission,
   and restart must wait for the same latest-revision flush.
6. A failed latest save must settle every waiting caller as failure and retain
   the user's unsaved controls for retry.
7. A successful save must reconcile backend-normalized values without
   replacing the settings object captured by an open setup wizard or Deno
   reminder. If another settings save completes between wizard completion and
   the Deno reminder action, the reminder mutation must remain in the next
   immutable snapshot and on disk.
8. A lifecycle flush captures revision A and holds its backend response while a
   control mutation creates revision B. Close/restart/update acknowledgement
   must remain pending until B, not just A, is durably saved; a failed B save
   must refuse the dependent lifecycle action.

## F11: Compatible profile wording

1. A source with MP4 formats may produce MP4 while retaining the existing fast
   selection path.
2. A source offering only WebM must not be described as guaranteed MP4 output.
3. Split audio/video and codecs unsupported by a target container must not make
   the profile imply a codec or playback guarantee that was not verified.
4. Preset and queue summaries must use the same qualified description as the
   profile selector.

## F12: queue persistence ordering and acknowledgement

1. A background writer pauses after capturing revision A; a later flush of
   revision B completes; then A resumes. Primary and backup must remain B.
2. Concurrent mutations and flushes must be serialized by one owner and flush
   must acknowledge the latest revision visible when called.
3. The backup must be atomically replaced and must never contain a partial
   primary snapshot.
4. A primary write or backup write can fail, including disk-full and rename
   failure. The failure must be returned to the flush caller and logged without
   claiming durability.
   A newer partially failed attempt must still prevent a delayed older
   snapshot from overwriting its primary file; a skipped flush must report an
   error unless an equal or newer revision was durably committed.
5. Process interruption during temp write, primary rename, or backup rename
   must leave a readable prior primary or backup.
6. An updater pre-install flush failure must abort before installer launch,
   leave the downloaded update available for retry, and leave active app state
   intact.
7. A renderer settings flush that remains pending beyond the close deadline
   must leave the app open; a later acknowledgement for that expired close
   generation must not destroy the window.
8. A backup path replaced with a directory must cause the real profile queue
   flush to fail visibly. Close and restart must be refused, and the latest
   primary queue snapshot must remain readable and available through the app.
9. Repeated close requests after a flush deadline must not create a stack of
   native timeout dialogs. One warning may remain visible until dismissed;
   stale timeout callbacks and later close attempts must not create duplicate
   warnings for the same unresolved save state.

## F13: macOS updater bundle safety

1. Two different apps in one parent directory must resolve different backup
   paths; two copies of the same-named app in different directories must also
   resolve different paths.
2. A truncated `Contents`, missing `Info.plist`, missing executable, or missing
   resources must be incomplete and cannot trigger backup deletion.
3. A complete staged bundle with a different bundle identifier or executable
   must be rejected before the live bundle moves.
4. Two installs of the same app must serialize their replacement and recovery
   transitions.
5. A failed move, permission failure, or cross-device move must retain a
   complete known-good bundle and recovery metadata.
6. Recovery may remove only a partial live bundle at the exact owned install
   path and may restore only a complete backup with the expected app identity.
7. An unrelated or identity-mismatched backup must remain untouched.
8. The privileged shell validator must reject symlinked bundle components,
   empty executables, and bundles missing the required Resources tree just as
   the unprivileged validator does.
9. A complete live app and a complete identity-matched sibling backup may both
   be protected by `/Applications` permissions. Recovery must preserve both
   entries, validate the staged update, then let the privileged path remove
   only the matching backup; it must not abort while trying to delete that
   backup before validation.
10. A partial live app with a complete identity-matched protected backup must
    retain the backup and partial live entry until the staged update passes
    identity validation. The privileged path may then restore the matching
    backup and continue replacement; an unrelated or incomplete backup remains
    untouched and fails closed.
11. A writable complete live app plus a complete identity-matched backup must
    recover and install without requesting administrator privileges. A
    PermissionDenied result at the recovery boundary may route to the
    privileged installer only after staged-bundle validation.
12. A writable partial live app plus a complete identity-matched backup must
    restore and install without administrator privileges. If partial recovery
    fails with PermissionDenied, the complete backup must remain available for
    the privileged retry; non-permission failures must be returned safely.
13. A Windows installer launch must preserve Tauri resources when launch fails,
    then run Tauri cleanup immediately before the successful launch path exits
    the process. Removing cleanup entirely leaves resource and window state
    behind during the direct installer exit.

## F03: download completion session ownership

1. A completion, legacy status event, progress event, or idle event from an
   earlier session arriving after a new manual download starts must not clear
   the current button, progress, or file result.
2. A completion for the current session must produce its own structured file
   result; legacy progress text must not overwrite the structured output path.
3. The prior completion's delayed result/hide timer must not reset a newly
   started download. Activity must retain both sessions' completion records.

## F14: updater check/download generations

1. Concurrent checks may finish out of order. Only the latest check generation
   may change pending update, status, or target.
2. A channel/target change while a check is in flight must invalidate that
   result and close its resource.
3. A download can begin while an older check is pending; that old check must
   not release or replace the resource being downloaded.
4. Download completion is bound to the immutable update identity and target
   captured at start. It cannot mark a replacement update as downloaded.
5. Cancellation, feed removal, stale errors, and stale not-available results
   must settle without mutating current status or leaking update resources.
6. Install must use only the exact downloaded identity.
7. A check requested during an active download must not issue a second feed
   request, replace the update being downloaded, or change its eventual status.
8. If an update download is cancelled and its captured identity is replaced,
   the old download resolving afterward must not mark the replacement as
   downloaded or installable; the old resource must be closed.
   While its transfer remains unsettled, retain the updater resource and the
   single-flight lock: a second download must be refused and a check must not
   reach the feed. Once the transfer settles and attaches any late bytes,
   close both resources before checking the replacement target.
9. If installation is refused because the actual profile queue backup cannot
   be written, the app must stay open and the downloaded bytes must remain
   attached to the same update identity. After removing the disk fault, retry
   must reach the installer path and retire the resource.

## E2E-only native command access

1. A native E2E command present in the invoke handler but absent from the
   generated command manifest or the E2E capability permission list is denied
   before its bounded test behavior runs. Cover stale-download event injection,
   close cancellation, updater-install probing, and the fixed network probe.
   Register these commands only in the E2E build manifest and E2E config so
   production capabilities and commands remain unchanged.

## State E2E fixture contracts

1. Setting a preview URL with JavaScript alone does not trigger URL validation
   or enable the Preview button. The test must dispatch the same input event as
   a user before clicking; remote-thumbnail rejection and bounded data-image
   assertions remain mandatory.
2. `get_queue` returns a bare queue array, while fallible IPC commands return
   an `{ ok, data, error }` result. Queue assertions must use the direct array
   returned by the renderer API and still verify both the live and persisted
   snapshots.
3. The updater-generation scenario must establish whether the controlled feed
   emitted an `available` status before waiting for its modal. A missing modal
   must report the check result/status so a broken mock contract cannot hide
   behind a timeout; the available-modal and identity assertions remain
   mandatory.

The native E2E controls updater IPC at the renderer boundary to make feed and
download races deterministic. The Tauri invoke bridge may be read-only, so a
plain property assignment or object clone cannot be assumed to install the
mock; verify the bridge descriptor and prove the packaged check reaches the
controlled feed before waiting for UI state. When the host bridge is frozen,
use a `VITE_ROSI_E2E`-gated adapter around only updater IPC/feed calls; it must
be absent from production builds and preserve the real updater state machine.
Its fake update install still calls the native `window::shutdown()` E2E probe
against a real profile backup-path fault, then allows the retry to pass once
that fault is removed.

## F08 renderer handoff for guarded thumbnails

1. A remote extractor thumbnail URL must never be assigned to `img.src`.
2. Only a bounded backend-produced `data:image/...;base64,...` thumbnail is
   renderable; absent, malformed, or remote values clear the old thumbnail.
3. A late preview response must not restore a thumbnail after the preview target
   changes or is cleared.
