//! `{ ok, data } | { ok: false, error }` envelopes shared with the frontend.

use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct IpcError {
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
