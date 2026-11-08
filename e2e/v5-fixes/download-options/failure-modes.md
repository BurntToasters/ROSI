# Shared download option resolver failure modes

1. **Resolution order changes.** Settings defaults must be applied first, a
   selected preset second, and explicit on-screen values last. An explicit
   `false` must survive every merge.
2. **Null is mistaken for an override.** `null` and omitted optional fields
   remain unset so a preset/default can supply them; explicit `false` remains
   a value. Hidden playlist controls omit the playlist, while a visible
   `current` selection overrides a saved `all` or `range` selection.
3. **Preview and start disagree.** `resolve_download_options` and
   `download_video` must return/use the same validated resolved snapshot for
   the same settings and request.
4. **Manual and queue disagree.** Both paths must call the shared resolver;
   equivalent settings, preset and explicit overrides produce equivalent
   resolved options.
5. **Queue replay drifts.** Queue admission stores all resolved settings and
   options. Starting or reloading a queued item after settings or presets
   change must keep its enqueue-time request.
6. **Invalid requests bypass envelopes.** Wrong-shaped URL/options payloads,
   unsafe URLs, and disallowed paths return the existing structured IPC error
   envelope rather than a Tauri deserialization rejection or a started job.
7. **Validation is weakened by consolidation.** URL and output path
   allow-lists, preset value validation, and lenient persisted settings/queue
   imports remain in force.
8. **Queue execution semantics change.** Queue ordering, duplicate handling,
   cancellation, and one-at-a-time execution remain unchanged.
9. **Stale renderer copy of a preset.** The renderer caches `downloadPresets`,
   and Rust can hold a newer stored value than that cache. Apply and every
   request must take preset values from `resolve_download_options`, never from
   the cached preset object. Apply writes Rust's resolved values into the
   controls, so the cache is not read for values at all.
10. **A copied value is sent as explicit.** After Apply, a control still holding
    the value Apply copied in must not be sent. Otherwise a later stored change
    to the preset is hidden by a stale on-screen value. Only controls changed
    after Apply are explicit. Exception: the video and audio format dropdowns
    hold URL-specific choices, so whatever they show for the current URL is
    always explicit, even when Apply put it there. The user must get exactly
    what the dropdowns show, and a URL switch during a save must not change the
    formats a request was built with (round-3 checks
    `download-uses-current-url-formats` and
    `manual-format-snapshot-survives-url-switch-during-save`).
11. **An on-screen change after selection loses to the preset.** A control the
    user changed after Apply must win. Related controls move as one group: the
    profile group (`profile`, `bestQuality`, `audioOnly`, `advancedOptions`) and
    the convert group (`convertEnabled`, `convertFormat`, `keepOriginal`), so a
    preset's derived flag cannot override a changed profile or convert choice.
12. **Preset deleted or edited after selection.** A deleted preset id is ignored
    by Rust, so the summary shows no preset label, and the renderer drops its
    selection and copied baseline once its cache loses the preset. An edited
    preset resolves to its stored value at the next summary refresh and start.
13. **Summary, manual Download, and queue add disagree.** All three build the
    request through one renderer builder, and the started request must equal
    `resolve_download_options` for that same request. Applying a preset must not
    change what the summary reports for the same settings.

## E2E acceptance

The native scenario resolves the same preset/overrides through manual and
queue admission, checks explicit `false`, inherited `null`, and the visible
playlist `current` override, rejects invalid payloads through the IPC
envelope, then changes settings before replaying a queued item and verifies
its completion still carries the enqueue-time snapshot. The existing E2E
runner report under `e2e/artifacts/` is the repeatable evidence.

The WebdriverIO scenario `applied preset follows the stored value in Rust`
applies a preset, changes its stored value through the backend, and checks
that the effective-options summary and a queued request both match
`resolve_download_options` for the same request, with no copied values sent.

## Preset preview without a URL

| #   | Failure mode                                                                                | Required behavior                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Apply sends a placeholder URL to `resolve_download_options`.                                | Apply calls `resolve_preset_options` with only a preset id. No request sent by Apply carries a URL, including `example.com`.              |
| 2   | An unknown or deleted preset id resolves silently to plain settings.                        | `resolve_preset_options` returns a `VALIDATION_ERROR` envelope. Apply reports failure and leaves the controls unchanged.                  |
| 3   | A malformed payload (not an object, missing or non-string `presetId`) rejects inside Tauri. | The command returns the structured error envelope and starts nothing.                                                                     |
| 4   | The URL-less preview computes precedence differently from a real request.                   | Both call `layer_candidate`, so for the same settings and preset the preview values equal the preset layer of `resolve_download_options`. |
| 5   | Apply reads the renderer's cached preset instead of the stored one.                         | The backend resolves the id from stored settings; the cached preset object is not read for values.                                        |
| 6   | Skipping URL validation for the preview weakens `resolve_download_options`.                 | `resolve_download_options` still returns `INVALID_URL` for a missing or invalid URL. Only the preview path skips the URL.                 |
| 7   | Preview has side effects.                                                                   | The preview only resolves values. It adds no queue item and starts no download.                                                           |

E2E acceptance: the WebdriverIO scenario `preset preview takes no URL and shows
backend values` records the renderer's calls during Apply and checks that the
command received only the preset id, with no call carrying `example.com`. It
checks that the controls show the preset values, that the URL-less preview
equals the URL-validated resolution for the same preset, that an unknown id
and a malformed payload return the `VALIDATION_ERROR` envelope, and that no
queue item was added.

## Manual download start: stored FFmpeg path and pending settings save

Round 5.1 renderer findings F4 to F5 (`src/engine/bind/download.ts`).

| #   | Failure mode                                                                                                  | Required behavior                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | The manual Download request sends the stored `ffmpegPath` after that file was removed. Rust refuses it with `ffmpegPath does not exist.` and nothing starts. | The manual request omits `ffmpegPath`. Rust falls back to the stored setting, then to the bundled FFmpeg, and the download starts.                                                    |
| 2   | Removing `ffmpegPath` from the request drops other request fields (`outputPath`, resolved overrides).         | The request still carries `url`, `outputPath` when a folder is set, and the same resolved overrides as before.                                                                              |
| 3   | The fix clears the stored `ffmpegPath` to make the request pass.                                              | The stored value is untouched. The settings loader keeps a stale path on purpose (`settings.rs`), so the value on disk is unchanged after a start.                                          |
| 4   | With "Ask where to save" off and no folder, a toggle changed just before Download is still in the 300 ms debounce when `download_video` reads settings from disk. | Settings are flushed to disk before `api.downloadVideo`, even when no save folder was chosen. The started request uses the changed value.                                 |
| 5   | The flush runs only inside `if (savePath)`, or a failed flush is ignored and the download starts anyway.      | The flush runs on every path. A failed flush calls `failManualDownloadStart`, clears `isDownloading`, calls `syncPrimaryActionState`, and shows the existing error toast. No download starts. |
| 6   | The flush moves ahead of the folder dialog, so a cancelled dialog still persists settings.                    | The folder dialog and its cancel path run first, as before. Only the flush before `downloadVideo` is unconditional.                                                                         |
| 7   | `downloadFolder` is assigned, or `updateUIFromSettings` runs, when no folder was chosen.                      | `downloadFolder` assignment and `updateUIFromSettings` run only when `savePath` is set.                                                                                                    |

E2E acceptance:

- `manual download starts with a stored FFmpeg path that no longer exists`
  saves a real FFmpeg-named file as `ffmpegPath`, reloads so the renderer holds
  it, deletes the file, and starts a manual download. The recorded
  `downloadVideo` request has no `ffmpegPath` key, the start result is `ok`, and
  the saved `ffmpegPath` is still the stored value.
- `manual download flushes a pending toggle with no save folder` sets
  `askDownloadLocation` off and `downloadFolder` empty, turns `convertEnabled`
  on and clicks Download in the same script turn. The recorded
  `downloadVideo` call sees `convertEnabled: true` through `getSettings` before
  it is forwarded, so the debounced save had reached the backend.

## Update Ready modal copy

Round 5.1 renderer finding F6 (`src/engine/updater-ui.ts`).

| #   | Failure mode                                                                                              | Required behavior                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The modal says the update installs on restart. Only Restart Now installs it, so quitting discards the bytes. | The message says that Restart Now installs the version, and that quitting makes ROSI download it again next time.                                                         |
| 2   | The version is missing or wrong in the message.                                                           | The message names `data.version`.                                                                                                                                          |
| 3   | The title or the button labels change.                                                                    | `Update Ready!`, `Restart Now`, and `Later` stay as they are. E2E and `renderer-dom-checks` match them.                                                                     |
| 4   | The modal key or the candidate guard changes.                                                             | `key: 'updater-downloaded'` and the `candidateId` check in Restart Now stay as they are.                                                                                  |

E2E acceptance: no scenario in this spec covers F6. It is a copy change in
`updater-ui.ts`, and `e2e/renderer-dom-checks/updater.cjs` is outside this
change set. The manager may add a check there that the modal message contains
the version and "Restart Now", and does not contain "will be installed when you
restart".
