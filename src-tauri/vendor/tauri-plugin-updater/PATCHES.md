# ROSI patches to tauri-plugin-updater

This directory is a patched copy of an upstream crate. `src-tauri/Cargo.toml`
overrides the crates.io dependency with:

```toml
[patch.crates-io]
tauri-plugin-updater = { path = "vendor/tauri-plugin-updater" }
```

Because of that override, a `tauri-plugin-updater` version bump in
`src-tauri/Cargo.toml` or a Dependabot PR changes nothing. The vendored
version is the only one that builds. Dependabot ignores this crate for that
reason (`.github/dependabot.yml`).

## Upstream base

| Field | Value |
| --- | --- |
| Crate | `tauri-plugin-updater` |
| Base version | `2.14.0` |
| Source | `https://crates.io/api/v1/crates/tauri-plugin-updater/2.14.0/download` |
| crates.io sha256 | `7259989d4fe11b2bf51f7d671642249b1837c4ae2da1430dc713ae38f98ceeec` |
| Upstream git sha1 | `44293a5722efcaf27060504e63b17aeba721b40f` (`.cargo_vcs_info.json`, path `plugins/updater`) |
| Newest stable 2.x seen | `2.14.1` (seen 2026-10-28 in the local crates.io cache). Dependency-only: `base64` 0.22 to 0.23 and `zip` 4 to 9 in `Cargo.toml`, `src/` byte-identical to 2.14.0. Not adopted; the base stays `2.14.0`. Before that, `2.14.0` was the newest (checked 2026-10-17; `2.13.3` and `2.13.2` are older) |

`Cargo.toml.orig`, `README.md`, `build.rs`, `permissions/`,
`CHANGELOG.md`, `SECURITY.md`, `api-iife.js`, the `LICENSE*` files and
`.cargo_vcs_info.json` are byte-identical to upstream 2.14.0. Upstream 2.14.0
excludes `guest-js/`, `package.json`, `rollup.config.js`, `tsconfig.json` and
`banner.png` from the crate, so they are not vendored any more.
ROSI changes are under `src/`, plus one dependency in `Cargo.toml`.
`ROSI.patch` is the complete diff (upstream crate to vendored crate),
excluding `target/`, `Cargo.lock`, `.cargo-ok`, `.cargo_vcs_info.json`,
`PATCHES.md` and `ROSI.patch`.

Apply the patch to a pristine copy with:

```sh
patch -p1 -d <pristine-2.14.0-dir> -i ROSI.patch
```

## Patched files

| File | Status | Why the patch exists |
| --- | --- | --- |
| `src/install_safety.rs` | new | Shared install checks. macOS: bundle identity and completeness, Mach-O architecture validation (`macos_bundle_executable_supports_host_arch`, checking both native execution and Rosetta 2 translation), a sibling backup path, a process-wide install lock, and a privileged replacement script whose arguments are shell-quoted. Windows: `ShellExecuteW` result check (values `<= 32` are failures). Archives: confined tar member, parent-directory and symlink-target checks, so an update cannot write outside the extract root. Linux: helper binaries (`pkexec`, `sudo`, `zenity`, `kdialog`, `sh`) are resolved only from fixed root-owned system directories and never through `PATH`; the privileged environment is an allowlist (session display, D-Bus, locale vars) and sets `PATH` to fixed system directories. Also cross-device move and copy fallback. Its `#[cfg(test)]` module runs with `cargo test`. |
| `src/appimage_install.rs` | new | Validates an AppImage before it replaces the live file: ELF class, machine and entrypoint checks, squashfs and ISO9660 structure for Type 2 images. Stages in a private work directory, moves the old image aside, then renames the stage into place, restoring the old image if that fails. Used on Linux and BSD only. |
| `src/appimage_archive.rs` | new | Bounded `.tar.gz` extraction for AppImage updates: entry-count limit, total decompressed-byte limit, exactly one regular `.AppImage` member, no links, truncation detection. Used on Linux and BSD. Its `BoundedArchiveReader` (decompressed-byte cap, tar end-block and trailing-data check) also bounds macOS app extraction. The module is compiled on macOS without the `zip` feature, because its `flate2` and `tar` dependencies are unconditional there. On Linux and BSD it still needs `zip`. |
| `src/updater.rs` | modified | See details below. |
| `src/lib.rs` | modified | Adds `mod install_safety;`. Plumbs the fallible `on_before_exit` hook and a new `on_windows_installer_launched` hook into the updater state. Windows cleanup now runs from the launched hook, not before launch. |
| `src/error.rs` | modified | Adds `Error::BeforeExit(String)` so a failed app-state flush aborts installation and keeps the update retryable. |
| `Cargo.toml` | modified | Adds the macOS-only `zstd` dependency (`default-features = false`) for per-arch `.app.tar.zst` updates. |
| `src/commands.rs` | modified | `allow_downgrades` is accepted but ignored (`let _ = allow_downgrades;`). ROSI decision: the flag cannot select an older release, so the default newer-only comparator always applies. Upstream honours the flag by replacing `version_comparator`. The config-level `allowDowngrades` (`Config::allow_downgrades`, parsed from `tauri.conf`) is not applied either: `lib.rs` does not install the downgrade comparator from it. |

### `src/updater.rs` details

- `on_before_exit` is fallible (`Fn() -> Result<(), String>`). `run_preinstall_flush`
  runs it before any install step. An error returns `Error::BeforeExit` and leaves
  the downloaded update in place. Upstream calls it unconditionally and ignores the result.
- Windows: the installer is launched with `ShellExecuteW`. `finish_windows_installer_launch`
  checks the return value, then runs cleanup and exit only after a successful launch.
  Upstream exits before launching.
- Downloads: `MAX_UPDATE_PACKAGE_BYTES` (512 MiB) is enforced on `Content-Length` and on
  the running byte count (`append_download_chunk`). A body longer than its declared length
  is an error.
- macOS: installs go through `install_inner_locked` inside the install lock. The new bundle
  is extracted with the confined extractor (`extract_macos_app_archive`), verified to support
  the host CPU architecture (`macos_bundle_executable_supports_host_arch` for the main executable
  and bundled sidecars, including Rosetta 2 migration to native Apple Silicon), the live bundle is
  moved to the sibling backup, the new bundle is moved live, and the backup is removed only
  after the identity check passes. `restore_macos_live_bundle` and
  `recover_macos_live_bundle` roll back a partial swap. When the user-owned path is not
  writable, the privileged AppleScript path runs with quoted arguments.
- macOS archives: `extract_macos_app_archive` picks gzip (Tauri `.app.tar.gz`) or zstd (ROSI
  per-arch `.app.tar.zst`, `scripts/pack-macos-updater-zst.js`) by magic bytes and rejects
  anything else. zstd frames may not ask for a window above 2^27
  (`MACOS_ZSTD_WINDOW_LOG_MAX`, matching the packer's `--long=27`). Both formats share the
  member checks, a 2 GiB decompressed cap, and a full-stream trailer check. Failure modes:
  `e2e/updater-zst.failure-modes.md`.
- Linux: privileged commands go through `linux_privileged_command` (env allowlist, fixed
  `PATH`, `LC_ALL=C`). Child processes run in their own process group with timeouts
  (`wait_child_output_timeout`, 600 s for package installs). Helper paths come from
  `resolve_trusted_system_helper`. `SSL_CERT_FILE` falls back to `/etc/pki/tls/certs/ca-bundle.crt`
  when the Debian path is absent. AppImage updates route through `appimage_archive` and
  `appimage_install`.
- Tests: `#[cfg(test)]` modules in `updater.rs`, `install_safety.rs`, `appimage_install.rs` and
  `appimage_archive.rs` are ROSI additions. They run under `cargo test` in the `rust-check` CI job.
- Rebased onto 2.14.0 (2026-10-17). Upstream 2.14.0 features kept: `Update::verify`,
  `restore_update`, `require_signed_version` and the signed-version checks,
  `configure_client`, `restart_after_install`, and the `updater_parameters` installer argument
  builder. The upstream `UpdaterContext` struct holds the ROSI fields too (`on_before_exit`,
  `on_windows_installer_launched`, `bundle_identifier`). `Updater` and `Update` keep
  `executable_name` as a plain field.
- `install()`: verified first (upstream 2.14.0), then `on_before_exit` runs before any install
  step. `download_and_install` goes through `install()`, so the hook runs there too.
- Not adopted from 2.14.0: its swap-based macOS install (`swap_bundle`, `replace_bundle`,
  `privileged_install_command`, `keep_backup_if_not_restored`, `SWAP_BUNDLE_JXA`, `sh_quote`,
  `applescript_string`) and `Updater::tmp_dir_locations`. ROSI's `install_inner_locked` and
  its Linux `try_tmp_locations` replace them. Their tests are dropped too. `try_tmp_locations`
  builds its own local list of candidate directories (system temp, user cache, app directory).
- Upstream 2.14.0 AppImage tests in `updater.rs` `offline_tests` are kept but use
  `appimage_install::test_fixtures::host_appimage` for both the live and the new image,
  because ROSI validates real AppImage structure, not only the ELF magic. A payload that is
  not an AppImage fails with `Error::Io` of kind `InvalidData` instead of
  `Error::InvalidUpdaterFormat`.

## Clippy warnings (resolved without deleting code)

`cargo clippy` on macOS reported 28 dead-code warnings, all in `appimage_install.rs`
and `appimage_archive.rs`. All of them are ROSI code. None is upstream code. The
functions are not dead: their only caller is the Linux/BSD `install_appimage` path in
`updater.rs`, which macOS does not compile. Deleting them would break AppImage
installs on Linux.

Fix: a `#![cfg_attr(target_os = "macos", allow(dead_code))]` at the top of both files.
Linux and BSD still warn about real dead code. macOS has no dead-code warnings. The modules
still compile on macOS so their tests keep running.

Other default clippy lints still fire on pre-existing code. On 2026-10-28, a cross check
(`cargo clippy --lib --tests --target aarch64-apple-darwin`, Rust 1.98.1, from Windows)
reported 5 lib lints (`map_or`, `div_ceil`, range `contains`) in `appimage_install.rs`, and 10
more in test code (`appimage_install.rs`, `appimage_archive.rs`, `install_safety.rs`,
`updater.rs`). None is in the Mach-O, zstd or macOS archive extraction code.


## Known gaps

- `allow_downgrades` is a deliberate behaviour change (see table above).
- cargo-audit cannot report advisories for this crate: it is a path dependency,
  so `src-tauri/Cargo.lock` has no registry source. `scripts/check-vendored-updater.mjs`
  reads the RustSec advisory database instead (`crates/tauri-plugin-updater/*.md`,
  shallow sparse clone of `https://github.com/rustsec/advisory-db`). An advisory
  whose `patched` and `unaffected` ranges both exclude the vendored version fails
  the check (exit 1). If the database cannot be cloned, the check warns and the job
  summary says the advisory check was skipped. Check
  `https://rustsec.org/packages/tauri-plugin-updater.html` by hand when rebasing.
- Only the macOS clippy result was checked locally. Linux-only code paths are covered
  by the `rust-check` and `smoke-build` CI jobs, not by a local run.
- The 2.14.0 rebase was checked on Windows only. Cross-target checks for Linux and macOS
  need a C toolchain (`ring`, `libdbus-sys`, `objc2-exception-helper`), which the rebase host
  lacked. The Linux and macOS code was merged by hand and needs CI (`rust-check`, `smoke-build`).
- The vendored crate has its own `Cargo.lock`, regenerated for 2.14.0 with the lock from
  `src-tauri` as the seed. It is a standalone root package, so its unit tests run with
  `cargo test --locked --manifest-path src-tauri/vendor/tauri-plugin-updater/Cargo.toml --lib`
  (CI gate `vendorUpdater` in `scripts/test-all.js`). The root `cargo test --all-targets`
  gate does not run them. Last run on Windows (2026-10-28, after the Mach-O and zstd changes):
  34 pass, 0 fail, 0 ignored. The macOS run is pending for this state. Its count and its one
  ignored test (the real-archive test that `scripts/e2e-updater-zst.mjs` runs with
  `ROSI_UPDATER_ZST_E2E_ARCHIVES`) must be confirmed on a Mac, through the macOS CI job or
  `npm run test:e2e:updater-zst`.

## Rebase procedure (new upstream version X)

1. Read the newest stable 2.x from `https://crates.io/api/v1/crates/tauri-plugin-updater`
   and its `checksum` field. Download `.../tauri-plugin-updater/X/download` into a fresh
   empty scratch directory and confirm the sha256 matches.
2. Extract it into a new empty directory `pristine-X`. Do not extract into the repo.
3. Dry-run the old patch against the new base:
   `patch -p1 --dry-run -d pristine-X -i ROSI.patch`. Resolve each rejected hunk by hand
   in `pristine-X`, keeping upstream fixes and the ROSI behaviour listed above.
4. Copy the resolved `src/` tree into this directory. Set `version` in `Cargo.toml`
   only if it differs from upstream X (it should not). Leave `target/` and `Cargo.lock` alone.
5. Regenerate the patch against pristine X, excluding build output:
   `diff -ruN -x target -x Cargo.lock -x .cargo-ok -x .cargo_vcs_info.json pristine-X <vendored-copy>`,
   with `a/` and `b/` path prefixes. Replace the upstream version and checksum in this file.
6. Move `@tauri-apps/plugin-updater` in `package.json` to the same minor version
   (the JS and Rust halves must match).
7. Run `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
   and `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets`. Let CI cover
   Linux and Windows.
8. Run `node scripts/check-vendored-updater.mjs`. It should report no advisory. A warning
   is expected only while the vendored version is behind the newest 2.x, or when the
   advisory database cannot be cloned. Use `--advisory-db <dir>` for an offline checkout.
9. Update the "Newest stable 2.x seen" row with the date you checked.
