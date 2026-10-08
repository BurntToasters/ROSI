# ci-vendor failure modes (written before the changes)

Scope: Finding 8 (vendored tauri-plugin-updater drift), Finding 10 (CI gaps).

Revision note: the advisory-db design replaced the cargo-audit JSON path after
the rows below were first written. Rows 9-26 describe the current checker.
The checker was implemented before this table was revised, so the table is
the contract the verifier checks, not a pre-implementation plan.

## Vendored updater documentation and patch artifact

1. Upstream 2.10.1 download is tampered or truncated. Mitigation: record the crates.io sha256 (806d9dac...) in PATCHES.md; verification re-downloads and compares.
2. ROSI.patch drifts from the vendored tree after a later edit (dead-code cleanup). Mitigation: regenerate ROSI.patch after the last source edit; verification applies it to pristine upstream and diffs against the vendored tree.
3. ROSI.patch accidentally includes target/ or Cargo.lock (large, machine-specific). Mitigation: diff excludes them; verification checks the patch has no `target/` or `Cargo.lock` hunks.
4. Patch headers reference absolute scratch paths, so `patch -p1` fails. Mitigation: headers normalized to a/ and b/; verification applies with `patch -p1 --dry-run`.
5. Removing "dead" code breaks Linux. The 28 clippy warnings are AppImage helpers that are only reachable on Linux/BSD; deleting them would break Linux installs. Mitigation: silence dead_code only on macOS builds in those two modules; do not delete code; verification runs clippy and checks the warning count is 0 for the vendored crate.
6. Removing `allow_downgrades` handling changes updater behavior. Mitigation: documented in PATCHES.md as a ROSI decision; not changed here.
7. PATCHES.md lists a wrong upstream version or checksum. Mitigation: verification greps the version and sha256 from PATCHES.md and compares with the computed values.
8. Upstream "latest" stated as 2.13.1 in the audit is stale. crates.io now lists 2.13.2 as newest 2.x. Mitigation: PATCHES.md records the observed newest version and the date it was checked.

## scripts/check-vendored-updater.mjs

cargo-audit cannot see advisories for this crate: it is a path dependency
(no `source` in src-tauri/Cargo.lock), so the checker reads the RustSec
advisory-db directly (`crates/tauri-plugin-updater/*.md`, TOML front matter).

9. crates.io unreachable (network, rate limit, 5xx). Behavior: `::warning::` and job summary line; the advisory check still runs; exit 0 so unrelated PRs are not blocked. Verification: fixture for crates.io is missing.
10. crates.io JSON shape changes (no `versions` array). Behavior: exit 2, never a silent pass.
11. Vendored Cargo.toml version cannot be parsed. Behavior: exit 2.
12. RustSec advisory database cannot be cloned (network, GitHub outage, bad URL). Behavior: `::warning::` and job summary line naming the advisory check as skipped; exit 0. Verification: `--advisory-url file:///nonexistent` exits 0 with a warning.
13. `--advisory-db <dir>` points at a missing directory. Behavior: exit 2 (usage), so an offline run cannot silently skip the check.
14. An advisory file has no TOML front matter. Behavior: exit 2 naming the file. Verification: `advisory-db-malformed`.
15. An advisory file names another package. Behavior: exit 2. Advisories are read only from `crates/tauri-plugin-updater/`.
16. Advisory `patched` or `unaffected` uses a range the parser does not understand (e.g. `~2.10`, `*`). Behavior: exit 2 (`unsupported`), never treated as "not patched".
17. Multi-line `patched = [ ... ]` arrays. Behavior: the array is read to its closing bracket. Verification: `advisory-db-multiline` (second range covers 2.10.1, so no hit).
18. Advisory affects the vendored version (not in patched and not in unaffected). Behavior: `::error::` naming the advisory id, exit 1. Verification: `advisory-db-unpatched`.
19. Advisory fixed in the vendored version. Behavior: no error, exit 0. Verification: `advisory-db-patched`.
20. Advisory listed as unaffected for the vendored version. Behavior: no error. Verification: `advisory-db-unaffected`.
21. Withdrawn advisory. Behavior: ignored. Verification: `advisory-db-withdrawn`.
22. No advisories for this crate (the current real database). Behavior: exit 0. Verification: `advisory-db-none` and the live run in the verifier.
23. Vendored version is behind newest stable 2.x. Behavior: `::warning::`, exit 0. Verification: `crates-newer.json`.
24. Vendored version is newer than crates.io newest (pre-release or local). Behavior: no warning, exit 0.
25. Prerelease versions (3.0.0-alpha.x) are picked as "newest 2.x". Behavior: only `2.x.y` without a suffix counts.
26. Multi-line git error text breaks the `::warning::` annotation. Behavior: annotation text is collapsed to one line. Verification: unreachable-database case prints one annotation line.

## CI workflow (.github/workflows/ci.yml)

27. Schedule run: heavy jobs (quality-gate, rust-check, smoke-build) are skipped, and ci-gate's `test = success` lines fail. Mitigation: ci-gate branches on `EVENT_NAME == schedule` and requires `skipped` for heavy jobs.
28. ci-gate on schedule accepts a failing security-audit or updater-manifest. Mitigation: those still require `success`.
29. workflow_dispatch behaves like push but `github.event.pull_request` is empty. Mitigation: release-promotion checks already treat empty base ref as non-main.
30. Skipped job dependency: rust-check/smoke-build need quality-gate. A skipped need makes the dependent skip. Mitigation: explicit `if` on each heavy job; verified by reading the gate.
31. yt-dlp fetch step added before a job that does not need it wastes time, and a missing step causes `ytdlp:check` to fail. Mitigation: step only in jobs listed in the task (quality-gate, rust-check, smoke-build).
32. `npm run ytdlp:fetch:all` does not exist yet (another agent adds it). Mitigation: verification checks package.json for the script before declaring success.
33. gpg missing on a runner image (windows-11-arm, macos-26-intel). Mitigation: documented note in ci.yml; a missing gpg fails the fetch step loudly.
34. Action refs not pinned to full SHA. Mitigation: verification greps `uses:` lines and requires 40-hex SHA for every action.
35. `permissions` widened above `contents: read`. Mitigation: verification checks the top-level permissions block.
36. `experimental-5.0.0` returns to push branches. Mitigation: verification requires push branches to be exactly `main` and `beta` (pushes are proven only on protected release branches).
37. YAML invalid after edit. Mitigation: verification parses ci.yml and dependabot.yml with a YAML parser available in node_modules (js-yaml or yaml) if present; otherwise a structural grep.
38. Dependabot ignore entry malformed (wrong key names), so the ignore is silently a no-op. Mitigation: verification checks `dependency-name: "tauri-plugin-updater"` under the cargo ecosystem.
39. The cron fires but `workflow_dispatch` is missing, leaving no manual trigger. Mitigation: verification checks both keys.
40. Bump PR opened with GITHUB_TOKEN gets no CI (GitHub does not start pull_request workflows for token-created events). Mitigation: ytdlp-watch.yml runs `gh workflow run ci.yml --ref <branch>` (workflow_dispatch is the allowed exception) with `actions: write` on that job only; a failed dispatch is a `::warning::`, and build-setup.md tells maintainers to re-run CI.
41. Watch job checklist still says copy-bundled-licenses.js must change. Mitigation: line removed; the script already reads the manifest.
42. Windows runner has gpg only under Git's usr/bin, not on PATH for PowerShell. Mitigation: fetch-ytdlp.cjs checks PATH, then `C:\Program Files\Git\usr\bin\gpg.exe`, then ROSI_GPG; a missing gpg still fails closed.
