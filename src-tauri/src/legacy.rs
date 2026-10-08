//! One-time import of ROSI 4 (Electron) data into a fresh ROSI 5 profile.
//!
//! ROSI 4 stored `settings.json`, its queue, lifetime stats, and download
//! activity in Electron's `userData` folder, `<config dir>/rosi`. When ROSI 5
//! starts without its own settings file, it copies those files into its data
//! folder; ROSI 5's loaders then validate them like any file of their own.
//! ROSI 4's folder is only read, so going back to ROSI 4 keeps working.

use crate::fs_util::{read_bounded, write_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// v4's package name was "rosi" with no productName, so that is the folder name.
const LEGACY_FOLDER: &str = "rosi";
const SETTINGS_FILE: &str = "settings.json";
const MARKER_FILE: &str = "legacy-v4-import.json";
const MAX_SETTINGS_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Copy)]
enum Shape {
    Array,
    Object,
}

/// Copied before settings.json: settings are written last, so an import that
/// stops early leaves no settings file and the next launch retries it.
const DATA_FILES: &[(&str, u64, Shape)] = &[
    ("download-queue.json", 32 * 1024 * 1024, Shape::Array),
    ("download-queue.backup.json", 32 * 1024 * 1024, Shape::Array),
    ("download-stats.json", 4 * 1024 * 1024, Shape::Object),
    ("download-activity.json", 16 * 1024 * 1024, Shape::Array),
];

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Skipped {
    file: String,
    reason: String,
}

/// Written to the ROSI 5 data folder after every import attempt.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    version: u32,
    outcome: String,
    source: String,
    imported_at: u64,
    imported: Vec<String>,
    skipped: Vec<Skipped>,
    #[serde(default)]
    retry_files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

pub fn recovery_message() -> Option<String> {
    let marker = crate::fs_util::read_json(
        &crate::app_state::data_dir().join(MARKER_FILE),
        MAX_SETTINGS_BYTES,
    )
    .and_then(|raw| serde_json::from_value::<Marker>(raw).ok())?;
    if marker.version != 1 || marker.retry_files.is_empty() {
        return None;
    }
    Some(format!("Some ROSI 4 data could not be imported: {}. The original ROSI 4 files are preserved. Repair the destination and restart ROSI to retry; existing ROSI 5 data will be preserved.", marker.retry_files.join(", ")))
}

/// Import ROSI 4 data if this is the first ROSI 5 launch. Call after
/// `app_state::init` and before anything loads settings, the queue, or stats.
pub fn import_on_first_launch(app: &AppHandle) {
    let data = crate::app_state::data_dir();
    let mut previous = crate::fs_util::read_json(&data.join(MARKER_FILE), MAX_SETTINGS_BYTES)
        .and_then(|raw| serde_json::from_value::<Marker>(raw).ok());
    let settings_exist = data.join(SETTINGS_FILE).exists();
    if settings_exist && previous.is_none() {
        return;
    }
    let Some(source) = find_source(app, &data) else {
        return;
    };
    // Early V5 markers called partial imports complete. Recover only known
    // OS-error skips with valid source data and no existing V5 regular file.
    if let Some(marker) = previous.as_mut().filter(|marker| {
        marker.version == 1
            && marker.source == source.to_string_lossy()
            && marker.outcome == "imported"
            && marker.retry_files.is_empty()
    }) {
        for &(name, max_bytes, shape) in DATA_FILES {
            if !data.join(name).is_file()
                && marker
                    .skipped
                    .iter()
                    .any(|skip| skip.file == name && skip.reason.contains("os error"))
                && read_json(&source.join(name), max_bytes).is_ok_and(|value| match shape {
                    Shape::Array => value.is_array(),
                    Shape::Object => value.is_object(),
                })
            {
                marker.retry_files.push(name.into());
            }
        }
    }
    let resume = previous.filter(|marker| {
        marker.version == 1
            && marker.source == source.to_string_lossy()
            && !marker.retry_files.is_empty()
    });
    // Never use a stored marker to read arbitrary paths or re-import over an
    // existing V5 profile after the original legacy source disappears.
    if settings_exist && resume.is_none() {
        return;
    }
    let marker = import_from(&source, &data, resume, settings_exist);
    match marker.outcome.as_str() {
        "imported" => crate::logging::info(&format!(
            "Imported ROSI 4 data from {}: {}",
            source.display(),
            marker.imported.join(", ")
        )),
        _ => crate::logging::warn(&format!(
            "Did not import ROSI 4 settings from {}: {}",
            source.display(),
            marker.reason.as_deref().unwrap_or("unknown reason")
        )),
    }
    for skipped in &marker.skipped {
        crate::logging::warn(&format!(
            "Skipped ROSI 4 {}: {}",
            skipped.file, skipped.reason
        ));
    }
    if let Err(error) = write_json(&data.join(MARKER_FILE), &marker) {
        crate::logging::warn(&format!("Could not record the ROSI 4 import: {error}"));
    }
}

fn candidate_dirs(app: &AppHandle) -> Vec<PathBuf> {
    // E2E builds on Windows cannot redirect %APPDATA% through the environment.
    #[cfg(feature = "e2e")]
    if let Some(dir) = std::env::var_os("ROSI_E2E_LEGACY_V4_DIR").filter(|dir| !dir.is_empty()) {
        return vec![PathBuf::from(dir)];
    }
    // Electron's appData: %APPDATA%, ~/Library/Application Support, or
    // $XDG_CONFIG_HOME (~/.config). Tauri's config_dir resolves the same.
    let dirs: Vec<PathBuf> = app
        .path()
        .config_dir()
        .map(|dir| dir.join(LEGACY_FOLDER))
        .into_iter()
        .collect();
    #[cfg(windows)]
    let dirs = {
        let mut dirs = dirs;
        if let Ok(local) = app.path().local_data_dir() {
            dirs.extend(store_package_dirs(&local));
        }
        dirs
    };
    dirs
}

/// The Microsoft Store (MSIX) build of ROSI 4 had its %APPDATA% writes
/// redirected into its package folder.
#[cfg(windows)]
fn store_package_dirs(local_app_data: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(local_app_data.join("Packages")) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .starts_with("burnttoasters.rosi_")
        })
        .map(|entry| {
            entry
                .path()
                .join("LocalCache")
                .join("Roaming")
                .join(LEGACY_FOLDER)
        })
        .collect();
    dirs.sort();
    dirs
}

fn find_source(app: &AppHandle, data: &Path) -> Option<PathBuf> {
    candidate_dirs(app)
        .into_iter()
        .filter(|dir| dir.as_path() != data)
        .find(|dir| dir.join(SETTINGS_FILE).is_file())
}

fn read_json(path: &Path, max_bytes: u64) -> Result<Value, String> {
    let raw = read_bounded(path, max_bytes)?.ok_or_else(|| "file disappeared".to_string())?;
    serde_json::from_str(&raw).map_err(|error| format!("invalid JSON ({error})"))
}

fn import_from(
    source: &Path,
    data: &Path,
    previous: Option<Marker>,
    settings_exist: bool,
) -> Marker {
    let retry = previous.as_ref().map(|marker| marker.retry_files.clone());
    let mut marker = previous.unwrap_or_else(|| Marker {
        version: 1,
        outcome: "skipped".into(),
        source: source.to_string_lossy().into_owned(),
        imported_at: crate::app_state::now_ms(),
        imported: Vec::new(),
        skipped: Vec::new(),
        retry_files: Vec::new(),
        reason: None,
    });
    if let Some(files) = &retry {
        marker
            .skipped
            .retain(|skipped| !files.contains(&skipped.file));
    }
    // settings.json is required: without it this is not a usable ROSI 4
    // profile, and importing only stats or a queue would be confusing.
    let raw_settings = if settings_exist {
        // A component retry must not depend on rereading legacy settings after
        // the V5 settings have already been committed and possibly changed.
        Value::Null
    } else {
        match read_json(&source.join(SETTINGS_FILE), MAX_SETTINGS_BYTES) {
            Ok(value @ Value::Object(_)) => value,
            Ok(_) => {
                marker.reason = Some("settings.json is not a JSON object".into());
                return marker;
            }
            Err(error) => {
                marker.reason = Some(format!("settings.json: {error}"));
                return marker;
            }
        }
    };
    // Persist intent before settings or components. If the final journal
    // update fails or the process exits, this record still permits a safe
    // restart that preserves already-created V5 files.
    marker.retry_files = DATA_FILES
        .iter()
        .filter(|(name, _, _)| {
            retry
                .as_ref()
                .is_none_or(|files| files.iter().any(|file| file == name))
                && source.join(name).exists()
        })
        .map(|(name, _, _)| (*name).to_string())
        .collect();
    marker.outcome = "partial".into();
    if let Err(error) = write_json(&data.join(MARKER_FILE), &marker) {
        marker.outcome = "failed".into();
        marker.reason = Some(format!("Could not preserve migration intent: {error}"));
        return marker;
    }
    marker.retry_files.clear();
    for (name, max_bytes, shape) in DATA_FILES {
        if retry
            .as_ref()
            .is_some_and(|files| !files.iter().any(|file| file == name))
        {
            continue;
        }
        let path = source.join(name);
        if !path.exists() {
            continue;
        }
        let outcome = read_json(&path, *max_bytes).and_then(|value| {
            let matches = match shape {
                Shape::Array => value.is_array(),
                Shape::Object => value.is_object(),
            };
            if !matches {
                return Err("unexpected JSON structure".into());
            }
            let destination = data.join(name);
            if retry.is_some() && destination.is_file() {
                return Err(
                    "Existing ROSI 5 data was preserved instead of retrying this component.".into(),
                );
            }
            write_json(&destination, &value).inspect_err(|_| {
                marker.retry_files.push((*name).to_string());
            })
        });
        match outcome {
            Ok(()) => marker.imported.push((*name).to_string()),
            Err(reason) => marker.skipped.push(Skipped {
                file: (*name).to_string(),
                reason,
            }),
        }
    }
    let settings_result = if settings_exist {
        Ok(())
    } else {
        crate::settings::import_legacy(&raw_settings)
    };
    match settings_result {
        Ok(()) => {
            if !marker.imported.iter().any(|file| file == SETTINGS_FILE) {
                marker.imported.push(SETTINGS_FILE.to_string());
            }
            marker.outcome = if marker.retry_files.is_empty() {
                "imported"
            } else {
                "partial"
            }
            .into();
            marker.reason = (!marker.retry_files.is_empty()).then(||
                "Some ROSI 4 files could not be written. Repair their destinations and restart ROSI to retry; existing ROSI 5 files will be preserved.".into());
        }
        Err(error) => {
            marker.outcome = "failed".into();
            marker.reason = Some(format!("could not write settings.json: {error}"));
        }
    }
    marker
}
