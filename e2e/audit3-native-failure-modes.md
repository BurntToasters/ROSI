# Audit 3 native repair failure modes

Findings 1–5 were recorded before the original repair harness and native
production edits. Follow-up findings 6–14 were recorded before their matching
diagnostic cases were added. The E2E probe must use a fresh ROSI E2E binary and
an isolated profile, then save a repeatable JSON artifact containing each case
and its invariant.

1. **Writable durable publication on Windows.** A downloaded stage or converted
   stage may be opened read-only before `sync_all`. Windows flush requires a
   write-capable handle, so publication fails before the no-replace install.
   The fix must reopen an existing stage with read and write access and must not
   create or truncate it. Both original-download and converted-output install
   paths must use this behavior. Linux/macOS success does not prove the Windows
   handle contract; report a Windows runtime gate separately if unavailable.
2. **Completed playlist entries on yt-dlp failure or cancellation.** yt-dlp can
   complete one or more entries and then return nonzero, or cancellation can
   arrive before the normal success path consumes `after_move:filepath`. The
   already-completed, validated regular files must remain recoverable and be
   represented by their final paths and accurate byte totals. Incomplete
   `.part` files must never be published. A colliding user file must remain
   byte-for-byte intact. Failure must remain failure and cancellation must
   remain cancelled even when completed entries are preserved.
3. **Caption preservation during conversion.** A source can contain video,
   audio, embedded subtitles, and requested external subtitle sidecars. MP4/MOV
   conversion must map compatible subtitle streams with a supported subtitle
   codec such as `mov_text`; audio-only conversions must not invent video or
   discard requested captions. If embedding a stream or sidecar is unsupported
   or conversion fails, preserve the requested caption as a sidecar. Publish
   each final media/caption artifact without replacing existing user files,
   avoid publishing duplicate captions, and do not delete original media or
   subtitle files until all required replacement artifacts are safely
   published. A stage cleanup must not remove requested captions.
4. **Final paths in session completion metadata.** Same-extension conversion
   can take a publication shortcut: the staged input becomes the user-visible
   output, but session state may retain the hidden staging path. If a later
   playlist item is cancelled or fails, completion metadata must report only
   paths that were successfully installed, and sizes must be computed from
   those final files. Do not mark a path complete before the session ownership
   gate and publication have both succeeded.
5. **GPU cache invalidation across FFmpeg changes.** A probe against FFmpeg A
   can be blocked while settings switch to FFmpeg B and clear the cache. If A
   later completes, its result must not be served as B's result for the cache
   TTL. Cached capabilities must be bound to the effective FFmpeg identity and
   stale in-flight probes must not overwrite the current generation. The E2E
   probe should use two marker FFmpeg wrappers with different encoder
   capability results, change settings while A is blocked, then prove a fresh
   lookup runs against B and returns B's result.
6. **An incomplete codec probe is not proof that embedded captions are absent.**
   `probe_media_codecs_for_session` currently collapses spawn, timeout, and
   diagnostic failures to an empty codec inventory. `convert_one` can then
   treat captions as absent and retire the original after successful
   conversion. Distinguish a verified probe with no subtitle streams from an
   unreliable probe; preserve the source whenever subtitle presence is unknown.
   The diagnostic should fail the codec probe while allowing conversion of a
   source with embedded captions, then verify the original remains recoverable.
7. **Caption sidecar enumeration errors must fail closed.**
   `caption_sidecar_paths` currently converts directory and entry errors into
   an empty list. That can let stage cleanup drop captions that were never
   enumerated. Propagate enumeration errors or use a verified ownership
   snapshot, retain the recovery stage, and verify the media final path remains
   represented while staged media and captions remain recoverable.
8. **Partial media publication must retain accurate completion paths.**
   `publish_staged_source_with_captions` can install media and then return only
   a caption error, so callers may report the obsolete staging path and omit
   the already-final media path. Unsupported embedded-caption originals that
   publish successfully also need to appear in completion paths. Preserve the
   published media path in all partial-publication outcomes and report
   ancillary caption failures without losing recovery data.
9. **Caption ownership must survive replacement races.** A staged sidecar can
   be replaced after ownership was established but before publication. Check
   its identity against the stage ownership snapshot immediately before and,
   where practical, after installation; preserve recovery data and do not
   silently publish or remove a replacement file.
10. **The native clippy gate must pass without suppressing useful linting.**
    `publish_pending_sources` currently exceeds the clippy argument-count
    threshold. Group its related publication parameters into a focused context
    or otherwise reduce the signature while preserving the same behavior.
11. **The aggregate E2E runner must read the artifact directory it produced.**
    The repair runner defaults to a tokenized audit directory while
    `scripts/test-e2e.js` reads the fixed
    `e2e/artifacts/download-process-repairs/repair-report.json`; this can make
    the aggregate gate validate a stale or missing report. Restore the
    standard default path or explicitly pass and validate the selected path,
    while retaining unique artifact paths for explicit diagnostic overrides.
12. **Stream mapping must match the codec decisions used during conversion.**
    The subtitle change maps every video and audio track while codec selection
    inspects only the first video and audio codecs. A secondary incompatible
    track can therefore make copy fail, and an attached-picture cover stream
    can be treated as ordinary video. Keep mapped streams aligned with the
    inspected tracks and exclude attached pictures from video selection, or
    explicitly select codecs per mapped stream. The diagnostic should cover a
    source with multiple video streams and attached cover art.
13. **Completion format must describe the final published path.**
    When cancellation or partial failure preserves a later original after an
    earlier converted output, the last final path can have a different
    extension from the requested target. Derive the completion format from the
    actual last published path and use the requested target only when no final
    path provides a format. The cancellation diagnostic should assert both
    final paths and the preserved original's format.
14. **A preserved original after conversion failure is a completed final path.**
    In `run_conversion`'s `Err(error)` branch, successful
    `publish_staged_source_with_captions` publication records the preserved
    path as failed but does not add it to `completed`. When no earlier
    conversion succeeded, session completion therefore omits the existing
    final file from `outputPaths` and byte totals, and cannot derive its format
    from that path. Force conversion to fail after downloading a valid source;
    verify the published original remains in `failedPaths` and also appears in
    `outputPaths` with accurate bytes and its actual format.
