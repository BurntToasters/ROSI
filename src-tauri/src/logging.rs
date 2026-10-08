//! Rolling local diagnostics log (`<app data>/logs/rosi.log`), replacing
//! electron-log. Lines are single-line, timestamped, and size-trimmed.

use std::io::Write;
use std::sync::Mutex;

const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_RENDERER_MESSAGE_CHARS: usize = 2000;

static LOG_LOCK: Mutex<()> = Mutex::new(());

fn log_path() -> std::path::PathBuf {
    crate::app_state::data_dir().join("logs").join("rosi.log")
}

/// UTC `YYYY-MM-DDTHH:MM:SS.mmmZ` without pulling in a date crate.
pub fn iso_timestamp(millis: u64) -> String {
    let seconds = millis / 1000;
    let days = (seconds / 86_400) as i64;
    let secs_of_day = seconds % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
        millis % 1000
    )
}

fn trim_if_needed(path: &std::path::Path) {
    let Ok(metadata) = std::fs::metadata(path) else {
        return;
    };
    if metadata.len() <= MAX_LOG_FILE_BYTES {
        return;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return;
    };
    let keep_from = bytes
        .len()
        .saturating_sub((MAX_LOG_FILE_BYTES / 2) as usize);
    let tail = &bytes[keep_from..];
    let start = tail
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let _ = crate::fs_util::atomic_write(path, &tail[start..]);
}

fn write_line(level: &str, message: &str) {
    let line = message.replace(['\r', '\n'], " ");
    if cfg!(debug_assertions) {
        eprintln!("[{level}] {line}");
    }
    let Ok(_guard) = LOG_LOCK.lock() else {
        return;
    };
    append_line(level, &line);
}

fn append_line(level: &str, line: &str) {
    let path = log_path();
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    trim_if_needed(&path);
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(&path) {
        let _ = writeln!(
            file,
            "{} [{level}] {line}",
            iso_timestamp(crate::app_state::now_ms())
        );
    }
}

thread_local! {
    static IN_PANIC_HOOK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Record panics in the rosi log before the previous hook runs. The log lock
/// may be held by the panicking thread, so the hook only try-locks and
/// otherwise appends unlocked. Re-entrant panics are ignored.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let reentered = IN_PANIC_HOOK.with(|flag| flag.replace(true));
        if !reentered {
            let payload = info
                .payload()
                .downcast_ref::<&str>()
                .map(|text| text.to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "<non-string panic payload>".to_string());
            let location = info
                .location()
                .map(|at| format!("{}:{}", at.file(), at.line()))
                .unwrap_or_else(|| "<unknown location>".to_string());
            let thread = std::thread::current();
            let name = thread.name().unwrap_or("<unnamed>");
            let message = format!("PANIC in thread '{name}' at {location}: {payload}")
                .replace(['\r', '\n'], " ");
            let _guard = LOG_LOCK.try_lock();
            append_line("panic", &message);
            IN_PANIC_HOOK.with(|flag| flag.set(false));
        }
        previous(info);
    }));
}

pub fn info(message: &str) {
    write_line("info", message);
}

pub fn warn(message: &str) {
    write_line("warn", message);
}

pub fn error(message: &str) {
    write_line("error", message);
}

#[tauri::command(async)]
pub fn log_error(message: serde_json::Value) {
    let Some(text) = message.as_str() else {
        return;
    };
    let truncated: String = if text.chars().count() > MAX_RENDERER_MESSAGE_CHARS {
        let head: String = text.chars().take(MAX_RENDERER_MESSAGE_CHARS).collect();
        format!("{head}...(truncated)")
    } else {
        text.to_string()
    };
    error(&format!("[renderer] {truncated}"));
}
