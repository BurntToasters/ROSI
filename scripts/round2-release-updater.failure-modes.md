# Round 2 updater and release failure inventory

Written before production changes. `round2-release-updater.test.mjs` covers the
release-gate and bundled-notice cases; `round2_*` Rust tests exercise the
vendored updater install entry point and platform-safe cleanup ordering.

## Updater install lifecycle

1. The application pre-install flush fails. The public updater install call
   must return the hook error without entering platform installation, cleaning
   Tauri resources, or consuming the downloaded update.
2. Windows `ShellExecuteW` returns any value from 0 through 32. Treat launch as
   failed, keep Tauri resources intact, and do not reach process exit.
3. Windows installer launch succeeds. Only then run Tauri cleanup immediately
   before process exit; cleanup must not run before the launch result is known.
4. macOS/Linux install and normal restart paths must not invoke the Windows
   direct-exit cleanup callback.
5. A macOS bundle is missing, symlinked, empty, or non-executable for any of
   `rosi`, `rosi-yt-dlp`, `rosi-ffmpeg`, or `rosi-ffprobe`. Rust recovery and
   the privileged shell validator must both reject it before deleting a
   recovery backup.
6. A streamed package omits Content-Length, lies with a smaller length, or
   crosses the configured cap in a later chunk. Reject before appending the
   over-limit bytes or verifying/installing the package.

## Stable metadata pull request

7. A release PR updates the expected version fields in all release metadata.
   It remains accepted with an added changelog section and metainfo release.
8. Any dependency entry, Cargo feature, build setting, release script, or other
   non-version value changes in an allowlisted manifest. Reject it.
9. Any tracked file is deleted, including an otherwise allowlisted metadata
   file. Reject it instead of omitting deletion statuses from the diff.
10. A rename, copy, untracked path, unknown status, or unexpected file path is
    included in the PR. Reject it.
11. Version fields disagree with the beta-suffix removal, or changelog/metainfo
    omit the new stable version. Reject it.

## Draft release verification

12. A checksum file names a missing asset, an unsafe or duplicate path, has a
    malformed digest, or records bytes different from the actual released
    asset. Reject the draft.
13. A detached GPG signature is missing, invalid, signed by another key, or
    the configured `GPG_KEY_ID` is missing/unresolvable/ambiguous. Fail closed.
14. A GPG signature is valid but its signer does not match the configured
    trusted key. Reject it even if the local keyring accepts the signature.
15. Existing Minisign updater signatures continue to be checked against the
    updater public key and manifest contents.

## Bundled third-party notices

16. The notice source is missing or does not identify the exact yt-dlp version
    of the shipped binaries. Fail the bundled-license step.
17. The matching upstream third-party notice is not copied into the frontend,
    shown in the licenses view, or included as a Tauri resource. Reject the
    release packaging configuration.
18. Strict Cargo 3.9 notice generation is removed or weakened from the release
    license gate. Keep it mandatory.
19. A stable metainfo PR inserts the expected release but also changes a
    launchable, URL, permission, or other component field. Reject it unless the
    metainfo head is exactly the base file with only that release element
    inserted.
20. A required stable or beta updater manifest, including an installer-specific
    beta target, has no required signed checksum bucket. A valid generated draft
    must pass while a missing checksum bucket fails closed.
21. Stable CHANGELOG generation rewrites download-table release URLs, removes
    the Beta callout, and inserts real stable notes after the intro. Accept the
    exact sync helper output while rejecting edits to the old release history or
    any other existing content.

## Third-audit Linux installer and release gates

22. A raw Linux updater body is empty, truncated, has no Type 1/Type 2
    AppImage marker, is not a valid little-endian ELF executable, or has the
    wrong ELF class/machine for this build. Reject it before moving the live
    AppImage.
23. A gzip tar archive has a matching `.AppImage` entry that is a directory,
    symlink, or hardlink, or it has duplicate matching entries. Reject it;
    never unpack an entry directly over the live application. A single valid
    regular file remains supported.
24. A valid payload inherits the existing executable mode. Preserve the old
    AppImage in a recoverable location after replacement; if the staged rename
    fails, restore the old file, and if restoration fails, retain and report
    the backup location.
25. Draft metadata says HEAD while the release tag resolves to another commit,
    including through one or more annotated tag objects. Reject the draft.
    A not-yet-created release tag may remain absent only while the draft
    metadata matches HEAD; publication must create the tag at that commit and
    verify the peeled target after the release is flipped live.
26. The direct publication command must invoke the current shared
    `release-preflight.js` after artifact/draft validation and before the
    publishing PATCH. A failed preflight must stop before any publication
    request, while the full draft artifact verifier remains required.

## AppImage ELF and filesystem validation follow-up

27. An ELF header has the right marker and machine but a zero entry point, no
    executable `PT_LOAD`, an entry point outside every executable load segment,
    or a segment whose file range overflows or exceeds the payload. Reject it
    before moving the installed AppImage.
28. A Type 2 image has only an ELF stub or a truncated/invalid SquashFS image:
    reject absent `hsqs`, truncated superblock/data, unsupported version or
    compression, impossible block size, or `bytes_used` beyond the appended
    filesystem. A Type 1 image must carry its ISO 9660 primary volume
    descriptor and a volume extent bounded by the file. Keep valid Tauri Type 2
    and supported legacy Type 1 images accepted.
29. A gzip tar stream contains a large non-AppImage member, excessive empty
    entries, a truncated candidate or gzip trailer, or duplicate candidates.
    Bound total decompressed bytes and entry traversal, consume/validate the
    complete stream before returning the candidate, require the complete tar
    end marker rather than a single zero block, and never install from a
    partial archive.
30. A legitimate SquashFS image stores its root as an extended directory inode
    (SQUASHFS_LDIR_TYPE, value 8). Accept both standard and extended directory
    inode types after checking the root inode's file-backed metadata bounds.
