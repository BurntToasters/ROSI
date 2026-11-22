//! Atomic, private file writes and bounded reads for persisted JSON state.

use crate::constants::CURRENT_PERSISTED_SCHEMA_VERSION;
use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    if getrandom::fill(&mut buffer).is_err() {
        // Fall back to time-derived entropy; names only need to be unique.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        for (index, byte) in buffer.iter_mut().enumerate() {
            *byte = (nanos >> ((index % 16) * 8)) as u8 ^ (index as u8).wrapping_mul(31);
        }
    }
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Directory builder that creates owner-only (0700) directories on Unix.
pub fn private_dir_builder() -> std::fs::DirBuilder {
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
}

/// RFC 4122 version 4 UUID string.
pub fn uuid_v4() -> String {
    let hex = random_hex(16);
    let mut chars: Vec<char> = hex.chars().collect();
    chars[12] = '4';
    let variant = u8::from_str_radix(&hex[16..17], 16).unwrap_or(0);
    chars[16] = char::from_digit(((variant & 0x3) | 0x8) as u32, 16).unwrap_or('8');
    let s: String = chars.into_iter().collect();
    format!(
        "{}-{}-{}-{}-{}",
        &s[0..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..32]
    )
}

/// Write `contents` to a private sibling temp file, fsync it, then rename it
/// over `path` so readers never observe a partially written file.
pub fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid file name".to_string())?;
    let temp = parent.join(format!(".{file_name}.{}.tmp", random_hex(8)));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temp).map_err(|error| error.to_string())?;
        file.write_all(contents)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        rename_replacing(&temp, path)?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// `rename` that replaces `to`. On Windows, antivirus and the search indexer
/// briefly open freshly written files, so replacing one can fail with
/// "access denied" / "sharing violation" for a few milliseconds; retry those.
pub fn rename_replacing(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let result = retry_transient_lock(|| windows_rename_replacing(from, to));
    #[cfg(not(windows))]
    let result = std::fs::rename(from, to);
    result.map_err(|error| error.to_string())
}

/// True for the Windows errors a scanner or indexer causes by briefly holding
/// a file: 5 (access denied), 32 (sharing violation), 33 (lock violation).
/// 80 (file exists) and 183 (already exists) are never listed, so a no-replace
/// collision is never retried.
#[cfg(windows)]
fn is_transient_lock_error(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

/// Runs `operation`, retrying transient lock errors up to 10 times with a
/// growing pause (about 1.4 s in total). Other errors return at once.
#[cfg(windows)]
pub(crate) fn retry_transient_lock<T>(
    mut operation: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<T> {
    let mut attempt = 0;
    loop {
        match operation() {
            Err(error) if attempt < 10 && is_transient_lock_error(&error) => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(25 * attempt));
            }
            other => return other,
        }
    }
}

/// Flush a directory entry after a completed atomic rename. Windows uses the
/// `MOVEFILE_WRITE_THROUGH` rename flag because Rust does not expose a portable
/// directory handle flush there.
pub fn sync_directory(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::fs::File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|error| error.to_string())
    }
    #[cfg(windows)]
    {
        let _ = directory;
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = directory;
        Ok(())
    }
}

#[cfg(windows)]
fn windows_rename_replacing(from: &Path, to: &Path) -> std::io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    windows_move_file(from, to, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)
}

/// One `MoveFileExW` call with caller-chosen `flags`. Both paths go through
/// `win32_path`, so long paths work. The caller owns the flag meaning and the
/// error mapping; this returns the raw `last_os_error` on failure.
#[cfg(windows)]
pub(crate) fn windows_move_file(from: &Path, to: &Path, flags: u32) -> std::io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let from = win32_path(from);
    let to = win32_path(to);
    // SAFETY: both buffers are NUL-terminated and live across the call.
    let result = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) };
    if result != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// NUL-terminated UTF-16 path for a raw Win32 call. The binary has no
/// long-path manifest, so Win32 limits a plain path to MAX_PATH, and directory
/// creation to 12 fewer. A path at or over 248 units becomes verbatim (`\\?\`,
/// or `\\?\UNC\` for a share), which lifts the limit. Shorter and relative paths are passed through unchanged.
#[cfg(windows)]
pub(crate) fn win32_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    // Directory creation fails at MAX_PATH minus 12 (248), so use that bound.
    const MAX_PATH_UNITS: usize = 248;
    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }
    let plain: Vec<u16> = path.as_os_str().encode_wide().collect();
    let verbatim = units(r"\\?\");
    let device = units(r"\\.\");
    let unc_prefix = units(r"\\");
    let is_absolute_drive = plain.len() >= 3
        && plain[0] < 128
        && (plain[0] as u8).is_ascii_alphabetic()
        && plain[1] == u16::from(b':')
        && (plain[2] == u16::from(b'\\') || plain[2] == u16::from(b'/'));
    let mut result = if plain.len() < MAX_PATH_UNITS
        || plain.starts_with(&verbatim)
        || plain.starts_with(&device)
    {
        plain
    } else {
        // Verbatim paths take no forward slashes and no `.` or `..` parts.
        // Paths reaching here come from `resolve_path`, which removes those.
        let normalized: Vec<u16> = plain
            .iter()
            .map(|&unit| {
                if unit == u16::from(b'/') {
                    u16::from(b'\\')
                } else {
                    unit
                }
            })
            .collect();
        if normalized.starts_with(&unc_prefix) {
            let mut share = units(r"\\?\UNC\");
            share.extend_from_slice(&normalized[2..]);
            share
        } else if is_absolute_drive {
            let mut drive = verbatim.clone();
            drive.extend_from_slice(&normalized);
            drive
        } else {
            normalized
        }
    };
    result.push(0);
    result
}

pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let serialized = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    atomic_write(path, &serialized)
}

/// Read the raw bytes of a file of at most `max_bytes`. Missing files return
/// `Ok(None)`.
pub fn read_bounded_bytes(path: &Path, max_bytes: u64) -> Result<Option<Vec<u8>>, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "{} is {} bytes (max {max_bytes})",
            path.display(),
            metadata.len()
        ));
    }
    let mut contents = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(max_bytes + 1).read_to_end(&mut contents))
        .map_err(|error| error.to_string())?;
    Ok(Some(contents))
}

/// Read a UTF-8 file of at most `max_bytes`. Missing files return `Ok(None)`.
pub fn read_bounded(path: &Path, max_bytes: u64) -> Result<Option<String>, String> {
    match read_bounded_bytes(path, max_bytes)? {
        Some(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|error| format!("{} is not valid UTF-8: {error}", path.display())),
        None => Ok(None),
    }
}

pub fn read_json(path: &Path, max_bytes: u64) -> Option<serde_json::Value> {
    match read_bounded(path, max_bytes) {
        Ok(Some(raw)) => match serde_json::from_str(&raw) {
            Ok(value) => Some(value),
            Err(error) => {
                crate::logging::warn(&format!("Could not parse {}: {error}", path.display()));
                None
            }
        },
        Ok(None) => None,
        Err(error) => {
            crate::logging::warn(&format!("Could not read {}: {error}", path.display()));
            None
        }
    }
}

pub fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
}

/// Recovery copy name for damaged bytes: `<stem>.recovery-<uuid>.json`.
fn recovery_copy_path(path: &Path) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("data");
    path.with_file_name(format!("{stem}.recovery-{}.json", uuid_v4()))
}

/// Copy the bytes of `path` to a new recovery file and return its path. The
/// original file is left as it is.
fn write_recovery_copy(path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let recovery = recovery_copy_path(path);
    atomic_write(&recovery, bytes)?;
    Ok(recovery)
}

/// Copy the file at `path` to a recovery file before a load discards records
/// that the next save would erase. The original file is not changed.
pub fn copy_to_recovery(path: &Path, max_bytes: u64) -> Result<PathBuf, String> {
    let bytes = read_bounded_bytes(path, max_bytes)?
        .ok_or_else(|| format!("{} disappeared", path.display()))?;
    write_recovery_copy(path, &bytes)
}

/// Run before a save replaces the persisted JSON file at `path`. A missing
/// file passes. An unreadable or oversized file refuses the write, and so does
/// a file that `check_schema` rejects. Bytes that are damaged (not UTF-8 or not
/// JSON) or have the wrong shape are copied to a recovery file first, so a save
/// never discards them.
pub fn guard_before_replace(
    path: &Path,
    max_bytes: u64,
    has_expected_shape: fn(&Value) -> bool,
    check_schema: impl FnOnce(&Value) -> Result<(), String>,
) -> Result<(), String> {
    let Some(bytes) = read_bounded_bytes(path, max_bytes)? else {
        return Ok(());
    };
    let parsed = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    match parsed {
        // A file that declares a schema version is checked before its shape,
        // so a newer file is refused whatever it looks like.
        Some(value) if value.get("schemaVersion").is_some() => {
            check_schema(&value)?;
            if has_expected_shape(&value) {
                return Ok(());
            }
            preserve_damaged(path, &bytes)
        }
        Some(value) if has_expected_shape(&value) => check_schema(&value),
        _ => preserve_damaged(path, &bytes),
    }
}

fn preserve_damaged(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let recovery = write_recovery_copy(path, bytes)?;
    crate::logging::warn(&format!(
        "Damaged file {} preserved at {} before it was replaced.",
        path.display(),
        recovery.display()
    ));
    Ok(())
}

/// Refuse to touch a file that declares a `schemaVersion` this build does not
/// know. Such a file is read best-effort but never rewritten.
pub fn ensure_schema_not_newer(value: &Value, what: &str) -> Result<(), String> {
    if ensure_schema_version_is_newer(value) {
        notify_newer_once(what);
        return Err(format!(
            "{what} was written by a newer ROSI version. This version will not overwrite it."
        ));
    }
    Ok(())
}

/// True when `path` holds a JSON object whose `schemaVersion` is newer than
/// this build. Such a file is preserved on purpose, so a refused write to it is
/// not a durability failure.
pub fn is_newer_schema_file(path: &Path, max_bytes: u64) -> bool {
    read_bounded(path, max_bytes)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .is_some_and(|value| ensure_schema_version_is_newer(&value))
}

fn ensure_schema_version_is_newer(value: &Value) -> bool {
    value
        .get("schemaVersion")
        .and_then(Value::as_f64)
        .is_some_and(|version| version > f64::from(CURRENT_PERSISTED_SCHEMA_VERSION))
}

/// One non-blocking warning per file kind per launch, so changes this version
/// cannot save are never lost silently.
pub fn notify_newer_once(what: &str) {
    static NOTIFIED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    {
        let mut notified = NOTIFIED.lock().unwrap_or_else(|p| p.into_inner());
        if notified.iter().any(|kind| kind == what) {
            return;
        }
        notified.push(what.to_string());
    }
    crate::logging::warn(&format!(
        "Told the user that a newer ROSI version owns {what}; changes will not be saved."
    ));
    crate::notices::show(
        "Newer ROSI Data",
        &format!(
            "{what} was saved by a newer version of ROSI. This version will not overwrite it, so changes you make here will not be kept. Reopen the newer ROSI version to keep working with this data."
        ),
        crate::notices::NoticeKind::Warning,
        false,
    );
}

/// Versioned list files are `{ "schemaVersion": n, "items": [...] }`. Files
/// written before versioning are bare arrays, and both forms are accepted.
pub fn is_list_file(value: &Value) -> bool {
    value.is_array() || value.get("items").is_some_and(Value::is_array)
}

/// The items of a list file in either form.
pub fn list_items(value: Value) -> Option<Vec<Value>> {
    match value {
        Value::Array(list) => Some(list),
        Value::Object(mut object) => match object.remove("items") {
            Some(Value::Array(list)) => Some(list),
            _ => None,
        },
        _ => None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListFile<'a, T: Serialize> {
    schema_version: u32,
    items: &'a [T],
}

/// Pretty-printed versioned list file. Writers and size checks share this
/// encoder so the measured size is the size on disk.
pub fn encode_list<T: Serialize>(items: &[T]) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(&ListFile {
        schema_version: CURRENT_PERSISTED_SCHEMA_VERSION,
        items,
    })
    .map_err(|error| error.to_string())
}
