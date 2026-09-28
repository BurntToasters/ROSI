//! Deno runtime detection and optional install (yt-dlp uses Deno for some
//! JavaScript-based extractors).

use crate::constants::{
    DENO_CHECK_TIMEOUT, DENO_INSTALL_TIMEOUT, MAX_ERROR_BUFFER, MAX_OUTPUT_BUFFER,
};
use serde::Serialize;
use std::path::PathBuf;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

fn search_paths() -> Vec<PathBuf> {
    if cfg!(windows) {
        let profile = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_default();
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_default();
        return vec![
            profile.join(".deno").join("bin").join("deno.exe"),
            local.join("deno").join("bin").join("deno.exe"),
            // winget installs Deno as a portable package and links it here.
            local
                .join("Microsoft")
                .join("WinGet")
                .join("Links")
                .join("deno.exe"),
            PathBuf::from("C:\\Program Files\\deno\\deno.exe"),
            PathBuf::from("C:\\deno\\deno.exe"),
        ];
    }
    let home = crate::app_state::home_dir().unwrap_or_default();
    vec![
        home.join(".deno").join("bin").join("deno"),
        PathBuf::from("/usr/local/bin/deno"),
        PathBuf::from("/opt/homebrew/bin/deno"),
        PathBuf::from("/usr/bin/deno"),
        PathBuf::from("/home/linuxbrew/.linuxbrew/bin/deno"),
        home.join(".local").join("bin").join("deno"),
    ]
}

fn installed() -> bool {
    if search_paths().iter().any(|path| path.exists()) {
        return true;
    }
    let lookup = if cfg!(windows) { "where" } else { "which" };
    let mut command = crate::process_util::command(lookup, &["deno".to_string()], &[], false);
    crate::process_util::run_with_timeout(&mut command, DENO_CHECK_TIMEOUT, 4096, 4096)
        .map(|output| !output.timed_out && output.code == Some(0))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn check_deno_installed() -> bool {
    tauri::async_runtime::spawn_blocking(installed)
        .await
        .unwrap_or(false)
}

#[derive(Default, Serialize)]
pub struct InstallResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn installer() -> Option<(&'static str, Vec<String>)> {
    if cfg!(windows) {
        return Some((
            "winget.exe",
            [
                "install",
                "--exact",
                "--id",
                "DenoLand.Deno",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--silent",
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
        ));
    }
    if cfg!(target_os = "macos") {
        return Some(("brew", vec!["install".to_string(), "deno".to_string()]));
    }
    None
}

fn install(app: tauri::AppHandle) -> InstallResult {
    let mut dialog = app
        .dialog()
        .message(
            "This will install Deno through your system package manager. Do you want to continue?",
        )
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install".to_string(),
            "Cancel".to_string(),
        ));
    if let Some(window) = crate::app_state::main_window() {
        dialog = dialog.parent(&window);
    }
    if !dialog.blocking_show() {
        return InstallResult {
            cancelled: Some(true),
            ..InstallResult::default()
        };
    }
    let Some((program, args)) = installer() else {
        return InstallResult {
            success: Some(false),
            error: Some("Automatic Deno installation is unavailable on this platform. Use the official installation instructions at https://docs.deno.com/runtime/getting_started/installation/.".to_string()),
            ..InstallResult::default()
        };
    };
    let mut command = crate::process_util::command(program, &args, &[], true);
    match crate::process_util::run_with_timeout(
        &mut command,
        DENO_INSTALL_TIMEOUT,
        MAX_OUTPUT_BUFFER,
        MAX_ERROR_BUFFER,
    ) {
        Ok(output) if output.timed_out => InstallResult {
            success: Some(false),
            error: Some("Installation timed out after 2 minutes".to_string()),
            ..InstallResult::default()
        },
        Ok(output) if output.code == Some(0) => InstallResult {
            success: Some(true),
            output: Some(output.stdout),
            ..InstallResult::default()
        },
        Ok(output) => InstallResult {
            success: Some(false),
            error: Some(if output.stderr.is_empty() {
                output.stdout
            } else {
                output.stderr
            }),
            ..InstallResult::default()
        },
        Err(error) => {
            crate::logging::error(&format!("Deno install error: {error}"));
            InstallResult {
                success: Some(false),
                error: Some(error.to_string()),
                ..InstallResult::default()
            }
        }
    }
}

#[tauri::command]
pub async fn install_deno(app: tauri::AppHandle) -> InstallResult {
    tauri::async_runtime::spawn_blocking(move || install(app))
        .await
        .unwrap_or_else(|error| InstallResult {
            success: Some(false),
            error: Some(error.to_string()),
            ..InstallResult::default()
        })
}
