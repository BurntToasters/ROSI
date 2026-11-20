//! POSIX watchdog: stops helper process groups when ROSI dies without cleanup.
//!
//! ROSI re-executes its own binary with `--rosi-process-watchdog` and keeps the
//! write end of a pipe. The watchdog reads newline-separated messages from it:
//! `+<pgid>` when ROSI starts a child process group, `-<pgid>` when that group
//! is finished, and `q` on a clean exit. End of file without `q` means ROSI
//! died: every registered group gets SIGTERM, then SIGKILL after the grace
//! period. This covers macOS (no `PR_SET_PDEATHSIG`) and processes that yt-dlp
//! starts itself on Linux.
//!
//! Only `std` and `libc` are used, so the module stands alone.

use std::ffi::OsStr;
use std::io::{self, Read};
use std::os::unix::io::AsRawFd;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Private argument that selects watchdog mode. It must be the first argument.
pub const ARG: &str = "--rosi-process-watchdog";

/// Time between SIGTERM and SIGKILL, for ROSI's own terminations and for the
/// watchdog.
pub const GRACE_PERIOD: Duration = Duration::from_secs(5);

const CLEAN_EXIT: &[u8] = b"q";
const MAX_LINE: usize = 32;
const MAX_GROUPS: usize = 4096;

// ROSI side.

static PIPE: Mutex<Option<ChildStdin>> = Mutex::new(None);
static FINISHED: AtomicBool = AtomicBool::new(false);

/// Starts the watchdog. Call once, after the private-mode dispatch.
pub fn start() -> io::Result<()> {
    let mut child = Command::new(std::env::current_exe()?)
        .arg(ARG)
        .stdin(Stdio::piped())
        // The watchdog must not hold ROSI's captured output pipes open.
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let Some(stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(io::Error::other("the watchdog pipe is missing"));
    };
    // A full pipe must fail a write, never block the caller.
    let fd = stdin.as_raw_fd();
    // SAFETY: `fd` is the open write end owned by `stdin`.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    // SAFETY: as above.
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        let error = io::Error::last_os_error();
        drop(stdin);
        let _ = child.wait();
        return Err(error);
    }
    // Reap the watchdog if it exits early, so it does not stay a zombie.
    let _ = std::thread::Builder::new()
        .name("rosi-watchdog-reaper".into())
        .spawn(move || {
            let _ = child.wait();
        });
    *PIPE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(stdin);
    Ok(())
}

/// Tells the watchdog a child process group now exists. Does nothing when no
/// watchdog was started (for example in a helper process).
pub fn register_group(pgid: u32) -> io::Result<()> {
    send(format!("+{pgid}\n").as_bytes())
}

/// Tells the watchdog a child process group has ended.
pub fn unregister_group(pgid: u32) -> io::Result<()> {
    send(format!("-{pgid}\n").as_bytes())
}

/// Tells the watchdog ROSI is exiting normally, so it must not kill anything.
pub fn clean_exit() -> io::Result<()> {
    let result = send(b"q\n");
    FINISHED.store(true, Ordering::SeqCst);
    result
}

fn send(message: &[u8]) -> io::Result<()> {
    if FINISHED.load(Ordering::SeqCst) {
        return Ok(());
    }
    let guard = PIPE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(pipe) = guard.as_ref() else {
        return Ok(());
    };
    loop {
        // SAFETY: the descriptor stays open while `guard` holds the pipe, and
        // the buffer is valid for `message.len()` bytes.
        let written = unsafe {
            libc::write(
                pipe.as_raw_fd(),
                message.as_ptr().cast::<libc::c_void>(),
                message.len(),
            )
        };
        if written < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        // Writes up to PIPE_BUF are all or nothing, so a short write means the
        // pipe is not usable.
        if written as usize != message.len() {
            return Err(io::Error::other("short write to the watchdog pipe"));
        }
        return Ok(());
    }
}

// Watchdog side.

/// Runs the watchdog when this process was started in watchdog mode. Returns
/// the exit code, or None for a normal ROSI start.
pub fn dispatch_from_argv() -> Option<i32> {
    let mut arguments = std::env::args_os();
    arguments.next()?;
    if arguments.next()?.as_os_str() != OsStr::new(ARG) {
        return None;
    }
    Some(run())
}

enum Ending {
    Clean,
    RosiDied,
}

fn run() -> i32 {
    // Leave ROSI's session and process group, so whatever reaches ROSI does
    // not reach the watchdog. This fails harmlessly if already a leader.
    // SAFETY: setsid has no preconditions.
    unsafe {
        libc::setsid();
        // Only SIGKILL ends the watchdog before ROSI does.
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    close_inherited_descriptors();
    let mut groups = Vec::new();
    if let Ending::RosiDied = watch(&mut groups) {
        terminate_groups(&mut groups);
    }
    0
}

/// Closes everything except stdin (the pipe) and the other standard streams.
fn close_inherited_descriptors() {
    // SAFETY: sysconf and close take plain integers.
    unsafe {
        let limit = libc::sysconf(libc::_SC_OPEN_MAX);
        let limit = if limit < 0 { 1024 } else { limit.min(65_536) };
        for descriptor in 3..limit as libc::c_int {
            libc::close(descriptor);
        }
    }
}

fn watch(groups: &mut Vec<i32>) -> Ending {
    // SAFETY: getpgrp has no preconditions.
    let own_group = unsafe { libc::getpgrp() };
    let mut input = io::stdin().lock();
    let mut buffer = [0u8; 256];
    let mut line = Vec::with_capacity(MAX_LINE);
    let mut overflow = false;
    loop {
        let read = match input.read(&mut buffer) {
            Ok(0) => return Ending::RosiDied,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            // The pipe cannot be watched any more, which is the same as ROSI
            // being gone.
            Err(_) => return Ending::RosiDied,
        };
        for &byte in &buffer[..read] {
            if byte != b'\n' {
                if line.len() < MAX_LINE {
                    line.push(byte);
                } else {
                    overflow = true;
                }
                continue;
            }
            if !overflow && line == CLEAN_EXIT {
                return Ending::Clean;
            }
            if !overflow {
                apply(&line, own_group, groups);
            }
            line.clear();
            overflow = false;
        }
    }
}

/// Handles one `+<pgid>` or `-<pgid>` line. Anything else is ignored.
fn apply(line: &[u8], own_group: i32, groups: &mut Vec<i32>) {
    let Some((&sign, digits)) = line.split_first() else {
        return;
    };
    let Some(pgid) = std::str::from_utf8(digits)
        .ok()
        .and_then(|digits| digits.parse::<u32>().ok())
        .and_then(|pgid| i32::try_from(pgid).ok())
    else {
        return;
    };
    // Group 0 and 1 mean "my group" and "init"; never signal them or our own.
    if pgid <= 1 || pgid == own_group {
        return;
    }
    match sign {
        b'+' => {
            if !groups.contains(&pgid) && groups.len() < MAX_GROUPS {
                groups.push(pgid);
            }
        }
        b'-' => groups.retain(|group| *group != pgid),
        _ => {}
    }
}

fn group_exists(pgid: i32) -> bool {
    // SAFETY: signal 0 only checks that the group exists.
    unsafe { libc::kill(-pgid, 0) == 0 }
}

fn terminate_groups(groups: &mut Vec<i32>) {
    for &pgid in groups.iter() {
        // SAFETY: `apply` only stores PGIDs above 1 that are not our own.
        unsafe {
            libc::kill(-pgid, libc::SIGTERM);
        }
    }
    let deadline = Instant::now() + GRACE_PERIOD;
    loop {
        groups.retain(|&pgid| group_exists(pgid));
        if groups.is_empty() || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    for &pgid in groups.iter() {
        // SAFETY: as above.
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
}
