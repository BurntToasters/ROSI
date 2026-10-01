//! Native macOS application menu. Custom items are delivered to the renderer
//! as `menu-action` events (queued until the main window reports ready).

use tauri::AppHandle;

static PENDING_MENU_ACTIONS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub fn flush_pending_menu_actions(_app: &AppHandle) {
    let pending = PENDING_MENU_ACTIONS
        .lock()
        .map(|mut actions| std::mem::take(&mut *actions))
        .unwrap_or_default();
    for action in pending {
        crate::app_state::emit("menu-action", action);
    }
}

#[cfg(target_os = "macos")]
fn deliver(app: &AppHandle, action: &str) {
    if let Err(error) = crate::window::show_main_window(app) {
        crate::logging::warn(&format!(
            "Failed to show main window for menu action: {error}"
        ));
    }
    if crate::window::MAIN_READY.load(std::sync::atomic::Ordering::SeqCst) {
        crate::app_state::emit("menu-action", action.to_string());
    } else if let Ok(mut pending) = PENDING_MENU_ACTIONS.lock() {
        pending.push(action.to_string());
    }
}

#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) -> Result<(), String> {
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItem, SubmenuBuilder};
    use tauri_plugin_opener::OpenerExt;

    const SETTINGS: &str = "open-settings";
    const CHECK_UPDATES: &str = "check-for-updates";
    const TOGGLE_SIDEBAR: &str = "toggle-sidebar";
    const LICENSES: &str = "show-licenses";
    const DOCS: &str = "menu-docs";
    const ISSUES: &str = "menu-issues";
    const QUIT: &str = "menu-quit";
    const DOCS_URL: &str = "https://github.com/BurntToasters/ROSI#readme";
    const ISSUES_URL: &str = "https://github.com/BurntToasters/ROSI/issues";

    let item = |id: &str, label: &str, accelerator: Option<&str>| {
        MenuItem::with_id(app, id, label, true, accelerator).map_err(|error| error.to_string())
    };
    let settings = item(SETTINGS, "Settings…", Some("CmdOrCtrl+,"))?;
    let check_updates = item(CHECK_UPDATES, "Check for Updates…", None)?;
    let toggle_sidebar = item(TOGGLE_SIDEBAR, "Toggle Sidebar", None)?;
    let licenses = item(LICENSES, "View Licenses", None)?;
    let docs = item(DOCS, "Documentation", None)?;
    let issues = item(ISSUES, "Report an Issue", None)?;
    let quit = item(QUIT, "Quit ROSI", Some("CmdOrCtrl+Q"))?;

    let about = AboutMetadata {
        name: Some("ROSI".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        copyright: Some("Copyright © BurntToasters".into()),
        ..Default::default()
    };
    let mut app_menu = SubmenuBuilder::new(app, "ROSI")
        .about(Some(about))
        .separator()
        .item(&settings);
    if crate::platform::distribution_channel() != "msstore" {
        app_menu = app_menu.item(&check_updates);
    }
    let app_menu = app_menu
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()
        .map_err(|error| error.to_string())?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()
        .map_err(|error| error.to_string())?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&toggle_sidebar)
        .separator()
        .fullscreen()
        .build()
        .map_err(|error| error.to_string())?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()
        .map_err(|error| error.to_string())?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&docs)
        .item(&issues)
        .separator()
        .item(&licenses)
        .build()
        .map_err(|error| error.to_string())?;
    let _ = help.set_as_help_menu_for_nsapp();
    let _ = window.set_as_windows_menu_for_nsapp();
    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit)
        .item(&view)
        .item(&window)
        .item(&help)
        .build()
        .map_err(|error| error.to_string())?;
    app.set_menu(menu).map_err(|error| error.to_string())?;

    app.on_menu_event(|app, event| match event.id().as_ref() {
        id @ (SETTINGS | CHECK_UPDATES | TOGGLE_SIDEBAR | LICENSES) => deliver(app, id),
        DOCS => {
            let _ = app.opener().open_url(DOCS_URL, None::<&str>);
        }
        ISSUES => {
            let _ = app.opener().open_url(ISSUES_URL, None::<&str>);
        }
        QUIT => crate::window::request_quit(app),
        _ => {}
    });
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}
