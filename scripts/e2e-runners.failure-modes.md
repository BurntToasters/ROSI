# E2E runner report verification, timeouts, and artifact pruning: failure modes

Covers `scripts/e2e/runner-report.js` (`verifyRunnerReport`),
`scripts/e2e/prune-artifacts.js` (`pruneRunnerArtifacts`), and their use in
`scripts/e2e/runners/native.js`, `probes.js`, `v5-fixes.js`, and
`e2e/long-term-persistence-run.mjs`. Unit tests are in
`scripts/e2e-runners.test.mjs`; they use temporary directories only.

## Report verification

1. A report whose `reportSha256` does not match the hash of the rest of the
   report fails when the caller asks for a self-hash check. Writers hash
   `JSON.stringify(body, null, 2)` with `reportSha256` removed, so the verifier
   uses the same serialization.
2. A report with no `reportSha256` fails a requested self-hash check. A check
   that is not requested is not run.
3. An identity field that differs from the expected value fails: `app`,
   `version`, `commit`, `platform`, `arch`, `binarySha256`, and `suite`.
4. An expected key that the caller did not supply is not checked. A runner
   that cannot know a value (for example a report without `commit`) is not
   failed for it.
5. Field aliases are read as the writers name them: `suite ?? scenario`,
   `passed ?? allPassed`, `probeSources ?? sourceHashes`, and
   `toneFixtureSha256 ?? fixtureHash`. A report that has neither name of an
   aliased pair fails the check that needs it.
6. `passed: false`, `allPassed: false`, or a report with neither verdict field
   fails a requested verdict check.
7. A `startedAt` earlier than `startedAfter` fails. A missing or non-date
   `startedAt`, `finishedAt`, or `startedAfter` fails. A `finishedAt` earlier
   than `startedAt` fails. `startedAfter` may be an ISO string or epoch ms.
8. A `null`, array, or non-object report returns a problem and does not throw.
9. The verifier only reads. It never writes the report or any file.

## v5-fixes report verification (`findRunnerReport`)

10. A report older than the gate start (mtime) is rejected, with one second of
    slack, as before.
11. A report with `passed: false` or `allPassed: false` is rejected. A report
    with `passed: true` or `allPassed: true` is accepted.
12. The v5-fixes self-hash is not checked. Network and async-proxy hash their
    body before adding `passed`, so a strict check would reject correct
    evidence. The persistence report has no embedded hash. Both are reported,
    not changed, because their writers are outside this change.

## Probe report verification (`probeReportProblems`)

13. A probe report with an observation where `invariantPassed` is `false` fails.
14. A probe report with no observations fails.
15. A probe report from another binary (`binarySha256`), commit, or version
    fails. A probe report that started before the suite fails.
16. A probe report with a tampered `reportSha256` fails.

## Timeouts (native runners)

17. `runRound2NativeRepairs` runs its child with `timeout: 900000`. A timed-out
    child is reported with a message that says it timed out after 900000 ms,
    not "did not report its artifact". The report is not read.
18. `runDownloadProcessRepairs` passes `timeout: 900000` to `run()`. A timeout
    error (`code === "ETIMEDOUT"`) is reported as a timeout, and the report
    problems are still listed when a report exists.
19. A non-timeout failure keeps its original message.
20. On Windows, `runDownloadProcessRepairs` still returns `skipped` before it
    starts a child, so no timeout or prune runs there.

## Artifact pruning (`pruneRunnerArtifacts`)

21. Only directories whose names match the runner's pattern are candidates.
    Files, other runners' folders, and names that do not match are never
    touched.
22. The newest `keep` candidates (default 20) by mtime are retained. The rest
    are removed. Ties are broken by name so the result is deterministic.
23. The current run directory is never removed, even when it is the oldest. It
    counts as retained.
24. `core/` and `adhoc/` are never removed, even if the pattern matches them.
25. Symlinks are never removed and never followed. A symlink to a matching
    directory, inside or outside `artifactsDir`, leaves its target in place.
26. Canonical report files (`e2e-report-*.json`, `latest-report.json`) are
    files, so they are never candidates.
27. A missing `artifactsDir` is a no-op. The function does not create it.
28. A relative `artifactsDir`, a non-RegExp or `g`/`y` pattern, and a `keep`
    that is not a non-negative integer throw `TypeError` before any deletion.
29. A removal that fails (for example a read-only directory) is listed in
    `failed`. The other candidates are still processed, and the function does
    not throw. A test that depends on permissions is skipped when running as
    root.
30. `probes.js` writes fixed directories (`audit-v5-beta2`), not timestamped
    run folders, so it does not prune.
31. `runV5FixesRunner` prunes `e2e/artifacts/v5-fixes-<area>` with the pattern
    of the timestamped run folders the v5 runners write. Earlier runs are kept
    and only the newest 20 are retained.
32. The long-term runner prunes its owned directory after the ownership guard.
    Its pattern covers `gate-<ms>-<pid>` (set by the gate) and the ISO-named
    folder used when run directly.

## Known limits

33. Pruning uses mtime, not the timestamp in the name. A folder whose files were
    touched recently is kept longer. Two concurrent gate runs on one host can
    still prune each other's folders. AGENTS.md requires serializing E2E runs,
    so this is not guarded in code.
34. The unit tests do not launch the app or spawn the real runners. The native
    E2E gate has not been run for these changes. Timeouts are tested through
    injected `spawn`/`run` functions, and the real paths are unverified.
