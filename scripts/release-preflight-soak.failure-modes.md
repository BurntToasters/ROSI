# Stable beta soak check: failure modes

The soak check lives in `scripts/release-preflight.js`. It applies only to
stable versions `X.Y.Z` and requires the newest local tag `vX.Y.Z-beta.N` to be
at least `STABLE_MIN_BETA_SOAK_DAYS` (14, in `scripts/release-policy.cjs`) old.
Beta versions skip the check.

Tests live in `scripts/release-preflight-soak.test.mjs`. They inject the tag
lookup and `now`, so no real git repository or clock is needed.

## Version scope

| Mode | Expected behavior |
| --- | --- |
| Beta version such as `5.0.0-beta.4` passed to the check | Check is not applied; the caller gates on stable only. The assert function rejects it with a clear message. |
| Stable version with a `-beta` or `-rc` suffix passed in | Rejected as not a stable version. |
| Malformed version such as `5.0` or `v5.0.0` | Rejected; no tag lookup runs. |

## Tag selection

| Mode | Expected behavior |
| --- | --- |
| No local tag for the stable base version | Fails with a message to run `git fetch --tags origin` or to accept a beta first. |
| Tags exist only for another base version (for example `v5.0.1-beta.1` when checking `5.0.0`) | Ignored; treated as no tag. |
| Tag names that look close but are not `vX.Y.Z-beta.N` (`vX.Y.Z-beta`, `vX.Y.Z-beta.01`, `vX.Y.Z-beta.1.2`, `vX.Y.Z-rc.1`, `vX.Y.Z-beta.x`) | Ignored. Leading zeros are rejected to match the release-version regex. |
| Several beta tags | The highest beta number `N` wins, matching semver prerelease order and the accepted beta number in the runbook. Its date is used, not the oldest. |
| Beta tags listed in arbitrary or duplicate order | Selection does not depend on input order. |
| Tag lookup throws (git missing, not a repository) | Error propagates; the check fails closed and never assumes a pass. |

## Date selection

| Mode | Expected behavior |
| --- | --- |
| Annotated tag with a tagger date | Tagger date is used, not the commit date. |
| Annotated tag with no tagger date | Peeled commit's committer date is used. |
| Lightweight tag | Commit committer date is used. |
| Tag date missing or empty in git output | Fails with a message naming the tag; never treated as age zero or infinity. |
| Tag date not a number (for example `abc`) | Treated as missing; fails with a clear message. |
| Empty string `""` for a Unix timestamp | Treated as missing, not as the epoch. |

## Age arithmetic

| Mode | Expected behavior |
| --- | --- |
| Tag exactly 14 days old | Passes ("at least 14 days"). |
| Tag 14 days minus one millisecond old | Fails and reports the remaining wait in whole days, rounded up. |
| Tag dated in the future (clock skew or bad tag) | Fails; a negative age never passes. |
| `now` is an invalid Date or not a Date | Fails; `NaN` comparisons must not pass the check. |
| Tag dated exactly at `now` | Fails (age 0). |
| Daylight saving transitions | Not a concern: comparison is in UTC milliseconds. |

## Enforcement and overrides

| Mode | Expected behavior |
| --- | --- |
| Other environment variables that look like a skip (`FORCE_UPLOAD`, `SKIP_E2E`, `SKIP_RELEASE_MIRROR`, a misspelled waiver name) | No effect on the soak. Only `ROSI_STABLE_SOAK_WAIVER` with a valid reason waives the age check. |
| Stable preflight passes branch, clean tree, and upstream checks, but soak fails | Preflight exits non-zero with the soak message before GitHub CLI checks run. |
| Beta preflight | Soak is never read; no tag lookup runs. |
| Publish path (`publish-release.cjs`) that runs preflight | Inherits the same check through the shared script. |

## Module contract

| Mode | Expected behavior |
| --- | --- |
| Importing `release-preflight.js` from a test | No side effects; the git and GitHub checks run only on direct execution. |
| `release-preflight.d.ts` out of date with exports | Declared exports must match the runtime exports. |
| Existing import `expectedReleaseBranch` | Behaves exactly as before. |

## Soak waiver (`ROSI_STABLE_SOAK_WAIVER`)

The waiver skips only the age check (the 14-day rule). It is for security
emergencies. The maintainer sets it on the command line, and the reason goes in
the stable promotion record. Rows marked (operational) are enforced by the
runbook, not by code, and have no test.

### Reading the variable

| Mode | Expected behavior |
| --- | --- |
| Variable unset | No waiver; the normal 14-day gate applies. |
| Variable empty or whitespace only | No waiver; treated as unset. |
| Bare flag `1`, `true`, `yes`, `on` in any case, with or without surrounding spaces | Rejected with a message that a written reason is required. Never waives. |
| Falsy words `0`, `false`, `no`, `off` | Rejected as too short to be a reason. Never waives. |
| Reason shorter than `STABLE_SOAK_WAIVER_MIN_LENGTH` (12) characters after trimming | Rejected. Padding with spaces does not count toward the minimum. |
| Reason exactly 12 characters after trimming | Accepted (boundary). |
| Reason with a line break, tab, or other control character (for example an ANSI escape) | Rejected. Otherwise the printed WARNING line could be split or forged in the release log. |
| Set but invalid waiver on a tag that is already old enough | Still rejected. A malformed waiver is an error, never silently ignored. |
| Variable with a similar but different name (`ROSI_STABLE_SOAK_WAIVE`, lowercase `rosi_stable_soak_waiver`) | Not read; no waiver. |

### Checks that still run

| Mode | Expected behavior |
| --- | --- |
| Valid waiver with a non-stable version (`5.0.0-beta.4`, `5.0.0-rc.1`, `5.0`) | Throws as before. The waiver never rescues a version the soak does not apply to. |
| Valid waiver with no local beta tag for the stable base | Throws the fetch hint. The waiver does not apply. |
| Valid waiver with an unreadable tag date | Throws. The waiver does not apply. |
| Valid waiver with a tag dated in the future | Throws. The waiver does not apply. |
| Valid waiver with an invalid `now` | Throws. The waiver does not apply. |
| Valid waiver while the tag lookup throws (git missing) | The error propagates. No pass. |

### Applying the waiver

| Mode | Expected behavior |
| --- | --- |
| Valid waiver, tag younger than 14 days | Passes with `waived: true`, the trimmed reason, the tag, and its age. `runPreflight` prints the WARNING line naming the tag, age in days, and reason. |
| Valid waiver, tag already 14 days or older | Passes with `waived: false`. No warning is printed and the waiver is unused. The waiver is recorded only when it is needed. |
| Waiver line format | Matches `release-preflight: WARNING: stable beta soak WAIVED (<tag>, <N> day(s) old; reason: <reason>)`. |
| Other overrides set (`FORCE_UPLOAD=1`, `SKIP_E2E=1`, `SKIP_RELEASE_MIRROR=1`, `ROSI_ALLOW_STUB_SIDECARS=1`) with no waiver | No effect on the soak. The 14-day gate still applies. |
| Waiver name added to `STABLE_FORBIDDEN_ENV` | Must not happen. The forbidden list would make every stable preflight with a waiver throw. Test asserts the name is absent. |

### Misuse outside the code (operational)

| Mode | Expected behavior |
| --- | --- |
| Waiver persisted in `.env` or a shell profile | Not blocked by code. `dotenv -e .env` in `release:publish` and `release:draft` loads `.env` values when they are not already set, so a persisted waiver would apply to later stable preflights. The runbook says to set it on the command only. Each use prints the WARNING line. |
| Junk reason that meets the length rule (for example twelve dashes) | Passes the code check. The code checks length and characters, not meaning. The reviewer checks the promotion record. |
| Publish path (`publish-release.cjs` spawns `release-preflight.js` with inherited env) | The waiver reaches the child preflight and applies there. This is intended: same gate, same WARNING line. |
