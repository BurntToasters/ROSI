# Round 2 E2E runner failure inventory

These runner failures must be rejected before the aggregate report can pass:

1. **Incomplete renderer coverage.** Any missing, duplicate, unexpected, or
   failed renderer observation must fail the canonical `round2-renderer` pass.
2. **Stale renderer artifact.** Results left by an earlier invocation must not
   satisfy the current pass. The runner must remove the unique destination
   before launching the isolated renderer profile and require a newly written
   complete artifact.
3. **Incomplete native coverage.** A native report with a missing, duplicate,
   or false required observation, any failure entry, a failed WDIO exit, or
   `passed: false` must fail the canonical `round2-native` pass.
4. **Native identity drift.** A report from another app, suite, package
   version, platform, architecture, E2E binary, FFmpeg, or source snapshot
   must be rejected.
5. **Native stale or altered evidence.** The native report must start during
   the current suite run, finish after it starts, and pass its canonical JSON
   self-hash check.
6. **Ad-hoc proof substitution.** `ROSI_E2E_ONLY` may run a focused spec for
   debugging, but it must not bypass the canonical inventory or claim a full
   suite pass.
7. **Unproven process-tree cleanup.** A cancelled download does not exercise
   the Windows Job Object leader-exit/descendant-pipe condition. The native
   report must label that observation as an explicit skip with a reason on
   every platform until an owned fixture proves it.
