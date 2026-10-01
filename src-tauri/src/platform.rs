//! Platform queries, updater target selection, and OS handoffs (external
//! URLs, reveal in file manager, notifications, folder picker).

use crate::ipc::{self, IpcResult, INTERNAL_ERROR, INVALID_PATH};
use serde::Serialize;
use serde_json::Value;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

/// Node-style platform name (`darwin` / `win32` / `linux`) for the frontend.
#[tauri::command]
pub fn get_app_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        _ => "linux",
    }
}

/// `msstore` builds are produced with `ROSI_DISTRIBUTION_CHANNEL=msstore` and
/// never use the in-app updater.
pub fn distribution_channel() -> &'static str {
    match option_env!("ROSI_DISTRIBUTION_CHANNEL") {
        Some("msstore") => "msstore",
        _ => "github",
    }
}

#[tauri::command]
pub fn get_distribution_channel() -> &'static str {
    distribution_channel()
}

#[tauri::command]
pub fn get_beta_updater_target() -> String {
    use tauri::utils::config::BundleType;

    let os = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86" => "i686",
        "arm64" => "aarch64",
        other => other,
    };
    let installer = match tauri::utils::platform::bundle_type() {
        Some(BundleType::Deb) => Some("deb"),
        Some(BundleType::Rpm) => Some("rpm"),
        Some(BundleType::AppImage) => Some("appimage"),
        Some(BundleType::Msi) => Some("msi"),
        Some(BundleType::Nsis) => Some("nsis"),
        Some(BundleType::App | BundleType::Dmg) => Some("app"),
        None => None,
    };
    match installer {
        Some(installer) => format!("{os}-beta-{arch}-{installer}"),
        None => format!("{os}-beta-{arch}"),
    }
}

/// The AppImage GTK hook (linuxdeploy-plugin-gtk, Tauri CLI < 2.12) exports
/// `GDK_BACKEND=x11` unconditionally. On a Wayland session without XWayland
/// there is no X display, so GTK init panics before any window appears. Fall
/// back to the native Wayland backend in exactly that case; must run before
/// the Tauri builder initializes GTK. Returns true when the backend changed.
#[cfg(target_os = "linux")]
pub fn repair_appimage_gdk_backend() -> bool {
    let set = |name: &str| std::env::var_os(name).is_some_and(|value| !value.is_empty());
    let forced_x11 = std::env::var("GDK_BACKEND").is_ok_and(|value| value == "x11");
    if set("APPIMAGE") && forced_x11 && !set("DISPLAY") && set("WAYLAND_DISPLAY") {
        std::env::set_var("GDK_BACKEND", "wayland");
        return true;
    }
    false
}

pub fn flatpak() -> bool {
    std::env::var_os("FLATPAK_ID").is_some_and(|id| !id.is_empty())
        || std::path::Path::new("/.flatpak-info").exists()
}

#[tauri::command]
pub fn is_flatpak() -> bool {
    flatpak()
}

#[tauri::command]
pub fn is_packaged() -> bool {
    let exe = match std::env::current_exe() {
        Ok(path) => path.to_string_lossy().to_string(),
        Err(_) => return false,
    };

    #[cfg(windows)]
    {
        let lower = exe.to_lowercase();
        !(lower.contains("\\target\\debug\\") || lower.contains("\\target\\release\\"))
    }

    #[cfg(target_os = "macos")]
    {
        exe.contains(".app/Contents/MacOS/")
    }

    #[cfg(target_os = "linux")]
    {
        !(exe.contains("/target/debug/") || exe.contains("/target/release/"))
    }
}

#[derive(Serialize)]
pub struct Opened {
    opened: bool,
}

#[derive(Serialize)]
pub struct Shown {
    shown: bool,
}

#[tauri::command(async)]
pub fn open_external(app: tauri::AppHandle, url: Value) -> IpcResult<Opened> {
    let url = match crate::validation::validate_external_url(&url) {
        Ok(url) => url,
        Err(error) => return ipc::from_error(error),
    };
    match app.opener().open_url(url, None::<&str>) {
        Ok(()) => ipc::ok(Opened { opened: true }),
        Err(error) => {
            crate::logging::error(&format!("Error in open-external handler: {error}"));
            ipc::err(INTERNAL_ERROR, "Failed to open external URL.")
        }
    }
}

#[tauri::command(async)]
pub fn open_file_location(app: tauri::AppHandle, file_path: Value) -> IpcResult<Opened> {
    let path = match crate::validation::validate_file_location(&file_path) {
        Ok(path) => std::path::PathBuf::from(path),
        Err(error) => return ipc::from_error(error),
    };
    let open_parent = |dir: &std::path::Path| {
        app.opener()
            .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
    };
    let result = if path.exists() {
        // Linux reveal needs org.freedesktop.FileManager1; the plugin's portal
        // fallback does not work, so open the containing folder instead.
        app.opener().reveal_item_in_dir(&path).or_else(|error| {
            match path.parent().filter(|dir| dir.exists()) {
                Some(dir) => {
                    crate::logging::warn(&format!(
                        "Reveal in file manager failed ({error}); opening the folder instead."
                    ));
                    open_parent(dir)
                }
                None => Err(error),
            }
        })
    } else if let Some(dir) = path.parent().filter(|dir| dir.exists()) {
        open_parent(dir)
    } else {
        return ipc::err(INVALID_PATH, "Path and containing directory do not exist.");
    };
    match result {
        Ok(()) => ipc::ok(Opened { opened: true }),
        Err(error) => {
            crate::logging::error(&format!("Error in open-file-location handler: {error}"));
            ipc::err(INTERNAL_ERROR, "Failed to open file location.")
        }
    }
}

#[tauri::command(async)]
pub fn show_notification(app: tauri::AppHandle, options: Value) -> IpcResult<Shown> {
    let request = match crate::validation::validate_notification(&options) {
        Ok(request) => request,
        Err(error) => return ipc::from_error(error),
    };
    let title = request
        .title
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "ROSI".to_string());
    let body = request.body.unwrap_or_default();
    match app.notification().builder().title(title).body(body).show() {
        Ok(()) => ipc::ok(Shown { shown: true }),
        Err(error) => {
            crate::logging::error(&format!("Error showing notification: {error}"));
            ipc::err(INTERNAL_ERROR, "Failed to show notification.")
        }
    }
}

#[tauri::command]
pub async fn select_download_location(app: tauri::AppHandle) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Prefer the user's last-chosen folder over the generic Downloads dir.
        let saved = crate::settings::load().download_folder;
        let default = if !saved.trim().is_empty() && std::path::Path::new(&saved).exists() {
            std::path::PathBuf::from(saved)
        } else {
            crate::app_state::downloads_dir()
        };
        let mut dialog = app
            .dialog()
            .file()
            .set_title("Select Download Folder")
            .set_directory(default)
            .set_can_create_directories(true);
        if let Some(window) = crate::app_state::main_window() {
            dialog = dialog.set_parent(&window);
        }
        dialog
            .blocking_pick_folder()
            .and_then(|folder| folder.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .unwrap_or(None)
}
