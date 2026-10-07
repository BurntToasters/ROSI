# Vendored tauri-plugin-updater

Path-patched from crates.io `tauri-plugin-updater` 2.10.1.

## Why

Keep `[patch.crates-io]` in `src-tauri/Cargo.toml` until upstream matches these
fixes:

- macOS privileged install must not interpolate bundle paths into a shell
  string. Paths are AppleScript handler arguments, quoted with
  `quoted form of` before `do shell script`.
- macOS must not `rm -rf` the live `.app` before the replacement is in place.
  The live bundle is renamed to a same-volume sibling backup
  (`.zinnia-update-backup`), the new bundle is moved in, then the backup is
  deleted. Failure restores the backup. Staging lives next to the `.app`, not
  under `/tmp`, so a dropped `TempDir` cannot erase the installed app. `EXDEV`
  copies onto the app's volume before the swap.
- macOS live, staged, and recovery bundles must each contain executable,
  non-symlink `rosi-yt-dlp`, `rosi-ffmpeg`, and `rosi-ffprobe` sidecars as well
  as the host executable and Resources directory. Rust and the privileged
  AppleScript path enforce the same bundle-completeness contract.
- Tar extraction must reject `Prefix` / `RootDir` / `ParentDir`, hard links,
  and symlinks that escape the extract root.
- Linux `pkexec` / `sudo` / `dpkg` / `rpm` must be absolute, root-owned
  helpers (`/usr/bin` or `/bin`), never resolved from `PATH`, with a minimal
  `PATH=/usr/bin:/bin` environment. Regular files must not be group/world
  writable. Root-owned helper symlinks are followed and the target must still
  be a trusted regular file (Linux symlink mode is always 0777 and unused).
  `sudo -S` must drain output and time out instead of piping both stdio and
  calling `wait()`.
- Linux RPM updates run `rpm -U --oldpackage`: RPM sorts `X.Y.Z-beta.N` above
  `X.Y.Z`, so beta -> stable was refused as a downgrade. The plugin has already
  compared versions with semver; `dpkg -i` only warns on the same case.
- Linux AppImage updates validate the AppImage marker and target ELF header,
  stage the payload before touching the live file, accept only one regular
  `.AppImage` tar entry, restore the existing executable mode, and retain the
  previous image for recovery after a successful swap.
- `Builder::on_before_exit` is a fallible pre-install flush on every platform.
  A failed state flush aborts installation and keeps the downloaded update
  available for retry. It must not perform Tauri cleanup before installation.
- Windows must treat `ShellExecuteW <= 32` as failure, keep Tauri resources
  intact on failure, and run Tauri cleanup only after a successful installer
  launch immediately before the direct process exit. Other platforms use their
  normal restart cleanup path.
- Updater package downloads are limited to 512 MiB based on actual streamed
  bytes, including responses without a `Content-Length` header.

Do not drop the path patch without an equivalent upstream fix.
