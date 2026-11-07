//! Informational native alerts: a title, a message and one OK button, with
//! nothing to do on dismissal. Production builds show them. E2E builds log and
//! record them instead, because WebDriver cannot see or dismiss a native alert
//! (failure modes in e2e/native-notices.failure-modes.md).

use tauri_plugin_dialog::MessageDialogKind;

#[derive(Clone, Copy)]
pub enum NoticeKind {
    Warning,
    Error,
}

impl From<NoticeKind> for MessageDialogKind {
    fn from(kind: NoticeKind) -> Self {
        match kind {
            NoticeKind::Warning => MessageDialogKind::Warning,
            NoticeKind::Error => MessageDialogKind::Error,
        }
    }
}

/// Shows the notice, attached to the main window when `parented` is set.
pub fn show(title: &str, message: &str, kind: NoticeKind, parented: bool) {
    #[cfg(feature = "e2e")]
    {
        let _ = parented;
        e2e::record(title, message, kind);
    }
    #[cfg(not(feature = "e2e"))]
    {
        use tauri_plugin_dialog::DialogExt;
        let Some(app) = crate::app_state::app() else {
            return;
        };
        let mut dialog = app.dialog().message(message).title(title).kind(kind.into());
        if parented {
            if let Some(window) = crate::app_state::main_window() {
                dialog = dialog.parent(&window);
            }
        }
        dialog.show(|_| {});
    }
}

#[cfg(feature = "e2e")]
mod e2e {
    use super::NoticeKind;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    const KEPT: usize = 64;

    #[derive(Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RecordedNotice {
        pub title: String,
        pub message: String,
        pub kind: &'static str,
    }

    static RECORD: Mutex<VecDeque<RecordedNotice>> = Mutex::new(VecDeque::new());

    pub fn record(title: &str, message: &str, kind: NoticeKind) {
        crate::logging::warn(&format!(
            "E2E build: native notice not shown: {title}: {message}"
        ));
        let mut record = RECORD.lock().unwrap_or_else(|p| p.into_inner());
        if record.len() == KEPT {
            record.pop_front();
        }
        record.push_back(RecordedNotice {
            title: title.to_string(),
            message: message.to_string(),
            kind: match kind {
                NoticeKind::Warning => "warning",
                NoticeKind::Error => "error",
            },
        });
    }

    pub fn snapshot() -> Vec<RecordedNotice> {
        RECORD
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .cloned()
            .collect()
    }
}

/// The notices this E2E process recorded instead of showing, oldest first.
#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_native_notices(
    window: tauri::WebviewWindow,
) -> Result<Vec<e2e::RecordedNotice>, String> {
    if window.label() != crate::app_state::MAIN_WINDOW {
        return Err("Only the main window may read the E2E native notices.".into());
    }
    Ok(e2e::snapshot())
}
