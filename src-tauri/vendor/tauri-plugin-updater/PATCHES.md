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
| Base version | `2.10.1` |
| Source | `https://crates.io/api/v1/crates/tauri-plugin-updater/2.10.1/download` |
| crates.io sha256 | `806d9dac662c2e4594ff03c647a552f2c9bd544e7d0f683ec58f872f952ce4af` |
| Upstream git sha1 | `d6a3898001a4bcc659e045f9501498751b77dbe6` (`.cargo_vcs_info.json`, path `plugins/updater`) |
| Newest stable 2.x seen | `2.13.2` (checked 2026-10-07 via crates.io; `2.13.1` is no longer newest) |

`Cargo.toml`, `Cargo.toml.orig`, `README.md`, `build.rs`, `permissions/`,
`guest-js/` and the JS build files are byte-identical to upstream 2.10.1.
All ROSI changes are under `src/`. `ROSI.patch` is the complete diff
(upstream `src/` to vendored `src/`), excluding `target/`, `Cargo.lock`,
`.cargo-ok` and `.cargo_vcs_info.json`.

Apply the patch to a pristine copy with:

```sh
patch -p1 -d <pristine-2.10.1-dir> -i ROSI.patch
```

## Patched files

| File | Status | Why the patch exists |
| --- | --- | --- |
| `src/install_safety.rs` | new | Shared install checks. macOS: bundle identity and completeness, a sibling backup path, a process-wide install lock, and a privileged replacement script whose arguments are shell-quoted. Windows: `ShellExecuteW` result check (values `<= 32` are failures). Archives: confined tar member, parent-directory and symlink-target checks, so an update cannot write outside the extract root. Linux: helper binaries (`pkexec`, `sudo`, `zenity`, `kdialog`, `sh`) are resolved only from fixed root-owned system directories and never through `PATH`; the privileged environment is an allowlist (session display, D-Bus, locale vars) and sets `PATH` to fixed system directories. Also cross-device move and copy fallback. Its `#[cfg(test)]` module runs with `cargo test`. |
| `src/appimage_install.rs` | new | Validates an AppImage before it replaces the live file: ELF class, machine and entrypoint checks, squashfs and ISO9660 structure for Type 2 images. Stages in a private work directory, moves the old image aside, then renames the stage into place, restoring the old image if that fails. Used on Linux and BSD only. |
| `src/appimage_archive.rs` | new | Bounded `.tar.gz` extraction for AppImage updates: entry-count limit, total decompressed-byte limit, exactly one regular `.AppImage` member, no links, truncation detection. Used on Linux and BSD only. |
| `src/updater.rs` | modified | See details below. |
| `src/lib.rs` | modified | Adds `mod install_safety;`. Plumbs the fallible `on_before_exit` hook and a new `on_windows_installer_launched` hook into the updater state. Windows cleanup now runs from the launched hook, not before launch. |
| `src/error.rs` | modified | Adds `Error::BeforeExit(String)` so a failed app-state flush aborts installation and keeps the update retryable. |
| `src/commands.rs` | modified | `allow_downgrades` is accepted but ignored (`let _ = allow_downgrades;`). ROSI decision: the flag cannot select an older release, so the default newer-only comparator always applies. Upstream honours the flag by replacing `version_comparator`. |

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
  is extracted with the confined extractor (`extract_macos_app_archive`), the live bundle is
  moved to the sibling backup, the new bundle is moved live, and the backup is removed only
  after the identity check passes. `restore_macos_live_bundle` and
  `recover_macos_live_bundle` roll back a partial swap. When the user-owned path is not
  writable, the privileged AppleScript path runs with quoted arguments.
- Linux: privileged commands go through `linux_privileged_command` (env allowlist, fixed
  `PATH`, `LC_ALL=C`). Child processes run in their own process group with timeouts
  (`wait_child_output_timeout`, 600 s for package installs). Helper paths come from
  `resolve_trusted_system_helper`. `SSL_CERT_FILE` falls back to `/etc/pki/tls/certs/ca-bundle.crt`
  when the Debian path is absent. AppImage updates route through `appimage_archive` and
  `appimage_install`.
- Tests: `#[cfg(test)]` modules in `updater.rs`, `install_safety.rs`, `appimage_install.rs` and
  `appimage_archive.rs` are ROSI additions. They run under `cargo test` in the `rust-check` CI job.

## Clippy warnings (resolved without deleting code)

`cargo clippy` on macOS reported 28 dead-code warnings, all in `appimage_install.rs`
and `appimage_archive.rs`. All of them are ROSI code. None is upstream code. The
functions are not dead: their only caller is the Linux/BSD `install_appimage` path in
`updater.rs`, which macOS does not compile. Deleting them would break AppImage
installs on Linux.

Fix: a `#![cfg_attr(target_os = "macos", allow(dead_code))]` at the top of both files.
Linux and BSD still warn about real dead code. macOS stays clean. The modules still
compile on macOS so their tests keep running.


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
