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
13. **Backend label drifts from the old renderer text.** `display_label` is built
    in `media_info.rs` and must reproduce the pre-B5 `formatFormatEntry` output
    byte for byte: `ID:` prefix, resolution, fps, codecs joined with ` + `
    (video codec first), ` (video + audio)` only for `audioVideo`, then the size
    suffix. Guarded by golden strings from the old function on the local HLS and
    MP4 fixtures in `typed-formats.spec.js`.
14. **Rounding differs from JavaScript.** `toFixed(2)` rounds exact binary ties
    up; Rust's `{:.2}` rounds them to even. A fps such as 23.976 must become
    `23.98fps`, and a size such as 1152 bytes (1.125 KB) must become `1.13 KB`.
    Integer fps must print without decimals (`25fps`). Fixtures do not reach the
    size branch, so the byte and fps helpers are also checked against the old
    JavaScript function in a differential run outside the repository (see the
    E2E section).
15. **Byte-size boundaries drift.** Sizes just below a power of 1024, and exact
    powers, must pick the same unit as `Math.floor(Math.log(n) / Math.log(1024))`
    with the unit capped at `PB`. Zero stays `0 B`. A size is never shown as
    `NaN`, `Infinity`, or an exponent form.
16. **Missing fields leave stray separators.** Absent resolution, fps, codecs,
    or both sizes must not add a space, an empty pair of parentheses, or `~`.
    Empty codec strings are skipped. A non-finite fps is skipped. The HLS
    audio-only variant (no resolution) and the MP4 fixture (no codecs) cover
    the missing-field path.
17. **Stream kind and label disagree.** `(video + audio)` follows `streamKind`,
    not codec presence. Audio-only and video-only entries must never carry it,
    and must never show the `audio only` resolution text. Fixtures cover the
    combined HLS variant plus audio-only and video-only variants.
18. **Free-text notes leak into the option text.** `format_note`, titles, and
    HLS `NAME` values are not read by the label builder, so unicode or very long
    notes cannot change the option text. Only structured fields are read.
19. **Renderer shows a missing or stale label.** Option text comes only from
    `displayLabel`. The renderer has no label fallback, so a missing field would
    show as `undefined`. The TypeScript type requires the field, and the spec
    asserts every option's text equals its entry's `displayLabel`.

## E2E acceptance

Use the native E2E media server and app bridge to verify structured IDs and
metadata reach both picker controls, a local manifest carrying a playlist-like
query stays usable as one current video, cancellation and URL changes retire
stale results, and a failed/empty response leaves no usable stale selections.
The existing E2E runner writes the repeatable report and app/source hashes
under `e2e/artifacts/`.
