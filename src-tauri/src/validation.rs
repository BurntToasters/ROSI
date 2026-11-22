//! Security boundary for everything the webview sends: URL safety (no private
//! or loopback targets), download/file path allow-lists, and strict payload
//! validation for download requests, settings patches, and queue operations.

use crate::constants::*;
use crate::ip_policy::{is_public_ipv4, is_public_ipv6};
use crate::ipc::{
    FalliblePayload, IpcError, JsonObject, INVALID_PATH, INVALID_URL, VALIDATION_ERROR,
};
use crate::types::{
    DownloadPreset, DownloadRequestOptions, NotificationInput, NotificationRequest,
    PlaylistSelection, QueueReorderInput, SettingsPatchInput,
};
use serde::Serialize;
use serde_json::{Map, Value};
use std::net::Ipv4Addr;
use std::path::{Component, Path, PathBuf};

// ---------------------------------------------------------------------------
// URLs

/// inet_aton-style IPv4 parsing (hex/octal/shorthand), matching how resolvers
/// may interpret a hostname that the URL parser left as a domain.
fn canonical_ipv4(host: &str) -> Option<Ipv4Addr> {
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '.' || c == 'x' || c == 'X')
    {
        return None;
    }
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 4 {
        return None;
    }
    let mut numbers = Vec::with_capacity(parts.len());
    for part in &parts {
        let lower = part.to_ascii_lowercase();
        let value = if let Some(hex) = lower.strip_prefix("0x") {
            u64::from_str_radix(hex, 16).ok()?
        } else if lower.len() > 1 && lower.starts_with('0') {
            u64::from_str_radix(&lower[1..], 8).ok()?
        } else if !lower.is_empty() && lower.bytes().all(|b| b.is_ascii_digit()) {
            lower.parse::<u64>().ok()?
        } else {
            return None;
        };
        numbers.push(value);
    }
    let (last, head) = numbers.split_last()?;
    if head.iter().any(|value| *value > 0xff) {
        return None;
    }
    let max_last = match numbers.len() {
        1 => 0xffff_ffff,
        2 => 0xff_ffff,
        3 => 0xffff,
        _ => 0xff,
    };
    if *last > max_last {
        return None;
    }
    let mut value: u64 = 0;
    for (index, part) in head.iter().enumerate() {
        value |= part << (24 - 8 * index);
    }
    value += last;
    Some(Ipv4Addr::from(value as u32))
}

fn is_rebinding_hostname(host: &str) -> bool {
    [
        ".nip.io",
        ".sslip.io",
        ".localtest.me",
        ".lvh.me",
        ".xip.io",
    ]
    .iter()
    .any(|suffix| host.ends_with(suffix) || host == &suffix[1..])
}

pub fn is_private_or_local_host(host: &url::Host<&str>) -> bool {
    match host {
        url::Host::Ipv4(ip) => !is_public_ipv4(*ip),
        url::Host::Ipv6(ip) => !is_public_ipv6(*ip),
        url::Host::Domain(domain) => {
            let host = domain.trim().trim_end_matches('.').to_ascii_lowercase();
            host.is_empty()
                || host == "localhost"
                || host.ends_with(".localhost")
                || is_rebinding_hostname(&host)
                || canonical_ipv4(&host).is_some_and(|ip| !is_public_ipv4(ip))
        }
    }
}

#[cfg(feature = "e2e")]
fn e2e_allows_loopback(host: &url::Host<&str>) -> bool {
    std::env::var("ROSI_E2E_ALLOW_LOOPBACK").as_deref() == Ok("1")
        && matches!(host, url::Host::Ipv4(ip) if ip.is_loopback())
}

#[cfg(not(feature = "e2e"))]
fn e2e_allows_loopback(_host: &url::Host<&str>) -> bool {
    false
}

fn parse_web_url(value: &str) -> Option<url::Url> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let url = url::Url::parse(trimmed).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

/// Checks stable URL syntax and literal-host policy without consulting DNS.
/// Persistence and metadata parsing use this so temporary resolver failures
/// cannot erase user data or unparse otherwise valid extractor output.
pub fn is_syntactically_safe_http_url(value: &str) -> bool {
    let Some(url) = parse_web_url(value) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host() else {
        return false;
    };
    e2e_allows_loopback(&host) || !is_private_or_local_host(&host)
}

/// Accepts a syntactically safe internal HTTP(S) URL. DNS is deliberately
/// deferred until a cancellable operation is reserved and the pinned proxy is
/// ready to connect to the exact vetted address set.
pub fn is_safe_http_url(value: &str) -> bool {
    is_syntactically_safe_http_url(value)
}

/// Validates DNS answers immediately before handing a URL to the system
/// browser/opener. ROSI cannot control DNS resolution or redirects performed
/// after the external application receives the URL; internal preview, formats,
/// and downloads use the pinned `network_security` proxy instead.
pub fn is_safe_external_url(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    let Ok(url) = url::Url::parse(trimmed) else {
        return false;
    };
    match url.scheme() {
        "mailto" | "ms-windows-store" => true,
        "http" | "https" => {
            url.host()
                .is_some_and(|host| !is_private_or_local_host(&host))
                && crate::network_security::is_public_http_destination(trimmed, false)
        }
        _ => false,
    }
}

/// Canonical queue URL: a safe http(s) URL without its fragment.
pub fn normalize_queue_url(value: &str) -> Option<String> {
    if !is_syntactically_safe_http_url(value) {
        return None;
    }
    let mut url = url::Url::parse(value.trim()).ok()?;
    url.set_fragment(None);
    Some(url.to_string())
}

// ---------------------------------------------------------------------------
// Paths

fn has_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

pub fn is_absolute_path(value: &str) -> bool {
    Path::new(value).is_absolute() || has_drive_prefix(value)
}

/// Lexical `path.resolve`: absolute, with `.` and `..` segments removed.
pub fn resolve_path(value: impl AsRef<Path>) -> PathBuf {
    let value = value.as_ref();
    let absolute = if value.is_absolute() {
        value.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(value)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str())
            }
            Component::CurDir => {}
            Component::ParentDir => {
                let at_root = normalized.parent().is_none();
                if !at_root {
                    normalized.pop();
                }
            }
        }
    }
    normalized
}

fn comparable(path: &Path) -> PathBuf {
    if cfg!(any(windows, target_os = "macos")) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    }
}

pub fn is_path_within(candidate: &Path, base: &Path) -> bool {
    comparable(&resolve_path(candidate)).starts_with(comparable(&resolve_path(base)))
}

/// Lexical rules plus, on Unix, the same rules for the real (symlink-resolved)
/// location of the deepest existing ancestor. This stops aliases such as
/// `/Volumes/Macintosh HD/...` or a link in the home folder from reaching
/// system folders.
fn is_allowed_download_base(resolved: &Path) -> bool {
    if !is_allowed_download_base_lexical(resolved) {
        return false;
    }
    #[cfg(unix)]
    {
        let mut existing = resolved;
        while !existing.exists() {
            match existing.parent() {
                Some(parent) => existing = parent,
                None => return true,
            }
        }
        if let Ok(real) = existing.canonicalize() {
            return is_allowed_download_base_lexical(&real)
                || canonical_bases()
                    .iter()
                    .any(|base| is_path_within(&real, base));
        }
    }
    // An admin share of this machine (\\localhost\C$\...) is a local path.
    #[cfg(windows)]
    if let Some(local) = local_admin_share_path(resolved) {
        if is_within_windows_system_dirs(&local) && !is_within_real_home(&local) {
            return false;
        }
    }
    // Resolve short names, junctions and trailing dots through the nearest
    // existing ancestor, then compare with the real system folders.
    #[cfg(windows)]
    if let Some(real) = real_path_of_existing_ancestor(resolved) {
        if is_within_windows_system_dirs(&real) && !is_within_real_home(&real) {
            return false;
        }
    }
    true
}

/// Canonical path of the deepest existing ancestor, without the verbatim prefix.
/// Network locations are not probed: a share cannot hold this machine's system
/// folders, and probing an offline one blocks settings loads for a long time.
#[cfg(windows)]
fn real_path_of_existing_ancestor(path: &Path) -> Option<PathBuf> {
    if is_network_location(path) {
        return None;
    }
    let mut existing = path;
    while !existing.exists() {
        existing = existing.parent()?;
    }
    existing.canonicalize().ok().map(strip_verbatim_prefix)
}

/// UNC paths, and drive letters mapped to a network share. Device paths
/// (`\\?\C:\`, `\\.\C:\`) are local.
#[cfg(windows)]
fn is_network_location(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    // DRIVE_REMOTE from Win32_System_WindowsProgramming, which ROSI does not enable.
    const DRIVE_REMOTE: u32 = 4;
    let text = path.to_string_lossy().replace('/', r"\");
    let local = text
        .strip_prefix(r"\\?\")
        .or_else(|| text.strip_prefix(r"\\.\"))
        .unwrap_or(&text);
    if local.starts_with(r"\\")
        || local
            .get(..4)
            .is_some_and(|head| head.eq_ignore_ascii_case(r"UNC\"))
    {
        return true;
    }
    let bytes = local.as_bytes();
    if bytes.len() < 2 || bytes[1] != b':' || !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    let root: Vec<u16> = std::ffi::OsStr::new(&format!(r"{}:\", bytes[0] as char))
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `root` is a NUL-terminated UTF-16 string that outlives the call.
    unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_REMOTE }
}

/// `\\localhost\C$\rest` (or any 127.x.x.x address, ::1, or this computer's
/// name) as `C:\rest`, and `\\localhost\ADMIN$\rest` as `%SystemRoot%\rest`.
/// The `\\.\UNC\` and `\\?\UNC\` forms are accepted too. Other UNC paths
/// return None.
#[cfg(windows)]
fn local_admin_share_path(path: &Path) -> Option<PathBuf> {
    use windows_sys::Win32::UI::Shell::FOLDERID_Windows;
    let text = path.to_string_lossy().replace('/', r"\");
    let unc = [r"\\?\UNC\", r"\\.\UNC\"]
        .iter()
        .find_map(|prefix| text.strip_prefix(*prefix))
        .or_else(|| text.strip_prefix(r"\\"))?;
    let mut parts = unc.splitn(3, '\\');
    let host = parts.next()?;
    let share = parts.next()?;
    let rest = parts.next().unwrap_or("");
    let computer = std::env::var("COMPUTERNAME").unwrap_or_default();
    let is_local_host = ["localhost", "127.0.0.1", "::1", "[::1]", "."]
        .iter()
        .any(|name| host.eq_ignore_ascii_case(name))
        || host
            .parse::<Ipv4Addr>()
            .is_ok_and(|address| address.is_loopback())
        || (!computer.is_empty() && host.eq_ignore_ascii_case(&computer));
    if !is_local_host {
        return None;
    }
    if share.eq_ignore_ascii_case("ADMIN$") {
        return Some(known_folder_path(&FOLDERID_Windows)?.join(rest));
    }
    let drive = share.strip_suffix('$')?;
    if drive.len() != 1 || !drive.as_bytes()[0].is_ascii_alphabetic() {
        return None;
    }
    Some(PathBuf::from(format!(r"{drive}:\{rest}")))
}

#[cfg(windows)]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix("\\\\?\\UNC\\") {
        PathBuf::from(format!("\\\\{rest}"))
    } else if let Some(rest) = text.strip_prefix("\\\\?\\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

#[cfg(windows)]
fn is_within_real_home(real: &Path) -> bool {
    crate::app_state::home_dir()
        .and_then(|home| home.canonicalize().ok())
        .map(strip_verbatim_prefix)
        .is_some_and(|home| is_path_within(real, &home))
}

#[cfg(windows)]
fn is_within_windows_system_dirs(path: &Path) -> bool {
    windows_system_dirs()
        .iter()
        .any(|dir| is_path_within(path, dir))
}

/// The real Windows, Program Files and ProgramData folders: Known Folders
/// first, then the environment values, each in plain and canonical form.
#[cfg(windows)]
fn windows_system_dirs() -> &'static [PathBuf] {
    use std::sync::OnceLock;
    use windows_sys::Win32::UI::Shell::{
        FOLDERID_ProgramData, FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86, FOLDERID_Windows,
    };
    static DIRS: OnceLock<Vec<PathBuf>> = OnceLock::new();
    DIRS.get_or_init(|| {
        let mut dirs: Vec<PathBuf> = [
            FOLDERID_Windows,
            FOLDERID_ProgramFiles,
            FOLDERID_ProgramFilesX86,
            FOLDERID_ProgramData,
        ]
        .iter()
        .filter_map(known_folder_path)
        .collect();
        for name in [
            "SystemRoot",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "ProgramData",
        ] {
            if let Some(value) = std::env::var_os(name) {
                if !value.is_empty() {
                    dirs.push(PathBuf::from(value));
                }
            }
        }
        let mut all: Vec<PathBuf> = Vec::new();
        for dir in dirs {
            let canonical = dir
                .canonicalize()
                .map(strip_verbatim_prefix)
                .unwrap_or_else(|_| dir.clone());
            for candidate in [dir, canonical] {
                // A drive root would block everything.
                if candidate.is_absolute()
                    && candidate.parent().is_some()
                    && !all.contains(&candidate)
                {
                    all.push(candidate);
                }
            }
        }
        all
    })
}

#[cfg(windows)]
fn known_folder_path(id: &windows_sys::core::GUID) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::SHGetKnownFolderPath;

    let mut raw: windows_sys::core::PWSTR = std::ptr::null_mut();
    // SAFETY: `raw` is a valid out pointer. On success Windows returns a
    // NUL-terminated string that is copied and then freed with CoTaskMemFree,
    // which is also required after a failed call.
    unsafe {
        let hr = SHGetKnownFolderPath(id, 0, std::ptr::null_mut(), &mut raw);
        let path = if hr >= 0 && !raw.is_null() {
            let mut len = 0;
            while *raw.add(len) != 0 {
                len += 1;
            }
            Some(PathBuf::from(std::ffi::OsString::from_wide(
                std::slice::from_raw_parts(raw, len),
            )))
        } else {
            None
        };
        CoTaskMemFree(raw as *const core::ffi::c_void);
        path
    }
}

/// Allowed roots with their own symlinks resolved, for comparing against a
/// resolved candidate (for example a home folder that is itself a link).
#[cfg(unix)]
fn canonical_bases() -> Vec<PathBuf> {
    let mut bases: Vec<PathBuf> = crate::app_state::home_dir().into_iter().collect();
    if cfg!(target_os = "macos") {
        bases.push(PathBuf::from("/Volumes"));
    }
    if cfg!(target_os = "linux") {
        bases.extend(["/mnt", "/media", "/run/media"].map(PathBuf::from));
        bases.extend(
            crate::app_state::media_dirs()
                .iter()
                .filter(|dir| resolve_path(dir).parent().is_some())
                .cloned(),
        );
        if crate::platform::flatpak() {
            if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
                bases.push(Path::new(&runtime).join("doc"));
            }
        }
    }
    bases
        .into_iter()
        .filter_map(|base| base.canonicalize().ok())
        // A base that resolves to the filesystem root would allow everything.
        .filter(|base| base.parent().is_some())
        .collect()
}

fn is_allowed_download_base_lexical(resolved: &Path) -> bool {
    if let Some(home) = crate::app_state::home_dir() {
        if is_path_within(resolved, &home) {
            return true;
        }
    }
    if cfg!(target_os = "macos") && is_path_within(resolved, Path::new("/Volumes")) {
        return true;
    }
    if cfg!(target_os = "linux")
        && ["/mnt", "/media", "/run/media"]
            .iter()
            .any(|root| is_path_within(resolved, Path::new(root)))
    {
        return true;
    }
    // The user's own XDG Downloads/Videos/Music folders, wherever
    // user-dirs.dirs points them. A misconfigured "/" never widens the list.
    if cfg!(target_os = "linux")
        && crate::app_state::media_dirs().iter().any(|dir| {
            let dir = resolve_path(dir);
            dir.parent().is_some() && is_path_within(resolved, &dir)
        })
    {
        return true;
    }
    // In Flatpak, folders picked outside the granted xdg dirs come back from
    // the file-chooser portal as document-portal exports the user approved.
    if cfg!(target_os = "linux") && crate::platform::flatpak() {
        if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
            let doc_root = Path::new(&runtime).join("doc");
            if resolved != doc_root && is_path_within(resolved, &doc_root) {
                return true;
            }
        }
    }
    #[cfg(windows)]
    if resolved.is_absolute() {
        return !is_within_windows_system_dirs(resolved);
    }
    false
}

fn path_error(message: impl Into<String>) -> IpcError {
    IpcError::new(INVALID_PATH, message)
}

fn validation_error(message: impl Into<String>) -> IpcError {
    IpcError::new(VALIDATION_ERROR, message)
}

/// Empty input is allowed and means "use the default download folder".
pub fn validate_download_path(value: &str) -> Result<String, IpcError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if !is_absolute_path(trimmed) {
        return Err(path_error("Download path must be an absolute path."));
    }
    let resolved = resolve_path(trimmed);
    if !is_allowed_download_base(&resolved) {
        return Err(path_error(
            "Download path must be within your home directory or an allowed external volume.",
        ));
    }
    Ok(resolved.to_string_lossy().into_owned())
}

fn validate_output_path(value: &str) -> Result<String, IpcError> {
    if !is_absolute_path(value.trim()) {
        return Err(path_error("Download outputPath must be an absolute path."));
    }
    validate_download_path(value)
}

pub fn validate_ffmpeg_path_value(value: Option<&str>) -> Result<Option<String>, IpcError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed == "ffmpeg" {
        return Ok(Some("ffmpeg".to_string()));
    }
    if !is_absolute_path(trimmed) {
        return Err(validation_error(
            "ffmpegPath must be an absolute path, empty string, or \"ffmpeg\".",
        ));
    }
    let resolved = resolve_path(trimmed);
    let base = resolved
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if base != "ffmpeg" && base != "ffmpeg.exe" {
        return Err(validation_error(
            "ffmpegPath must point to ffmpeg or ffmpeg.exe.",
        ));
    }
    // Checked before any filesystem call: probing a remote path would make
    // this machine open an SMB connection and could run a remote executable.
    #[cfg(windows)]
    if is_network_location(&resolved) {
        return Err(validation_error(
            "ffmpegPath must not point to a network location.",
        ));
    }
    if !resolved.exists() {
        return Err(validation_error("ffmpegPath does not exist."));
    }
    Ok(Some(resolved.to_string_lossy().into_owned()))
}

/// The checks of `validate_ffmpeg_path_value` except existence, for values
/// loaded from disk.
pub fn validate_ffmpeg_path_shape(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed == "ffmpeg" {
        return Some(trimmed.to_string());
    }
    if !is_absolute_path(trimmed) {
        return None;
    }
    let resolved = resolve_path(trimmed);
    let base = resolved
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    (base == "ffmpeg" || base == "ffmpeg.exe").then(|| resolved.to_string_lossy().into_owned())
}

/// Stored activity and queue data pass a `Value`; the commands pass a string.
pub fn validate_file_location(value: &Value) -> Result<String, IpcError> {
    validate_file_path(value.as_str().unwrap_or(""))
}

pub fn validate_file_path(raw: &str) -> Result<String, IpcError> {
    if raw.trim().is_empty() {
        return Err(path_error("File path must be a non-empty string."));
    }
    let trimmed = raw.trim();
    if trimmed.len() > 4096 {
        return Err(path_error("File path exceeds maximum length."));
    }
    if !is_absolute_path(trimmed) {
        return Err(path_error("File path must be absolute."));
    }
    let resolved = resolve_path(trimmed);
    if !is_allowed_download_base(&resolved) {
        return Err(path_error("File path is outside allowed locations."));
    }
    Ok(resolved.to_string_lossy().into_owned())
}

pub fn validate_external_url(url: &str) -> Result<String, IpcError> {
    if is_safe_external_url(url) {
        Ok(url.trim().to_string())
    } else {
        Err(IpcError::new(INVALID_URL, "Invalid external URL payload."))
    }
}

// ---------------------------------------------------------------------------
// Payload helpers

fn as_object<'a>(value: &'a Value, message: &str) -> Result<&'a Map<String, Value>, IpcError> {
    value.as_object().ok_or_else(|| validation_error(message))
}

fn optional_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, IpcError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.as_str())),
        Some(_) => Err(validation_error(format!(
            "{key} must be a string when provided."
        ))),
    }
}

fn optional_bool(object: &Map<String, Value>, key: &str) -> Result<Option<bool>, IpcError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(validation_error(format!(
            "{key} must be a boolean when provided."
        ))),
    }
}

fn as_positive_index(value: &Value) -> Option<u32> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && number >= 1.0 && number <= f64::from(u32::MAX))
        .then_some(number as u32)
}

pub fn validate_playlist(value: &Value) -> Result<PlaylistSelection, IpcError> {
    let object = as_object(value, "playlist must be an object.")?;
    let mode = object.get("mode").and_then(Value::as_str).unwrap_or("");
    if !matches!(mode, "current" | "all" | "range") {
        return Err(validation_error(
            "playlist.mode must be current, all, or range.",
        ));
    }
    let start = object.get("start").filter(|value| !value.is_null());
    let end = object.get("end").filter(|value| !value.is_null());
    if mode != "range" {
        if start.is_some() || end.is_some() {
            return Err(validation_error(
                "playlist.start and playlist.end are only valid for range mode.",
            ));
        }
        return Ok(PlaylistSelection {
            mode: mode.to_string(),
            start: None,
            end: None,
        });
    }
    let start = start.and_then(as_positive_index);
    let end = end.and_then(as_positive_index);
    match (start, end) {
        (Some(start), Some(end)) if start <= end && end <= MAX_PLAYLIST_ITEM_INDEX => {
            Ok(PlaylistSelection {
                mode: "range".to_string(),
                start: Some(start),
                end: Some(end),
            })
        }
        _ => Err(validation_error(format!(
            "Playlist range must use 1-based integer bounds with start <= end and end <= {MAX_PLAYLIST_ITEM_INDEX}."
        ))),
    }
}

const PRESET_BOOLEAN_FIELDS: &[&str] = &[
    "bestQuality",
    "audioOnly",
    "convertEnabled",
    "keepOriginalAfterConvert",
    "gpuAcceleration",
    "writeSubtitles",
    "embedThumbnail",
    "embedMetadata",
    "sponsorblockRemove",
];

pub fn set_preset_bool(preset: &mut DownloadPreset, key: &str, value: bool) {
    let slot = match key {
        "bestQuality" => &mut preset.best_quality,
        "audioOnly" => &mut preset.audio_only,
        "convertEnabled" => &mut preset.convert_enabled,
        "keepOriginalAfterConvert" => &mut preset.keep_original_after_convert,
        "gpuAcceleration" => &mut preset.gpu_acceleration,
        "writeSubtitles" => &mut preset.write_subtitles,
        "embedThumbnail" => &mut preset.embed_thumbnail,
        "embedMetadata" => &mut preset.embed_metadata,
        "sponsorblockRemove" => &mut preset.sponsorblock_remove,
        _ => return,
    };
    *slot = Some(value);
}

pub fn preset_boolean_fields() -> &'static [&'static str] {
    PRESET_BOOLEAN_FIELDS
}

fn validate_preset_list(value: &Value) -> Result<Vec<DownloadPreset>, IpcError> {
    let list = value
        .as_array()
        .filter(|list| list.len() <= MAX_DOWNLOAD_PRESETS)
        .ok_or_else(|| {
            validation_error(format!(
                "downloadPresets must be an array with at most {MAX_DOWNLOAD_PRESETS} entries."
            ))
        })?;
    let mut presets = Vec::with_capacity(list.len());
    let mut ids = std::collections::HashSet::new();
    let mut names = std::collections::HashSet::new();
    for raw in list {
        let object = as_object(raw, "Each download preset must be an object.")?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if id.is_empty()
            || id.len() > MAX_PRESET_ID_LENGTH
            || !is_safe_identifier(id)
            || ids.contains(id)
        {
            return Err(validation_error(
                "Preset IDs must be unique safe identifiers.",
            ));
        }
        let normalized_name = name.to_lowercase();
        if name.is_empty()
            || name.chars().count() > MAX_PRESET_NAME_LENGTH
            || names.contains(&normalized_name)
        {
            return Err(validation_error(format!(
                "Preset names must be unique and at most {MAX_PRESET_NAME_LENGTH} characters."
            )));
        }
        let profile = object.get("profile").and_then(Value::as_str).unwrap_or("");
        if !allowed(ALLOWED_DOWNLOAD_PROFILES, profile) {
            return Err(validation_error("Preset profile is invalid."));
        }
        let mut preset = DownloadPreset {
            id: id.to_string(),
            name: name.to_string(),
            profile: profile.to_string(),
            ..DownloadPreset::default()
        };
        for key in PRESET_BOOLEAN_FIELDS {
            match object.get(*key) {
                None | Some(Value::Null) => {}
                Some(Value::Bool(value)) => set_preset_bool(&mut preset, key, *value),
                Some(_) => {
                    return Err(validation_error(format!("Preset {key} must be a boolean.")));
                }
            }
        }
        if let Some(value) = object.get("audioFormat").filter(|v| !v.is_null()) {
            match value.as_str() {
                Some(format) if allowed(ALLOWED_AUDIO_FORMATS, format) => {
                    preset.audio_format = Some(format.to_string())
                }
                _ => return Err(validation_error("Preset audioFormat is invalid.")),
            }
        }
        for key in ["videoFormat", "audioFormatId"] {
            if let Some(value) = object.get(key).filter(|v| !v.is_null()) {
                match value.as_str().map(str::trim) {
                    Some(format) if is_format_id(format) => {
                        if key == "videoFormat" {
                            preset.video_format = Some(format.to_string());
                        } else {
                            preset.audio_format_id = Some(format.to_string());
                        }
                    }
                    _ => return Err(validation_error(format!("Preset {key} is invalid."))),
                }
            }
        }
        if let Some(value) = object.get("convertFormat").filter(|v| !v.is_null()) {
            match value.as_str() {
                Some(format) if allowed(ALLOWED_CONVERT_FORMATS, format) => {
                    preset.convert_format = Some(format.to_string())
                }
                _ => return Err(validation_error("Preset convertFormat is invalid.")),
            }
        }
        if let Some(value) = object.get("gpuType").filter(|v| !v.is_null()) {
            match value.as_str() {
                Some(gpu) if allowed(ALLOWED_GPU_TYPES, gpu) => {
                    preset.gpu_type = Some(gpu.to_string())
                }
                _ => return Err(validation_error("Preset gpuType is invalid.")),
            }
        }
        if let Some(value) = object.get("subtitleLangs").filter(|v| !v.is_null()) {
            let langs = value.as_str().map(str::trim).unwrap_or("");
            if langs.is_empty() || langs.len() > 256 || !is_subtitle_langs(langs) {
                return Err(validation_error("Preset subtitleLangs is invalid."));
            }
            preset.subtitle_langs = Some(langs.to_string());
        }
        if let Some(value) = object.get("playlist").filter(|v| !v.is_null()) {
            preset.playlist = Some(validate_playlist(value)?);
        }
        ids.insert(id.to_string());
        names.insert(normalized_name);
        presets.push(preset);
    }
    Ok(presets)
}

pub fn validate_queue_item_id(raw: &str) -> Result<String, IpcError> {
    let id = raw.trim();
    if id.len() > 128 || !is_safe_identifier(id) {
        return Err(validation_error("Queue item ID is invalid."));
    }
    Ok(id.to_string())
}

/// Returns the queue item ID and `true` for up, `false` for down.
pub fn validate_queue_reorder(
    payload: FalliblePayload<JsonObject<QueueReorderInput>>,
) -> Result<(String, bool), IpcError> {
    let request = payload
        .into_typed(VALIDATION_ERROR, "Queue reorder payload must be an object.")?
        .0;
    let Some(FalliblePayload::Typed(raw_id)) = request.id else {
        return Err(validation_error("Queue item ID must be a string."));
    };
    let id = validate_queue_item_id(&raw_id)?;
    let direction = match request.direction {
        Some(FalliblePayload::Typed(direction)) => direction,
        _ => String::new(),
    };
    match direction.as_str() {
        "up" => Ok((id, true)),
        "down" => Ok((id, false)),
        _ => Err(validation_error(
            "Queue reorder direction must be up or down.",
        )),
    }
}

const REQUEST_BOOLEAN_FIELDS: &[&str] = &[
    "convertEnabled",
    "keepOriginal",
    "profileEnabled",
    "bestQuality",
    "advancedOptions",
    "audioOnly",
    "hookBrowser",
    "gpuAcceleration",
    "writeSubtitles",
    "embedThumbnail",
    "embedMetadata",
    "sponsorblockRemove",
];

pub fn validate_download_request(value: &Value) -> Result<DownloadRequestOptions, IpcError> {
    let object = as_object(value, "Download payload must be an object.")?;
    let url = match object.get("url").and_then(Value::as_str) {
        Some(url) if is_syntactically_safe_http_url(url) => url.trim().to_string(),
        _ => {
            return Err(IpcError::new(
                INVALID_URL,
                "Download URL must be a valid http/https URL.",
            ));
        }
    };
    let output_path = match object.get("outputPath").and_then(Value::as_str) {
        Some(path) if !path.trim().is_empty() => validate_output_path(path)?,
        _ => {
            return Err(path_error(
                "Download outputPath must be a non-empty string path.",
            ));
        }
    };
    let raw_ffmpeg_path = optional_string(object, "ffmpegPath")?;
    let ffmpeg_path = match raw_ffmpeg_path {
        Some(value) if value.trim().is_empty() => Some(String::new()),
        value => validate_ffmpeg_path_value(value.map(str::trim))?,
    };
    let convert_format = optional_string(object, "convertFormat")?
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(format) = &convert_format {
        if !allowed(ALLOWED_CONVERT_FORMATS, format) {
            return Err(validation_error(
                "convertFormat must be one of: mp4, mov, mp3, m4a.",
            ));
        }
    }
    let mut formats = [None, None];
    for (slot, key) in formats.iter_mut().zip(["videoFormat", "audioFormat"]) {
        if let Some(value) = optional_string(object, key)? {
            if !is_format_id(value.trim()) {
                return Err(validation_error(format!(
                    "{key} must be a valid yt-dlp format ID."
                )));
            }
            *slot = Some(value.trim().to_string());
        }
    }
    let mut booleans = std::collections::HashMap::new();
    for key in REQUEST_BOOLEAN_FIELDS {
        if let Some(value) = optional_bool(object, key)? {
            booleans.insert(*key, value);
        }
    }
    let mut profile = optional_string(object, "profile")?.map(str::to_string);
    if profile
        .as_deref()
        .is_some_and(|value| !allowed(ALLOWED_DOWNLOAD_PROFILES, value))
    {
        return Err(validation_error(
            "profile must be compatible, best-video, audio, or custom.",
        ));
    }
    // Requests stored by earlier builds marked a disabled profile this way.
    if booleans.get("profileEnabled") == Some(&false) {
        profile = Some("compatible".into());
    }
    let audio_output_format = optional_string(object, "audioOutputFormat")?.map(str::to_string);
    if audio_output_format
        .as_deref()
        .is_some_and(|value| !allowed(ALLOWED_AUDIO_FORMATS, value))
    {
        return Err(validation_error("audioOutputFormat is invalid."));
    }
    let gpu_type = optional_string(object, "gpuType")?.map(str::to_string);
    if gpu_type
        .as_deref()
        .is_some_and(|value| !allowed(ALLOWED_GPU_TYPES, value))
    {
        return Err(validation_error(
            "gpuType must be auto, nvidia, amd, or intel.",
        ));
    }
    let browser_choice =
        optional_string(object, "browserChoice")?.map(|value| value.trim().to_lowercase());
    if browser_choice
        .as_deref()
        .is_some_and(|value| !allowed(ALLOWED_BROWSERS, value))
    {
        return Err(validation_error("browserChoice is not an allowed browser."));
    }
    let subtitle_langs = match object.get("subtitleLangs").filter(|v| !v.is_null()) {
        None => None,
        Some(value) => {
            let langs = value.as_str().map(str::trim).unwrap_or("");
            if langs.is_empty() || langs.len() > 256 || !is_subtitle_langs(langs) {
                return Err(validation_error("subtitleLangs is invalid."));
            }
            Some(langs.to_string())
        }
    };
    let preset_id = optional_string(object, "presetId")?.map(str::trim);
    if let Some(id) = preset_id {
        if id.is_empty() || id.len() > MAX_PRESET_ID_LENGTH || !is_safe_identifier(id) {
            return Err(validation_error(
                "presetId must be a safe preset identifier.",
            ));
        }
    }
    let preset_name = optional_string(object, "presetName")?.map(str::trim);
    if let Some(name) = preset_name {
        if name.is_empty() || name.chars().count() > MAX_PRESET_NAME_LENGTH {
            return Err(validation_error(format!(
                "presetName must be at most {MAX_PRESET_NAME_LENGTH} characters."
            )));
        }
    }
    let playlist = match object.get("playlist").filter(|v| !v.is_null()) {
        Some(value) => Some(validate_playlist(value)?),
        None => None,
    };
    let [video_format, audio_format] = formats;
    let flag = |key: &str| booleans.get(key).copied();
    Ok(DownloadRequestOptions {
        url,
        output_path,
        ffmpeg_path,
        convert_enabled: flag("convertEnabled"),
        convert_format,
        keep_original: flag("keepOriginal"),
        video_format,
        audio_format,
        playlist,
        profile,
        preset_id: preset_id.map(str::to_string),
        preset_name: preset_name.map(str::to_string),
        best_quality: flag("bestQuality"),
        advanced_options: flag("advancedOptions"),
        audio_only: flag("audioOnly"),
        audio_output_format,
        hook_browser: flag("hookBrowser"),
        browser_choice,
        gpu_acceleration: flag("gpuAcceleration"),
        gpu_type,
        write_subtitles: flag("writeSubtitles"),
        subtitle_langs,
        embed_thumbnail: flag("embedThumbnail"),
        embed_metadata: flag("embedMetadata"),
        sponsorblock_remove: flag("sponsorblockRemove"),
    })
}

fn enum_choice(
    field: Result<String, Value>,
    list: &[&str],
    message: &str,
) -> Result<Value, IpcError> {
    match field {
        Ok(choice) if allowed(list, &choice) => Ok(Value::String(choice)),
        _ => Err(validation_error(message)),
    }
}

/// A string setting checked against a closed list: key, typed field, allowed values, refusal message.
type ChoiceSetting = (
    &'static str,
    Option<FalliblePayload<String>>,
    &'static [&'static str],
    &'static str,
);

fn boolean_setting(field: Result<bool, Value>, key: &str) -> Result<Value, IpcError> {
    field
        .map(Value::Bool)
        .map_err(|_| validation_error(format!("{key} must be a boolean.")))
}

/// A validated settings patch plus the fields that were refused.
pub struct SettingsPatch {
    pub values: Map<String, Value>,
    pub rejected: Vec<RejectedSetting>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RejectedSetting {
    pub key: String,
    pub message: String,
}

/// Runs the policy for one known key. Returns `None` when the key is absent or
/// already stored with the same JSON: an unchanged value is not validated
/// again, so a stored path that is missing right now is not reported on every
/// save. A wrong JSON type reaches the policy as `Err(raw)`.
fn check_setting<T: Serialize>(
    key: &str,
    field: Option<FalliblePayload<T>>,
    stored: &Map<String, Value>,
    policy: impl FnOnce(Result<T, Value>) -> Result<Value, IpcError>,
) -> Option<Result<Value, IpcError>> {
    let field = field?;
    if stored.get(key) == Some(&field.as_json()) {
        return None;
    }
    Some(policy(field.into_result()))
}

/// Collects the validated values and refusals of one settings patch, so each
/// settings group below can record its outcomes without sharing a closure.
struct PatchBuilder<'a> {
    patch: SettingsPatch,
    stored: &'a Map<String, Value>,
}

impl PatchBuilder<'_> {
    fn record(&mut self, key: &str, outcome: Option<Result<Value, IpcError>>) {
        match outcome {
            None => {}
            Some(Ok(value)) => {
                self.patch.values.insert(key.to_string(), value);
            }
            Some(Err(error)) => self.patch.rejected.push(RejectedSetting {
                key: key.to_string(),
                message: error.message,
            }),
        }
    }

    fn check<T: Serialize>(
        &mut self,
        key: &str,
        field: Option<FalliblePayload<T>>,
        policy: impl FnOnce(Result<T, Value>) -> Result<Value, IpcError>,
    ) {
        let outcome = check_setting(key, field, self.stored, policy);
        self.record(key, outcome);
    }
}

fn validate_settings_version_field(
    builder: &mut PatchBuilder<'_>,
    field: Option<FalliblePayload<f64>>,
) {
    builder.check("settingsVersion", field, |field| match field {
        Ok(version)
            if version.fract() == 0.0
                && version >= 1.0
                && version <= f64::from(CURRENT_SETTINGS_VERSION) =>
        {
            Ok(Value::from(version as u32))
        }
        _ => Err(validation_error(format!(
            "settingsVersion must be an integer between 1 and {CURRENT_SETTINGS_VERSION}."
        ))),
    });
}

fn validate_download_presets_field(
    builder: &mut PatchBuilder<'_>,
    field: Option<FalliblePayload<Vec<DownloadPreset>>>,
) {
    builder.check("downloadPresets", field, |field| {
        let presets = match field {
            Ok(list) => {
                validate_preset_list(&serde_json::to_value(list).unwrap_or(Value::Array(vec![])))
            }
            Err(raw) => validate_preset_list(&raw),
        }?;
        Ok(serde_json::to_value(presets).unwrap_or(Value::Array(vec![])))
    });
}

fn validate_flag_settings(builder: &mut PatchBuilder<'_>, input: &mut SettingsPatchInput) {
    let flags: [(&str, Option<FalliblePayload<bool>>); 22] = [
        ("showConsoleOutput", input.show_console_output.take()),
        ("dockCollapsed", input.dock_collapsed.take()),
        ("askDownloadLocation", input.ask_download_location.take()),
        ("advancedOptions", input.advanced_options.take()),
        ("audioOnly", input.audio_only.take()),
        ("convertEnabled", input.convert_enabled.take()),
        (
            "keepOriginalAfterConvert",
            input.keep_original_after_convert.take(),
        ),
        ("firstLaunch", input.first_launch.take()),
        ("hookBrowser", input.hook_browser.take()),
        ("animateBackground", input.animate_background.take()),
        ("flatUi", input.flat_ui.take()),
        ("notifications", input.notifications.take()),
        ("showTaskbarProgress", input.show_taskbar_progress.take()),
        (
            "denoReminderDismissed",
            input.deno_reminder_dismissed.take(),
        ),
        ("gpuAcceleration", input.gpu_acceleration.take()),
        ("bestQuality", input.best_quality.take()),
        ("hideSupportModal", input.hide_support_modal.take()),
        (
            "checkUpdatesOnStartup",
            input.check_updates_on_startup.take(),
        ),
        ("writeSubtitles", input.write_subtitles.take()),
        ("embedThumbnail", input.embed_thumbnail.take()),
        ("embedMetadata", input.embed_metadata.take()),
        ("sponsorblockRemove", input.sponsorblock_remove.take()),
    ];
    for (key, field) in flags {
        builder.check(key, field, |field| boolean_setting(field, key));
    }
}

fn validate_choice_settings(builder: &mut PatchBuilder<'_>, input: &mut SettingsPatchInput) {
    let choices: [ChoiceSetting; 7] = [
        (
            "downloadMode",
            input.download_mode.take(),
            ALLOWED_DOWNLOAD_PROFILES,
            "downloadMode must be compatible, best-video, audio, or custom.",
        ),
        (
            "dockTab",
            input.dock_tab.take(),
            ALLOWED_DOCK_TABS,
            "dockTab must be queue, activity, or console.",
        ),
        (
            "theme",
            input.theme.take(),
            ALLOWED_THEMES,
            "theme must be one of: system, light, dark, purple.",
        ),
        (
            "gpuType",
            input.gpu_type.take(),
            ALLOWED_GPU_TYPES,
            "gpuType must be one of: auto, nvidia, amd, intel.",
        ),
        (
            "audioFormat",
            input.audio_format.take(),
            ALLOWED_AUDIO_FORMATS,
            "audioFormat must be one of: mp3, flac, ogg, wav, m4a, opus.",
        ),
        (
            "convertFormat",
            input.convert_format.take(),
            ALLOWED_CONVERT_FORMATS,
            "convertFormat must be one of: mp4, mov, mp3, m4a.",
        ),
        (
            "updateChannel",
            input.update_channel.take(),
            ALLOWED_UPDATE_CHANNELS,
            "updateChannel must be auto, stable, or beta.",
        ),
    ];
    for (key, field, list, message) in choices {
        builder.check(key, field, |field| enum_choice(field, list, message));
    }
}

fn validate_subtitle_langs_field(
    builder: &mut PatchBuilder<'_>,
    field: Option<FalliblePayload<String>>,
) {
    builder.check("subtitleLangs", field, |field| match field {
        Ok(langs) if langs.len() <= 256 && is_subtitle_langs(&langs) => Ok(Value::String(langs)),
        _ => Err(validation_error(
            "subtitleLangs must be a comma-separated list of language codes (e.g. en,es).",
        )),
    });
}

fn validate_browser_choice_field(
    builder: &mut PatchBuilder<'_>,
    field: Option<FalliblePayload<String>>,
) {
    builder.check("browserChoice", field, |field| {
        let choice = field.map_err(|_| validation_error("browserChoice must be a string."))?;
        let normalized = choice.trim().to_lowercase();
        if !allowed(ALLOWED_BROWSERS, &normalized) {
            return Err(validation_error("browserChoice is not an allowed browser."));
        }
        Ok(Value::String(normalized))
    });
}

fn validate_ffmpeg_path_field(
    builder: &mut PatchBuilder<'_>,
    field: Option<FalliblePayload<String>>,
) {
    builder.check("ffmpegPath", field, |field| {
        let path = field.map_err(|_| validation_error("ffmpegPath must be a string."))?;
        if path.len() > 1024 {
            return Err(validation_error(
                "ffmpegPath exceeds maximum length of 1024.",
            ));
        }
        let trimmed = path.trim();
        Ok(Value::String(
            validate_ffmpeg_path_value((!trimmed.is_empty()).then_some(trimmed))?
                .unwrap_or_default(),
        ))
    });
}

fn validate_upstream_proxy_field(
    builder: &mut PatchBuilder<'_>,
    field: Option<FalliblePayload<String>>,
) {
    builder.check("upstreamProxy", field, |field| {
        let proxy = field.map_err(|_| validation_error("upstreamProxy must be a string."))?;
        // Not trimmed: a value with surrounding whitespace is refused.
        crate::network_security::parse_upstream_proxy(&proxy).map_err(validation_error)?;
        Ok(Value::String(proxy))
    });
}

fn validate_download_folder_field(
    builder: &mut PatchBuilder<'_>,
    field: Option<FalliblePayload<String>>,
) {
    builder.check("downloadFolder", field, |field| {
        let folder = field.map_err(|_| validation_error("downloadFolder must be a string."))?;
        if folder.len() > 4096 {
            return Err(validation_error(
                "downloadFolder exceeds maximum length of 4096.",
            ));
        }
        Ok(Value::String(validate_download_path(&folder)?))
    });
}

/// Validate a partial settings update. Unknown keys are ignored. A known key
/// with an invalid value is refused on its own, so one bad field never blocks
/// saving the others (or the close flush). `stored` is the current settings
/// JSON, used for the unchanged-value check.
pub fn validate_settings_patch(
    payload: FalliblePayload<JsonObject<SettingsPatchInput>>,
    stored: &Map<String, Value>,
) -> Result<SettingsPatch, IpcError> {
    let mut input = payload
        .into_typed(VALIDATION_ERROR, "Settings payload must be an object.")?
        .0;
    let mut builder = PatchBuilder {
        patch: SettingsPatch {
            values: Map::new(),
            rejected: Vec::new(),
        },
        stored,
    };

    validate_settings_version_field(&mut builder, input.settings_version.take());
    validate_download_presets_field(&mut builder, input.download_presets.take());
    validate_flag_settings(&mut builder, &mut input);
    validate_choice_settings(&mut builder, &mut input);
    validate_subtitle_langs_field(&mut builder, input.subtitle_langs.take());
    validate_browser_choice_field(&mut builder, input.browser_choice.take());
    validate_ffmpeg_path_field(&mut builder, input.ffmpeg_path.take());
    validate_upstream_proxy_field(&mut builder, input.upstream_proxy.take());
    validate_download_folder_field(&mut builder, input.download_folder.take());

    let mut patch = builder.patch;
    // Matches the key order of the old map-based walk.
    patch.rejected.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(patch)
}

/// `show_notification` options. A non-object is refused as a payload; a wrong
/// type on any of the three fields refuses the group with one message.
pub fn validate_notification(
    payload: FalliblePayload<JsonObject<NotificationInput>>,
) -> Result<NotificationRequest, IpcError> {
    const FIELD_TYPES: &str =
        "Notification title, body, and filePath must be strings when provided.";
    let input = payload
        .into_typed(VALIDATION_ERROR, "Notification payload must be an object.")?
        .0;
    let text = |field: Option<FalliblePayload<String>>| {
        field
            .map(|field| field.into_typed(VALIDATION_ERROR, FIELD_TYPES))
            .transpose()
    };
    let title = text(input.title)?;
    let body = text(input.body)?;
    let file_path = text(input.file_path)?;
    if title
        .as_ref()
        .is_some_and(|value| value.chars().count() > 256)
        || body
            .as_ref()
            .is_some_and(|value| value.chars().count() > 1024)
        || file_path.as_ref().is_some_and(|value| value.len() > 4096)
    {
        return Err(validation_error(
            "Notification field exceeds maximum length.",
        ));
    }
    if let Some(path) = file_path.filter(|path| !path.trim().is_empty()) {
        validate_file_path(&path)?;
    }
    Ok(NotificationRequest {
        title: title.map(|value| value.trim().to_string()),
        body: body.map(|value| value.trim().to_string()),
    })
}
