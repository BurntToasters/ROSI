// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Shared install-path and helper-binary checks used by the platform updaters.
//! Keep this module free of extra crate dependencies so unit tests can run
//! without elevation.

#![allow(dead_code)]

use std::path::{Component, Path, PathBuf};

/// AppleScript used for privileged macOS bundle replacement.
///
/// Paths are handler arguments, then quoted with `quoted form of`. The live
/// bundle is renamed to a sibling backup *before* the new bundle is moved into
/// place. A leftover backup is deleted only when the live path already has
/// `Contents`. Failure removes a partial new tree at `$SRC` (never the live
/// copy, which is at `$BAK`) and restores the backup. `mv` onto an existing
/// directory would nest the backup, so restore always clears `$SRC` first.
pub const MACOS_PRIVILEGED_INSTALL_SCRIPT: &str = r#"
on installUpdate(srcPath, newPath, backupPath)
  do shell script "NEW=" & quoted form of newPath & "; SRC=" & quoted form of srcPath & "; BAK=" & quoted form of backupPath & "; /bin/test -d \"$NEW/Contents\" || exit 1; if /bin/test ! -d \"$SRC/Contents\"; then if /bin/test -d \"$BAK/Contents\"; then if /bin/test -e \"$SRC\"; then /bin/rm -rf \"$SRC\"; fi; /bin/mv -f \"$BAK\" \"$SRC\" || exit 1; fi; fi; /bin/test -d \"$SRC/Contents\" || exit 1; if /bin/test -e \"$BAK\"; then /bin/rm -rf \"$BAK\"; fi; /bin/mv -f \"$SRC\" \"$BAK\" || exit 1; if /bin/mv -f \"$NEW\" \"$SRC\" && /bin/test -d \"$SRC/Contents\"; then /bin/rm -rf \"$BAK\"; exit 0; fi; if /bin/test -e \"$SRC\"; then /bin/rm -rf \"$SRC\"; fi; /bin/mv -f \"$BAK\" \"$SRC\"; exit 1" with administrator privileges
end installUpdate
"#;

/// True when `path` looks like a complete macOS `.app` bundle.
pub fn macos_app_bundle_complete(path: &Path) -> bool {
    path.join("Contents").is_dir()
}

/// Session variables pkexec, zenity, and polkit agents need after `env_clear`.
/// Never includes `PATH`.
pub const LINUX_PRIVILEGED_ENV_ALLOWLIST: &[&str] = &[
    "HOME",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP",
];

/// Sibling backup directory next to the live `.app` (same volume, not `/tmp`).
pub fn macos_update_backup_path(extract_path: &Path) -> Option<PathBuf> {
    extract_path
        .parent()
        .map(|parent| parent.join(".zinnia-update-backup"))
}

/// ShellExecuteW returns a value `<= 32` on failure (Win32).
pub fn shell_execute_launch_ok(result: isize) -> bool {
    result > 32
}

/// True when `rename` failed because source and destination are on different devices.
pub fn is_cross_device(err: &std::io::Error) -> bool {
    match err.raw_os_error() {
        // Unix EXDEV
        Some(18) => true,
        // Windows ERROR_NOT_SAME_DEVICE
        Some(17) if cfg!(windows) => true,
        _ => false,
    }
}

/// Skip the archive's first path component (Tauri `.app.tar.gz` wrapper), then
/// reject `Prefix` / `RootDir` / `ParentDir`. Remaining components must be
/// relative and contained.
pub fn confined_tar_member_relative(entry_path: &Path) -> Result<PathBuf, ConfinedPathError> {
    let mut components = entry_path.components();
    match components.next() {
        Some(Component::Normal(_)) | Some(Component::CurDir) => {}
        Some(Component::Prefix(_))
        | Some(Component::RootDir)
        | Some(Component::ParentDir)
        | None => {
            return Err(ConfinedPathError::Unconfined);
        }
    }

    let mut relative = PathBuf::new();
    for component in components {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                return Err(ConfinedPathError::Unconfined);
            }
        }
    }
    Ok(relative)
}

/// Create `dest`'s parent directories under `root` without following symlinks.
pub fn create_confined_parent_dirs(root: &Path, dest: &Path) -> std::io::Result<()> {
    let Some(parent) = dest.parent() else {
        return Ok(());
    };
    if !path_is_inside(root, parent) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "parent path is not confined",
        ));
    }
    if parent == root {
        return Ok(());
    }
    let relative = parent.strip_prefix(root).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "parent path is not confined",
        )
    })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(part) = component else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "parent path is not confined",
            ));
        };
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "refusing to create updater files through a symlink parent",
                ));
            }
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "updater extract parent is not a directory",
                ));
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current)?;
            }
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

/// Lexical containment: `candidate` must be `root` or a descendant without `..`.
pub fn path_is_inside(root: &Path, candidate: &Path) -> bool {
    if candidate == root {
        return true;
    }
    let Ok(rest) = candidate.strip_prefix(root) else {
        return false;
    };
    rest.components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

/// Symlink targets must be relative and stay inside `root` when resolved from
/// the symlink's parent directory.
pub fn confined_symlink_target(root: &Path, link_parent: &Path, target: &Path) -> bool {
    if target.as_os_str().is_empty() {
        return false;
    }
    if !path_is_inside(root, link_parent) {
        return false;
    }

    let mut resolved = link_parent.to_path_buf();
    for component in target.components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if resolved == root || !resolved.pop() {
                    return false;
                }
            }
            Component::Prefix(_) | Component::RootDir => return false,
        }
        if !path_is_inside(root, &resolved) {
            return false;
        }
    }
    path_is_inside(root, &resolved)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfinedPathError {
    Unconfined,
}

impl std::fmt::Display for ConfinedPathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfinedPathError::Unconfined => {
                write!(f, "updater archive member path is not confined")
            }
        }
    }
}

impl std::error::Error for ConfinedPathError {}

/// Candidate absolute paths for a Linux helper. Never search `PATH`.
pub fn trusted_system_helper_candidates(name: &str) -> [PathBuf; 2] {
    [
        PathBuf::from("/usr/bin").join(name),
        PathBuf::from("/bin").join(name),
    ]
}

pub fn helper_name_is_safe(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

/// Root-owned regular file, not group/world-writable.
pub fn unix_metadata_is_trusted_helper(uid: u32, mode: u32, is_regular_file: bool) -> bool {
    is_regular_file && uid == 0 && (mode & 0o022) == 0
}

/// Trust check for the directory entry at a helper path before following it.
///
/// Regular files must be root-owned and not group/world-writable. Symlink
/// inodes must be root-owned; their mode is ignored because Linux always
/// reports 0777 on symlinks and never uses those bits (`man 7 symlink`).
/// Rejecting 0777 would refuse `/usr/bin/sh` -> `dash` and any distro helper
/// that is an alias.
pub fn unix_directory_entry_is_trusted_helper(uid: u32, mode: u32, is_symlink: bool) -> bool {
    if uid != 0 {
        return false;
    }
    if is_symlink {
        return true;
    }
    (mode & 0o022) == 0
}

#[cfg(unix)]
pub fn unix_helper_is_trusted(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    let Ok(link_meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    // The directory entry must be root-owned. A user-owned /usr/bin symlink
    // cannot be swapped in. Writable-bit checks apply to regular files only.
    if !unix_directory_entry_is_trusted_helper(
        link_meta.uid(),
        link_meta.mode(),
        link_meta.file_type().is_symlink(),
    ) {
        return false;
    }
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    unix_metadata_is_trusted_helper(meta.uid(), meta.mode(), meta.is_file())
}

#[cfg(unix)]
pub fn resolve_trusted_system_helper(name: &str) -> std::io::Result<PathBuf> {
    if !helper_name_is_safe(name) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid helper name",
        ));
    }
    for candidate in trusted_system_helper_candidates(name) {
        if unix_helper_is_trusted(&candidate) {
            return Ok(candidate);
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!("trusted helper {name} not found"),
    ))
}

/// Recursively copy a directory tree onto `dst` (for EXDEV fallback).
pub fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir_all(&from, &to)?;
        } else if file_type.is_symlink() {
            let target = std::fs::read_link(&from)?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, &to)?;
            #[cfg(not(unix))]
            {
                let _ = target;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "symlink copy is not supported on this platform",
                ));
            }
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Move a directory onto `dst`. On EXDEV, copy beside the destination then rename.
pub fn move_dir_replacing(src: &Path, dst: &Path) -> std::io::Result<()> {
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(err) if is_cross_device(&err) => {
            if let Some(parent) = dst.parent() {
                let staging = parent.join(".zinnia-update-staging");
                if staging.exists() {
                    std::fs::remove_dir_all(&staging)?;
                }
                copy_dir_all(src, &staging)?;
                std::fs::rename(&staging, dst)?;
                let _ = std::fs::remove_dir_all(src);
                Ok(())
            } else {
                Err(err)
            }
        }
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn macos_script_quotes_handler_args_and_restores_backup() {
        assert!(MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("quoted form of"));
        assert!(MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("backupPath"));
        assert!(MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("/bin/test -d \\\"$NEW/Contents\\\""));
        assert!(MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("/bin/test -d \\\"$SRC/Contents\\\""));
        assert!(MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("/bin/mv -f \\\"$BAK\\\" \\\"$SRC\\\""));
        assert!(
            MACOS_PRIVILEGED_INSTALL_SCRIPT
                .contains("/bin/rm -rf \\\"$SRC\\\"; fi; /bin/mv -f \\\"$BAK\\\" \\\"$SRC\\\""),
            "failed swap must remove the incomplete new tree before restoring the backup"
        );
        let swap_at = MACOS_PRIVILEGED_INSTALL_SCRIPT
            .find("/bin/mv -f \\\"$SRC\\\" \\\"$BAK\\\"")
            .expect("live bundle must be renamed to the sibling backup first");
        let stale_backup_rm = MACOS_PRIVILEGED_INSTALL_SCRIPT
            .find(concat!(
                "if /bin/test -e \\\"$BAK\\\"; then /bin/rm -rf \\\"$BAK\\\"; fi; ",
                "/bin/mv -f \\\"$SRC\\\" \\\"$BAK\\\""
            ))
            .expect(
                "stale backup may be removed only after live Contents exists and immediately before the swap",
            );
        assert!(
            stale_backup_rm < swap_at,
            "must not delete the sibling backup before the live bundle is moved"
        );
        assert!(
            !MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("rm -rf \" & quoted form of srcPath"),
            "must never rm -rf the live bundle path via AppleScript concatenation"
        );
        assert!(
            !MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("Zinnia.app")
                && !MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("/Applications"),
            "script template must not embed filesystem paths"
        );
        let malicious = "/Applications/Don't '; touch /tmp/pwned; '.app";
        assert!(!MACOS_PRIVILEGED_INSTALL_SCRIPT.contains(malicious));
    }

    #[test]
    fn backup_path_is_sibling_not_tmp() {
        let app = Path::new("/Applications/Zinnia.app");
        assert_eq!(
            macos_update_backup_path(app).as_deref(),
            Some(Path::new("/Applications/.zinnia-update-backup"))
        );
    }

    #[test]
    fn shell_execute_rejects_win32_error_codes() {
        assert!(!shell_execute_launch_ok(0));
        assert!(!shell_execute_launch_ok(2));
        assert!(!shell_execute_launch_ok(32));
        assert!(shell_execute_launch_ok(33));
        assert!(shell_execute_launch_ok(42));
    }

    #[test]
    fn tar_paths_reject_parent_root_and_prefix() {
        assert_eq!(
            confined_tar_member_relative(Path::new("Zinnia.app/Contents/MacOS/zinnia")).unwrap(),
            PathBuf::from("Contents/MacOS/zinnia")
        );
        assert!(confined_tar_member_relative(Path::new("Zinnia.app"))
            .unwrap()
            .as_os_str()
            .is_empty());
        assert!(confined_tar_member_relative(Path::new("Zinnia.app/../etc/passwd")).is_err());
        assert!(confined_tar_member_relative(Path::new("/etc/passwd")).is_err());
        assert!(confined_tar_member_relative(Path::new("Zinnia.app/Contents/../../etc")).is_err());
        assert!(confined_tar_member_relative(Path::new("..")).is_err());
    }

    #[test]
    fn symlink_targets_must_stay_inside_extract_root() {
        let root = Path::new("/tmp/extract");
        let parent = Path::new("/tmp/extract/Contents/MacOS");
        assert!(confined_symlink_target(
            root,
            parent,
            Path::new("../Resources/icon.icns")
        ));
        assert!(!confined_symlink_target(
            root,
            parent,
            Path::new("/etc/passwd")
        ));
        assert!(!confined_symlink_target(
            root,
            parent,
            Path::new("../../../../etc/passwd")
        ));
        assert!(!confined_symlink_target(root, parent, Path::new("")));
    }

    #[test]
    fn trusted_helpers_never_search_path() {
        let old = std::env::var("PATH").ok();
        std::env::set_var("PATH", "/tmp/hostile-updater-path:/opt/evil/bin");
        let candidates = trusted_system_helper_candidates("pkexec");
        assert_eq!(candidates[0], PathBuf::from("/usr/bin/pkexec"));
        assert_eq!(candidates[1], PathBuf::from("/bin/pkexec"));
        assert!(helper_name_is_safe("dpkg"));
        assert!(helper_name_is_safe("rpm"));
        assert!(helper_name_is_safe("sudo"));
        assert!(!helper_name_is_safe("../usr/bin/pkexec"));
        assert!(!helper_name_is_safe("/usr/bin/pkexec"));
        assert!(!helper_name_is_safe("pkexec/../../bin/sh"));
        #[cfg(unix)]
        {
            let resolved = resolve_trusted_system_helper("sh").expect("sh should exist");
            assert!(
                resolved == PathBuf::from("/bin/sh") || resolved == PathBuf::from("/usr/bin/sh"),
                "hostile PATH must not change trusted helper resolution, got {resolved:?}"
            );
        }
        match old {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }
    }

    #[test]
    fn linux_privileged_env_keep_session_display_and_dbus() {
        assert!(LINUX_PRIVILEGED_ENV_ALLOWLIST.contains(&"DISPLAY"));
        assert!(LINUX_PRIVILEGED_ENV_ALLOWLIST.contains(&"WAYLAND_DISPLAY"));
        assert!(LINUX_PRIVILEGED_ENV_ALLOWLIST.contains(&"DBUS_SESSION_BUS_ADDRESS"));
        assert!(LINUX_PRIVILEGED_ENV_ALLOWLIST.contains(&"XDG_RUNTIME_DIR"));
        assert!(!LINUX_PRIVILEGED_ENV_ALLOWLIST
            .iter()
            .any(|key| *key == "PATH"));
    }

    #[cfg(unix)]
    #[test]
    fn confined_parent_dirs_refuse_symlink_parents() {
        let root =
            std::env::temp_dir().join(format!("zinnia-updater-confine-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let outside =
            std::env::temp_dir().join(format!("zinnia-updater-outside-{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let dest = link.join("evil");
        let err = create_confined_parent_dirs(&root, &dest).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn helper_mode_rejects_group_or_world_writable_and_non_root() {
        assert!(unix_metadata_is_trusted_helper(0, 0o755, true));
        assert!(unix_metadata_is_trusted_helper(0, 0o750, true));
        assert!(!unix_metadata_is_trusted_helper(0, 0o775, true));
        assert!(!unix_metadata_is_trusted_helper(0, 0o757, true));
        assert!(!unix_metadata_is_trusted_helper(501, 0o755, true));
        assert!(!unix_metadata_is_trusted_helper(0, 0o755, false));
        // Linux symlink inodes are always 0777; a root-owned link must still
        // be a valid helper directory entry.
        assert!(unix_directory_entry_is_trusted_helper(0, 0o777, true));
        assert!(unix_directory_entry_is_trusted_helper(0, 0o755, true));
        assert!(!unix_directory_entry_is_trusted_helper(501, 0o777, true));
        assert!(!unix_directory_entry_is_trusted_helper(0, 0o777, false));
        assert!(!unix_directory_entry_is_trusted_helper(0, 0o775, false));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_sh_from_system_roots_without_elevation() {
        let resolved =
            resolve_trusted_system_helper("sh").expect("sh should exist as a root helper");
        assert!(
            resolved == PathBuf::from("/bin/sh") || resolved == PathBuf::from("/usr/bin/sh"),
            "unexpected sh path {resolved:?}"
        );
        assert!(unix_helper_is_trusted(&resolved));
        let hostile = std::env::temp_dir().join("zinnia-hostile-pkexec");
        let _ = std::fs::write(&hostile, b"#!/bin/sh\n");
        assert!(!unix_helper_is_trusted(&hostile));
        let _ = std::fs::remove_file(&hostile);
        let hostile_link = std::env::temp_dir().join("zinnia-hostile-sh-link");
        let _ = std::fs::remove_file(&hostile_link);
        std::os::unix::fs::symlink(&resolved, &hostile_link).unwrap();
        assert!(
            !unix_helper_is_trusted(&hostile_link),
            "a user-owned symlink to a trusted helper must not be trusted"
        );
        let _ = std::fs::remove_file(&hostile_link);
        assert!(resolve_trusted_system_helper("definitely-not-a-zinnia-helper").is_err());
    }
}
