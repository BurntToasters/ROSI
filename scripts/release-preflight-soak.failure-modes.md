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
| Environment variable set to skip the soak for stable | No effect; there is no override for stable. |
| Stable preflight passes branch, clean tree, and upstream checks, but soak fails | Preflight exits non-zero with the soak message before GitHub CLI checks run. |
| Beta preflight | Soak is never read; no tag lookup runs. |
| Publish path (`publish-release.cjs`) that runs preflight | Inherits the same check through the shared script. |

## Module contract

| Mode | Expected behavior |
| --- | --- |
| Importing `release-preflight.js` from a test | No side effects; the git and GitHub checks run only on direct execution. |
| `release-preflight.d.ts` out of date with exports | Declared exports must match the runtime exports. |
| Existing import `expectedReleaseBranch` | Behaves exactly as before. |
