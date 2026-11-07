# Typed format discovery failure modes

1. **Invalid or unsafe URL accepted.** Format discovery must keep the existing
   safe HTTP URL validation and network-security guard before yt-dlp runs.
2. **Unbounded process or output.** Format discovery must keep its tracked
   process slot, timeout, bounded stdout/stderr capture, and cancellation path.
3. **Superseded lookup returns late.** A reply for an old URL or cancelled
   request must not repopulate either picker or restore format selections.
4. **Malformed or incomplete JSON treated as success.** Missing, invalid, or
   truncated structured metadata must surface as a failed lookup, never as a
   valid empty list.
5. **Wrong stream classification.** Audio-only, video-only, and combined
   audio/video formats must be classified from codec metadata, including codec
   values represented by `none`; when both codec fields are missing, known
   audio/video containers retain the existing combined-format fallback.
   Non-media and storyboard entries must not be selectable.
6. **Format ID changed or guessed.** The renderer must submit the exact ID from
   the structured entry when it matches the downloader's existing accepted
   format-ID syntax, and must not parse IDs from display text.
7. **Optional metadata crashes or lies.** Missing codecs, resolution, fps, or
   both size fields must remain representable; an approximate size must be
   marked approximate rather than presented as exact.
8. **UI has no terminal state.** Loading must end on cancellation, empty
   results, and errors; empty or failed results must clear selectable values
   and invalidate URL-bound selections.
9. **Legacy completion text overrides structured completion.** Manual download
   outcomes must continue to be driven by session-matched structured
   `download-complete` events, while the legacy text event remains available
   for diagnostic output.
10. **Playlist wrapper hides the selected video's formats.** Format lookup on a
    URL with a playlist wrapper must stay scoped to the current video with
    `--no-playlist`. If yt-dlp still returns playlist-only metadata, fail with
    an actionable request for a specific video URL; never enumerate an
    unbounded playlist to find formats.
11. **Explicit no-codec metadata is mistaken for absent metadata.** An
    extension-based combined-stream fallback may cover missing codec fields,
    but `vcodec: "none"` and `acodec: "none"` explicitly describe a non-media
    entry and must be omitted.
12. **Unused progress text parser becomes a second authority.** The renderer's
    `parseYtdlpProgress` helper has no production call sites; remove it and its
    dedicated tests while keeping progress strings in the diagnostic console.

## E2E acceptance

Use the native E2E media server and app bridge to verify structured IDs and
metadata reach both picker controls, a local manifest carrying a playlist-like
query stays usable as one current video, cancellation and URL changes retire
stale results, and a failed/empty response leaves no usable stale selections.
The existing E2E runner writes the repeatable report and app/source hashes
under `e2e/artifacts/`.
