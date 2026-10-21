# yt-dlp provenance: failure modes

Written before the implementation (AGENTS.md). Each row names a way the change
could fail and the control that must catch it. `verify.mjs` exercises the rows
marked **verify**; the rest are covered by the code paths named in the table.

## Fetch and signature (scripts/fetch-ytdlp.cjs)

| #   | Failure                                                                         | Control                                                                                            | Check                                                                  |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| F1  | SHA2-256SUMS tampered in transit                                                | GPG verify of SHA2-256SUMS.sig against the committed key                                           | **verify** (tampered copy must be rejected)                            |
| F2  | Signature from a different key (key swapped in repo or attacker-signed)         | Primary-key fingerprint from `VALIDSIG` must equal the pinned fingerprint                          | **verify** (wrong-key signature rejected)                              |
| F3  | `gpg` not installed                                                             | Fail closed; only `--allow-unsigned-sums` bypasses, and only outside CI/release                    | **verify** (PATH without gpg exits non-zero)                           |
| F4  | `--allow-unsigned-sums` used in CI or a release build                           | Flag refused when `CI` or `ROSI_RELEASE` is set                                                    | **verify**                                                             |
| F5  | `--allow-unsigned-sums` used with `--update`                                    | Refused: update trust rests entirely on the signature                                              | **verify**                                                             |
| F6  | Binary bytes differ from upstream sums                                          | Downloaded hash compared to SHA2-256SUMS entry; mismatch deletes temp file                         | **verify** (corrupted download fixture rejected by `downloadVerified`) |
| F7  | Binary matches sums but not the committed manifest (manifest stale or tampered) | Manifest hash must equal sums hash before any download                                             | **verify** (manifest/sums disagreement fails)                          |
| F8  | Sums file lacks the requested binary name                                       | Explicit error, no download                                                                        | code path                                                              |
| F9  | Truncated download (network drop, short body)                                   | Content-length check when provided; hash check always                                              | code path + F6                                                         |
| F10 | Partial file left in assets/ after a crash                                      | Download goes to `assets/.ytdlp-*.tmp`, renamed only after verify; `.gitignore` covers the pattern | code path                                                              |
| F11 | Redirect to http:// or non-GitHub host                                          | Only https allowed; redirect count capped at 5                                                     | code path                                                              |
| F12 | Hang on a stalled connection                                                    | Request timeout (60 s idle) rejects                                                                | code path                                                              |
| F13 | `--missing-only` re-downloads a good file, or skips a bad one                   | Skip only when local hash equals manifest hash                                                     | **verify** (current assets skipped, no network)                        |
| F14 | Unknown `--target` triple                                                       | Explicit error listing valid triples                                                               | code path                                                              |
| F15 | `--update` given a non-version string (path traversal in URL/filename)          | Version regex `^\d{4}\.\d{2}\.\d{2}(\.\d+)?$`                                                      | **verify**                                                             |
| F16 | Atomic manifest write interrupted                                               | Write to temp file, then rename                                                                    | code path                                                              |
| F17 | Windows rename over an existing binary fails (EPERM)                            | Remove destination then rename; error surfaced, temp deleted                                       | code path (not runnable on macOS)                                      |
| F18 | Temp directory for sums not cleaned                                             | `finally` removes it                                                                               | code path                                                              |

## Manifest and check (scripts/check-ytdlp.cjs)

| #   | Failure                                                                    | Control                                            | Check                                       |
| --- | -------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------- |
| C1  | Manifest in old format (`binaries`) read by new code                       | Require `version` and `files`; fail with a message | **verify** (old format rejected)            |
| C2  | Binary on disk not matching manifest                                       | Hash mismatch fails                                | **verify** (fixture copy with altered byte) |
| C3  | Manifest version has no matching license file in assets/                   | Fail                                               | **verify**                                  |
| C4  | License file on disk differs from its recorded sha256                      | Fail                                               | **verify**                                  |
| C5  | tauri.conf.json resource path does not reference the manifest license file | Fail                                               | **verify**                                  |
| C6  | Binaries absent for host                                                   | Fail with "run ytdlp:fetch" hint                   | **verify**                                  |

## Live provenance (verify.mjs, network)

| #   | Failure                                                | Control                                        | Check                           |
| --- | ------------------------------------------------------ | ---------------------------------------------- | ------------------------------- |
| L1  | Upstream release missing or renamed                    | Fetch error surfaces HTTP status               | **verify** (live fetch of sums) |
| L2  | Committed manifest disagrees with upstream signed sums | Mismatch fails                                 | **verify**                      |
| L3  | Committed license file differs from upstream tag       | Hash compare against raw.githubusercontent.com | **verify**                      |

## Sidecars and build wiring

| #   | Failure                                             | Control                                                                                                      | Check                                                  |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| R1  | prepare-sidecars reads old manifest key `binaries`  | Updated to `files`                                                                                           | code path + C1                                         |
| R2  | prepare-sidecars runs offline with binaries missing | Fetch fails, prepare fails closed                                                                            | code path                                              |
| R3  | Binaries accidentally committed again               | `.gitignore` entries; `git ls-files` shows none                                                              | **verify** (git ls-files check, skipped if not a repo) |
| R4  | CI runs ytdlp:check before ytdlp:fetch:all          | Other agent owns ci.yml; `ytdlp:fetch:all` name must exist                                                   | **verify** (npm script exists, runs)                   |
| R5  | Watch workflow leaks a token or runs untrusted code | Read-only default permissions; write scopes only on the job; actions pinned by SHA; no `pull_request_target` | review                                                 |
| S6  | Watch job opens duplicate PRs                       | Skip if an open PR already uses the branch                                                                   | review                                                 |
| S7  | Watch job cannot open PRs (repo setting)            | Fall back to opening an issue                                                                                | review                                                 |

## Known gaps (not covered by verify.mjs)

- Windows rename semantics (F17) and Windows gpg availability on CI runners.
- The workflow itself is not executed locally; it is checked with `actionlint`
  when available, otherwise by review.
- Binary download of the full 155 MB set is not repeated on every verify run;
  verify.mjs downloads only the smallest needed binary when `--download` is set.

## gpg lookup on Windows (scripts/fetch-ytdlp.cjs `resolveGpg`)

Written before the lookup was added to the verifier (AGENTS.md: failure modes
first). `windows-latest` ships gpg only inside Git for Windows, which is often
not on PATH for PowerShell.

| #   | Failure                                               | Control                                                            | Check                                                        |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| G1  | gpg on PATH on Windows                                | PATH wins over the Git location                                    | **verify** (simulated win32, runs("gpg") true)               |
| G2  | gpg not on PATH, Git for Windows installed            | Falls back to `<ProgramFiles>\Git\usr\bin\gpg.exe` when it runs    | **verify**                                                   |
| G3  | Git gpg candidate exists but does not run             | Skipped; next candidate tried, else fail closed                    | **verify**                                                   |
| G4  | No gpg anywhere on Windows                            | Fail closed with a message that names Git for Windows and ROSI_GPG | **verify**                                                   |
| G5  | ROSI_GPG set to a missing file                        | Explicit error, no silent fallback                                 | **verify**                                                   |
| G6  | ROSI_GPG set to a valid file                          | Used before PATH or Git lookup                                     | **verify**                                                   |
| G7  | Windows home path with backslashes passed to MSYS gpg | `gpgPath` converts to forward slashes on win32 only                | **verify** (`C:\...` becomes `C:/...`; POSIX path unchanged) |
| G8  | Non-Windows platform picks up the Git location        | Git candidates are considered only when platform is win32          | **verify** (darwin with no gpg fails, no Git path)           |
| G9  | Missing gpg on macOS/Linux still fails closed         | F3 check above; PATH empty leads to an error                       | existing F3                                                  |

## Seamless release fetch (written before the retry change)

| #   | Failure                                                         | Control                                                                                   |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| R1  | Transient network error or GitHub 5xx fetching sums or a binary | Retry up to 3 attempts with backoff, then fail with every attempt's error                 |
| R2  | Truncated or corrupted download (hash mismatch)                 | Discard the temp file and retry the pinned URL; never install a mismatching file          |
| R3  | Retries hide a permanent problem (404 for the pinned version)   | HTTP 4xx is not retried; fail at once naming the version                                  |
| R4  | Signature or manifest disagreement                              | Never retried: a bad signature or a manifest that disagrees with signed sums fails closed |
| R5  | A retry leaves temp files in assets/                            | Each attempt removes its own temp file in `finally`                                       |
