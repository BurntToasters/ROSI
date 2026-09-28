//! Atomic, private file writes and bounded reads for persisted JSON state.

use std::io::{Read, Write};
use std::path::Path;

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
        rename_replacing(&temp, path)
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
        match std::fs::rename(from, to) {
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
