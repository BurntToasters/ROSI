//! Location of the bundled yt-dlp / FFmpeg / ffprobe sidecars and the
//! effective FFmpeg binary for a download (custom path > bundled > PATH).
//!
//! Tauri installs externalBin sidecars next to the main executable with the
//! target triple stripped (`rosi-yt-dlp`, `rosi-ffmpeg`, `rosi-ffprobe`). The
//! `rosi-` prefix keeps Linux packages from colliding with distro `ffmpeg` /
//! `yt-dlp` files in /usr/bin.

use crate::constants::MAX_ERROR_BUFFER;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

pub const YTDLP_SIDECAR: &str = "rosi-yt-dlp";
pub const FFMPEG_SIDECAR: &str = "rosi-ffmpeg";
pub const FFPROBE_SIDECAR: &str = "rosi-ffprobe";
const EXE_SUFFIX: &str = std::env::consts::EXE_SUFFIX;

static YTDLP_PATH: OnceLock<PathBuf> = OnceLock::new();

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

pub fn bundled_path(name: &str) -> Option<PathBuf> {
    exe_dir().map(|dir| dir.join(format!("{name}{EXE_SUFFIX}")))
}

fn probe_version(path: &Path) -> Result<String, String> {
    let mut command = crate::process_util::command(path, &["--version".to_string()], &[], true);
    match crate::process_util::run_with_timeout(&mut command, Duration::from_secs(60), 512, 4096) {
        Ok(output) if !output.timed_out && output.code == Some(0) => Ok(output
            .stdout
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string()),
        Ok(output) if output.timed_out => Err("timed out".to_string()),
        Ok(output) => Err(if output.stderr.trim().is_empty() {
            format!("exit code {:?}", output.code)
        } else {
            output.stderr.trim().to_string()
        }),
        Err(error) => Err(error.to_string()),
    }
}

fn mac_system_ytdlp() -> Option<PathBuf> {
    let home = crate::app_state::home_dir().unwrap_or_default();
    [
        home.join(".local").join("bin").join("yt-dlp"),
        PathBuf::from("/opt/homebrew/bin/yt-dlp"),
        PathBuf::from("/usr/local/bin/yt-dlp"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

fn resolve_ytdlp() -> PathBuf {
    let bundled = bundled_path(YTDLP_SIDECAR).unwrap_or_else(|| PathBuf::from(YTDLP_SIDECAR));
    if !cfg!(target_os = "macos") || !crate::platform::is_packaged() {
        return bundled;
    }
    // macOS can block a PyInstaller sidecar at launch (library validation /
    // Team ID mismatch). Fall back to a user-installed yt-dlp in that case.
    match probe_version(&bundled) {
        Ok(version) => {
            crate::logging::info(&format!("Bundled yt-dlp verified: {version}"));
            return bundled;
        }
        Err(detail) => crate::logging::warn(&format!(
            "Bundled yt-dlp failed startup check at {}: {detail}",
            bundled.display()
        )),
    }
    if let Some(system) = mac_system_ytdlp() {
        match probe_version(&system) {
            Ok(_) => {
                crate::logging::info(&format!(
                    "Using system yt-dlp fallback at {}",
                    system.display()
                ));
                return system;
            }
            Err(detail) => crate::logging::warn(&format!(
                "System yt-dlp failed startup check at {}: {detail}",
                system.display()
            )),
        }
    }
    bundled
}

/// Effective yt-dlp path. The first call may probe the binary (macOS only).
pub fn ytdlp_path() -> PathBuf {
    YTDLP_PATH.get_or_init(resolve_ytdlp).clone()
}

pub fn bundled_ffmpeg() -> Option<PathBuf> {
    bundled_path(FFMPEG_SIDECAR).filter(|path| path.is_file())
}

fn is_bare_command(value: &str) -> bool {
    !Path::new(value).is_absolute() && !value.contains('/') && !value.contains('\\')
}

/// Resolve a user-supplied FFmpeg location (binary, directory, or bare name).
fn resolve_custom_ffmpeg(custom: &str) -> Option<PathBuf> {
    let trimmed = custom.trim();
    if trimmed.is_empty() {
        return None;
    }
    if is_bare_command(trimmed) {
        return Some(PathBuf::from(trimmed));
    }
    let mut candidate = crate::validation::resolve_path(trimmed);
    if candidate.is_dir() {
        candidate = candidate.join(format!("ffmpeg{EXE_SUFFIX}"));
    } else if cfg!(windows) && !candidate.exists() && candidate.extension().is_none() {
        let with_exe = candidate.with_extension("exe");
        if with_exe.exists() {
            candidate = with_exe;
        }
    }
    Some(candidate)
}

pub fn effective_ffmpeg(custom: Option<&str>) -> PathBuf {
    if let Some(resolved) = custom.and_then(resolve_custom_ffmpeg) {
        let base = resolved
            .file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if base != "ffmpeg" && base != "ffmpeg.exe" {
            crate::logging::warn(&format!(
                "Custom ffmpeg path has invalid basename, falling back: {}",
                resolved.display()
            ));
        } else if is_bare_command(&resolved.to_string_lossy()) || resolved.exists() {
            return resolved;
        } else {
            crate::logging::warn(&format!(
                "Custom ffmpeg path does not exist, falling back: {}",
                resolved.display()
            ));
        }
    }
    bundled_ffmpeg().unwrap_or_else(|| PathBuf::from("ffmpeg"))
}

/// Log bundled sidecar versions at startup (diagnostics only).
pub fn verify_bundled() {
    for name in [FFMPEG_SIDECAR, FFPROBE_SIDECAR] {
        let Some(path) = bundled_path(name).filter(|path| path.is_file()) else {
            crate::logging::warn(&format!("Bundled {name} not found next to the executable."));
            continue;
        };
        let mut command = crate::process_util::command(&path, &["-version".to_string()], &[], true);
        match crate::process_util::run_with_timeout(
            &mut command,
            Duration::from_secs(15),
            512,
            MAX_ERROR_BUFFER,
        ) {
            Ok(output) if output.code == Some(0) => crate::logging::info(&format!(
                "Bundled {name} verified: {}",
                output.stdout.lines().next().unwrap_or_default().trim()
            )),
            Ok(output) => crate::logging::warn(&format!(
                "Bundled {name} at {} exited with code {:?}",
                path.display(),
                output.code
            )),
            Err(error) => crate::logging::warn(&format!(
                "Bundled {name} at {} failed to execute: {error}",
                path.display()
            )),
        }
    }
}
