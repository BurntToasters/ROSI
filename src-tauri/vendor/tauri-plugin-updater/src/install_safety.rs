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
/// Paths and identity are handler arguments, quoted before reaching the
/// shell. Every candidate must have the expected bundle identifier,
/// executable, and Resources directory. A backup is removed only after its
/// identity has been verified and a complete replacement is live.
pub const MACOS_PRIVILEGED_INSTALL_SCRIPT: &str = r#"
on installUpdate(srcPath, newPath, backupPath, bundleIdentifier, executableName)
  do shell script "NEW=" & quoted form of newPath & "; SRC=" & quoted form of srcPath & "; BAK=" & quoted form of backupPath & "; BID=" & quoted form of bundleIdentifier & "; EXE=" & quoted form of executableName & "; set -e; valid_bundle() { B=\"$1\"; /bin/test ! -L \"$B\" && /bin/test -d \"$B\" && /bin/test ! -L \"$B/Contents\" && /bin/test -d \"$B/Contents\" && /bin/test ! -L \"$B/Contents/Info.plist\" && /bin/test -f \"$B/Contents/Info.plist\" && /bin/test ! -L \"$B/Contents/Resources\" && /bin/test -d \"$B/Contents/Resources\" && /bin/test ! -L \"$B/Contents/MacOS\" && /bin/test -d \"$B/Contents/MacOS\" && /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \"$B/Contents/Info.plist\" 2>/dev/null | /usr/bin/grep -Fqx -- \"$BID\" && /usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' \"$B/Contents/Info.plist\" 2>/dev/null | /usr/bin/grep -Fqx -- \"$EXE\" && /bin/test ! -L \"$B/Contents/MacOS/$EXE\" && /bin/test -f \"$B/Contents/MacOS/$EXE\" && /bin/test -s \"$B/Contents/MacOS/$EXE\" && /bin/test -x \"$B/Contents/MacOS/$EXE\" && /bin/test ! -L \"$B/Contents/MacOS/rosi-yt-dlp\" && /bin/test -f \"$B/Contents/MacOS/rosi-yt-dlp\" && /bin/test -s \"$B/Contents/MacOS/rosi-yt-dlp\" && /bin/test -x \"$B/Contents/MacOS/rosi-yt-dlp\" && /bin/test ! -L \"$B/Contents/MacOS/rosi-ffmpeg\" && /bin/test -f \"$B/Contents/MacOS/rosi-ffmpeg\" && /bin/test -s \"$B/Contents/MacOS/rosi-ffmpeg\" && /bin/test -x \"$B/Contents/MacOS/rosi-ffmpeg\" && /bin/test ! -L \"$B/Contents/MacOS/rosi-ffprobe\" && /bin/test -f \"$B/Contents/MacOS/rosi-ffprobe\" && /bin/test -s \"$B/Contents/MacOS/rosi-ffprobe\" && /bin/test -x \"$B/Contents/MacOS/rosi-ffprobe\"; }; /bin/test -d \"$NEW/Contents\" || exit 1; valid_bundle \"$NEW\" || exit 1; if ! valid_bundle \"$SRC\"; then if valid_bundle \"$BAK\"; then if /bin/test -e \"$SRC\"; then /bin/rm -rf \"$SRC\"; fi; /bin/mv -f \"$BAK\" \"$SRC\" || exit 1; /bin/test -d \"$SRC/Contents\" || exit 1; else exit 1; fi; fi; if /bin/test -e \"$BAK\" && ! valid_bundle \"$BAK\"; then exit 1; fi; if /bin/test -e \"$BAK\"; then /bin/rm -rf \"$BAK\"; fi; /bin/mv -f \"$SRC\" \"$BAK\" || exit 1; valid_bundle \"$BAK\" || { /bin/mv -f \"$BAK\" \"$SRC\"; exit 1; }; if /bin/mv -f \"$NEW\" \"$SRC\" && valid_bundle \"$SRC\"; then if ! /bin/rm -rf \"$BAK\"; then :; fi; exit 0; fi; if /bin/test -e \"$SRC\"; then /bin/rm -rf \"$SRC\"; fi; /bin/mv -f \"$BAK\" \"$SRC\"; exit 1" with administrator privileges
end installUpdate
"#;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MacosBundleIdentity {
    pub bundle_identifier: String,
    pub executable: String,
}

/// Read the identity required to compare live, staged, and recovery bundles.
pub fn macos_app_bundle_identity(path: &Path) -> Option<MacosBundleIdentity> {
    let info = path.join("Contents/Info.plist");
    let metadata = std::fs::symlink_metadata(&info).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    let bundle_identifier = read_plist_string(&info, "CFBundleIdentifier")?;
    let executable = read_plist_string(&info, "CFBundleExecutable")?;
    if !safe_bundle_identifier(&bundle_identifier) || !safe_executable_name(&executable) {
        return None;
    }
    Some(MacosBundleIdentity {
        bundle_identifier,
        executable,
    })
}

fn safe_bundle_identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
}

fn safe_executable_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
}

fn xml_plist_string(contents: &str, key: &str) -> Option<String> {
    let key = format!("<key>{key}</key>");
    let after_key = contents.split_once(&key)?.1;
    let start = after_key.find("<string>")? + "<string>".len();
    let value = &after_key[start..];
    let end = value.find("</string>")?;
    Some(
        value[..end]
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'"),
    )
}

fn read_plist_string(path: &Path, key: &str) -> Option<String> {
    if let Ok(contents) = std::fs::read_to_string(path) {
        if let Some(value) = xml_plist_string(&contents, key) {
            return Some(value);
        }
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/libexec/PlistBuddy")
            .arg("-c")
            .arg(format!("Print :{key}"))
            .arg(path)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Require a readable identity, an executable file, and the required
/// resources tree. Symlinked top-level bundle components are not complete.
pub fn macos_app_bundle_complete(path: &Path) -> bool {
    let Some(identity) = macos_app_bundle_identity(path) else {
        return false;
    };
    let Ok(bundle_metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    let Ok(contents_metadata) = std::fs::symlink_metadata(path.join("Contents")) else {
        return false;
    };
    let Ok(resources_metadata) = std::fs::symlink_metadata(path.join("Contents/Resources")) else {
        return false;
    };
    let macos_path = path.join("Contents/MacOS");
    let Ok(macos_metadata) = std::fs::symlink_metadata(&macos_path) else {
        return false;
    };
    let executable = macos_path.join(identity.executable);
    if bundle_metadata.file_type().is_symlink()
        || !bundle_metadata.is_dir()
        || contents_metadata.file_type().is_symlink()
        || !contents_metadata.is_dir()
        || resources_metadata.file_type().is_symlink()
        || !resources_metadata.is_dir()
        || macos_metadata.file_type().is_symlink()
        || !macos_metadata.is_dir()
        || !macos_bundle_executable_complete(&executable)
    {
        return false;
    }
    ["rosi-yt-dlp", "rosi-ffmpeg", "rosi-ffprobe"]
        .iter()
        .all(|name| macos_bundle_executable_complete(&macos_path.join(name)))
}

fn macos_bundle_executable_complete(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
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

/// App- and install-scoped sibling backup, on the same volume as the live `.app`.
pub fn macos_update_backup_path(extract_path: &Path) -> Option<PathBuf> {
    let parent = extract_path.parent()?;
    let app_name = extract_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("app")
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let hash = extract_path
        .as_os_str()
        .to_string_lossy()
        .bytes()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        });
    Some(parent.join(format!(".{app_name}.rosi-update-backup-{hash:016x}")))
}

/// Serialize all in-process macOS bundle swaps and their recovery steps.
pub fn with_macos_update_install_lock<T>(operation: impl FnOnce() -> T) -> T {
    static INSTALL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = INSTALL_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    operation()
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

/// Move a directory onto an absent `dst`. On EXDEV, copy into a unique sibling
/// staging directory, then rename. Existing staging data is never removed.
pub fn move_dir_replacing(src: &Path, dst: &Path) -> std::io::Result<()> {
    if dst.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "updater destination must be absent before replacement",
        ));
    }
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(err) if is_cross_device(&err) => {
            if let Some(parent) = dst.parent() {
                let staging = tempfile::Builder::new()
                    .prefix(".rosi-update-staging-")
                    .tempdir_in(parent)?;
                copy_dir_all(src, staging.path())?;
                std::fs::rename(staging.path(), dst)?;
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

    #[cfg(unix)]
    fn write_round2_complete_app_bundle(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        let macos = path.join("Contents/MacOS");
        std::fs::create_dir_all(path.join("Contents/Resources")).unwrap();
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::write(
            path.join("Contents/Info.plist"),
            "<plist><dict><key>CFBundleIdentifier</key><string>run.rosie.rosi</string><key>CFBundleExecutable</key><string>rosi</string></dict></plist>",
        )
        .unwrap();
        for name in ["rosi", "rosi-yt-dlp", "rosi-ffmpeg", "rosi-ffprobe"] {
            let binary = macos.join(name);
            std::fs::write(&binary, b"round2 sidecar fixture").unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn round2_macos_bundle_requires_all_three_executable_sidecars() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let bundle = temp.path().join("ROSI.app");
        write_round2_complete_app_bundle(&bundle);
        assert!(macos_app_bundle_complete(&bundle));

        for name in ["rosi-yt-dlp", "rosi-ffmpeg", "rosi-ffprobe"] {
            let sidecar = bundle.join("Contents/MacOS").join(name);
            std::fs::remove_file(&sidecar).unwrap();
            assert!(
                !macos_app_bundle_complete(&bundle),
                "bundle missing {name} must be incomplete"
            );
            std::fs::write(&sidecar, b"round2 sidecar fixture").unwrap();
            std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let ffprobe = bundle.join("Contents/MacOS/rosi-ffprobe");
        std::fs::set_permissions(&ffprobe, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            !macos_app_bundle_complete(&bundle),
            "non-executable sidecar must be incomplete"
        );
    }

    #[test]
    fn round2_privileged_validator_checks_all_critical_sidecars() {
        for name in ["rosi-yt-dlp", "rosi-ffmpeg", "rosi-ffprobe"] {
            for condition in ["! -L", "-f", "-s", "-x"] {
                assert!(
                    MACOS_PRIVILEGED_INSTALL_SCRIPT.contains(&format!(
                        "/bin/test {condition} \\\"$B/Contents/MacOS/{name}\\\""
                    )),
                    "privileged validator must require {condition} for {name}"
                );
            }
        }
    }

    #[test]
    fn macos_script_quotes_handler_args_and_restores_backup() {
        assert!(MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("quoted form of"));
        assert!(MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("backupPath"));
        assert!(MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("/bin/test -d \\\"$NEW/Contents\\\""));
        assert!(MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("/bin/test -d \\\"$SRC/Contents\\\""));
        for component in [
            "$B",
            "$B/Contents",
            "$B/Contents/Info.plist",
            "$B/Contents/Resources",
            "$B/Contents/MacOS",
            "$B/Contents/MacOS/$EXE",
        ] {
            assert!(
                MACOS_PRIVILEGED_INSTALL_SCRIPT
                    .contains(&format!("/bin/test ! -L \\\"{component}\\\"")),
                "privileged validation must reject symlinked bundle component {component}"
            );
        }
        assert!(
            MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("/bin/test -s \\\"$B/Contents/MacOS/$EXE\\\"")
        );
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
    fn backup_path_is_scoped_to_the_app_and_installation() {
        let first_app = Path::new("/Applications/ROSI.app");
        let other_app = Path::new("/Applications/Helper.app");
        let second_install = Path::new("/Volumes/Applications/ROSI.app");
        let first_backup = macos_update_backup_path(first_app).unwrap();

        assert_eq!(first_backup.parent(), first_app.parent());
        assert_ne!(first_backup, macos_update_backup_path(other_app).unwrap());
        assert_ne!(
            first_backup,
            macos_update_backup_path(second_install).unwrap()
        );
        assert!(first_backup
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("ROSI"));
    }

    struct TestDirectory(PathBuf);

    fn super_test_id() -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("{}-{nanos}", std::process::id())
    }

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("tauri-updater-install-safety-{}", super_test_id()));
            std::fs::create_dir(&path).expect("create isolated updater directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_test_bundle(path: &Path, bundle_id: &str, executable: &str) {
        let contents = path.join("Contents");
        let macos = contents.join("MacOS");
        std::fs::create_dir_all(&macos).expect("create bundle executable directory");
        std::fs::create_dir_all(contents.join("Resources")).expect("create bundle resources");
        std::fs::write(
            contents.join("Info.plist"),
            format!(
                "<plist><dict><key>CFBundleIdentifier</key><string>{bundle_id}</string><key>CFBundleExecutable</key><string>{executable}</string></dict></plist>"
            ),
        )
        .expect("write bundle identity");
        let executable_path = macos.join(executable);
        std::fs::write(&executable_path, b"test executable").expect("write bundle executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable_path, std::fs::Permissions::from_mode(0o755))
                .expect("mark bundle executable");
        }
        for name in ["rosi-yt-dlp", "rosi-ffmpeg", "rosi-ffprobe"] {
            let sidecar = macos.join(name);
            std::fs::write(&sidecar, b"test sidecar").expect("write required bundle sidecar");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o755))
                    .expect("mark required bundle sidecar executable");
            }
        }
    }

    #[test]
    fn complete_bundle_requires_identity_executable_and_resources() {
        let directory = TestDirectory::new();
        let complete = directory.0.join("ROSI.app");
        write_test_bundle(&complete, "run.rosie.rosi", "ROSI");
        assert!(macos_app_bundle_complete(&complete));
        assert_eq!(
            macos_app_bundle_identity(&complete),
            Some(MacosBundleIdentity {
                bundle_identifier: "run.rosie.rosi".into(),
                executable: "ROSI".into(),
            })
        );

        let partial = directory.0.join("Partial.app");
        std::fs::create_dir_all(partial.join("Contents")).expect("create partial Contents");
        assert!(!macos_app_bundle_complete(&partial));

        let missing_executable = directory.0.join("MissingExecutable.app");
        write_test_bundle(&missing_executable, "run.rosie.rosi", "ROSI");
        std::fs::remove_file(missing_executable.join("Contents/MacOS/ROSI"))
            .expect("remove expected executable");
        assert!(!macos_app_bundle_complete(&missing_executable));

        let empty_executable = directory.0.join("EmptyExecutable.app");
        write_test_bundle(&empty_executable, "run.rosie.rosi", "ROSI");
        std::fs::write(empty_executable.join("Contents/MacOS/ROSI"), b"")
            .expect("truncate expected executable");
        assert!(!macos_app_bundle_complete(&empty_executable));

        #[cfg(unix)]
        {
            let symlinked_macos = directory.0.join("SymlinkedMacos.app");
            write_test_bundle(&symlinked_macos, "run.rosie.rosi", "ROSI");
            let external_macos = directory.0.join("external-macos");
            std::fs::create_dir(&external_macos).expect("create external MacOS directory");
            std::fs::copy(
                symlinked_macos.join("Contents/MacOS/ROSI"),
                external_macos.join("ROSI"),
            )
            .expect("copy external executable");
            std::fs::remove_dir_all(symlinked_macos.join("Contents/MacOS"))
                .expect("remove original MacOS directory");
            std::os::unix::fs::symlink(&external_macos, symlinked_macos.join("Contents/MacOS"))
                .expect("replace MacOS directory with symlink");
            assert!(!macos_app_bundle_complete(&symlinked_macos));
        }

        let different_identity = directory.0.join("Other.app");
        write_test_bundle(&different_identity, "run.example.other", "Other");
        assert_ne!(
            macos_app_bundle_identity(&complete),
            macos_app_bundle_identity(&different_identity)
        );
    }

    #[test]
    fn install_lock_serializes_bundle_replacement_work() {
        let active = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let maximum = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let first_active = std::sync::Arc::clone(&active);
        let first_maximum = std::sync::Arc::clone(&maximum);
        let first = std::thread::spawn(move || {
            with_macos_update_install_lock(|| {
                let now = first_active.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                first_maximum.fetch_max(now, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(30));
                first_active.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            });
        });
        let second_active = std::sync::Arc::clone(&active);
        let second_maximum = std::sync::Arc::clone(&maximum);
        let second = std::thread::spawn(move || {
            with_macos_update_install_lock(|| {
                let now = second_active.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                second_maximum.fetch_max(now, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(30));
                second_active.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            });
        });
        first.join().expect("first install operation completes");
        second.join().expect("second install operation completes");
        assert_eq!(maximum.load(std::sync::atomic::Ordering::SeqCst), 1);
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
