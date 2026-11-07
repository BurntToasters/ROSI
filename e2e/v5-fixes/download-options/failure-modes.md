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
