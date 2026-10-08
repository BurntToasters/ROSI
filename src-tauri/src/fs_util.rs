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
    let mut attempt = 0;
    loop {
        #[cfg(windows)]
        let rename = windows_rename_replacing(from, to);
        #[cfg(not(windows))]
        let rename = std::fs::rename(from, to);
        match rename {
            Ok(()) => return Ok(()),
            Err(error)
                if cfg!(windows)
                    && attempt < 10
                    && (error.kind() == std::io::ErrorKind::PermissionDenied
                        || error.raw_os_error() == Some(32)) =>
            {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(25 * attempt));
            }
            Err(error) => return Err(error.to_string()),
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
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let serialized = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    atomic_write(path, &serialized)
}

/// Read a UTF-8 file of at most `max_bytes`. Missing files return `Ok(None)`.
pub fn read_bounded(path: &Path, max_bytes: u64) -> Result<Option<String>, String> {
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
    let mut contents = String::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(max_bytes + 1).read_to_string(&mut contents))
        .map_err(|error| error.to_string())?;
    Ok(Some(contents))
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

/// Run before a save replaces the persisted JSON file at `path`. A missing
/// file passes. An unreadable or oversized file refuses the write, and so does
/// a file that `check_schema` rejects. Bytes that are damaged or have the
/// wrong shape are copied to a recovery file first, so a save never discards
/// them.
pub fn guard_before_replace(
    path: &Path,
    max_bytes: u64,
    has_expected_shape: fn(&Value) -> bool,
    check_schema: impl FnOnce(&Value) -> Result<(), String>,
) -> Result<(), String> {
    let Some(raw) = read_bounded(path, max_bytes)? else {
        return Ok(());
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(value) if has_expected_shape(&value) => check_schema(&value),
        _ => {
            let recovery = recovery_copy_path(path);
            atomic_write(&recovery, raw.as_bytes())?;
            crate::logging::warn(&format!(
                "Damaged file {} preserved at {} before it was replaced.",
                path.display(),
                recovery.display()
            ));
            Ok(())
        }
    }
}

/// Refuse to touch a file that declares a `schemaVersion` this build does not
/// know. Such a file is read best-effort but never rewritten.
pub fn ensure_schema_not_newer(value: &Value, what: &str) -> Result<(), String> {
    let newer = value
        .get("schemaVersion")
        .and_then(Value::as_f64)
        .is_some_and(|version| version > f64::from(CURRENT_PERSISTED_SCHEMA_VERSION));
    if newer {
        notify_newer_once(what);
        return Err(format!(
            "{what} was written by a newer ROSI version. This version will not overwrite it."
        ));
    }
    Ok(())
}

/// One non-blocking warning per file kind per launch, so changes this version
/// cannot save are never lost silently.
fn notify_newer_once(what: &str) {
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
    if let Some(app) = crate::app_state::app() {
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .message(format!(
                "{what} was saved by a newer version of ROSI. This version will not overwrite it, so changes you make here will not be kept. Reopen the newer ROSI version to keep working with this data."
            ))
            .title("Newer ROSI Data")
            .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
            .show(|_| {});
    }
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
