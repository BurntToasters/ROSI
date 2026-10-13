# V5 beta 2 deep audit probes: failure modes

Written before any probe code. Each probe drives the real unpackaged E2E
build. A probe records observations; `invariantPassed: false` is a reproduced
product defect. No production code changes precede these probes.

## D1. A newer queue file blocks closing the app (`close-newer-queue`)

Hypothesis: `queue::flush()` runs in every close, restart and update path.
Its writer refuses a queue file whose `schemaVersion` is newer than this
build. The refusal is permanent, so every close attempt fails and the window
stays open.

Ways the product can fail:

1. The close is refused and the window stays open.
2. The window closes, but the newer queue file is rewritten (downgrade
   protection broken).
3. The window closes only after the renderer timeout dialog.

Ways the probe can mislead:

- The close request never reaches the backend (WebDriver did not deliver it).
  Guard: require a `prepare-for-close` acknowledgement or a close-outcome log
  line before judging.
- The app closes, and teardown then fails because no webview remains. Guard:
  set `globalThis.rosiMainWindowClosed` before judging, as the main suite does.

Expected (correct) behavior: the window closes, and the newer queue file keeps
its original bytes.

## D2. A newer settings file blocks closing the app (`close-newer-settings`)

Hypothesis: the renderer saves its full settings snapshot before it
acknowledges a close. `save_settings` refuses to replace a settings file with
a newer `settingsVersion`, so the renderer never acknowledges, and the
backend shows "Save Still Pending" after 1.5 s.

Ways the product can fail: same as D1, with settings.json as the protected
file.

Ways the probe can mislead: a native warning dialog shown at startup can hold
focus. Guard: judge only from the log and the window state, not from the UI.

Expected: the window closes, and settings.json keeps its original bytes.

## D3. A rejected download folder blocks every later save and closing (`close-invalid-folder`)

Hypothesis: the folder picker result is stored in renderer settings without
validation. When the backend rejects that folder (outside home and the allowed
volumes), the whole settings snapshot is rejected. Every later save, and the
close flush, fails until the user picks another folder.

The probe replaces only `window.api.selectDownloadLocation` so it returns a
real folder outside the profile's HOME. This is what the native picker returns
when a user chooses such a folder (for example `/Users/Shared` on macOS or
`/srv/media` on Linux). The backend path is unchanged.

Ways the product can fail:

1. The UI shows the rejected folder as if it were saved.
2. An unrelated setting changed afterwards is not saved.
3. The close is refused.

Ways the probe can mislead: the replacement folder is accidentally inside
HOME. Guard: record the folder and HOME, and assert the folder is outside
HOME before judging.

Expected: the rejected folder is refused at selection time, unrelated settings
still save, and the window closes.

## D4. A manual download that starts during queue start fails the whole queue (`queue-owner-race`)

Hypothesis: `start_queue` checks the session owner once. The runner later
calls `start_download` for each item. When a manual session holds the slot,
`start_download` returns "Download session already active with a different
owner." and the runner marks the item failed and moves to the next one at
once. Every pending item fails in milliseconds without being attempted.

Ways the product can fail:

1. One or more queue items are marked failed with the owner-conflict error.
2. The queue stops with all items failed while the manual download runs.

Ways the probe can mislead:

- The manual request is rejected first (queue won the race). Then no conflict
  can occur. Guard: repeat the race several times and record each round's
  winner; only a round where both requests were accepted can judge.
- Items fail for an unrelated reason (unreachable URL). Guard: judge only on
  the exact owner-conflict error text.

Expected: a queue item never fails because of a session-owner conflict; the
runner waits for the slot or refuses to start.

## D5. The startup sweep leaks bookkeeping files and keeps partial conversions (`staging-sweep-leak`)

Hypothesis: a crash leaves `.rosi-download-<uuid>/` with media, the
`.rosi-path-<session>-<uuid>.txt` bookkeeping file (non-empty), and a nested
`.rosi-convert-<uuid>/` partial output. The sweep "recovers" the bookkeeping
file into the user's folder as `... (recovered).txt`, never removes the nested
conversion directory, and therefore keeps the stage directory forever.

Ways the product can fail:

1. A `.rosi-path-* (recovered).txt` file appears in the download folder.
2. The nested `.rosi-convert-*` directory and its partial output remain.
3. The stage directory remains after the sweep.

Ways the probe can mislead:

- The seeded entries are not stale (mtime under 24 h). Guard: set every
  seeded entry's mtime two days back, directory last, and record it.
- The sweep has not run yet. Guard: wait for the "Recovered staged file" log
  line for the seeded media before judging.

Expected: the media is recovered once, the bookkeeping file and the partial
conversion are removed, and the stage directory is gone.

## D6. Idle HTTPS tunnels exhaust the proxy's fixed worker pool (`proxy-pool-exhaustion`)

Hypothesis: each CONNECT tunnel occupies one of the 8 proxy workers for its
whole life, with no idle timeout. yt-dlp keeps finished HTTPS connections
open in its pool. When one download touches more than 8 HTTPS origins that
keep connections alive, later connections wait in the proxy queue until an
origin closes an idle connection. Fragments stall or are skipped.

The probe serves an HLS playlist whose 12 segments each live on a different
loopback HTTPS port with a long keep-alive timeout. It records when each
segment was first requested.

Ways the product can fail:

1. Segments after the eighth tunnel are not requested within the observation
   window.
2. The download takes much longer than the segment data needs.
3. The download completes with skipped fragments (silent truncation).

Ways the probe can mislead:

- The bundled yt-dlp does not pool connections (urllib handler). Then every
  segment arrives promptly and the hypothesis is refuted. Record that as a
  passing invariant, not a probe error.
- The test CA is not trusted, so every CONNECT fails. Guard: require segment 1
  to be served over TLS before judging.
- The origins close idle connections early (Node's default 5 s keep-alive).
  Guard: set the origins' keep-alive timeout to 10 minutes and record it.

Expected: every segment is requested within a few seconds of the previous
one, and the download completes with all 12 segments.
