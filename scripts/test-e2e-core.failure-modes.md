# Core E2E profile failure inventory

Before adding the profile, protect these failure cases:

1. **A partial run can be mistaken for release proof.** Core reports must set
   `fullSuite: false` and `profile: "core"`; release verification must keep
   accepting only its unchanged full report.
2. **A profile is omitted or its value is missing.** `--profile` requires one
   known profile name; both `--profile` and `--profile=` without a value fail
   before building.
3. **An invalid or duplicated profile is silently accepted.** Unknown names,
   repeated flags, and conflicting `--profile` forms fail clearly.
4. **Core combines with owner groups or an ad-hoc spec.** Reject both CLI
   `--group` and `ROSI_E2E_GROUPS`, plus any nonblank `ROSI_E2E_ONLY`.
5. **The selection drifts from the approved inventory.** Core expects exactly
   the 25 named main scenarios plus every scenario from state repairs, offline
   queue, round2 renderer, and round3 renderer; full mode keeps its old list.
6. **A title selector accidentally matches adjacent tests.** Every selected
   scenario must map to one complete Mocha full title; regex metacharacters are
   escaped and alternatives are anchored, so only listed tests run.
7. **Mocha hooks are skipped or test order changes.** The existing main spec
   and WebdriverIO pass stay in use; grep filters tests while retaining the
   describe hooks and source order.
8. **A scenario is missing, duplicated, failed, or unexpectedly skipped.**
   Core validates exact expected scenario cardinality and outcomes with the
   same platform skip policy as the full gate.
9. **Core lacks an encoder or probe but appears green.** Require working
   FFmpeg and FFprobe before fixture generation or WebdriverIO starts; selected
   conversion scenarios cannot be silently skipped.
10. **The artifact claims a different invocation's screenshots.** Each core
    invocation gets a unique evidence and screenshot directory. It never
    clears prior core artifacts, hashes only its own screenshots, and updates
    a documented latest report after writing the unique report.
11. **A failed early stage is represented by a stale report on repeat.** Each
    repeat has a unique run ID; the stability runner accepts only the report
    written by that ID and fails if build or fixture setup exits before report
    generation.
12. **A timing omits a failed stage or excludes the build.** Monotonic timing
    begins before the binary build, records build, fixtures, every WebdriverIO
    pass, every runner, and total elapsed time, including a stage that throws.
    The slowest stages are printed in full and core runs.
13. **Binary identity or full evidence changes.** The current E2E build and
    binary hash path remain authoritative; full report location and full
    expected scenario inventory stay unchanged.
14. **Specialized runners accidentally enter core.** Only the listed main
    selection and four complete supporting suites run; no other owner runner
    or dynamic v5-fixes area is enabled.
15. **The warm-time goal is presented as measured evidence.** Documentation
    labels under ten minutes as a target until a manager records actual runs.
