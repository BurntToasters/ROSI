# V5 beta 2 adversarial audit probes

The audit probes exercise the actual Tauri app, Rust IPC, bundled yt-dlp, local media server, and real FFmpeg. No production code changes precede these probes.

Failure modes to check:

1. A settings response arrives after another UI change but before the next debounced save starts. The old response must not erase the newer choice.
2. A failed conversion targets a file that already exists. The old file must retain its original bytes.
3. A WebM video uses VP8, GPU acceleration is off, and conversion requests MP4. Conversion must select a working CPU encoder.
4. A playlist contains multiple videos and conversion is enabled. Every selected video must receive the requested conversion.
5. Concurrent manual starts overwrite the active session without cancelling all helper processes. Cancellation must stop every process started by those requests.
6. Two persisted queue writers run concurrently. A flush must not be overwritten by an older debounced snapshot.
7. A release preparation skips GUI E2E. Its local proof must not claim full candidate acceptance without separately verifying exact-commit CI evidence.
8. Concurrent format or preview requests replace a tracked child slot. Cancellation must stop every child belonging to superseded requests.
9. Flat UI retains raised control shadows, disabled primary text loses contrast, or focused Activity actions remain faded. Distinguish these failure paths before treating them as product defects:
   - The test samples a computed shadow or contrast ratio while the setting save, root data attribute, or CSS transition is still settling. Record the persisted setting, control value, root `data-flat-ui`/`data-theme`, and computed styles, then wait for the expected rendered state before retaining the existing exact shadow and 3:1 contrast assertions.
   - A Flat UI assertion fails before its cleanup, leaving `flatUi` enabled for the later theme-contrast probe. Restore each probe's original theme and Flat UI values in `finally`, including when an assertion fails, so one failed probe cannot contaminate the next.
   - The rendered state and computed styles have settled but the selected profile still has a shadow or disabled text remains below 3:1. Preserve the defect as a product failure; do not relax the selector, shadow expectation, or contrast threshold.
10. A hostname accepted by production URL validation resolves to loopback. With the E2E loopback exception disabled, direct loopback must be rejected and a DNS alias must not reach the same private fixture.
11. A cancelled helper's parent exits on SIGTERM while its descendant ignores SIGTERM and keeps stdout open. Cancellation must escalate against the remaining tree and release blocked readers, even after the parent is reaped. Use a controlled FFmpeg wrapper in the isolated profile for this signal behavior; do not change or install a system helper.
12. The Compatible profile advertises an MP4 output but a site offers only WebM. Record the actual successful output before testing subsequent conversion, so selection behavior is distinguishable from conversion failure.

Probes record observed defects, controls, file hashes, and screenshots. A successful probe run means the observations completed; it does not mean ROSI passed the acceptance conditions above.
