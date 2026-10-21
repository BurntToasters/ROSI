//! Process-wide handles: the Tauri app handle, resolved user directories, and
//! the single event sink used by background download/queue threads.

use serde::Serialize;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

static APP: OnceLock<AppHandle> = OnceLock::new();
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static HOME_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
static DOWNLOAD_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
static MEDIA_DIRS: OnceLock<Vec<PathBuf>> = OnceLock::new();

pub const MAIN_WINDOW: &str = "main";
pub const SPLASH_WINDOW: &str = "splash";

pub fn init(app: &AppHandle) -> Result<(), String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve the app data directory: {error}"))?;
    // Unpackaged E2E builds isolate all persisted state in a temporary profile.
    #[cfg(feature = "e2e")]
    let data = std::env::var_os("ROSI_E2E_DATA_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .unwrap_or(data);
    std::fs::create_dir_all(&data)
        .map_err(|error| format!("Could not create {}: {error}", data.display()))?;
    let _ = DATA_DIR.set(data);
    let _ = HOME_DIR.set(app.path().home_dir().ok());
    let _ = DOWNLOAD_DIR.set(app.path().download_dir().ok());
    let media = [
        app.path().download_dir(),
        app.path().video_dir(),
        app.path().audio_dir(),
    ];
    let _ = MEDIA_DIRS.set(media.into_iter().filter_map(Result::ok).collect());
    let _ = APP.set(app.clone());
    Ok(())
}

pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

pub fn data_dir() -> PathBuf {
    DATA_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("run.rosie.rosi"))
}

pub fn home_dir() -> Option<PathBuf> {
    if let Some(Some(home)) = HOME_DIR.get() {
        return Some(home.clone());
    }
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The OS-configured Downloads, Videos, and Music folders. On Linux these
/// come from user-dirs.dirs and may live outside $HOME (e.g. a data disk).
pub fn media_dirs() -> &'static [PathBuf] {
    MEDIA_DIRS.get().map(Vec::as_slice).unwrap_or(&[])
}

pub fn downloads_dir() -> PathBuf {
    if let Some(Some(downloads)) = DOWNLOAD_DIR.get() {
        return downloads.clone();
    }
    home_dir()
        .map(|home| home.join("Downloads"))
        .unwrap_or_else(std::env::temp_dir)
}

pub fn main_window() -> Option<WebviewWindow> {
    app().and_then(|app| app.get_webview_window(MAIN_WINDOW))
}

/// Emit an event to the main window. Background threads use this instead of
/// holding an AppHandle of their own.
pub fn emit<S: Serialize + Clone>(event: &str, payload: S) {
    if let Some(app) = app() {
        if let Err(error) = app.emit_to(MAIN_WINDOW, event, payload) {
            crate::logging::warn(&format!("Failed to emit {event}: {error}"));
        }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
