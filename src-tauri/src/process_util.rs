//! Child-process helpers: a minimal allow-listed environment, an enhanced
//! PATH for GUI launches, no console windows on Windows, process-group
//! spawning, whole-tree termination, and bounded output capture.

use shared_child::SharedChild;
use std::ffi::OsStr;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const ENV_ALLOWLIST: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "SystemRoot",
    "SYSTEMDRIVE",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "PROGRAMDATA",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "COMSPEC",
    "WINDIR",
    "PATHEXT",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_ARCHITEW6432",
    "NUMBER_OF_PROCESSORS",
    "XDG_RUNTIME_DIR",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "FLATPAK_ID",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
    "PYTHONUNBUFFERED",
];

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn env_path(name: &str) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// PATH with common per-user tool locations prepended, so GUI launches (which
/// inherit a minimal PATH on macOS) still find Deno, Homebrew, and similar.
pub fn enhanced_path() -> std::ffi::OsString {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut entries: Vec<PathBuf> = if cfg!(windows) {
        vec![
            env_path("USERPROFILE").join(".deno").join("bin"),
            env_path("LOCALAPPDATA").join("deno").join("bin"),
            // winget portable packages (Deno via "Install") link here; the
            // user PATH entry only reaches processes started after install.
            env_path("LOCALAPPDATA")
                .join("Microsoft")
                .join("WinGet")
                .join("Links"),
            PathBuf::from("C:\\Program Files\\deno"),
            PathBuf::from("C:\\deno"),
        ]
    } else {
        let home = crate::app_state::home_dir().unwrap_or_default();
        vec![
            home.join(".deno").join("bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
            PathBuf::from("/sbin"),
            PathBuf::from("/home/linuxbrew/.linuxbrew/bin"),
            home.join(".local").join("bin"),
        ]
    };
    entries.extend(std::env::split_paths(&current));
    entries.retain(|entry| !entry.as_os_str().is_empty());
    std::env::join_paths(entries).unwrap_or(current)
}

#[cfg(target_os = "linux")]
fn mounted_noexec(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    unsafe { libc::statvfs(path.as_ptr(), &mut stat) == 0 && stat.f_flag & libc::ST_NOEXEC != 0 }
}

/// The bundled yt-dlp is a PyInstaller build that unpacks and maps shared
/// libraries from TMPDIR, so it cannot start when the temp dir is mounted
/// noexec (a common hardening). Returns a private exec-capable replacement.
#[cfg(target_os = "linux")]
fn exec_capable_tmpdir() -> Option<PathBuf> {
    static DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let current = std::env::temp_dir();
        if !mounted_noexec(&current) {
            return None;
        }
        let fallback = crate::app_state::data_dir().join("tmp");
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&fallback)
            .ok()?;
        if mounted_noexec(&fallback) {
            crate::logging::warn(&format!(
                "{} and {} are mounted noexec; yt-dlp may fail to start.",
                current.display(),
                fallback.display()
            ));
            return None;
        }
        crate::logging::info(&format!(
            "{} is mounted noexec; helper processes use {} instead.",
            current.display(),
            fallback.display()
        ));
        Some(fallback)
    })
    .clone()
}

/// Build a command with piped stdout/stderr, null stdin, and a scrubbed
/// environment. `new_group` makes the child a process-group leader on Unix so
/// the whole tree (e.g. yt-dlp's merge FFmpeg) can be signalled together.
pub fn command<P: AsRef<OsStr>>(
    program: P,
    args: &[String],
    extra_env: &[(&str, &str)],
    new_group: bool,
) -> Command {
    let mut command = Command::new(program);
    command.args(args);
    command.env_clear();
    for key in ENV_ALLOWLIST {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    // yt-dlp is a frozen Python app. Without these, Windows pipes use the
    // legacy ANSI code page and non-Latin titles/paths reach us mangled.
    command.env("PYTHONUTF8", "1");
    command.env("PYTHONIOENCODING", "utf-8");
    #[cfg(target_os = "linux")]
    if let Some(dir) = exec_capable_tmpdir() {
        command.env("TMPDIR", dir);
    }
    for (key, value) in extra_env {
        command.env(key, value);
    }
    command.env("PATH", enhanced_path());
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = new_group;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        if new_group {
            command.process_group(0);
        }
    }
    command
}

pub fn spawn(command: &mut Command) -> std::io::Result<Arc<SharedChild>> {
    SharedChild::spawn(command).map(Arc::new)
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: i32) -> bool {
    // A process-group leader has PGID == PID. For children that were not
    // spawned as leaders this targets an empty group and fails harmlessly.
    unsafe { libc::killpg(pid as libc::pid_t, signal) == 0 }
}

/// Stop a child and its descendants. Unix: SIGTERM to the process group, then
/// SIGKILL after five seconds. Windows: `taskkill /T /F` (PyInstaller yt-dlp
/// runs its payload in a child process that a plain TerminateProcess orphans).
pub fn terminate_tree(child: &Arc<SharedChild>) {
    let pid = child.id();
    #[cfg(unix)]
    {
        if !signal_group(pid, libc::SIGTERM) {
            let _ = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
        }
        let child = Arc::clone(child);
        std::thread::spawn(move || {
            if matches!(child.wait_timeout(Duration::from_secs(5)), Ok(None)) {
                signal_group(pid, libc::SIGKILL);
                let _ = child.kill();
            }
        });
    }
    #[cfg(windows)]
    {
        // Absolute path: never resolve taskkill through a user-controlled PATH.
        let taskkill_exe = std::env::var_os("SystemRoot")
            .map(|root| PathBuf::from(root).join("System32").join("taskkill.exe"))
            .filter(|path| path.is_file())
            .unwrap_or_else(|| PathBuf::from("taskkill.exe"));
        let mut taskkill = command(
            taskkill_exe,
            &[
                "/PID".to_string(),
                pid.to_string(),
                "/T".to_string(),
                "/F".to_string(),
            ],
            &[],
            false,
        );
        taskkill.stdout(Stdio::null()).stderr(Stdio::null());
        let _ = taskkill.status();
        let _ = child.kill();
    }
}

fn drain<R: Read + Send + 'static>(
    reader: Option<R>,
    limit: usize,
) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let Some(mut reader) = reader else {
            return String::new();
        };
        let mut kept = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let room = limit.saturating_sub(kept.len());
                    kept.extend_from_slice(&chunk[..read.min(room)]);
                }
            }
        }
        String::from_utf8_lossy(&kept).into_owned()
    })
}

pub struct Output {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Run a command to completion (or timeout), capturing bounded output.
pub fn run_with_timeout(
    command: &mut Command,
    timeout: Duration,
    max_stdout: usize,
    max_stderr: usize,
) -> std::io::Result<Output> {
    let child = spawn(command)?;
    wait_with_output(&child, timeout, max_stdout, max_stderr)
}

pub fn wait_with_output(
    child: &Arc<SharedChild>,
    timeout: Duration,
    max_stdout: usize,
    max_stderr: usize,
) -> std::io::Result<Output> {
    let stdout = drain(child.take_stdout(), max_stdout);
    let stderr = drain(child.take_stderr(), max_stderr);
    let mut timed_out = false;
    let status = match child.wait_timeout(timeout)? {
        Some(status) => status,
        None => {
            timed_out = true;
            terminate_tree(child);
            child.wait()?
        }
    };
    Ok(Output {
        code: status.code(),
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
        timed_out,
    })
}

/// A cancellable, single-slot child process (formats / video-info lookups).
pub struct TrackedSlot {
    current: Mutex<Option<(Arc<SharedChild>, Arc<std::sync::atomic::AtomicBool>)>>,
}

pub enum TrackedError {
    Spawn(String),
    Cancelled,
    TimedOut,
}

impl TrackedSlot {
    pub const fn new() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }

    pub fn cancel(&self) {
        let current = self
            .current
            .lock()
            .map(|mut slot| slot.take())
            .unwrap_or(None);
        if let Some((child, cancelled)) = current {
            cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
            terminate_tree(&child);
        }
    }

    /// Replace any running child with a new one and wait for it.
    pub fn run(
        &self,
        mut command: Command,
        timeout: Duration,
        max_stdout: usize,
        max_stderr: usize,
    ) -> Result<Output, TrackedError> {
        self.cancel();
        let child = spawn(&mut command).map_err(|error| TrackedError::Spawn(error.to_string()))?;
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        if let Ok(mut slot) = self.current.lock() {
            *slot = Some((Arc::clone(&child), Arc::clone(&cancelled)));
        }
        let output = wait_with_output(&child, timeout, max_stdout, max_stderr);
        if let Ok(mut slot) = self.current.lock() {
            if slot
                .as_ref()
                .is_some_and(|(owned, _)| Arc::ptr_eq(owned, &child))
            {
                *slot = None;
            }
        }
        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(TrackedError::Cancelled);
        }
        let output = output.map_err(|error| TrackedError::Spawn(error.to_string()))?;
        if output.timed_out {
            return Err(TrackedError::TimedOut);
        }
        Ok(output)
    }
}
