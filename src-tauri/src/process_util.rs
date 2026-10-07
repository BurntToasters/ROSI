//! Child-process helpers: a minimal allow-listed environment, an enhanced
//! PATH for GUI launches, no console windows on Windows, process-group
//! spawning, whole-tree termination, and bounded output capture.

use shared_child::SharedChild;
use std::ffi::OsStr;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
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

const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_SUSPENDED: u32 = 0x0000_0004;

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
    #[cfg(windows)]
    if let Some(directory) = std::env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(PathBuf::from))
    {
        // Private FFmpeg launcher copies are invoked by yt-dlp from a temp
        // directory. Keep ROSI's packaged app-local DLL directory on their
        // inherited PATH so the early helper mode retains normal DLL lookup.
        entries.insert(0, directory);
    }
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

/// Temp location for executable helper aliases. On Linux, do not create them
/// on a noexec temp mount where Python/FFmpeg subprocess launch would fail.
pub fn executable_temp_dir() -> Result<PathBuf, String> {
    let current = std::env::temp_dir();
    #[cfg(target_os = "linux")]
    {
        if !mounted_noexec(&current) {
            return Ok(current);
        }
        return exec_capable_tmpdir().ok_or_else(|| {
            "The system temporary directory is noexec and no executable helper directory is available."
                .to_string()
        });
    }
    #[cfg(not(target_os = "linux"))]
    Ok(current)
}

/// Build a command with piped stdout/stderr, null stdin, and a scrubbed
/// environment. `new_group` makes the child a process-group leader on Unix so
/// the whole tree (e.g. yt-dlp's merge FFmpeg) can be signalled together. On
/// Windows, the child starts suspended and resumes after Job Object assignment.
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
        // Do not let user-space code create descendants before this process
        // belongs to its owned Job Object.
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
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

struct ManagedState {
    status: Option<std::process::ExitStatus>,
    terminating: bool,
    owned_group_survivors: bool,
}

/// Shared child handle with a short polling gate around reaping. Tree
/// termination holds the gate while it escalates, so a waiter cannot reap the
/// group leader and free its PID before the process group has been checked.
pub struct ManagedChild {
    child: SharedChild,
    state: Mutex<ManagedState>,
    #[cfg(unix)]
    process_group: bool,
    #[cfg(windows)]
    job: WindowsJob,
}

#[cfg(windows)]
struct WindowsJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

// The owned kernel handle stays valid until the final Arc<ManagedChild> drops.
// TerminateJobObject is safe to call concurrently with waiting on the child.
#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, 1);
        }
    }
}

#[cfg(windows)]
fn assign_windows_job(pid: u32) -> std::io::Result<WindowsJob> {
    use std::ptr::null;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_SUSPEND_RESUME, PROCESS_TERMINATE,
    };

    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let owned_job = WindowsJob { handle: job };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err(std::io::Error::last_os_error());
    }

    let process: HANDLE = unsafe {
        OpenProcess(
            PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_SUSPEND_RESUME,
            0,
            pid,
        )
    };
    if process.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let assigned = unsafe { AssignProcessToJobObject(job, process) };
    if assigned == 0 {
        let error = std::io::Error::last_os_error();
        unsafe {
            CloseHandle(process);
        }
        return Err(error);
    }

    // CommandExt::creation_flags starts the primary thread suspended, so the
    // process cannot spawn descendants before it joins this owned job.
    #[link(name = "ntdll")]
    extern "system" {
        fn NtResumeProcess(process_handle: HANDLE) -> i32;
    }
    let resumed = unsafe { NtResumeProcess(process) } >= 0;
    let resume_error = (!resumed).then(std::io::Error::last_os_error);
    unsafe {
        CloseHandle(process);
    }
    if let Some(error) = resume_error {
        return Err(error);
    }
    Ok(owned_job)
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE reaps descendants even if
            // the leader exited before the owner finished draining its pipes.
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.handle);
            }
        }
    }
}

impl ManagedChild {
    fn state(&self) -> std::sync::MutexGuard<'_, ManagedState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn take_stdout(&self) -> Option<std::process::ChildStdout> {
        self.child.take_stdout()
    }

    pub fn take_stderr(&self) -> Option<std::process::ChildStderr> {
        self.child.take_stderr()
    }

    pub fn wait_timeout(
        self: &Arc<Self>,
        timeout: Duration,
    ) -> std::io::Result<Option<std::process::ExitStatus>> {
        let deadline = std::time::Instant::now().checked_add(timeout);
        loop {
            let mut state = self.state();
            if let Some(status) = state.status.as_ref() {
                let status = *status;
                let clean_group = state.owned_group_survivors;
                drop(state);
                if clean_group {
                    terminate_tree(self);
                }
                return Ok(Some(status));
            }
            // Keep cancellation responsive while retaining exclusive control
            // of the small interval in which SharedChild may reap the leader.
            let poll = deadline
                .map(|deadline| deadline.saturating_duration_since(std::time::Instant::now()))
                .unwrap_or(Duration::from_millis(50))
                .min(Duration::from_millis(50));
            #[cfg(unix)]
            let status = if child_exit_observed(self.child.id())? {
                if self.process_group {
                    // WNOWAIT keeps the exited group leader as a zombie until
                    // after this signal, so its PID/PGID cannot be reused.
                    // Once the leader has exited, any remaining group member
                    // is an orphaned helper and must not outlive the operation.
                    signal_group(self.child.id(), libc::SIGKILL);
                }
                Some(self.child.wait()?)
            } else {
                None
            };
            #[cfg(windows)]
            let status = self.child.wait_timeout(poll)?;
            if let Some(status) = status {
                #[cfg(windows)]
                self.job.terminate();
                state.owned_group_survivors = false;
                state.status = Some(status);
                state.terminating = false;
                return Ok(Some(status));
            }
            if deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
                return Ok(None);
            }
            drop(state);
            if cfg!(unix) {
                std::thread::sleep(poll);
            }
        }
    }

    pub fn wait(self: &Arc<Self>) -> std::io::Result<std::process::ExitStatus> {
        loop {
            if let Some(status) = self.wait_timeout(Duration::from_secs(24 * 60 * 60))? {
                return Ok(status);
            }
        }
    }
}

#[cfg(unix)]
fn child_exit_observed(pid: u32) -> std::io::Result<bool> {
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == 0 {
            return Ok(info.si_signo == libc::SIGCHLD);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

pub fn spawn(command: &mut Command) -> std::io::Result<Arc<ManagedChild>> {
    let child = SharedChild::spawn(command)?;
    #[cfg(windows)]
    let job = match assign_windows_job(child.id()) {
        Ok(job) => job,
        Err(error) => {
            // The process was created suspended. If ownership cannot be
            // established, terminate it before returning the spawn failure.
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    #[cfg(unix)]
    let process_group =
        unsafe { libc::getpgid(child.id() as libc::pid_t) == child.id() as libc::pid_t };
    Ok(Arc::new(ManagedChild {
        child,
        state: Mutex::new(ManagedState {
            status: None,
            terminating: false,
            owned_group_survivors: false,
        }),
        #[cfg(unix)]
        process_group,
        #[cfg(windows)]
        job,
    }))
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: i32) -> bool {
    // A process-group leader has PGID == PID. For children that were not
    // spawned as leaders this targets an empty group and fails harmlessly.
    unsafe { libc::killpg(pid as libc::pid_t, signal) == 0 }
}

/// Stop a child and its descendants. Unix: SIGTERM to the process group, then
/// SIGKILL after five seconds. Windows: terminate the owned kill-on-close job.
pub fn terminate_tree(child: &Arc<ManagedChild>) {
    #[cfg(unix)]
    let pid = child.id();
    let mut state = child.state();
    if state.terminating {
        return;
    }
    if state.status.is_some() && !state.owned_group_survivors {
        return;
    }
    state.terminating = true;
    #[cfg(unix)]
    {
        if child.process_group {
            if !signal_group(pid, libc::SIGTERM) {
                let _ = child.child.kill();
            }
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                match child_exit_observed(pid) {
                    Ok(true) => {
                        // WNOWAIT leaves our exited leader unreaped, pinning
                        // its PID/PGID while orphaned descendants are killed.
                        signal_group(pid, libc::SIGKILL);
                        break;
                    }
                    Ok(false) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    Ok(false) => {
                        // The still-live group leader pins this PGID, so the
                        // bounded grace-period escalation cannot hit a reused
                        // process group.
                        signal_group(pid, libc::SIGKILL);
                        let _ = child.child.kill();
                        break;
                    }
                    Err(_) => {
                        // If ownership can no longer be proven with waitid,
                        // only target the specific child handle.
                        let _ = child.child.kill();
                        break;
                    }
                }
            }
        } else {
            let _ = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
            if matches!(child.child.wait_timeout(Duration::from_secs(5)), Ok(None)) {
                let _ = child.child.kill();
            }
        }
        if let Ok(status) = child.child.wait() {
            state.status = Some(status);
        }
    }
    #[cfg(windows)]
    {
        child.job.terminate();
        let _ = child.child.kill();
        if let Ok(status) = child.child.wait() {
            state.status = Some(status);
        }
    }
    state.owned_group_survivors = false;
    state.terminating = false;
}

fn drain<R: Read + Send + 'static>(reader: Option<R>, limit: usize) -> mpsc::Receiver<String> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let Some(mut reader) = reader else {
            let _ = sender.send(String::new());
            return;
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
        let _ = sender.send(String::from_utf8_lossy(&kept).into_owned());
    });
    receiver
}

fn receive_drain(receiver: mpsc::Receiver<String>, deadline: std::time::Instant) -> (String, bool) {
    match receiver.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
        Ok(output) => (output, true),
        Err(mpsc::RecvTimeoutError::Disconnected) => (String::new(), true),
        Err(mpsc::RecvTimeoutError::Timeout) => (String::new(), false),
    }
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
    child: &Arc<ManagedChild>,
    timeout: Duration,
    max_stdout: usize,
    max_stderr: usize,
) -> std::io::Result<Output> {
    let stdout = drain(child.take_stdout(), max_stdout);
    let stderr = drain(child.take_stderr(), max_stderr);
    let mut timed_out = false;
    let mut wait_error = None;
    let status = match child.wait_timeout(timeout) {
        Ok(Some(status)) => Some(status),
        Ok(None) => {
            timed_out = true;
            terminate_tree(child);
            child.wait().ok()
        }
        Err(error) => {
            wait_error = Some(error);
            terminate_tree(child);
            child.wait().ok()
        }
    };
    let drain_deadline = std::time::Instant::now() + PIPE_DRAIN_TIMEOUT;
    let (stdout, stdout_drained) = receive_drain(stdout, drain_deadline);
    let (stderr, stderr_drained) = receive_drain(stderr, drain_deadline);
    timed_out |= !stdout_drained || !stderr_drained;
    if let Some(error) = wait_error {
        return Err(error);
    }
    let Some(status) = status else {
        return Err(std::io::Error::other(
            "Child process status is unavailable.",
        ));
    };
    let output = Output {
        code: status.code(),
        stdout,
        stderr,
        timed_out,
    };
    Ok(output)
}

/// A cancellable, single-slot child process (formats / video-info lookups).
pub struct TrackedSlot {
    state: Mutex<TrackedState>,
    starting: Mutex<()>,
}

struct TrackedState {
    generation: u64,
    current: Option<TrackedOperation>,
}

struct TrackedOperation {
    generation: u64,
    child: Option<Arc<ManagedChild>>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
}

pub enum TrackedError {
    Spawn(String),
    Cancelled,
    TimedOut,
}

/// A single-slot reservation acquired at the IPC boundary, before validation
/// or work can be queued. Dropping it releases the slot only if no newer
/// request has replaced it.
pub struct TrackedReservation<'a> {
    slot: &'a TrackedSlot,
    generation: u64,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
}

impl TrackedReservation<'_> {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn cancellation_flag(&self) -> Arc<std::sync::atomic::AtomicBool> {
        Arc::clone(&self.cancelled)
    }
}

impl Drop for TrackedReservation<'_> {
    fn drop(&mut self) {
        self.slot
            .release_reservation(self.generation, &self.cancelled);
    }
}

impl TrackedSlot {
    pub const fn new() -> Self {
        Self {
            state: Mutex::new(TrackedState {
                generation: 0,
                current: None,
            }),
            starting: Mutex::new(()),
        }
    }

    pub fn cancel(&self) {
        let operation = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.generation = state.generation.wrapping_add(1);
            state.current.take()
        };
        if let Some(operation) = operation {
            operation
                .cancelled
                .store(true, std::sync::atomic::Ordering::SeqCst);
            if let Some(child) = operation.child {
                terminate_tree(&child);
            }
        }
    }

    /// Reserve the slot before validation, blocking-pool queueing, or secure
    /// helper setup. Replacing a pending reservation invalidates its token;
    /// replacing a running one also terminates its process tree.
    pub fn reserve(&self) -> TrackedReservation<'_> {
        let starting = self
            .starting
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (generation, previous) = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.generation = state.generation.wrapping_add(1);
            let generation = state.generation;
            let previous = state.current.take();
            state.current = Some(TrackedOperation {
                generation,
                child: None,
                cancelled: Arc::clone(&cancelled),
            });
            (generation, previous)
        };
        if let Some(previous) = previous {
            previous
                .cancelled
                .store(true, std::sync::atomic::Ordering::Release);
            if let Some(child) = previous.child {
                terminate_tree(&child);
            }
        }
        drop(starting);
        TrackedReservation {
            slot: self,
            generation,
            cancelled,
        }
    }

    fn reservation_is_current(&self, reservation: &TrackedReservation<'_>) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.generation == reservation.generation
            && state.current.as_ref().is_some_and(|operation| {
                operation.generation == reservation.generation
                    && Arc::ptr_eq(&operation.cancelled, &reservation.cancelled)
                    && !reservation.is_cancelled()
            })
    }

    fn release_reservation(&self, generation: u64, cancelled: &Arc<std::sync::atomic::AtomicBool>) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.generation == generation
            && state.current.as_ref().is_some_and(|operation| {
                operation.generation == generation && Arc::ptr_eq(&operation.cancelled, cancelled)
            })
        {
            state.current = None;
        }
    }

    /// Run a command using a reservation captured before an asynchronous
    /// handoff. Cancellation during preparation refuses to spawn; cancellation
    /// racing spawn kills the late child before it can become the active job.
    pub fn run_reserved_with<T>(
        &self,
        reservation: TrackedReservation<'_>,
        mut command: Command,
        timeout: Duration,
        max_stdout: usize,
        max_stderr: usize,
        transform: impl FnOnce(Output) -> T,
    ) -> Result<T, TrackedError> {
        // Serialize replacement through publication, but never hold this gate
        // while waiting for a child. `cancel` can still invalidate a pending
        // reservation while spawn is in progress.
        let starting = self
            .starting
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !self.reservation_is_current(&reservation) {
            return Err(TrackedError::Cancelled);
        }
        let child = match spawn(&mut command) {
            Ok(child) => child,
            Err(error) => return Err(TrackedError::Spawn(error.to_string())),
        };
        let registered = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.generation == reservation.generation
                && state.current.as_ref().is_some_and(|operation| {
                    operation.generation == reservation.generation
                        && Arc::ptr_eq(&operation.cancelled, &reservation.cancelled)
                        && !reservation.is_cancelled()
                })
            {
                if let Some(operation) = state.current.as_mut() {
                    operation.child = Some(Arc::clone(&child));
                }
                true
            } else {
                false
            }
        };
        drop(starting);
        if !registered {
            reservation
                .cancelled
                .store(true, std::sync::atomic::Ordering::Release);
            terminate_tree(&child);
            return Err(TrackedError::Cancelled);
        }
        let output = wait_with_output(&child, timeout, max_stdout, max_stderr);
        if !self.reservation_is_current(&reservation) {
            return Err(TrackedError::Cancelled);
        }
        let output = match output {
            Ok(output) => output,
            Err(error) => return Err(TrackedError::Spawn(error.to_string())),
        };
        if output.timed_out {
            return Err(TrackedError::TimedOut);
        }
        let transformed = transform(output);
        if !self.reservation_is_current(&reservation) {
            return Err(TrackedError::Cancelled);
        }
        Ok(transformed)
    }
}
