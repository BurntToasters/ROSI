//! Window lifecycle: startup splash, deferred main-window reveal, the
//! close flow (confirm while busy, flush settings, then destroy), restart, and
//! shutdown cleanup.

use crate::app_state::{MAIN_WINDOW, SPLASH_WINDOW};
use crate::constants::{SETTINGS_FLUSH_TIMEOUT, SPLASH_FADE_DELAY};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub static MAIN_READY: AtomicBool = AtomicBool::new(false);
static CLOSE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static CLOSE_CONFIRMING: AtomicBool = AtomicBool::new(false);
static CLOSE_ACKNOWLEDGED: AtomicBool = AtomicBool::new(false);
static CLOSE_GENERATION: AtomicU64 = AtomicU64::new(0);
// Native dialogs are asynchronous. Keep one timeout warning visible even if
// the user retries close repeatedly while the previous warning is open.
static CLOSE_TIMEOUT_DIALOG_VISIBLE: AtomicBool = AtomicBool::new(false);
static CLOSE_STATE_LOCK: Mutex<()> = Mutex::new(());
pub static APP_QUITTING: AtomicBool = AtomicBool::new(false);

pub fn create_splash(app: &AppHandle) {
    if app.get_webview_window(SPLASH_WINDOW).is_some() {
        return;
    }
    let builder =
        WebviewWindowBuilder::new(app, SPLASH_WINDOW, WebviewUrl::App("splash.html".into()))
            .title("ROSI")
            .inner_size(360.0, 360.0)
            .resizable(false)
            .decorations(false)
            // WebKitGTK transparency depends on the compositor; Linux gets an
            // opaque splash rather than a black box.
            .transparent(!cfg!(target_os = "linux"))
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .center();
    match builder.build() {
        Ok(splash) => {
            // A stuck splash must never outlive a failed startup.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(30));
                let _ = splash.destroy();
            });
        }
        Err(error) => crate::logging::warn(&format!("Could not create splash window: {error}")),
    }
}

fn close_splash(app: &AppHandle) {
    if let Some(splash) = app.get_webview_window(SPLASH_WINDOW) {
        let _ = splash.destroy();
    }
}

/// Only the bundled frontend (and the Vite dev server in debug builds) may
/// load in the main webview.
pub fn is_app_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            host == "tauri.localhost"
                || (cfg!(debug_assertions)
                    && matches!(host, "localhost" | "127.0.0.1")
                    && url.port() == Some(5173))
        }
        "about" => url.as_str() == "about:blank",
        _ => false,
    }
}

/// Hand a blocked navigation to the system browser when it is a safe
/// external URL; everything else is dropped.
fn open_blocked_url(app: &AppHandle, url: &tauri::Url) {
    use tauri_plugin_opener::OpenerExt;
    if crate::validation::is_safe_external_url(url.as_str()) {
        if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
            crate::logging::warn(&format!("Could not open external URL: {error}"));
        }
    } else {
        crate::logging::warn(&format!("Blocked navigation to {}", url.scheme()));
    }
}

/// Injected into every frame of the main window before page scripts run.
/// WebView2 honours F5 / Ctrl+R / Ctrl+P and every engine offers Reload in its
/// default context menu; a reload would drop in-memory download state while
/// yt-dlp keeps running. Editable fields and text selections keep their
/// native menu so right-click Paste and Copy still work.
const WEBVIEW_GUARD_SCRIPT: &str = r#"
(function () {
  if (window.__ROSI_WEBVIEW_GUARD__) return;
  window.__ROSI_WEBVIEW_GUARD__ = true;
  function editable(target) {
    var el = target instanceof Element ? target : null;
    if (!el) return false;
    if (el.closest("textarea, [contenteditable=''], [contenteditable='true']")) return true;
    var input = el.closest("input");
    return !!input && !/^(button|checkbox|radio|range|color|file|submit|reset|image)$/i.test(input.type);
  }
  document.addEventListener("contextmenu", function (event) {
    var selection = window.getSelection && window.getSelection();
    var hasSelection = !!selection && !selection.isCollapsed && String(selection).trim() !== "";
    if (!editable(event.target) && !hasSelection) event.preventDefault();
  }, true);
  window.addEventListener("keydown", function (event) {
    var key = String(event.key || "").toLowerCase();
    var mod = event.ctrlKey || event.metaKey;
    if (key === "f5" || (mod && !event.altKey && (key === "r" || key === "p"))) {
      event.preventDefault();
    }
  }, true);
})();
"#;

/// Native title bar appearance for a saved theme preference. Dark and purple
/// pin a dark bar so it matches the page even when the system appearance is
/// light; the renderer keeps it in sync on later theme changes.
fn window_theme(preference: &str) -> Option<tauri::Theme> {
    match preference {
        "light" => Some(tauri::Theme::Light),
        "dark" | "purple" => Some(tauri::Theme::Dark),
        _ => None,
    }
}

fn build_main(app: &AppHandle) -> Result<WebviewWindow, String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .cloned()
        .ok_or_else(|| "tauri.conf.json has no main window".to_string())?;
    let navigation_app = app.clone();
    let popup_app = app.clone();
    WebviewWindowBuilder::from_config(app, &config)
        .map_err(|error| error.to_string())?
        .theme(window_theme(&crate::settings::load().theme))
        .initialization_script_for_all_frames(WEBVIEW_GUARD_SCRIPT)
        .on_navigation(move |url| {
            if is_app_url(url) {
                return true;
            }
            open_blocked_url(&navigation_app, url);
            false
        })
        .on_new_window(move |url, _features| {
            open_blocked_url(&popup_app, &url);
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
        .map_err(|error| error.to_string())
        .inspect(fit_to_work_area)
}

/// The configured 1200x900 (logical) window is taller than the work area of
/// common 1366x768 laptops at 125% scaling, which leaves the bottom of the UI
/// under the taskbar. Shrink it to fit the monitor the window opens on; the
/// page itself scrolls, and the OS still enforces the configured minimum.
fn fit_to_work_area(window: &WebviewWindow) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let (Some(monitor), Ok(outer), Ok(inner)) = (monitor, window.outer_size(), window.inner_size())
    else {
        return;
    };
    let area = monitor.work_area().size;
    let max_width = area.width.saturating_mul(95) / 100;
    let max_height = area.height.saturating_mul(95) / 100;
    if outer.width <= max_width && outer.height <= max_height {
        return;
    }
    let frame_width = outer.width.saturating_sub(inner.width);
    let frame_height = outer.height.saturating_sub(inner.height);
    let size = tauri::PhysicalSize::new(
        outer.width.min(max_width).saturating_sub(frame_width),
        outer.height.min(max_height).saturating_sub(frame_height),
    );
    let _ = window.set_size(size);
    let _ = window.center();
}

fn reveal(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Create the (hidden) main window if needed, or focus the existing one.
pub fn show_main_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if MAIN_READY.load(Ordering::SeqCst) {
            reveal(&window);
        } else if let Some(splash) = app.get_webview_window(SPLASH_WINDOW) {
            // Relaunched while still starting: bring the splash forward so the
            // second launch visibly lands on the running instance.
            let _ = splash.set_focus();
        }
        return Ok(());
    }
    MAIN_READY.store(false, Ordering::SeqCst);
    let window = build_main(app)?;
    let generation = CLOSE_GENERATION.load(Ordering::SeqCst);
    let handle = app.clone();
    // Fallback: reveal even if the renderer never reports readiness.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(15));
        if CLOSE_GENERATION.load(Ordering::SeqCst) != generation
            || MAIN_READY.load(Ordering::SeqCst)
        {
            return;
        }
        crate::logging::warn("Main window did not report ready in time; showing it anyway.");
        let main_thread = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            close_splash(&main_thread);
            reveal(&window);
        });
    });
    Ok(())
}

#[tauri::command]
pub fn mark_main_window_ready(app: AppHandle, window: WebviewWindow) {
    if window.label() != MAIN_WINDOW || MAIN_READY.swap(true, Ordering::SeqCst) {
        return;
    }
    crate::logging::info("Main window reported ready.");
    let delay = if app.get_webview_window(SPLASH_WINDOW).is_some() {
        SPLASH_FADE_DELAY
    } else {
        std::time::Duration::ZERO
    };
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            close_splash(&handle);
            reveal(&window);
            crate::app_menu::flush_pending_menu_actions(&handle);
        });
    });
}

fn destroy_main(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        cancel_close();
        return Err("The main window was unavailable after state flush.".into());
    };
    if let Err(error) = window.destroy() {
        cancel_close();
        return Err(format!("Could not close the main window: {error}"));
    }
    Ok(())
}

fn cancel_close() {
    let _state = CLOSE_STATE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cancel_close_locked();
}

fn cancel_close_locked() {
    CLOSE_IN_PROGRESS.store(false, Ordering::SeqCst);
    CLOSE_CONFIRMING.store(false, Ordering::SeqCst);
    CLOSE_ACKNOWLEDGED.store(false, Ordering::SeqCst);
    CLOSE_GENERATION.fetch_add(1, Ordering::SeqCst);
    APP_QUITTING.store(false, Ordering::SeqCst);
    crate::logging::warn("Close cancelled because durable state could not be confirmed.");
}

fn cancel_close_generation(generation: u64) -> bool {
    let _state = CLOSE_STATE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if CLOSE_GENERATION.load(Ordering::SeqCst) != generation
        || !CLOSE_IN_PROGRESS.load(Ordering::SeqCst)
    {
        return false;
    }
    cancel_close_locked();
    true
}

fn expire_unacknowledged_close_generation(generation: u64) -> bool {
    let _state = CLOSE_STATE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if CLOSE_GENERATION.load(Ordering::SeqCst) != generation
        || !CLOSE_IN_PROGRESS.load(Ordering::SeqCst)
        || CLOSE_ACKNOWLEDGED.load(Ordering::SeqCst)
    {
        return false;
    }
    cancel_close_locked();
    true
}

fn acknowledge_close_generation(generation: u64) -> bool {
    let _state = CLOSE_STATE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if CLOSE_GENERATION.load(Ordering::SeqCst) != generation
        || !CLOSE_IN_PROGRESS.load(Ordering::SeqCst)
    {
        return false;
    }
    CLOSE_ACKNOWLEDGED.store(true, Ordering::SeqCst);
    true
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_cancel_close_request(window: WebviewWindow, generation: u64) -> Result<(), String> {
    if window.label() != MAIN_WINDOW {
        return Err("Only the main window may cancel an E2E close request.".into());
    }
    let _state = CLOSE_STATE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if CLOSE_GENERATION.load(Ordering::SeqCst) != generation
        || !CLOSE_IN_PROGRESS.load(Ordering::SeqCst)
    {
        return Err("The E2E close request is no longer current.".into());
    }
    CLOSE_IN_PROGRESS.store(false, Ordering::SeqCst);
    CLOSE_CONFIRMING.store(false, Ordering::SeqCst);
    CLOSE_ACKNOWLEDGED.store(false, Ordering::SeqCst);
    CLOSE_GENERATION.fetch_add(1, Ordering::SeqCst);
    APP_QUITTING.store(false, Ordering::SeqCst);
    crate::logging::info("E2E close request retired after renderer flush acknowledgement.");
    Ok(())
}

fn close_generation_is_current(generation: u64) -> bool {
    let _state = CLOSE_STATE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    CLOSE_IN_PROGRESS.load(Ordering::SeqCst)
        && CLOSE_GENERATION.load(Ordering::SeqCst) == generation
}

fn consume_close_generation(generation: u64) -> bool {
    let _state = CLOSE_STATE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !CLOSE_IN_PROGRESS.load(Ordering::SeqCst)
        || !CLOSE_ACKNOWLEDGED.load(Ordering::SeqCst)
        || CLOSE_GENERATION.load(Ordering::SeqCst) != generation
    {
        return false;
    }
    // Retire the token before releasing the lock so a late timeout cannot
    // cancel this close after durability has been confirmed.
    CLOSE_GENERATION.fetch_add(1, Ordering::SeqCst);
    CLOSE_ACKNOWLEDGED.store(false, Ordering::SeqCst);
    true
}

fn begin_flush_and_close(app: AppHandle) {
    let generation = {
        let _state = CLOSE_STATE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        CLOSE_IN_PROGRESS.store(true, Ordering::SeqCst);
        CLOSE_ACKNOWLEDGED.store(false, Ordering::SeqCst);
        CLOSE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1
    };
    crate::app_state::emit("prepare-for-close", generation);
    std::thread::spawn(move || {
        std::thread::sleep(SETTINGS_FLUSH_TIMEOUT);
        if expire_unacknowledged_close_generation(generation) {
            crate::logging::warn(
                "Timed out waiting for renderer settings flush; leaving the app open.",
            );
            if CLOSE_TIMEOUT_DIALOG_VISIBLE
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                app.dialog()
                    .message("ROSI could not confirm that settings and the download queue were saved. The app will stay open. Try closing it again after the save finishes.")
                    .title("Save Still Pending")
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {
                        CLOSE_TIMEOUT_DIALOG_VISIBLE.store(false, Ordering::SeqCst);
                    });
            }
        }
    });
}

/// Main window close: confirm while a download or queue is active, ask the
/// renderer to flush pending settings, then destroy the window.
pub fn on_main_close_requested(app: &AppHandle, api: &tauri::CloseRequestApi) {
    api.prevent_close();
    if CLOSE_IN_PROGRESS.load(Ordering::SeqCst) || CLOSE_CONFIRMING.swap(true, Ordering::SeqCst) {
        return;
    }
    let busy = crate::downloader::is_busy() || crate::queue::is_running();
    let handle = app.clone();
    if !busy {
        CLOSE_CONFIRMING.store(false, Ordering::SeqCst);
        begin_flush_and_close(handle);
        return;
    }
    std::thread::spawn(move || {
        let mut dialog = handle
            .dialog()
            .message("A download is currently in progress.\n\nClosing ROSI now will cancel the active download. Are you sure?")
            .title("Download in Progress")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Close Anyway".to_string(),
                "Cancel".to_string(),
            ));
        if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
            dialog = dialog.parent(&window);
        }
        let confirmed = dialog.blocking_show();
        CLOSE_CONFIRMING.store(false, Ordering::SeqCst);
        if confirmed {
            begin_flush_and_close(handle);
        } else {
            APP_QUITTING.store(false, Ordering::SeqCst);
        }
    });
}

#[tauri::command]
pub async fn notify_settings_flushed(
    app: AppHandle,
    window: WebviewWindow,
    generation: u64,
) -> Result<(), String> {
    if window.label() != MAIN_WINDOW {
        return Err("Only the main window can complete a close request.".into());
    }
    if !acknowledge_close_generation(generation) {
        return Err("The close request expired before its state flush completed.".into());
    }
    let shutdown = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(feature = "e2e")]
        if let Some(delay) = std::env::var("ROSI_E2E_CLOSE_SHUTDOWN_DELAY_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .map(|milliseconds| milliseconds.min(10_000))
        {
            std::thread::sleep(std::time::Duration::from_millis(delay));
        }
        shutdown_for_close(generation)
    })
    .await;
    let shutdown = match shutdown {
        Ok(result) => result,
        Err(error) => Err(format!("Could not finish application shutdown: {error}")),
    };
    if let Err(error) = shutdown {
        cancel_close_generation(generation);
        return Err(format!(
            "Could not durably save application state before closing: {error}"
        ));
    }
    if !consume_close_generation(generation) {
        return Err("The close request expired before its state flush completed.".into());
    }
    destroy_main(&app)?;
    crate::logging::info("Settings and download queue flushed; closing main window.");
    Ok(())
}

pub fn on_main_destroyed(app: &AppHandle) {
    crate::logging::info("Main window closed.");
    MAIN_READY.store(false, Ordering::SeqCst);
    {
        let _state = CLOSE_STATE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        CLOSE_IN_PROGRESS.store(false, Ordering::SeqCst);
        CLOSE_ACKNOWLEDGED.store(false, Ordering::SeqCst);
        CLOSE_GENERATION.fetch_add(1, Ordering::SeqCst);
    }
    close_splash(app);
    if cfg!(target_os = "macos") && !APP_QUITTING.load(Ordering::SeqCst) {
        // macOS keeps the app in the Dock; a closed window still stops work.
        stop_active_work();
        return;
    }
    if APP_QUITTING.load(Ordering::SeqCst) {
        app.exit(0);
    }
}

/// Quit from the app menu: run the normal close flow first, then exit.
#[cfg(target_os = "macos")]
pub fn request_quit(app: &AppHandle) {
    APP_QUITTING.store(true, Ordering::SeqCst);
    match app.get_webview_window(MAIN_WINDOW) {
        Some(window) => {
            if let Err(error) = window.close() {
                cancel_close();
                crate::logging::error(&format!("Could not begin a durable quit: {error}"));
                app.dialog()
                    .message(format!("ROSI could not begin quitting safely: {error}"))
                    .title("Could Not Quit ROSI")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
        None => match shutdown() {
            Ok(()) => app.exit(0),
            Err(error) => {
                APP_QUITTING.store(false, Ordering::SeqCst);
                app.dialog()
                    .message(format!("ROSI could not save the download queue, so it will remain open.\n\n{error}"))
                    .title("Could Not Quit ROSI")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        },
    }
}

pub fn stop_active_work() {
    crate::queue::stop();
    crate::media_info::cancel_all();
}

/// Flush once before stopping work so a failed write leaves it running, then
/// flush the post-cancellation queue state before the process exits.
fn shutdown_with_close_generation(generation: Option<u64>) -> Result<(), String> {
    crate::queue::flush().map_err(|error| {
        crate::logging::error(&format!(
            "Could not confirm the queue before shutdown: {error}"
        ));
        error
    })?;
    if let Some(generation) = generation {
        if !close_generation_is_current(generation) {
            return Err("The close request expired before shutdown completed.".into());
        }
    }
    stop_active_work();
    crate::queue::flush().map_err(|error| {
        crate::logging::error(&format!("Could not confirm the final queue state: {error}"));
        error
    })
}

fn shutdown_for_close(generation: u64) -> Result<(), String> {
    shutdown_with_close_generation(Some(generation))
}

pub fn shutdown() -> Result<(), String> {
    shutdown_with_close_generation(None)
}

pub fn restart_with(
    app: &AppHandle,
    before_restart: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    APP_QUITTING.store(true, Ordering::SeqCst);
    if let Err(error) = shutdown().and_then(|()| before_restart()) {
        APP_QUITTING.store(false, Ordering::SeqCst);
        return Err(error);
    }
    app.restart()
}

pub fn restart(app: &AppHandle) -> Result<(), String> {
    restart_with(app, || Ok(()))
}

#[tauri::command(async)]
pub fn restart_app(app: AppHandle) -> Result<(), String> {
    restart(&app)
}
