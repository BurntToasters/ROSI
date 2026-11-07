//! `{ ok, data } | { ok: false, error }` envelopes shared with the frontend.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A typed-first adapter for IPC payloads. Invalid shapes are retained as JSON
/// so command validators can return ROSI's normal error envelope instead of
/// letting Tauri reject the invocation during argument extraction.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum FalliblePayload<T> {
    Typed(T),
    Invalid(Value),
}

impl<T: Serialize> FalliblePayload<T> {
    pub fn into_value(self) -> Value {
        match self {
            Self::Typed(value) => serde_json::to_value(value).unwrap_or(Value::Null),
            Self::Invalid(value) => value,
        }
    }
}

/// Validly shaped manual/preview request fields. Values are checked again by
/// `validate_download_request` for URL, path and allow-list policy.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct DownloadRequestOverrides {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playlist: Option<crate::types::PlaylistSelection>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_output_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hook_browser: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_choice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_acceleration: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
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

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct DownloadRequestInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(flatten)]
    pub options: DownloadRequestOverrides,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum QueueUrlInput {
    Text(String),
    Other(Value),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct QueueUrlsInput(pub Vec<QueueUrlInput>);

#[derive(Clone, Debug, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(optional_fields = nullable))]
pub struct IpcError {
    #[cfg_attr(
        test,
        ts(
            type = "\"VALIDATION_ERROR\" | \"INVALID_URL\" | \"INVALID_PATH\" | \"NOT_AVAILABLE\" | \"INTERNAL_ERROR\" | \"NEWER_VERSION\""
        )
    )]
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

pub const VALIDATION_ERROR: &str = "VALIDATION_ERROR";
pub const INVALID_URL: &str = "INVALID_URL";
pub const INVALID_PATH: &str = "INVALID_PATH";
pub const NOT_AVAILABLE: &str = "NOT_AVAILABLE";
pub const INTERNAL_ERROR: &str = "INTERNAL_ERROR";
/// The file belongs to a newer ROSI version and is intentionally preserved.
pub const NEWER_VERSION: &str = "NEWER_VERSION";

impl IpcError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct IpcResult<T: Serialize> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<IpcError>,
}

pub fn ok<T: Serialize>(data: T) -> IpcResult<T> {
    IpcResult {
        ok: true,
        data: Some(data),
        error: None,
    }
}

pub fn err<T: Serialize>(code: &'static str, message: impl Into<String>) -> IpcResult<T> {
    from_error(IpcError::new(code, message))
}

pub fn from_error<T: Serialize>(error: IpcError) -> IpcResult<T> {
    IpcResult {
        ok: false,
        data: None,
        error: Some(error),
    }
}

impl<T: Serialize> From<Result<T, IpcError>> for IpcResult<T> {
    fn from(value: Result<T, IpcError>) -> Self {
        match value {
            Ok(data) => ok(data),
            Err(error) => from_error(error),
        }
    }
}
