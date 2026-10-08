# E2E consolidation failure modes

Written before the gate wiring in `scripts/test-e2e.js` changed. Each mode names
the check that must catch it.

1. **Suite never runs.** A suite is not referenced by the gate, so regressions
   pass silently. Check: every wired suite is a named scenario in
   `EXPECTED_SCENARIOS`, and `scenarioOutcomeProblems` fails when it is missing.
2. **Suite runs but its result is ignored.** A runner exits nonzero, or writes
   a failing report, and the gate still passes. Check: each runner's exit code
   and report verdict feed the scenario status, and failed scenarios add to
   `failure`, which throws.
3. **Suite silently skipped.** A runner returns early, or a spec uses
   `it.skip`/`describe.skip`/`xit`/`this.skip()`, so mocha reports success with
   nothing run. Check: unacceptable statuses fail, and v5-fixes spec sources are
   scanned for skip/only markers before they run.
4. **Skip allowed on the wrong platform.** A platform-only suite (macOS `ps`,
   `/usr/bin/python3`, Unix-only runner) reports `skipped` on a platform where it
   should run, or runs where it cannot work. Check: `ALLOWED_E2E_SKIPS` lists
   the exact platforms, and the skip reason is recorded.
5. **Report from an earlier run is read.** A stale report file from a previous
   run passes the check. Check: each runner's artifact directory is unique per
   gate run, and reports are checked for start time within this run, or the
   directory is cleared first.
6. **Report is edited or truncated.** A hand-edited or partially written report
   passes. Check: the self-hash (`reportSha256`) is verified where the runner
   writes one, and JSON parse failures fail the scenario.
7. **Binary replaced between build and run.** A suite runs a binary that was
   rebuilt without the E2E feature, or a different binary than the one that was
   hashed. Check: each runner verifies the E2E stamp is not older than the
   binary and records `binarySha256` equal to the current binary.
8. **Duplicate builds.** A runner or new pass calls cargo or
   `buildE2eBinary()` again, so suites test different binaries. Check: only
   `main()` calls `buildE2eBinary`, and no new code path calls cargo.
9. **Parallel GUI runs clobber each other.** Two suites launch the app or share
   a profile at once. Check: all GUI suites run sequentially inside `main()`,
   each with its own profile from `createE2eProfile`.
10. **Media server closed too early or blocking.** A synchronous `spawnSync`
    runner runs while the in-process media server must serve, so it hangs or
    times out. Check: runners that need no media server run after
    `server.close()`; wdio passes run inside the `try` where the server is up.
11. **v5-fixes directory not discovered.** A new `e2e/v5-fixes/<area>/` with
    specs is ignored. Check: discovery lists every child directory with a
    `*.spec.js` or `run.mjs`, and each becomes a named scenario that must be
    reported.
12. **v5-fixes runner exits zero while failing.** Check: nonzero exit fails the
    scenario, and the report is found under `e2e/artifacts/v5-fixes-<area>/`.
13. **Evidence outside e2e/artifacts.** A runner writes to `os.tmpdir()`, so the
    evidence is lost. Check: each runner's report path must resolve under
    `e2e/artifacts/`, and the gate records that path.
14. **Ad-hoc run pollutes the gate.** `ROSI_E2E_ONLY` runs add the full suite
    list. Check: wired suites and v5-fixes discovery run only when
    `ROSI_E2E_ONLY` is unset.
15. **Probe reports failures but exits zero.** The audit-v5-beta2 probes exit
    zero when observations complete, even when `invariantPassed` is false.
    Check: the gate requires every observation `invariantPassed === true`.
16. **Security probe depends on public DNS.** `localtest.me` must resolve to
    loopback. Check: the scenario reason names the DNS requirement, so the
    failure is traceable instead of a generic error.
17. **Suite reruns under `--repeat`.** Stability runs repeat every new suite.
    Check: this is expected and documented; no state is shared across runs
    except the artifact directories, which are timestamped.

## Runner-owned v5-fixes areas (run.mjs convention)

Written before the wiring change. An area with `e2e/v5-fixes/<area>/run.mjs`
is owned by its runner. Areas without one keep the generic wdio pass.

18. **Runner-owned spec also runs under wdio.** The generic `./v5-fixes/*/*.spec.js`
    glob, or a gate pass, runs a spec that its runner already drives, so the
    spec runs twice with different env. Check: the default specs in
    `e2e/wdio.conf.js` exclude areas with `run.mjs`, and the gate starts no wdio
    pass for those areas.
19. **Runner exits zero without a report.** The runner passes its exit code but
    writes nothing, or writes to a path the gate does not look at. Check: the gate
    requires a `report.json` under `e2e/artifacts/v5-fixes-<area>/` whose mtime is
    at or after the gate start, and it fails the area when none is found.
20. **Report says failed but exit code is zero.** Check: the gate also requires the
    report verdict (`passed === true` or `allPassed === true`) to be true.
21. **Runner report is unparseable or from an earlier run.** Check: JSON parse
    errors and stale mtimes fail the area; the directory is never reused across runs
    because runners timestamp their directory names.
22. **Spec path passed to wdio does not resolve.** `ROSI_E2E_SPECS` values such
    as `./v5-fixes/...` are resolved by WDIO relative to the config directory
    (`e2e/`), not the process cwd. Check: runners use `./v5-fixes/<area>/<spec>`
    with `e2e/wdio.conf.js` as the config path; a wrong path makes WDIO warn
    "did not match any file" and the runner's report stays empty.
23. **Downloader fallback spec silently skipped off macOS.** A mocha skip makes
    the spec pass with nothing checked. Check: the gate rejects skip markers in
    spec sources. Off macOS the downloader runner records the fallback case as
    `skipped: platform` with a reason in its report, and a missing reason fails
    the report verdict.
24. **Orphan fixtures planted after the app already swept.** The sweep runs once
    at startup, so fixtures created in a spec's `before` are never swept. Check:
    the downloader runner plants the orphan fixtures before it launches WDIO.
25. **exFAT image mounted where ROSI refuses it.** Download folders must live
    under the home folder or `/Volumes` on macOS. Check: the runner mounts the
    image under the profile home, which the app treats as home, and the spec
    fails clearly when `ROSI_V5_FIX_EXFAT_MOUNT` is missing.
26. **Disk image or temp files left behind.** A failed mount or spec leaves an
    attached image. Check: the runner detaches and deletes in `finally`, and
    verifies the detach result.
27. **Network verifiers join the gate.** `ytdlp/verify.mjs` and
    `ci-vendor/verify-ci-vendor.mjs` need network access. Check: discovery picks up
    only `*.spec.js` and `run.mjs`, so these scripts are not run by the gate.
28. **Evidence written outside e2e/artifacts.** Check: verify-ci-vendor writes to
    `e2e/artifacts/v5-fixes-ci-vendor/<timestamp>/`, and the stray
    `e2e/v5-fixes/ci-vendor/artifacts/` directory is removed.
