# yt-dlp gpg path handling failure modes

Written before the code (AGENTS.md). Covers `gpgPath` and `gpgFlavor` in
`scripts/fetch-ytdlp.cjs`, used by `verifySumsSignature` for the homedir, the
`--import` key path, and the signature and sums paths. Checked by
`scripts/fetch-ytdlp-gpg-path.test.mjs` with injected platform, flavor and
probe values, so it runs on macOS and Linux.

Background: on `windows-latest`, `gpg` on PATH is Git for Windows' MSYS build.
MSYS gpg reads `C:/x/y` as a path relative to its own working directory, so
the homedir and key paths broke. Native GnuPG (Gpg4win) accepts `C:/x/y`.

1. MSYS gpg receives `C:/...` (the current code). It treats the path as
   relative and fails. Expected: MSYS flavor gets `/c/...`.
2. Native GnuPG receives `/c/...`. It may not accept it. Expected: native
   flavor keeps the drive letter and only converts backslashes to slashes.
3. MSYS gpg found through the Git location `...\Git\usr\bin\gpg.exe`, with
   either slash style and any letter case. Expected: detected as MSYS.
4. MSYS gpg found on PATH as bare `gpg`. The path check cannot see it.
   Expected: detected from the `Home:` line of `gpg --version`, which starts
   with `/` for MSYS and with a drive letter for native GnuPG.
5. Native GnuPG on PATH with `Home: C:/Users/...`. Expected: native, not MSYS.
6. The version probe fails (ENOENT, non-zero exit, no `Home:` line, or throws).
   Expected: native, no exception. Native matches the pre-existing behavior.
7. Non-Windows platforms. Expected: `gpgPath` returns its input unchanged and
   `gpgFlavor` returns `posix` without running the probe.
8. Drive-less relative paths (`assets\x.asc`). Expected: MSYS keeps them
   relative, only the separators change.
9. Lowercase and uppercase drive letters. Expected: MSYS lowercases the drive
   (`D:\a` becomes `/d/a`); native keeps the case.
10. Bare drive root (`C:\`) becomes `/c/` for MSYS and `C:/` for native.
11. UNC paths (`\\server\share\x`). Expected: `//server/share/x` in both
    flavors, which both accept.
12. Mixed separators (`C:\a/b\c`). Expected: every separator is normalized.
13. Paths with spaces or parentheses (`C:\Program Files (x86)\...`). Expected:
    no quoting or escaping; spawnSync passes arguments without a shell.
14. Existing two-argument callers (`gpgPath(p, "win32")`) keep the native
    result, so `e2e/v5-fixes/ytdlp/verify.mjs` check G7 still passes.
15. The flavor is computed from the resolved gpg, not from the path of the
    temp homedir. Expected: `verifySumsSignature` computes it once and uses it
    for every path it passes to gpg.
