# ROSI 5.1 verification foundation failure modes

This note is written before changes to the E2E runner and benchmark utility.

1. **A scenario disappears from full proof.** A manifest omission, duplicate,
   or typo can make the suite appear complete while coverage is missing. Keep
   one canonical manifest entry per existing scenario, validate the inventory
   for duplicates and missing/extra names, and keep full-gate evidence bound to
   the whole canonical list.
2. **A selected feature runs the wrong underlying suite.** A group can point
   at the wrong runner owner or miss a required pass. Make selection expand to
   the existing runnable owner boundary and include that boundary's complete
   expected scenario set; report the requested groups and expanded selection.
3. **A platform allowance masks a real failure.** A skip allowed on Windows,
   macOS, or Linux can silently spread to the wrong host. Preserve the current
   scenario-to-platform map verbatim and continue rejecting skipped outcomes
   everywhere else.
4. **A runner-owned suite runs twice or not at all.** Treating a runner-owned
   spec like a generic WebdriverIO spec can duplicate side effects; omitting its
   owner can create a false pass. Preserve runner ownership and require each
   runner's fresh, passing report as the full gate currently does.
5. **A targeted run is accepted as release proof.** Suite/group selection or
   `ROSI_E2E_ONLY` can accidentally set `fullSuite: true` or claim the complete
   expected list. Keep any targeted run partial and retain release-session's
   checks for `fullSuite: true`, the canonical complete list, and the exact
   E2E binary hash.
6. **A size or timing result looks more certain than its source.** Missing
   files, absent reports, and unmeasured runtime metrics must not become zero
   or inferred values. Record only observed sizes and report references, label
   unavailable metrics explicitly, and compare only supplied, schema-valid
   baseline reports.
7. **An artifact comparison mixes unrelated runs.** Different revisions,
   platforms, or tool versions can make a delta misleading. Record those
   identities in every benchmark report and mark comparisons incompatible when
   the identity fields differ.

## Acceptance boundary

The full gate retains every existing scenario, its platform allowances,
execution owner, report checks, and binary hash. Manifest-selected runs are
useful for focused verification but never constitute full release proof. The
benchmark captures reproducible file-size and inventory data; runtime
performance remains unavailable until it is measured on the required hosts.
