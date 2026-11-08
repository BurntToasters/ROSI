# AppImage zstd compression: failure modes

Scope: the Linux AppImage build (`build:linux:*:prepared`) and
`scripts/check-appimage-compression.js`. Plan item C6.1. Tauri builds the
AppImage with linuxdeploy's AppImage plugin, which compresses the SquashFS
payload with gzip unless `LDAI_COMP` names another algorithm. ROSI sets
`LDAI_COMP=zstd`, so the payload is smaller and the updater signature is still
computed by `tauri build` over the final file.

Status: the macOS host cannot build or run an AppImage. Every row below is
proven only when `release:linux:x64:continue` runs on the Linux release
machine, and the launch check on Ubuntu 24.04 is manual (row 6).

| #   | Failure mode                                                                                         | Required behavior                                                                                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The linuxdeploy plugin ignores `LDAI_COMP`, so the AppImage stays gzip and nobody notices            | `check-appimage-compression.js` reads the SquashFS superblock after the ELF runtime and fails the release unless the compression id is zstd (6).                                                                                                                                                                           |
| 2   | The AppImage runtime cannot read a zstd payload, so the app never starts                             | The check runs the AppImage with `--appimage-extract` into a temporary directory, which uses the runtime's own SquashFS reader, and requires `AppRun` and the `rosi` binary in it.                                                                                                                                         |
| 3   | The updater signature covers a different file than the one published                                 | Compression happens inside `tauri build`, before Tauri signs the AppImage. No step rewrites the AppImage after the build.                                                                                                                                                                                                  |
| 4   | The check reads the wrong offset (a runtime with a different ELF layout) and passes or fails by luck | The SquashFS offset is the end of the ELF section header table, and the magic `hsqs` must be at that offset, or the check fails.                                                                                                                                                                                           |
| 5   | The check runs on a stale AppImage from an earlier build                                             | The check takes the AppImage path from the target's bundle directory and requires it to be newer than the release session start.                                                                                                                                                                                           |
| 6   | The AppImage starts on the build machine but not on the documented floor (Ubuntu 24.04)              | Manual: launch the built AppImage on Ubuntu 24.04 before publishing, and record it in docs/IMPLEMENTATION-5.1.md with the AppImage SHA-256.                                                                                                                                                                                |
| 7   | The vendored updater rejects the new AppImage                                                        | The updater installs the AppImage file itself (createUpdaterArtifacts: true, no archive). Its structure check, `validate_squashfs_at` in `src-tauri/vendor/tauri-plugin-updater/src/appimage_install.rs`, accepts compression ids 1 to 6, which includes zstd. A Linux update from the previous beta proves it end to end. |

Proof:

- `node scripts/check-appimage-compression.js --self-test` builds a synthetic
  ELF plus SquashFS header for each compression id and checks rows 1 and 4. It
  runs on any OS.
- Release: `node scripts/check-appimage-compression.js --target
x86_64-unknown-linux-gnu` in `release:linux:x64:continue`, after the build
  and the glibc check. It writes `e2e/artifacts/appimage-compression-report.json`.
