//! Per-operation launchers that force yt-dlp's FFmpeg tools to read local
//! inputs only. yt-dlp's postprocessor argument hooks do not cover its direct
//! ffprobe calls, so each invocation is routed through this process entry.

use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;

const CONFIG_FILE: &str = "launcher.json";
const CONFIG_LIMIT: u64 = 16 * 1024;
const PATH_LIMIT: usize = 32 * 1024;
const LOCAL_PROTOCOLS: &str = "file,pipe";

#[derive(Debug, Serialize, Deserialize)]
struct LauncherConfig {
    version: u8,
    ffmpeg: Option<PathBuf>,
    ffprobe: Option<PathBuf>,
}

/// Unique local launcher paths that remain present until the owning yt-dlp
/// process and its descendants have finished.
pub struct FfmpegToolGuard {
    directory: PathBuf,
    location: PathBuf,
}

impl FfmpegToolGuard {
    /// Always pass yt-dlp a private tool location. An empty location suppresses
    /// independent PATH discovery; available tools receive protected aliases.
    /// If launcher setup fails, fail the operation closed.
    pub fn create(custom_ffmpeg: Option<&str>) -> Result<Self, String> {
        Self::create_inner(custom_ffmpeg, false)
    }

    #[cfg(feature = "e2e")]
    pub fn create_ffprobe_only(custom_ffmpeg: Option<&str>) -> Result<Self, String> {
        Self::create_inner(custom_ffmpeg, true)
    }

    fn create_inner(custom_ffmpeg: Option<&str>, ffprobe_only: bool) -> Result<Self, String> {
        let configured = crate::sidecars::effective_ffmpeg(custom_ffmpeg);
        let ffmpeg = if ffprobe_only {
            None
        } else {
            resolve_executable(&configured)
        };
        let ffprobe = if ffprobe_only {
            resolve_path_probe()
        } else if ffmpeg.is_some() {
            resolve_probe(&configured)
        } else {
            resolve_path_probe()
        };
        let has_tools = ffmpeg.is_some() || ffprobe.is_some();
        let root = if has_tools {
            crate::process_util::executable_temp_dir()?
        } else {
            std::env::temp_dir()
        };
        let executable = if has_tools {
            Some(std::env::current_exe().map_err(|error| {
                format!("Could not locate the ROSI media-tool launcher: {error}")
            })?)
        } else {
            None
        };

        for _ in 0..32 {
            let directory = root.join(format!("rosi-media-tools-{}", crate::fs_util::uuid_v4()));
            match create_private_directory(&directory) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!(
                        "Could not reserve a private media-tool directory: {error}"
                    ));
                }
            }

            let result = (|| {
                let Some(executable) = executable.as_deref() else {
                    return Ok::<_, String>(directory.clone());
                };
                let config_path = directory.join(CONFIG_FILE);
                let config = LauncherConfig {
                    version: 1,
                    ffmpeg: ffmpeg.clone(),
                    ffprobe: ffprobe.clone(),
                };
                write_private_config(&config_path, &config)?;

                let ffmpeg_alias = alias_path(&directory, "ffmpeg");
                install_executable_alias(executable, &config_path, &ffmpeg_alias, "ffmpeg")?;
                if ffprobe.is_some() {
                    let ffprobe_alias = alias_path(&directory, "ffprobe");
                    install_executable_alias(executable, &config_path, &ffprobe_alias, "ffprobe")?;
                }
                Ok(directory.clone())
            })();

            match result {
                Ok(location) => {
                    return Ok(Self {
                        directory,
                        location,
                    })
                }
                Err(error) => {
                    let _ = fs::remove_dir_all(&directory);
                    return Err(error);
                }
            }
        }
        Err("Could not reserve a unique media-tool launcher path.".to_string())
    }

    pub fn location(&self) -> &Path {
        &self.location
    }
}

impl Drop for FfmpegToolGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[derive(Clone, Copy)]
enum ToolKind {
    Ffmpeg,
    Ffprobe,
}

/// Run before Tauri startup. Only the two exact private alias names enter this
/// mode; an invalid/missing config fails closed instead of opening the GUI.
pub fn dispatch_from_argv() -> Option<i32> {
    let mut arguments = std::env::args_os();
    let _argv0 = PathBuf::from(arguments.next()?);
    #[cfg(unix)]
    {
        let marker = arguments.next()?;
        if marker.as_os_str() != OsStr::new("--rosi-private-media-tool") {
            return None;
        }
        let Some(config) = arguments.next() else {
            eprintln!("ROSI private media-tool invocation is incomplete.");
            return Some(1);
        };
        let Some(role) = arguments.next() else {
            eprintln!("ROSI private media-tool invocation is incomplete.");
            return Some(1);
        };
        let Some(role) = role.to_str() else {
            eprintln!("ROSI private media-tool invocation is incomplete.");
            return Some(1);
        };
        let kind = match role {
            "ffmpeg" => ToolKind::Ffmpeg,
            "ffprobe" => ToolKind::Ffprobe,
            _ => return Some(1),
        };
        let config = PathBuf::from(config);
        Some(run_tool(
            &config,
            config.parent().unwrap_or_else(|| Path::new(".")),
            kind,
            arguments.collect(),
        ))
    }
    #[cfg(windows)]
    {
        let name = _argv0.file_name()?.to_str()?;
        let kind = if name == alias_name("ffmpeg") {
            ToolKind::Ffmpeg
        } else if name == alias_name("ffprobe") {
            ToolKind::Ffprobe
        } else {
            return None;
        };
        let directory = _argv0.parent()?;
        Some(run_tool(
            &directory.join(CONFIG_FILE),
            directory,
            kind,
            arguments.collect(),
        ))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (_argv0, arguments);
        None
    }
}

fn run_tool(config_path: &Path, directory: &Path, kind: ToolKind, arguments: Vec<OsString>) -> i32 {
    let config = match read_private_config(config_path, directory) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("ROSI media-tool launcher refused to start: {error}");
            return 1;
        }
    };
    let (executable, arguments) = match kind {
        ToolKind::Ffmpeg => {
            let Some(executable) = config.ffmpeg else {
                eprintln!("ROSI media-tool launcher has no configured ffmpeg.");
                return 1;
            };
            (executable, restrict_ffmpeg_arguments(arguments))
        }
        ToolKind::Ffprobe => {
            let Some(executable) = config.ffprobe else {
                eprintln!("ROSI media-tool launcher has no configured ffprobe.");
                return 1;
            };
            (executable, restrict_ffprobe_arguments(arguments))
        }
    };

    // The forwarded process inherits only ROSI's existing environment
    // allowlist. In particular, yt-dlp's HTTP proxy variables and other
    // environment overrides do not reach FFmpeg or ffprobe.
    let mut command = crate::process_util::command(&executable, &[], &[], false);
    command.args(arguments);
    command
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    match crate::process_util::spawn(&mut command) {
        Ok(child) => match child.wait() {
            Ok(status) => status.code().unwrap_or(1),
            Err(error) => {
                eprintln!(
                    "ROSI media-tool launcher could not wait for the configured tool: {error}"
                );
                1
            }
        },
        Err(error) => {
            eprintln!("ROSI media-tool launcher could not start the configured tool: {error}");
            1
        }
    }
}

fn restrict_ffmpeg_arguments(arguments: Vec<OsString>) -> Vec<OsString> {
    let arguments = without_protocol_whitelist(arguments);
    let mut guarded = Vec::with_capacity(arguments.len() + 4);
    for argument in arguments {
        if argument == OsStr::new("-i") {
            guarded.push(OsString::from("-protocol_whitelist"));
            guarded.push(OsString::from(LOCAL_PROTOCOLS));
        }
        guarded.push(argument);
    }
    guarded
}

fn restrict_ffprobe_arguments(arguments: Vec<OsString>) -> Vec<OsString> {
    let arguments = without_protocol_whitelist(arguments);
    let mut guarded = Vec::with_capacity(arguments.len() + 2);
    guarded.push(OsString::from("-protocol_whitelist"));
    guarded.push(OsString::from(LOCAL_PROTOCOLS));
    guarded.extend(arguments);
    guarded
}

/// Remove every caller-supplied whitelist before inserting ROSI's restriction,
/// so a later argument cannot widen the protocols for an input.
fn without_protocol_whitelist(arguments: Vec<OsString>) -> Vec<OsString> {
    let mut guarded = Vec::with_capacity(arguments.len());
    let mut index = 0;
    while index < arguments.len() {
        let argument = arguments[index].to_string_lossy();
        if argument == "-protocol_whitelist" {
            index = (index + 2).min(arguments.len());
            continue;
        }
        if argument.starts_with("-protocol_whitelist=")
            || argument.starts_with("-protocol_whitelist:")
        {
            index += 1;
            continue;
        }
        guarded.push(arguments[index].clone());
        index += 1;
    }
    guarded
}

fn alias_name(tool: &str) -> String {
    format!("{tool}{}", std::env::consts::EXE_SUFFIX)
}

fn alias_path(directory: &Path, tool: &str) -> PathBuf {
    directory.join(alias_name(tool))
}

fn create_private_directory(path: &Path) -> std::io::Result<()> {
    fs::create_dir(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_private_config(path: &Path, config: &LauncherConfig) -> Result<(), String> {
    let bytes = serde_json::to_vec(config)
        .map_err(|error| format!("Could not encode media-tool config: {error}"))?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Could not create private media-tool config: {error}"))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("Could not write private media-tool config: {error}"))
}

fn install_executable_alias(
    source: &Path,
    config: &Path,
    destination: &Path,
    tool: &str,
) -> Result<(), String> {
    #[cfg(unix)]
    {
        let source = source
            .to_str()
            .ok_or_else(|| "ROSI executable path is not UTF-8.".to_string())?;
        let config = config
            .to_str()
            .ok_or_else(|| "Media-tool config path is not UTF-8.".to_string())?;
        let mut script = String::from("#!/bin/sh\n");
        for (name, value) in loader_environment() {
            if let Some(value) = value.to_str() {
                script.push_str(name);
                script.push('=');
                script.push_str(&shell_quote(value));
                script.push_str("; export ");
                script.push_str(name);
                script.push('\n');
            }
        }
        script.push_str("exec ");
        script.push_str(&shell_quote(source));
        script.push_str(" --rosi-private-media-tool ");
        script.push_str(&shell_quote(config));
        script.push(' ');
        script.push_str(tool);
        script.push_str(" \"$@\"\n");

        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o700);
        }
        let mut file = options
            .open(destination)
            .map_err(|error| format!("Could not create protected media-tool launcher: {error}"))?;
        file.write_all(script.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("Could not write protected media-tool launcher: {error}"))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        let _ = (config, tool);
        if fs::hard_link(source, destination).is_ok() {
            return Ok(());
        }
        fs::copy(source, destination)
            .map(|_| ())
            .map_err(|error| format!("Could not install a protected media-tool launcher: {error}"))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (source, config, destination, tool);
        Err("Protected media-tool launchers are unavailable on this platform.".into())
    }
}

#[cfg(unix)]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(unix)]
fn loader_environment() -> Vec<(&'static str, OsString)> {
    #[cfg(target_os = "linux")]
    const NAMES: &[&str] = &["LD_LIBRARY_PATH"];
    #[cfg(target_os = "macos")]
    const NAMES: &[&str] = &[
        "DYLD_FRAMEWORK_PATH",
        "DYLD_LIBRARY_PATH",
        "DYLD_FALLBACK_FRAMEWORK_PATH",
        "DYLD_FALLBACK_LIBRARY_PATH",
    ];
    NAMES
        .iter()
        .filter_map(|name| std::env::var_os(name).map(|value| (*name, value)))
        .collect()
}

fn read_private_config(path: &Path, directory: &Path) -> Result<LauncherConfig, String> {
    let directory_metadata = fs::symlink_metadata(directory)
        .map_err(|error| format!("private launcher directory is unavailable: {error}"))?;
    if !directory_metadata.is_dir() || directory_metadata.file_type().is_symlink() {
        return Err("private launcher directory is not a real directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if directory_metadata.mode() & 0o077 != 0
            || directory_metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err("private launcher directory permissions are unsafe".into());
        }
    }

    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("private launcher config is unavailable: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > CONFIG_LIMIT {
        return Err("private launcher config is not a bounded regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("private launcher config permissions are unsafe".into());
        }
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|file| file.take(CONFIG_LIMIT + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("Could not read private launcher config: {error}"))?;
    if bytes.len() as u64 > CONFIG_LIMIT {
        return Err("private launcher config exceeds its size limit".into());
    }
    let config: LauncherConfig = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Private launcher config is invalid: {error}"))?;
    if config.version != 1 {
        return Err("private launcher config version is unsupported".into());
    }
    if let Some(path) = config.ffmpeg.as_ref() {
        validate_tool_path(path)?;
    }
    if let Some(path) = config.ffprobe.as_ref() {
        validate_tool_path(path)?;
    }
    Ok(config)
}

fn validate_tool_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().len() > PATH_LIMIT || !path.is_absolute() {
        return Err("configured media-tool path is outside the allowed bounds".into());
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("configured media tool is unavailable: {error}"))?;
    if !metadata.is_file() {
        return Err("configured media tool is not a regular file".into());
    }
    Ok(())
}

fn resolve_executable(path: &Path) -> Option<PathBuf> {
    if is_bare_name(path) {
        return resolve_from_path(path.as_os_str());
    }
    path.canonicalize()
        .ok()
        .filter(|candidate| candidate.is_file())
}

fn resolve_probe(ffmpeg: &Path) -> Option<PathBuf> {
    let executable = resolve_executable(ffmpeg)?;
    let selected = if is_bare_name(ffmpeg) {
        &executable
    } else {
        ffmpeg
    };
    let name = selected.file_name()?.to_string_lossy().to_ascii_lowercase();
    let probe_name = match name.as_str() {
        "ffmpeg" => Some("ffprobe".to_string()),
        "ffmpeg.exe" => Some("ffprobe.exe".to_string()),
        _ => name
            .strip_prefix("rosi-ffmpeg")
            .map(|suffix| format!("rosi-ffprobe{suffix}")),
    };
    let sibling = probe_name.and_then(|name| selected.parent().map(|parent| parent.join(name)));
    sibling
        .as_deref()
        .and_then(resolve_executable)
        .filter(|probe| probe != &executable)
        .or_else(|| {
            crate::sidecars::bundled_path(crate::sidecars::FFPROBE_SIDECAR)
                .as_deref()
                .and_then(resolve_executable)
                .filter(|probe| probe != &executable)
        })
        .or_else(|| resolve_path_probe().filter(|probe| probe != &executable))
}

fn resolve_path_probe() -> Option<PathBuf> {
    resolve_from_path(OsStr::new(&format!(
        "ffprobe{}",
        std::env::consts::EXE_SUFFIX
    )))
}

fn is_bare_name(path: &Path) -> bool {
    path.components().count() == 1 && path.file_name().is_some()
}

fn resolve_from_path(name: &OsStr) -> Option<PathBuf> {
    let search_path = crate::process_util::enhanced_path();
    for directory in std::env::split_paths(&search_path) {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return candidate.canonicalize().ok();
        }
        #[cfg(windows)]
        if candidate.extension().is_none() {
            let with_exe = candidate.with_extension("exe");
            if with_exe.is_file() {
                return with_exe.canonicalize().ok();
            }
        }
    }
    None
}

#[cfg(test)]
mod audit4_tests {
    use super::*;

    #[test]
    fn probe_uses_the_selected_sibling_and_never_ffmpeg() {
        let root = std::env::temp_dir().join(crate::fs_util::uuid_v4());
        fs::create_dir(&root).unwrap();
        let ffmpeg = root.join("FFMPEG");
        let ffprobe = root.join(format!("ffprobe{}", std::env::consts::EXE_SUFFIX));
        fs::write(&ffmpeg, "ffmpeg fixture").unwrap();
        fs::write(&ffprobe, "ffprobe fixture").unwrap();
        assert_eq!(
            resolve_probe(&ffmpeg),
            Some(ffprobe.canonicalize().unwrap())
        );
        #[cfg(unix)]
        {
            let lexical = root.join("ffmpeg");
            // A separate directory avoids case-insensitive filesystem aliases.
            let selected = root.join("selected");
            fs::create_dir(&selected).unwrap();
            std::os::unix::fs::symlink(&ffmpeg, selected.join("ffmpeg")).unwrap();
            std::os::unix::fs::symlink(&ffmpeg, selected.join("ffprobe")).unwrap();
            assert_ne!(
                resolve_probe(&selected.join("ffmpeg")),
                Some(ffmpeg.canonicalize().unwrap())
            );
            let _ = lexical;
        }
        fs::remove_dir_all(root).unwrap();
    }
}
