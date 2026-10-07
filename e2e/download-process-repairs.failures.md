# Downloader and process repair failure inventory

The original cases were written before the repair probe and production edits.
Follow-up cases below were recorded before the corresponding integration fixes.
The native probe must preserve its observations under an isolated profile so a
passing process exit cannot hide an invariant failure.

1. **Conversion ownership and collisions (F01).** A failed conversion or a
   cancellation while FFmpeg is writing beside the input must leave an existing
   destination byte-for-byte intact and keep the input. A successful conversion
   must not replace a pre-existing destination implicitly. Two distinct input
   URLs whose output templates select the same conversion destination (for
   example the same yt-dlp stem and ID in `.mp4` and `.webm` containers), and repeated
   attempts for the same input, must not share or clean up each
   other's temporary outputs. The final destination must appear atomically or
   remain absent after a failed/cancelled installation; a crash must not expose
   a partially copied final file. On Windows, the collision assertion must
   specifically prove the install primitive does not replace an existing file:
   `std::fs::rename` has replacement semantics there, so a same-name output
   collision must preserve the original destination bytes and choose a distinct
   suffixed name.
2. **Manual and queue startup ownership (F03).** Ten overlapping manual starts,
   a manual start racing a queued start, cancellation while yt-dlp is spawning,
   and app shutdown during startup must leave one valid owner or reject the
   competing request. Every child that loses its reservation must be killed.
   After a new session starts, injected legacy completion, structured
   completion, idle progress, and ordinary progress events carrying an older
   session ID must not clear the new button, progress display, or result timer.
   The probe also performs a real cancel/start sequence before injecting the
   reordered events.
3. **Metadata reservation ownership (F04).** Concurrent preview and format
   requests, replacement during process spawn, cancellation before child
   registration, and clear-URL cancellation must terminate all superseded
   yt-dlp children and suppress their late result. Ten repeated requests must
   settle within 15 seconds from first dispatch, including replacement and
   final cancellation; ordinary SIGTERM exits must not consume the full
   escalation grace period.
4. **Whole-tree escalation and pipes (F05).** A helper whose parent exits on
   SIGTERM while a descendant ignores it and holds stdout/stderr open must be
   escalated based on the process group, even after the leader exits. Timeout,
   explicit cancellation, and shutdown must release readers and settle within a
   fixed bound without signalling a newly reused process group.
5. **Playlist conversion accounting (F09).** Every validated final path in an
   all/range playlist must be converted. A conversion failure in one entry or
   cancellation between entries must leave unrelated entries and original
   files intact according to keep-original policy, with completion status and
   byte totals reflecting every output. A partial failure must expose both its
   completed output paths and failed source paths, and must not report success.
   Cancellation after the first entry must retain that entry in completion
   data and never expose the in-progress entry's staging file. A native fixture
   exercises both a conversion failure after one successful entry and
   cancellation while the second entry is being probed.
6. **CPU codec fallback (F10).** A VP8/VP9 WebM requested as MP4 with GPU off
   and with no usable GPU encoder must choose a CPU encoder and produce a valid
   MP4. A compatible source/container pair should still stream-copy. A selected
   hardware encoder that cannot initialize must follow a defined CPU fallback
   and produce a valid MP4, or return a clear failure without damaging
   source/destination files. Cancellation while the codec probe is starting or
   running must kill the probe and settle the session without later conversion.
   A forced wrapper failure of `h264_nvenc` proves that a CPU retry produces a
   valid MP4.
7. **Shared authentication/runtime arguments (F15).** With browser-cookie
   hooking enabled, format discovery and preview must receive the same
   validated cookie-source arguments as a download. Invalid browser values must
   be omitted or rejected, operation-specific playlist/download flags must stay
   separate, and diagnostics must not expose cookie data. User yt-dlp config or
   plugin directories must not override the attempt-owned proxy or add
   unguarded downloader paths. Selecting `m3u8:native` is insufficient if
   yt-dlp's HlsFD delegates an unsupported HLS variant to FFmpegFD: an FFmpeg
   downloader can open nested `file:`, `tcp:`, or `ftp:` references without
   passing them through the guarded HTTP proxy. Force that fallback and require
   its input protocol whitelist to reject local-file/FTP/network escape inputs,
   while a normal native HLS playlist, segment fetch, and local FFmpeg
   post-processing still succeed. Only explicitly supported network protocols
   may be used by the helper; local FFmpeg conversions and codec probes must
   not open network protocols. yt-dlp postprocessor FFprobe subprocesses must
   also be confined when they inspect a downloaded local concat playlist that
   references a private HTTP segment; direct FFprobe calls do not inherit
   yt-dlp's postprocessor-argument hooks. The same protected launcher must
   preserve successful ordinary audio extraction, constrain every FFmpeg `-i`
   input and the positional FFprobe input, and remain owned by the cancellable
   yt-dlp process tree. When FFmpeg is unavailable but ffprobe is discoverable
   on PATH, yt-dlp must receive a private ffprobe-only directory override so
   the PATH tool is wrapped and network-restricted; when neither tool exists,
   an empty override must prevent yt-dlp from discovering helpers elsewhere.
   Ordinary direct downloads must still work in these no-FFmpeg cases.
8. **Bounded line framing and diagnostics (F16).** A child emitting a very long
   newline-free byte stream or an oversized line containing multibyte UTF-8
   must keep reader memory, retained diagnostics, and renderer events bounded;
   truncation must preserve useful leading/trailing context and valid text, and
   cancellation must still complete promptly.

The follow-up native E2E records a collision between distinct same-stem MP4 and
WebM inputs, a 10-request metadata replacement/cancel duration, forced GPU
encoder initialization failure and CPU fallback, codec-probe cancellation,
partial playlist failure, cancellation between playlist entries, and the
stale-event injection described above. Each timing and output-path invariant
is saved in the hashed repair report.

The existing `e2e/audit-v5-beta2` probes establish the native baseline for
conversion collision, concurrent starts, playlist conversion, VP8 conversion,
metadata requests, and process-tree escalation. The new probe adds explicit
repair assertions and records a repeatable JSON artifact. Browser-profile
cookie extraction remains an environment-dependent gate if no isolated browser
profile is available.

The private FFmpeg launcher dispatch also has a malformed-invocation case:
passing the reserved `--rosi-private-media-tool` flag without its config and
role must exit with status 1 and an explicit rejection marker before Tauri
startup. It must never fall through into a normal GUI process. The same
fail-closed rule applies to missing or non-UTF-8 roles and invalid reserved
invocations.

The metadata IPC boundary also has a delayed-DNS cancellation case. Start a
formats request for the E2E synthetic delayed-DNS host, cancel while resolution
is pending, and require the original caller to settle as cancelled within a
short bound. It must not later spawn yt-dlp or publish a stale result; a
replacement request must then succeed. This covers reservation before DNS,
blocking-pool queuing, secure-tool setup, and child registration.

Metadata cancellation must also cover the post-yt-dlp thumbnail fetch. A
thumbnail endpoint that accepts the guarded request but stalls its response
must be interrupted when `cancelVideoInfo` replaces/cancels that metadata
reservation. The original caller must settle as cancelled within one second,
its active proxy socket must close, no stale preview may publish, and a new
metadata request must succeed while the stalled request is still pending.

The second full-gate artifact exposed fixture failures that can hide later
coverage. On macOS, yt-dlp maps colon and question-mark characters to distinct
fullwidth characters, so those two URL names do not collide; prove an actual
same-target collision using distinct `.mp4` and `.webm` inputs with the same
yt-dlp stem and ID, then verify distinct source paths, the shared requested
conversion target, unique final outputs, and preservation of the first output.
The delayed-cancellation fixture must wrap both app-owned FFmpeg and yt-dlp's
direct ffprobe. The app-owned codec probe passes `-i`; yt-dlp's ffprobe receives
its input positionally, so both helper contracts need distinct input parsing.
The cancellation readiness marker must be tied to a live protected FFmpeg codec
probe, and cancellation must reap it while retaining the completed earlier
playlist output.

Metadata replacement assertions must not pass when yt-dlp exits before startup
because its Firefox cookie database is missing. The isolated Firefox fixture
must live under the platform's `Firefox/Profiles` directory, and each ten-call
replacement/cancel scenario must observe a live helper before cancellation,
ten settled cancellation envelopes, no remaining helper, and a successful
replacement. Keep each fixture wait bounded so one missing marker cannot spend
two minutes inside the single repair scenario and starve the cookie, protocol,
and diagnostics cases. The recorded process command lines must redact the
ephemeral `--proxy` credentials while retaining the process ID, role, and URL
marker needed to establish ownership.

Attempt 3 exposed several remaining fixture-contract gaps. The between-entry
cancellation wrapper matched `cancel-between-second`, while yt-dlp names the
second media source `cancel-between-2`; require a live app-owned FFmpeg codec
probe for that exact downloaded input before cancelling, then verify the first
converted output remains and the second output never appears. The HLS fallback
case must capture the actual guarded FFmpeg helper arguments and confirm the
forced `file,pipe` whitelist is applied to its network input; a generic exit
code and zero requests alone do not prove protocol rejection. FFprobe attack
and normal-extraction cases must use extractor inputs that actually select an
audio format and reach the configured FFprobe helper. Require a helper trace
for the normal case and an FFprobe-specific rejection/argument trace for the
malicious local playlist, while keeping the nested private endpoint untouched.
Do not treat yt-dlp's earlier `Requested format is not available` as success.
The ffprobe fixture should be a local ffconcat file that points to a safe
relative sibling HLS playlist with an HTTP segment, so FFmpeg's concat safe
path check does not hide whether the protocol whitelist rejected the nested
network reference. Because yt-dlp downloads into a private `.rosi-download-*`
directory, the sibling playlist must be copied into that exact active staging
directory before the slow fixture response finishes. A missing-sibling diagnostic
must fail the probe; success requires FFprobe's explicit HTTP-not-on-whitelist
diagnostic, the exact protected input whitelist, and zero requests to the nested
private endpoint. Capture bounded helper diagnostics, redacting cookie,
HTTP-header, and proxy credential values from the artifact. Put the PATH-only
ffprobe wrapper before the real tool directory so the missing-FFmpeg case proves
the private ffprobe-only launcher was used.

## F10 follow-up: quiet FFmpeg fallback diagnostics

The real HLS fallback invokes FFmpeg with `-loglevel quiet`. The guarded
launcher still exits with the expected nonzero status when an HTTP input is
outside `file,pipe`, but quiet mode removes the protocol-whitelist diagnostic
needed to prove the rejection in the native trace. The fixture must preserve
the production argument list while using an explicitly recorded, test-only
diagnostic override for this assertion.
