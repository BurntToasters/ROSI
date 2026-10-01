#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity;
mod app_menu;
mod app_state;
mod command_builders;
mod constants;
mod deno;
mod downloader;
mod fs_util;
mod gpu;
mod ipc;
mod legacy;
mod logging;
mod media_info;
mod platform;
mod process_util;
mod progress;
mod queue;
mod settings;
mod sidecars;
mod stats;
mod types;
mod validation;
mod window;

#[cfg(target_os = "macos")]
use tauri::Manager;

fn production_integrations_enabled() -> bool {
    !cfg!(feature = "e2e")
}

fn report_missing_ytdlp(app: &tauri::AppHandle) -> bool {
    let Some(path) = sidecars::bundled_path(sidecars::YTDLP_SIDECAR) else {
        return false;
    };
    if path.is_file() {
        return false;
    }
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    logging::error(&format!("yt-dlp binary not found at {}", path.display()));
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "yt-dlp binary not found at {}.\nPlease reinstall ROSI.",
            path.display()
        ))
        .title("Missing Dependency")
        .kind(MessageDialogKind::Error)
        .show(move |_| handle.exit(1));
    true
}

fn main() {
    #[cfg(target_os = "linux")]
    let repaired_gdk_backend = platform::repair_appimage_gdk_backend();
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(feature = "e2e")]
    {
        builder = builder
            .plugin(tauri_plugin_wdio::init())
            .plugin(tauri_plugin_wdio_webdriver::init());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if production_integrations_enabled() {
            builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                // Window work from the single-instance callback can deadlock
                // WebView2 on Windows; dispatch after the callback returns.
                let handle = app.clone();
                std::thread::spawn(move || {
                    let main_thread = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if let Err(error) = window::show_main_window(&main_thread) {
                            logging::warn(&format!("Failed to focus main window: {error}"));
                        }
                    });
                });
            }));
        }
        // Microsoft Store builds update through the Store, never in-app.
        if platform::distribution_channel() != "msstore" {
            // Windows installs exit via process::exit, skipping RunEvent::Exit.
            builder = builder.plugin(
                tauri_plugin_updater::Builder::new()
                    .on_before_exit(|| {
                        logging::info("Launching the update installer; stopping active work.");
                        window::shutdown();
                    })
                    .build(),
            );
        }
    }

    let app = builder
        .setup(move |app| {
            app_state::init(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            logging::info(&format!(
                "ROSI {} starting ({} {})",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH
            ));
            #[cfg(target_os = "linux")]
            if repaired_gdk_backend {
                logging::info("No X display for the AppImage's forced X11 backend; using Wayland.");
            }
            // Before anything reads settings, the queue, or stats.
            legacy::import_on_first_launch(app.handle());
            if report_missing_ytdlp(app.handle()) {
                return Ok(());
            }
            queue::init();
            std::thread::spawn(|| {
                let _ = sidecars::ytdlp_path();
                sidecars::verify_bundled();
            });
            if let Err(error) = app_menu::install(app.handle()) {
                logging::warn(&format!("Failed to install macOS app menu: {error}"));
            }
            if platform::is_packaged() && production_integrations_enabled() {
                window::create_splash(app.handle());
            }
            window::show_main_window(app.handle())
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::get_default_settings,
            settings::save_settings,
            settings::reset_settings,
            settings::export_settings,
            settings::import_settings,
            stats::get_stats,
            stats::reset_stats,
            activity::get_download_activity,
            activity::clear_download_activity,
            media_info::get_formats,
            media_info::cancel_formats,
            media_info::get_video_info,
            media_info::cancel_video_info,
            downloader::download_video,
            downloader::cancel_download,
            queue::add_to_queue,
            queue::remove_from_queue,
            queue::retry_queue_item,
            queue::reorder_queue_item,
            queue::clear_queue,
            queue::get_queue,
            queue::start_queue,
            queue::cancel_queue,
            platform::select_download_location,
            platform::open_external,
            platform::open_file_location,
            platform::show_notification,
            deno::check_deno_installed,
            deno::install_deno,
            gpu::detect_gpu,
            platform::is_packaged,
            platform::is_flatpak,
            platform::get_app_platform,
            platform::get_distribution_channel,
            platform::get_beta_updater_target,
            window::restart_app,
            logging::log_error,
            window::notify_settings_flushed,
            window::mark_main_window_ready,
        ])
        .build(tauri::generate_context!())
        .expect("failed to initialize Tauri application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } if label == app_state::MAIN_WINDOW => window::on_main_close_requested(app_handle, &api),
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } if label == app_state::MAIN_WINDOW => window::on_main_destroyed(app_handle),
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            // macOS keeps running in the Dock after its last window closes.
            if cfg!(target_os = "macos")
                && code.is_none()
                && !window::APP_QUITTING.load(std::sync::atomic::Ordering::SeqCst)
            {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Exit => window::shutdown(),
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } if app_handle
            .get_webview_window(app_state::MAIN_WINDOW)
            .is_none() =>
        {
            if let Err(error) = window::show_main_window(app_handle) {
                logging::warn(&format!("Failed to reopen main window: {error}"));
            }
        }
        _ => {}
    });
}
