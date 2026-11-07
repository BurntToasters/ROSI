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

## E2E acceptance

The native scenario resolves the same preset/overrides through manual and
queue admission, checks explicit `false`, inherited `null`, and the visible
playlist `current` override, rejects invalid payloads through the IPC
envelope, then changes settings before replaying a queued item and verifies
its completion still carries the enqueue-time snapshot. The existing E2E
runner report under `e2e/artifacts/` is the repeatable evidence.
