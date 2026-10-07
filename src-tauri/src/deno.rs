//! Deno runtime detection and optional install (yt-dlp uses Deno for some
//! JavaScript-based extractors).

use crate::constants::{
    DENO_CHECK_TIMEOUT, DENO_INSTALL_TIMEOUT, MAX_ERROR_BUFFER, MAX_OUTPUT_BUFFER,
};
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

fn search_paths() -> Vec<PathBuf> {
    #[cfg(feature = "e2e")]
    if let Some(directory) = std::env::var_os("ROSI_E2E_DENO_PROBE_DIR") {
        return vec![PathBuf::from(directory).join(if cfg!(windows) {
            "deno.exe"
        } else {
            "deno"
        })];
    }
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
    let executable_name = if cfg!(windows) { "deno.exe" } else { "deno" };
    let mut seen = HashSet::new();
    let mut candidates = search_paths();
    #[cfg(feature = "e2e")]
    let isolated_probe = std::env::var_os("ROSI_E2E_DENO_PROBE_DIR").is_some();
    #[cfg(not(feature = "e2e"))]
    let isolated_probe = false;
    if !isolated_probe {
        candidates.extend(
            std::env::split_paths(&crate::process_util::enhanced_path())
                .map(|directory| directory.join(executable_name)),
        );
    }
    candidates.retain(|path| seen.insert(crate::validation::resolve_path(path)));
    candidates.truncate(64);

    let deadline = Instant::now() + DENO_CHECK_TIMEOUT;
    for candidate in candidates {
        if !std::fs::metadata(&candidate).is_ok_and(|metadata| metadata.file_type().is_file()) {
            continue;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let timeout = remaining.min(Duration::from_secs(2));
        let mut command =
            crate::process_util::command(candidate, &["--version".to_string()], &[], true);
        let Ok(output) = crate::process_util::run_with_timeout(&mut command, timeout, 4096, 4096)
        else {
            continue;
        };
        if !output.timed_out && output.code == Some(0) && has_version_line(&output.stdout) {
            return true;
        }
    }
    false
}

fn has_version_line(stdout: &str) -> bool {
    stdout.lines().any(|line| {
        let mut words = line.split_whitespace();
        let Some(runtime) = words.next() else {
            return false;
        };
        let Some(version) = words.next() else {
            return false;
        };
        runtime.eq_ignore_ascii_case("deno")
            && version.split(['.', '-', '+']).take(3).count() == 3
            && version
                .split(['.', '-', '+'])
                .take(3)
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    })
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
