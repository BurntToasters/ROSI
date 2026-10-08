//! Scratch-entry hygiene for the download folder. A crash, force quit or
//! reboot can leave ROSI staging entries behind. Startup sweeps stale ones
//! without following symlinks, and Windows hides new entries.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_BOOKKEEPING_BYTES: u64 = 64 * 1024;
const RECOVERY_ATTEMPTS: u32 = 100;
const MAX_SWEEP_FOLDERS: usize = 32;
const STAGING_PREFIXES: [&str; 5] = [
    ".rosi-download-",
    ".rosi-convert-",
    ".rosi-retire-",
    ".rosi-source-retire-",
    ".rosi-caption-publish-",
];

/// Sweep stale staging entries from the configured download folder. Runs on a
/// background thread at startup; a session that is already running is skipped.
pub fn sweep_orphans_on_startup() {
    for folder in sweep_folders() {
        if let Err(error) = sweep_download_folder(&folder) {
            crate::logging::warn(&format!(
                "Could not sweep staging entries in {}: {error}",
                folder.display()
            ));
        }
    }
}

/// The default folder plus folders that recorded activity and queued requests
/// point at. Each must still pass download-path validation; duplicates are
/// dropped and the list is capped so startup work stays bounded.
fn sweep_folders() -> Vec<PathBuf> {
    let recorded = crate::activity::recorded_output_folders()
        .into_iter()
        .chain(crate::queue::queued_output_folders());
    let mut folders = vec![configured_download_folder()];
    let mut seen: HashSet<PathBuf> = folders.iter().cloned().collect();
    for folder in recorded {
        if folders.len() >= MAX_SWEEP_FOLDERS {
            break;
        }
        let Some(text) = folder.to_str() else {
            continue;
        };
        let Ok(valid) = crate::validation::validate_download_path(text) else {
            continue;
        };
        if valid.is_empty() {
            continue;
        }
        let valid = PathBuf::from(valid);
        if seen.insert(valid.clone()) {
            folders.push(valid);
        }
    }
    folders
}

fn configured_download_folder() -> PathBuf {
    let configured = crate::settings::load().download_folder;
    let configured = configured.trim();
    if configured.is_empty() {
        crate::app_state::downloads_dir()
    } else {
        PathBuf::from(configured)
    }
}

fn sweep_download_folder(folder: &Path) -> std::io::Result<()> {
    let now = SystemTime::now();
    for entry in std::fs::read_dir(folder)?.flatten() {
        if crate::downloader::is_busy() {
            return Ok(());
        }
        let path = entry.path();
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        // symlink_metadata never follows links, so a link is neither swept
        // nor traversed.
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !is_stale(&metadata, now) {
            continue;
        }
        if metadata.is_dir() && is_staging_dir_name(&name) {
            sweep_staging_dir(folder, &path);
        } else if metadata.is_file() && is_bookkeeping_name(&name) {
            remove_bookkeeping_file(&path, &metadata);
        } else if metadata.is_file()
            && metadata.len() == 0
            && name.strip_prefix(".rosi-probe-").is_some_and(is_uuid_like)
        {
            // An empty rename-flag probe left by an interrupted install.
            remove_bookkeeping_file(&path, &metadata);
        } else if metadata.is_file()
            && name.starts_with(".rosi-caption-publish-")
            && is_staging_dir_name(&name)
        {
            // A caption sidecar moved aside before publication; keep it.
            if let Err(error) = recover_file(folder, &path) {
                crate::logging::warn(&format!(
                    "Retaining staged caption {}: {error}",
                    path.display()
                ));
            }
        }
    }
    Ok(())
}

fn is_stale(metadata: &std::fs::Metadata, now: SystemTime) -> bool {
    metadata
        .modified()
        .ok()
        .and_then(|modified| now.duration_since(modified).ok())
        .is_some_and(|age| age >= STALE_AFTER)
}

/// True for `<prefix><uuid>` names, so user folders that merely look similar
/// are not matched.
fn is_staging_dir_name(name: &str) -> bool {
    STAGING_PREFIXES
        .iter()
        .any(|prefix| name.strip_prefix(prefix).is_some_and(is_uuid_like))
}

/// True for `.rosi-path-<session>-<uuid>.txt` metadata files.
fn is_bookkeeping_name(name: &str) -> bool {
    name.strip_prefix(".rosi-path-")
        .and_then(|rest| rest.strip_suffix(".txt"))
        .is_some_and(|middle| {
            middle.split_once('-').is_some_and(|(session, uuid)| {
                !session.is_empty()
                    && session.bytes().all(|byte| byte.is_ascii_digit())
                    && is_uuid_like(uuid)
            })
        })
}

/// True for yt-dlp files that are never the user's output: `.part`, `.ytdl`
/// control files, `.part-Frag<N>` fragments and `.temp.<ext>` postprocessor
/// output. Format streams are handled by `format_stream_stem`.
fn is_ytdlp_intermediate(name: &str) -> bool {
    if name.ends_with(".part") || name.ends_with(".ytdl") {
        return true;
    }
    if let Some((_, fragment)) = name.rsplit_once(".part-Frag") {
        return !fragment.is_empty() && fragment.bytes().all(|byte| byte.is_ascii_digit());
    }
    let Some((stem, _extension)) = name.rsplit_once('.') else {
        return false;
    };
    stem.len() > ".temp".len() && stem.ends_with(".temp")
}

/// The merged-output stem of a `<stem>.f<digits>.<ext>` format stream.
fn format_stream_stem(name: &str) -> Option<&str> {
    let (stem, _extension) = name.rsplit_once('.')?;
    let (base, last) = stem.rsplit_once('.')?;
    (!base.is_empty()
        && last.len() > 1
        && last.starts_with('f')
        && last[1..].bytes().all(|byte| byte.is_ascii_digit()))
    .then_some(base)
}

/// Stems of complete merged files in a staging directory. A format stream is
/// redundant only when its merged output survived beside it.
fn merged_output_stems(directory: &Path) -> HashSet<String> {
    let Ok(children) = std::fs::read_dir(directory) else {
        return HashSet::new();
    };
    children
        .flatten()
        .filter(|child| {
            std::fs::symlink_metadata(child.path())
                .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
        })
        .filter_map(|child| {
            let name = child.file_name().to_string_lossy().into_owned();
            if is_ytdlp_intermediate(&name) || format_stream_stem(&name).is_some() {
                return None;
            }
            name.rsplit_once('.').map(|(stem, _)| stem.to_string())
        })
        .collect()
}

fn is_uuid_like(text: &str) -> bool {
    text.len() == 36
        && text
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

/// Removes yt-dlp intermediates and empty files, and moves other regular
/// files into the download folder under a fresh name. Subdirectories and
/// symlinks are never traversed; a staging directory is removed only when
/// empty.
fn sweep_staging_dir(folder: &Path, directory: &Path) {
    let children = match std::fs::read_dir(directory) {
        Ok(children) => children,
        Err(error) => {
            crate::logging::warn(&format!(
                "Could not read staging leftover {}: {error}",
                directory.display()
            ));
            return;
        }
    };
    let merged = merged_output_stems(directory);
    let mut retained = false;
    for child in children.flatten() {
        let path = child.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            retained = true;
            continue;
        };
        if !metadata.is_file() {
            crate::logging::warn(&format!(
                "Retaining nested entry in staging leftover: {}",
                path.display()
            ));
            retained = true;
            continue;
        }
        let name = child.file_name().to_string_lossy().into_owned();
        let redundant_stream = format_stream_stem(&name).is_some_and(|stem| merged.contains(stem));
        if is_ytdlp_intermediate(&name) || redundant_stream || metadata.len() == 0 {
            if let Err(error) = std::fs::remove_file(&path) {
                crate::logging::warn(&format!(
                    "Could not remove staging leftover {}: {error}",
                    path.display()
                ));
                retained = true;
            }
            continue;
        }
        match recover_file(folder, &path) {
            Ok(destination) => crate::logging::info(&format!(
                "Recovered staged file from an interrupted session to {}",
                destination.display()
            )),
            Err(error) => {
                crate::logging::warn(&format!(
                    "Retaining staged file {}: {error}",
                    path.display()
                ));
                retained = true;
            }
        }
    }
    if retained {
        return;
    }
    match std::fs::remove_dir(directory) {
        Ok(()) => crate::logging::info(&format!(
            "Removed stale staging directory {}",
            directory.display()
        )),
        Err(error) => crate::logging::warn(&format!(
            "Retaining staging directory {}: {error}",
            directory.display()
        )),
    }
}

/// Moves a recovered file beside the download folder's other files. The
/// no-replace install never overwrites an existing user file.
fn recover_file(folder: &Path, path: &Path) -> Result<PathBuf, String> {
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());
    let extension = path
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
        .unwrap_or_default();
    for attempt in 0..RECOVERY_ATTEMPTS {
        let label = if attempt == 0 {
            " (recovered)".to_string()
        } else {
            format!(" (recovered {})", attempt + 1)
        };
        let destination = folder.join(format!("{stem}{label}{extension}"));
        match install_no_replace(path, &destination) {
            Ok(()) => return Ok(destination),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("no free recovery name".to_string())
}

fn remove_bookkeeping_file(path: &Path, metadata: &std::fs::Metadata) {
    if metadata.len() > MAX_BOOKKEEPING_BYTES {
        crate::logging::warn(&format!(
            "Retaining oversized staging metadata {}",
            path.display()
        ));
        return;
    }
    match std::fs::remove_file(path) {
        Ok(()) => crate::logging::info(&format!(
            "Removed stale staging metadata {}",
            path.display()
        )),
        Err(error) => crate::logging::warn(&format!(
            "Could not remove staging metadata {}: {error}",
            path.display()
        )),
    }
}

pub(crate) struct DownloadStage {
    pub(crate) directory: PathBuf,
    pub(crate) preserve_on_drop: bool,
    pub(crate) root_identity: FileIdentity,
    pub(crate) owned_entries: Option<HashMap<PathBuf, FileIdentity>>,
}

impl Drop for DownloadStage {
    fn drop(&mut self) {
        if self.preserve_on_drop {
            crate::logging::warn(&format!(
                "Retaining staged original files for recovery in {}",
                self.directory.display()
            ));
            return;
        }

        let Some(expected_entries) = self.owned_entries.as_ref() else {
            crate::logging::warn(&format!(
                "Retaining download staging without a complete ownership snapshot: {}",
                self.directory.display()
            ));
            return;
        };
        let Some(parent) = self.directory.parent() else {
            crate::logging::warn("Retaining download staging because its parent is unavailable.");
            return;
        };
        for _ in 0..32 {
            let quarantine = parent.join(format!(".rosi-retire-{}", crate::fs_util::uuid_v4()));
            match install_no_replace(&self.directory, &quarantine) {
                Ok(()) => {
                    let verified = file_identity(&quarantine) == Some(self.root_identity)
                        && stage_entries_match(&quarantine, expected_entries);
                    if verified {
                        if let Err(error) = std::fs::remove_dir_all(&quarantine) {
                            crate::logging::warn(&format!(
                                "Could not remove verified download staging {}: {error}",
                                quarantine.display()
                            ));
                        }
                    } else if install_no_replace(&quarantine, &self.directory).is_err() {
                        crate::logging::warn(&format!(
                            "Retaining changed download staging at {} because its original path was claimed.",
                            quarantine.display()
                        ));
                    } else {
                        crate::logging::warn(&format!(
                            "Retaining changed download staging at {} after ownership verification failed.",
                            self.directory.display()
                        ));
                    }
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                Err(error) => {
                    crate::logging::warn(&format!(
                        "Could not quarantine owned download staging {}: {error}",
                        self.directory.display()
                    ));
                    return;
                }
            }
        }
        crate::logging::warn(&format!(
            "Could not reserve a retirement name for download staging {}; retaining it.",
            self.directory.display()
        ));
    }
}

impl DownloadStage {
    pub(crate) fn snapshot_owned_contents(&mut self) -> Result<(), String> {
        match snapshot_stage_entries(&self.directory) {
            Ok(entries) => {
                self.owned_entries = Some(entries);
                Ok(())
            }
            Err(error) => {
                self.preserve_on_drop = true;
                Err(error)
            }
        }
    }

    pub(crate) fn identity_for(&self, path: &Path) -> Option<FileIdentity> {
        let relative = path.strip_prefix(&self.directory).ok()?;
        self.owned_entries.as_ref()?.get(relative).copied()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct FileIdentity {
    #[cfg(unix)]
    pub(crate) device: u64,
    #[cfg(unix)]
    pub(crate) inode: u64,
    #[cfg(windows)]
    pub(crate) volume: u32,
    #[cfg(windows)]
    pub(crate) index: u64,
}

pub(crate) fn file_identity(path: &Path) -> Option<FileIdentity> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() && !metadata.is_dir() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use std::ptr::{null, null_mut};
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        };

        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        let read = unsafe { GetFileInformationByHandle(handle, &mut information) } != 0;
        unsafe {
            CloseHandle(handle);
        }
        read.then_some(FileIdentity {
            volume: information.dwVolumeSerialNumber,
            index: (u64::from(information.nFileIndexHigh) << 32)
                | u64::from(information.nFileIndexLow),
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = metadata;
        None
    }
}

pub(crate) fn snapshot_stage_entries(
    root: &Path,
) -> Result<HashMap<PathBuf, FileIdentity>, String> {
    let mut entries = HashMap::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            let identity = file_identity(&path)
                .ok_or_else(|| format!("Could not verify staged entry {}", path.display()))?;
            let relative = path
                .strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_path_buf();
            entries.insert(relative, identity);
            if metadata.is_dir() {
                pending.push(path);
            }
        }
    }
    Ok(entries)
}

pub(crate) fn stage_entries_match(root: &Path, expected: &HashMap<PathBuf, FileIdentity>) -> bool {
    snapshot_stage_entries(root).is_ok_and(|current| {
        current
            .iter()
            .all(|(path, identity)| expected.get(path) == Some(identity))
    })
}

pub(crate) fn reserve_download_stage(download_dir: &Path) -> Result<DownloadStage, String> {
    for _ in 0..32 {
        let directory = download_dir.join(format!(".rosi-download-{}", crate::fs_util::uuid_v4()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&directory) {
            Ok(()) => {
                crate::staging::hide_on_windows(&directory);
                let Some(root_identity) = file_identity(&directory) else {
                    return Err(format!(
                        "Could not verify the reserved staging directory {}; it was retained.",
                        directory.display()
                    ));
                };
                return Ok(DownloadStage {
                    directory,
                    preserve_on_drop: false,
                    root_identity,
                    owned_entries: Some(HashMap::new()),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not reserve a private download staging directory.".to_string())
}

pub(crate) fn reserve_path_output_file(
    download_dir: &Path,
    session_id: u64,
) -> Result<PathBuf, String> {
    for _ in 0..32 {
        let path = download_dir.join(format!(
            ".rosi-path-{session_id}-{}.txt",
            crate::fs_util::uuid_v4()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => {
                drop(file);
                crate::staging::hide_on_windows(&path);
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not reserve a unique yt-dlp path metadata file.".to_string())
}

pub(crate) fn sync_staged_file(path: &Path) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true);
    options.open(path)?.sync_all()
}

#[cfg(unix)]
pub(crate) fn path_cstring(path: &Path) -> std::io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error.to_string()))
}

/// Move a complete staging file into place atomically without replacing an
/// existing destination. The staging directory is beside the source, keeping
/// this operation on the same volume even for removable filesystems.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn install_no_replace(temp: &Path, destination: &Path) -> std::io::Result<()> {
    match flagged_rename(temp, destination) {
        Ok(()) => Ok(()),
        Err(error) if flag_unsupported(&error, destination) => {
            install_without_flags(temp, destination)
        }
        Err(error) => Err(error),
    }
}

/// One rename that fails instead of replacing an existing destination.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn flagged_rename(from: &Path, to: &Path) -> std::io::Result<()> {
    let from_path = path_cstring(from)?;
    let to_path = path_cstring(to)?;
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from_path.as_ptr(),
            libc::AT_FDCWD,
            to_path.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    let result =
        unsafe { libc::renamex_np(from_path.as_ptr(), to_path.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// True when the no-replace flag itself is unsupported. ENOTSUP, EOPNOTSUPP
/// and ENOSYS mean that on their own. EINVAL is also returned for unrelated
/// rename errors, so it counts only when a probe rename shows the flag fails.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn flag_unsupported(error: &std::io::Error, destination: &Path) -> bool {
    match error.raw_os_error() {
        Some(libc::ENOTSUP) | Some(libc::EOPNOTSUPP) | Some(libc::ENOSYS) => true,
        Some(libc::EINVAL) => destination.parent().is_some_and(flag_rejected_by_probe),
        _ => false,
    }
}

/// Renames an empty probe file within the destination folder using the same
/// flag. Returns true only when that flagged rename fails with a
/// flag-unsupported error. The probe is removed on every path.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn flag_rejected_by_probe(folder: &Path) -> bool {
    let Some(source) = create_probe_file(folder) else {
        return false;
    };
    let target = folder.join(format!(".rosi-probe-{}", crate::fs_util::uuid_v4()));
    let result = flagged_rename(&source, &target);
    // The source is gone after a successful rename, so NotFound is expected.
    if let Err(error) = std::fs::remove_file(&source) {
        if error.kind() != std::io::ErrorKind::NotFound {
            crate::logging::warn(&format!(
                "Could not remove rename probe {}: {error}",
                source.display()
            ));
        }
    }
    match result {
        Ok(()) => {
            if let Err(error) = std::fs::remove_file(&target) {
                crate::logging::warn(&format!(
                    "Could not remove rename probe {}: {error}",
                    target.display()
                ));
            }
            false
        }
        Err(error) => matches!(
            error.raw_os_error(),
            Some(libc::EINVAL) | Some(libc::ENOTSUP) | Some(libc::EOPNOTSUPP) | Some(libc::ENOSYS)
        ),
    }
}

/// Creates an empty, exclusively named probe file. Returns None when no name
/// is free after a few tries, or when the folder cannot be written.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn create_probe_file(folder: &Path) -> Option<PathBuf> {
    for _ in 0..8 {
        let path = folder.join(format!(".rosi-probe-{}", crate::fs_util::uuid_v4()));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(_) => return Some(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

/// Flag-free no-replace install. The destination name is reserved exclusively
/// first (`create_dir` for directories, `create_new` for files), then the
/// source renames over that empty placeholder. Any user content that appears
/// at the destination makes the rename fail instead of being replaced.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn install_without_flags(temp: &Path, destination: &Path) -> std::io::Result<()> {
    let is_dir = std::fs::symlink_metadata(temp)?.is_dir();
    if is_dir {
        std::fs::create_dir(destination)?;
    } else {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
    }
    let result = std::fs::rename(temp, destination);
    if result.is_err() {
        // Remove the reservation only while it is still empty, so a
        // placeholder that gained content is never deleted.
        let still_empty = if is_dir {
            std::fs::read_dir(destination).is_ok_and(|mut entries| entries.next().is_none())
        } else {
            std::fs::metadata(destination).is_ok_and(|metadata| metadata.len() == 0)
        };
        if still_empty {
            let _ = if is_dir {
                std::fs::remove_dir(destination)
            } else {
                std::fs::remove_file(destination)
            };
        }
    }
    result
}

#[cfg(windows)]
pub(crate) fn install_no_replace(temp: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    // `std::fs::rename` replaces an existing destination on Windows. Use the
    // Win32 move primitive without MOVEFILE_REPLACE_EXISTING so an output
    // collision fails atomically instead of overwriting a user's file.
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    let temp: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result =
        unsafe { MoveFileExW(temp.as_ptr(), destination.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if result != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn install_no_replace(temp: &Path, destination: &Path) -> std::io::Result<()> {
    // Hard-link installation is also an atomic no-replace operation. Some
    // filesystems do not support it; in that case conversion fails safely.
    std::fs::hard_link(temp, destination)
}

/// Marks a new ROSI scratch entry hidden on Windows, where dot-prefixed names
/// are not hidden. Failure is ignored because the entry works either way.
pub fn hide_on_windows(path: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, INVALID_FILE_ATTRIBUTES,
        };
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: `wide` is a NUL-terminated buffer that lives for both calls.
        unsafe {
            let current = GetFileAttributesW(wide.as_ptr());
            if current != INVALID_FILE_ATTRIBUTES {
                SetFileAttributesW(wide.as_ptr(), current | FILE_ATTRIBUTE_HIDDEN);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = path;
}
