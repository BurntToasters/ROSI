//! Shared data model. Field names serialize as camelCase so the frontend sees
//! the same shapes the Electron preload bridge exposed in ROSI v4.

use crate::ipc::{present_payload, FalliblePayload};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A closed set of setting values, serialized as fixed strings.
macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[cfg_attr(test, derive(ts_rs::TS))]
        pub enum $name {
            $(#[serde(rename = $text)] $variant),+
        }

        impl $name {
            pub const NAMES: &'static [&'static str] = &[$($text),+];

            // Not every enum is converted back to its name outside serde.
            #[allow(dead_code)]
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }

            pub fn parse(value: &str) -> Option<Self> {
                match value {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

string_enum!(Theme {
    System => "system",
    Light => "light",
    Dark => "dark",
    Purple => "purple",
});

string_enum!(DockTab {
    Queue => "queue",
    Activity => "activity",
    Console => "console",
});

string_enum!(DownloadProfile {
    Compatible => "compatible",
    BestVideo => "best-video",
    Audio => "audio",
    Custom => "custom",
});

string_enum!(GpuType {
    Auto => "auto",
    Nvidia => "nvidia",
    Amd => "amd",
    Intel => "intel",
});

string_enum!(UpdateChannel {
    Auto => "auto",
    Stable => "stable",
    Beta => "beta",
});

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct PlaylistSelection {
    #[cfg_attr(test, ts(type = "\"current\" | \"all\" | \"range\""))]
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<u32>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct DownloadPreset {
    pub id: String,
    pub name: String,
    #[cfg_attr(test, ts(as = "DownloadProfile"))]
    pub profile: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub best_quality: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_format_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub convert_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub convert_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_original_after_convert: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_acceleration: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(as = "Option<GpuType>"))]
    pub gpu_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_subtitles: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle_langs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed_thumbnail: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed_metadata: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sponsorblock_remove: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playlist: Option<PlaylistSelection>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct Settings {
    pub settings_version: u32,
    pub theme: Theme,
    pub show_console_output: bool,
    pub dock_tab: DockTab,
    pub dock_collapsed: bool,
    pub download_mode: DownloadProfile,
    pub download_presets: Vec<DownloadPreset>,
    pub ask_download_location: bool,
    pub advanced_options: bool,
    pub audio_only: bool,
    pub audio_format: String,
    pub convert_enabled: bool,
    pub convert_format: String,
    pub keep_original_after_convert: bool,
    pub first_launch: bool,
    pub hook_browser: bool,
    pub browser_choice: String,
    pub animate_background: bool,
    pub flat_ui: bool,
    pub notifications: bool,
    pub deno_reminder_dismissed: bool,
    pub gpu_acceleration: bool,
    pub gpu_type: GpuType,
    pub best_quality: bool,
    pub ffmpeg_path: String,
    pub upstream_proxy: String,
    pub download_folder: String,
    pub hide_support_modal: bool,
    pub check_updates_on_startup: bool,
    pub update_channel: UpdateChannel,
    pub write_subtitles: bool,
    pub subtitle_langs: String,
    pub embed_thumbnail: bool,
    pub embed_metadata: bool,
    pub sponsorblock_remove: bool,
    pub show_taskbar_progress: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct DownloadRequestOptions {
    pub url: String,
    pub output_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ffmpeg_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub convert_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub convert_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_original: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_format: Option<String>,
    /// A selected yt-dlp audio format ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playlist: Option<PlaylistSelection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(as = "Option<DownloadProfile>"))]
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub best_quality: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advanced_options: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_only: Option<bool>,
    /// Audio extraction format, separate from the yt-dlp audio format ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_output_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hook_browser: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_choice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_acceleration: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(as = "Option<GpuType>"))]
    pub gpu_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_subtitles: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle_langs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed_thumbnail: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed_metadata: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sponsorblock_remove: Option<bool>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Owner {
    Manual,
    Queue,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Outcome {
    Success,
    Failed,
    Cancelled,
}

impl Outcome {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "success" => Some(Self::Success),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

/// Structured result of one download session. Activity entries share this shape.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct DownloadCompletion {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<u64>,
    pub owner: Owner,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_item_id: Option<String>,
    pub outcome: Outcome,
    pub status_message: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(as = "Option<DownloadProfile>"))]
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_name: Option<String>,
    pub request: DownloadRequestOptions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub started_at: u64,
    pub completed_at: u64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Phase {
    Download,
    Merge,
    Convert,
    Idle,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct JobProgressEvent {
    pub phase: Phase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<u64>,
    /// `null` when the phase has no determinate percentage.
    pub phase_percent: Option<f64>,
    /// Progress for only the active item, before queue weighting.
    pub item_overall_percent: f64,
    /// Queue-weighted progress for queue downloads, otherwise itemOverallPercent.
    pub overall_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_item_id: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    pub indeterminate: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded_bytes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed_bytes_per_second: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta_seconds: Option<f64>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum QueueStatus {
    Pending,
    Downloading,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct QueueItem {
    pub id: String,
    pub url: String,
    pub status: QueueStatus,
    pub added_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<DownloadRequestOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Payload of `queue-update`. `revision` increases with every queue change the
/// coordinator publishes, so the renderer can drop an older snapshot.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct QueueSnapshot {
    pub revision: u64,
    pub items: Vec<QueueItem>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct VideoInfo {
    pub title: String,
    pub uploader: Option<String>,
    pub duration_seconds: Option<f64>,
    pub thumbnail: Option<String>,
    pub ext: Option<String>,
    pub view_count: Option<f64>,
    pub is_playlist: bool,
    pub playlist_count: Option<f64>,
    pub webpage_url: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum StreamKind {
    Audio,
    Video,
    AudioVideo,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct FormatEntry {
    pub format_id: String,
    pub stream_kind: StreamKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vcodec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acodec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_size_bytes: Option<u64>,
    /// Option text for format pickers, built by the backend. The renderer shows it verbatim.
    pub display_label: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FormatList {
    pub formats: Vec<FormatEntry>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct DownloadStats {
    pub total_downloads: u64,
    pub successful_downloads: u64,
    pub failed_downloads: u64,
    pub cancelled_downloads: u64,
    pub total_bytes_downloaded: u64,
    pub format_counts: BTreeMap<String, u64>,
    pub first_download_at: Option<u64>,
    pub last_download_at: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct GpuDetectionResult {
    pub nvidia: bool,
    pub amd: bool,
    pub intel: bool,
}

/// A notification after validation: trimmed title and body.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NotificationRequest {
    pub title: Option<String>,
    pub body: Option<String>,
}

/// `show_notification` options as sent. Each field is typed on its own, so a
/// wrong type is refused by `validate_notification` with the group message.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct NotificationInput {
    #[cfg_attr(test, ts(type = "string", optional))]
    pub title: Option<FalliblePayload<String>>,
    #[cfg_attr(test, ts(type = "string", optional))]
    pub body: Option<FalliblePayload<String>>,
    #[cfg_attr(test, ts(type = "string", optional))]
    pub file_path: Option<FalliblePayload<String>>,
}

/// `reorder_queue_item` request as sent. A missing or wrong-typed field is
/// refused by `validate_queue_reorder` with that field's message.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct QueueReorderInput {
    #[cfg_attr(test, ts(type = "string", optional))]
    pub id: Option<FalliblePayload<String>>,
    #[cfg_attr(test, ts(type = "\"up\" | \"down\"", optional))]
    pub direction: Option<FalliblePayload<String>>,
}

/// A partial settings update as the renderer sends it. Each known key is
/// typed on its own (`None` when absent, `Invalid` for a wrong type, `null`
/// included), so `validate_settings_patch` can refuse fields one at a time.
/// Unknown keys are ignored.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatchInput {
    #[serde(default, deserialize_with = "present_payload")]
    pub settings_version: Option<FalliblePayload<f64>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub download_presets: Option<FalliblePayload<Vec<DownloadPreset>>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub show_console_output: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub dock_collapsed: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub ask_download_location: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub advanced_options: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub audio_only: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub convert_enabled: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub keep_original_after_convert: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub first_launch: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub hook_browser: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub animate_background: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub flat_ui: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub notifications: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub show_taskbar_progress: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub deno_reminder_dismissed: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub gpu_acceleration: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub best_quality: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub hide_support_modal: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub check_updates_on_startup: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub write_subtitles: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub embed_thumbnail: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub embed_metadata: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub sponsorblock_remove: Option<FalliblePayload<bool>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub download_mode: Option<FalliblePayload<String>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub dock_tab: Option<FalliblePayload<String>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub theme: Option<FalliblePayload<String>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub gpu_type: Option<FalliblePayload<String>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub audio_format: Option<FalliblePayload<String>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub convert_format: Option<FalliblePayload<String>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub update_channel: Option<FalliblePayload<String>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub subtitle_langs: Option<FalliblePayload<String>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub browser_choice: Option<FalliblePayload<String>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub ffmpeg_path: Option<FalliblePayload<String>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub upstream_proxy: Option<FalliblePayload<String>>,
    #[serde(default, deserialize_with = "present_payload")]
    pub download_folder: Option<FalliblePayload<String>>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct QueueProgress {
    pub completed_items: usize,
    pub queue_total: usize,
    pub queue_item_id: Option<String>,
}

/// Pushed on `updater-status`. Every variant is produced by `updater.rs`.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum UpdaterStatusEvent {
    Checking,
    #[serde(rename_all = "camelCase")]
    Available {
        candidate_id: u64,
        version: String,
        release_notes: Option<String>,
        is_beta: bool,
        /// Flatpak builds read the feed; the update is taken from the release page.
        manual_install: bool,
    },
    #[serde(rename_all = "camelCase")]
    NotAvailable {
        version: String,
        is_beta: bool,
    },
    Error {
        message: String,
        kind: UpdaterErrorKind,
    },
    Cancelled,
    #[serde(rename_all = "camelCase")]
    Downloaded {
        candidate_id: u64,
        version: String,
    },
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum UpdaterErrorKind {
    Feed,
    Download,
    Install,
}

/// Pushed on `updater-progress` while a download runs.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UpdaterProgressEvent {
    pub percent: f64,
    pub bytes_per_second: f64,
    pub transferred: u64,
    pub total: u64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum CheckRefusalReason {
    DevMode,
    Message,
}

/// Why `check_for_updates` did not start a check. `null` means it started.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CheckRefusal {
    pub reason: CheckRefusalReason,
    pub message: String,
}

/// Result of `download_update`. Failures are reported here and as events.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct DownloadOutcome {
    pub success: bool,
    pub cancelled: bool,
    pub error: Option<String>,
}

impl DownloadOutcome {
    pub fn success() -> Self {
        Self {
            success: true,
            cancelled: false,
            error: None,
        }
    }

    pub fn cancelled() -> Self {
        Self {
            success: false,
            cancelled: true,
            error: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            success: false,
            cancelled: false,
            error: Some(message.into()),
        }
    }
}

/// Payload for `resolve_preset_options`: a saved preset id and no URL.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PresetOptionsInput {
    pub preset_id: String,
}

#[cfg(test)]
mod ts_bindings {
    //! `src/generated/ipc-types.ts` is generated from these types. Run
    //! `ROSI_UPDATE_IPC_TYPES=1 cargo test ts_bindings` after changing them.
    //! `ts(as)`/`ts(type)` field attributes narrow `String` fields that IPC
    //! validation already restricts to a closed set.
    use super::*;
    use ts_rs::{Config, TS};

    const GENERATED: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/generated/ipc-types.ts");

    fn render() -> String {
        // Timestamps and byte counts stay below 2^53, so plain numbers are exact.
        let cfg = Config::new().with_large_int("number");
        let decls = [
            Theme::decl(&cfg),
            DockTab::decl(&cfg),
            DownloadProfile::decl(&cfg),
            GpuType::decl(&cfg),
            UpdateChannel::decl(&cfg),
            PlaylistSelection::decl(&cfg),
            DownloadPreset::decl(&cfg),
            Settings::decl(&cfg),
            DownloadRequestOptions::decl(&cfg),
            Owner::decl(&cfg),
            Outcome::decl(&cfg),
            DownloadCompletion::decl(&cfg),
            Phase::decl(&cfg),
            JobProgressEvent::decl(&cfg),
            QueueStatus::decl(&cfg),
            QueueItem::decl(&cfg),
            QueueSnapshot::decl(&cfg),
            VideoInfo::decl(&cfg),
            StreamKind::decl(&cfg),
            FormatEntry::decl(&cfg),
            FormatList::decl(&cfg),
            DownloadStats::decl(&cfg),
            GpuDetectionResult::decl(&cfg),
            crate::ipc::IpcError::decl(&cfg),
            crate::ipc::DownloadRequestInput::decl(&cfg),
            PresetOptionsInput::decl(&cfg),
            crate::downloader::Started::decl(&cfg),
            crate::queue::Started::decl(&cfg),
            crate::queue::AddResult::decl(&cfg),
            crate::queue::RemovedCount::decl(&cfg),
            crate::platform::Opened::decl(&cfg),
            crate::platform::Shown::decl(&cfg),
            crate::settings::Exported::decl(&cfg),
            crate::settings::Imported::decl(&cfg),
            crate::deno::InstallResult::decl(&cfg),
            NotificationInput::decl(&cfg),
            QueueReorderInput::decl(&cfg),
            UpdaterStatusEvent::decl(&cfg),
            UpdaterErrorKind::decl(&cfg),
            UpdaterProgressEvent::decl(&cfg),
            CheckRefusalReason::decl(&cfg),
            CheckRefusal::decl(&cfg),
            DownloadOutcome::decl(&cfg),
        ];
        let mut out = String::from(
            "// Generated from src-tauri/src/types.rs by the ts_bindings test. Do not edit.\n",
        );
        for decl in decls {
            out.push_str("\nexport ");
            out.push_str(&decl);
            out.push('\n');
        }
        out
    }

    #[test]
    fn generated_ipc_types_are_current() {
        let rendered = render();
        if std::env::var("ROSI_UPDATE_IPC_TYPES").as_deref() == Ok("1") {
            std::fs::write(GENERATED, &rendered).expect("write generated IPC types");
            return;
        }
        let committed = std::fs::read_to_string(GENERATED).unwrap_or_default();
        assert!(
            committed == rendered,
            "src/generated/ipc-types.ts is stale; run ROSI_UPDATE_IPC_TYPES=1 cargo test ts_bindings"
        );
    }
}
