# Audit 4 repair failure inventory

Write verification before production repairs. Preserve unrelated behavior and retain repeatable JSON/TAP artifacts.

1. Session finalization: cancel/close must wait through delayed statistics and completion callbacks; multiple finalizing sessions cannot evade shutdown; callback cleanup must release waiters; queue stop must wait for a claimed-but-unstarted runner without holding its start lock.
2. Conversion: attached pictures must be detected independently of primary video. Keep the original whenever conversion omits artwork, even with Keep original disabled. Preserve existing caption and incomplete-probe retention, collision ownership, cancellation recovery and no-artwork conversion behavior.
3. Probe routing: uppercase names, renamed symlink targets, bundled names, absent siblings, and a sibling symlink pointing back at FFmpeg must never route probe arguments to FFmpeg. Prefer the selected lexical sibling, then a distinct bundled/PATH probe.
4. Export: pending, debounce and failed saves must not export stale disk settings; successful saves and picker cancellation retain existing behavior.
5. Request snapshots: changing URL, playlist controls or preset during a settings save/folder prompt must not alter the original manual or queue request. Invalid ranges must fail before asynchronous work. Preserve hidden preset playlist defaults and visible Current overrides.
6. Manifest routing: reject malformed envelopes, wrong OS/architecture/installer, unknown keys, missing required target and mismatched feed name. Accept valid stable/beta fallback keys and universal macOS artifacts. Keep signature and release-owned URL checks.
7. Cancellation: recovery errors and paths must survive completion, queue persistence and activity presentation. Ordinary cancellation must not invent a failure.
8. Deno: success=false, missing/invalid success, timeout and rejected bridge calls must display failure in reminder and wizard. Cancellation stays cancellation; success=true stays success.
9. Dependency: source-map-js must resolve outside the affected range; lock resolution, installed package, build and advisory report must agree.

Native GUI E2E is preferred. Controlled renderer/native isolation is supplemental when native execution is unavailable; it does not certify signed installers or hosted CI.
