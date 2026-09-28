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
- `Builder::on_before_exit` lets the app stop its own work (downloads, queue
  flush) right before the Windows installer takes over via `process::exit`.
- Windows must treat `ShellExecuteW <= 32` as failure and must not run
  `on_before_exit` / `exit` until the installer actually launches.

Do not drop the path patch without an equivalent upstream fix.
