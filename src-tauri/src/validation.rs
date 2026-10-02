//! Security boundary for everything the webview sends: URL safety (no private
//! or loopback targets), download/file path allow-lists, and strict payload
//! validation for download requests, settings patches, and queue operations.

use crate::constants::*;
use crate::ipc::{IpcError, INVALID_PATH, INVALID_URL, VALIDATION_ERROR};
use crate::types::{
    DownloadPreset, DownloadRequestOptions, NotificationRequest, PlaylistSelection,
};
use serde_json::{Map, Value};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Component, Path, PathBuf};

// ---------------------------------------------------------------------------
// URLs

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 127
        || a == 10
        || a == 0
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 169 && b == 254)
}

fn is_private_ipv6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() {
        return true;
    }
    if let Some(mapped) = ip.to_ipv4_mapped() {
        if is_private_ipv4(mapped) {
            return true;
        }
    }
    let first = ip.segments()[0];
    // fe80::/10 link-local and fc00::/7 unique-local.
    (first & 0xffc0) == 0xfe80 || (first & 0xfe00) == 0xfc00
}

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
    .any(|suffix| host.ends_with(suffix))
}

pub fn is_private_or_local_host(host: &url::Host<&str>) -> bool {
    match host {
        url::Host::Ipv4(ip) => is_private_ipv4(*ip),
        url::Host::Ipv6(ip) => is_private_ipv6(*ip),
        url::Host::Domain(domain) => {
            let host = domain.trim().trim_end_matches('.').to_ascii_lowercase();
            host.is_empty()
                || host == "localhost"
                || host.ends_with(".localhost")
                || is_rebinding_hostname(&host)
                || canonical_ipv4(&host).is_some_and(is_private_ipv4)
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

pub fn is_safe_http_url(value: &str) -> bool {
    let Some(url) = parse_web_url(value) else {
        return false;
    };
    match url.host() {
        Some(host) => e2e_allows_loopback(&host) || !is_private_or_local_host(&host),
        None => false,
    }
}

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
        "http" | "https" => url
            .host()
            .is_some_and(|host| !is_private_or_local_host(&host)),
        _ => false,
    }
}

/// Canonical queue URL: a safe http(s) URL without its fragment.
pub fn normalize_queue_url(value: &str) -> Option<String> {
    if !is_safe_http_url(value) {
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

fn is_allowed_download_base(resolved: &Path) -> bool {
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
    if cfg!(windows) && resolved.is_absolute() {
        let normalized = format!(
            "{}\\",
            resolved.to_string_lossy().replace('/', "\\").to_lowercase()
        );
        let blocked = [
            "\\windows\\",
            "\\program files\\",
            "\\program files (x86)\\",
            "\\programdata\\",
        ];
        return !blocked.iter().any(|segment| normalized.contains(segment));
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
    if !resolved.exists() {
        return Err(validation_error("ffmpegPath does not exist."));
    }
    Ok(Some(resolved.to_string_lossy().into_owned()))
}

pub fn validate_file_location(value: &Value) -> Result<String, IpcError> {
    let Some(raw) = value.as_str().filter(|raw| !raw.trim().is_empty()) else {
        return Err(path_error("File path must be a non-empty string."));
    };
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

pub fn validate_external_url(value: &Value) -> Result<String, IpcError> {
    match value.as_str() {
        Some(url) if is_safe_external_url(url) => Ok(url.trim().to_string()),
        _ => Err(IpcError::new(INVALID_URL, "Invalid external URL payload.")),
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
                    return Err(validation_error(format!("Preset {key} must be a boolean.")))
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

pub fn validate_queue_item_id(value: &Value) -> Result<String, IpcError> {
    let Some(raw) = value.as_str() else {
        return Err(validation_error("Queue item ID must be a string."));
    };
    let id = raw.trim();
    if id.len() > 128 || !is_safe_identifier(id) {
        return Err(validation_error("Queue item ID is invalid."));
    }
    Ok(id.to_string())
}

pub fn validate_queue_reorder(value: &Value) -> Result<(String, bool), IpcError> {
    let object = as_object(value, "Queue reorder payload must be an object.")?;
    let id = validate_queue_item_id(object.get("id").unwrap_or(&Value::Null))?;
    match object.get("direction").and_then(Value::as_str) {
        Some("up") => Ok((id, true)),
        Some("down") => Ok((id, false)),
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
        Some(url) if is_safe_http_url(url) => url.trim().to_string(),
        _ => {
            return Err(IpcError::new(
                INVALID_URL,
                "Download URL must be a valid http/https URL.",
            ))
        }
    };
    let output_path = match object.get("outputPath").and_then(Value::as_str) {
        Some(path) if !path.trim().is_empty() => validate_output_path(path)?,
        _ => {
            return Err(path_error(
                "Download outputPath must be a non-empty string path.",
            ))
        }
    };
    let ffmpeg_path = validate_ffmpeg_path_value(
        optional_string(object, "ffmpegPath")?
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )?;
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

const SETTINGS_BOOLEAN_KEYS: &[&str] = &[
    "showConsoleOutput",
    "dockCollapsed",
    "askDownloadLocation",
    "advancedOptions",
    "audioOnly",
    "convertEnabled",
    "keepOriginalAfterConvert",
    "firstLaunch",
    "hookBrowser",
    "animateBackground",
    "flatUi",
    "notifications",
    "showTaskbarProgress",
    "denoReminderDismissed",
    "gpuAcceleration",
    "bestQuality",
    "hideSupportModal",
    "checkUpdatesOnStartup",
    "writeSubtitles",
    "embedThumbnail",
    "embedMetadata",
    "sponsorblockRemove",
];

fn enum_patch(value: &Value, list: &[&str], message: &str) -> Result<Value, IpcError> {
    match value.as_str() {
        Some(choice) if allowed(list, choice) => Ok(Value::String(choice.to_string())),
        _ => Err(validation_error(message)),
    }
}

/// Validate a partial settings update. Unknown keys are ignored; known keys
/// with invalid values reject the whole patch.
pub fn validate_settings_patch(value: &Value) -> Result<Map<String, Value>, IpcError> {
    let object = as_object(value, "Settings payload must be an object.")?;
    let mut patch = Map::new();
    for (key, raw) in object {
        let validated = match key.as_str() {
            "settingsVersion" => match raw.as_f64() {
                Some(version)
                    if version.fract() == 0.0
                        && version >= 1.0
                        && version <= f64::from(CURRENT_SETTINGS_VERSION) =>
                {
                    Value::from(version as u32)
                }
                _ => {
                    return Err(validation_error(format!(
                    "settingsVersion must be an integer between 1 and {CURRENT_SETTINGS_VERSION}."
                )))
                }
            },
            "downloadPresets" => {
                serde_json::to_value(validate_preset_list(raw)?).unwrap_or(Value::Array(vec![]))
            }
            key if SETTINGS_BOOLEAN_KEYS.contains(&key) => match raw {
                Value::Bool(flag) => Value::Bool(*flag),
                _ => return Err(validation_error(format!("{key} must be a boolean."))),
            },
            "downloadMode" => enum_patch(
                raw,
                ALLOWED_DOWNLOAD_PROFILES,
                "downloadMode must be compatible, best-video, audio, or custom.",
            )?,
            "dockTab" => enum_patch(
                raw,
                ALLOWED_DOCK_TABS,
                "dockTab must be queue, activity, or console.",
            )?,
            "theme" => enum_patch(
                raw,
                ALLOWED_THEMES,
                "theme must be one of: system, light, dark, purple.",
            )?,
            "gpuType" => enum_patch(
                raw,
                ALLOWED_GPU_TYPES,
                "gpuType must be one of: auto, nvidia, amd, intel.",
            )?,
            "audioFormat" => enum_patch(
                raw,
                ALLOWED_AUDIO_FORMATS,
                "audioFormat must be one of: mp3, flac, ogg, wav, m4a, opus.",
            )?,
            "convertFormat" => enum_patch(
                raw,
                ALLOWED_CONVERT_FORMATS,
                "convertFormat must be one of: mp4, mov, mp3, m4a.",
            )?,
            "updateChannel" => enum_patch(
                raw,
                ALLOWED_UPDATE_CHANNELS,
                "updateChannel must be auto, stable, or beta.",
            )?,
            "subtitleLangs" => match raw.as_str() {
                Some(langs) if langs.len() <= 256 && is_subtitle_langs(langs) => {
                    Value::String(langs.to_string())
                }
                _ => return Err(validation_error(
                    "subtitleLangs must be a comma-separated list of language codes (e.g. en,es).",
                )),
            },
            "browserChoice" => {
                let Some(choice) = raw.as_str() else {
                    return Err(validation_error("browserChoice must be a string."));
                };
                let normalized = choice.trim().to_lowercase();
                if !allowed(ALLOWED_BROWSERS, &normalized) {
                    return Err(validation_error("browserChoice is not an allowed browser."));
                }
                Value::String(normalized)
            }
            "ffmpegPath" => {
                let Some(path) = raw.as_str() else {
                    return Err(validation_error("ffmpegPath must be a string."));
                };
                if path.len() > 1024 {
                    return Err(validation_error(
                        "ffmpegPath exceeds maximum length of 1024.",
                    ));
                }
                let trimmed = path.trim();
                Value::String(
                    validate_ffmpeg_path_value((!trimmed.is_empty()).then_some(trimmed))?
                        .unwrap_or_default(),
                )
            }
            "downloadFolder" => {
                let Some(folder) = raw.as_str() else {
                    return Err(validation_error("downloadFolder must be a string."));
                };
                if folder.len() > 4096 {
                    return Err(validation_error(
                        "downloadFolder exceeds maximum length of 4096.",
                    ));
                }
                Value::String(validate_download_path(folder)?)
            }
            _ => continue,
        };
        patch.insert(key.clone(), validated);
    }
    Ok(patch)
}

pub fn validate_notification(value: &Value) -> Result<NotificationRequest, IpcError> {
    let object = as_object(value, "Notification payload must be an object.")?;
    let fields = ["title", "body", "filePath"].map(|key| optional_string(object, key));
    let [title, body, file_path] = match fields {
        [Ok(title), Ok(body), Ok(file_path)] => [title, body, file_path],
        _ => {
            return Err(validation_error(
                "Notification title, body, and filePath must be strings when provided.",
            ))
        }
    };
    if title.is_some_and(|value| value.chars().count() > 256)
        || body.is_some_and(|value| value.chars().count() > 1024)
        || file_path.is_some_and(|value| value.len() > 4096)
    {
        return Err(validation_error(
            "Notification field exceeds maximum length.",
        ));
    }
    if let Some(path) = file_path.filter(|path| !path.trim().is_empty()) {
        validate_file_location(&Value::String(path.to_string()))?;
    }
    Ok(NotificationRequest {
        title: title.map(|value| value.trim().to_string()),
        body: body.map(|value| value.trim().to_string()),
    })
}
