//! Structured job progress: yt-dlp JSON/legacy progress parsing, FFmpeg
//! `-progress` parsing, phase weighting (download / merge / convert), queue
//! weighting, and emit throttling.

use crate::types::{JobProgressEvent, Phase, QueueProgress, Settings};
use serde_json::Value;
use std::time::{Duration, Instant};

const PHASE_DOWNLOAD_END: f64 = 70.0;
const PHASE_MERGE_END: f64 = 85.0;
const PHASE_CONVERT_END: f64 = 100.0;
const EMIT_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Plan {
    pub expect_merge: bool,
    pub expect_convert: bool,
}

#[derive(Clone, Debug, Default)]
pub struct YtdlpProgress {
    pub status: Option<String>,
    /// Set on `postprocess:%(progress)j` lines (Merger, ExtractAudio, ...).
    pub postprocessor: Option<String>,
    pub downloaded_bytes: Option<f64>,
    pub total_bytes: Option<f64>,
    pub total_bytes_estimate: Option<f64>,
    pub eta: Option<f64>,
    pub speed: Option<f64>,
    pub fragment_index: Option<f64>,
    pub fragment_count: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct Metrics {
    pub downloaded_bytes: Option<f64>,
    pub total_bytes: Option<f64>,
    pub speed_bytes_per_second: Option<f64>,
    pub eta_seconds: Option<f64>,
}

pub struct LegacyProgress {
    pub percent: f64,
    pub total_size: String,
    pub speed: Option<String>,
    pub eta: Option<String>,
}

/// Parse `[download]  42.0% of ~12.3MiB at 1.2MiB/s ETA 00:10`.
pub fn parse_legacy(message: &str) -> Option<LegacyProgress> {
    let start = message.find("[download]")? + "[download]".len();
    let mut tokens = message[start..].split_whitespace();
    let percent_token = tokens.next()?;
    let percent: f64 = percent_token.strip_suffix('%')?.parse().ok()?;
    if tokens.next()? != "of" {
        return None;
    }
    let total_size = tokens.next()?.trim_start_matches('~').to_string();
    let mut speed = None;
    let mut eta = None;
    if tokens.next() == Some("at") {
        speed = tokens.next().map(str::to_string);
        if tokens.next() == Some("ETA") {
            eta = tokens.next().map(str::to_string);
        }
    }
    let (speed, eta) = match (speed, eta) {
        (Some(speed), Some(eta)) => (Some(speed), Some(eta)),
        _ => (None, None),
    };
    Some(LegacyProgress {
        percent,
        total_size,
        speed,
        eta,
    })
}

fn number_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<f64> {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

pub fn try_parse_json(line: &str) -> Option<YtdlpProgress> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(trimmed) else {
        return None;
    };
    Some(YtdlpProgress {
        status: object
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_string),
        postprocessor: object
            .get("postprocessor")
            .and_then(Value::as_str)
            .map(str::to_string),
        downloaded_bytes: number_field(&object, "downloaded_bytes"),
        total_bytes: number_field(&object, "total_bytes"),
        total_bytes_estimate: number_field(&object, "total_bytes_estimate"),
        eta: number_field(&object, "eta"),
        speed: number_field(&object, "speed"),
        fragment_index: number_field(&object, "fragment_index"),
        fragment_count: number_field(&object, "fragment_count"),
    })
}

pub fn format_bytes(bytes: f64) -> String {
    if !bytes.is_finite() || bytes <= 0.0 {
        return "0 B".to_string();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let exponent = ((bytes.ln() / 1024f64.ln()).floor() as usize).min(units.len() - 1);
    let value = bytes / 1024f64.powi(exponent as i32);
    let mut text = format!("{value:.2}");
    if text.contains('.') {
        text = text.trim_end_matches('0').trim_end_matches('.').to_string();
    }
    format!("{text} {}", units[exponent])
}

pub fn format_eta(seconds: Option<f64>) -> Option<String> {
    let seconds = seconds.filter(|value| value.is_finite() && *value >= 0.0)?;
    let total = seconds.round() as u64;
    let (hours, minutes, secs) = (total / 3600, (total % 3600) / 60, total % 60);
    Some(if hours > 0 {
        format!("{hours:02}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes:02}:{secs:02}")
    })
}

pub fn json_to_phase_percent(data: &YtdlpProgress) -> f64 {
    if data.status.as_deref() == Some("finished") {
        return 100.0;
    }
    let total = data.total_bytes.or(data.total_bytes_estimate);
    if let (Some(done), Some(total)) = (data.downloaded_bytes, total) {
        if total > 0.0 {
            return (done / total * 100.0).min(100.0);
        }
    }
    if let (Some(index), Some(count)) = (data.fragment_index, data.fragment_count) {
        if count > 0.0 {
            return (index / count * 100.0).min(100.0);
        }
    }
    f64::NAN
}

pub fn format_summary(data: &YtdlpProgress, phase_percent: f64) -> (String, String) {
    let total = data.total_bytes.or(data.total_bytes_estimate);
    let percent_label = if phase_percent.is_finite() {
        format!("{phase_percent:.1}%")
    } else {
        "…".to_string()
    };
    let total_label = total
        .map(format_bytes)
        .unwrap_or_else(|| "unknown size".to_string());
    let mut details = format!("{percent_label} of {total_label}");
    if let Some(speed) = data.speed.filter(|speed| *speed > 0.0) {
        details.push_str(&format!(" at {}/s", format_bytes(speed)));
    }
    if let Some(eta) = format_eta(data.eta) {
        details.push_str(&format!(" ETA {eta}"));
    }
    ("Downloading...".to_string(), details)
}

/// Status label for a yt-dlp post-processing step.
pub fn postprocess_label(postprocessor: &str) -> &'static str {
    match postprocessor {
        "Merger" => "Merging video and audio...",
        "ExtractAudio" => "Extracting audio...",
        "VideoConvertor" | "VideoRemuxer" => "Converting...",
        "EmbedThumbnail" | "EmbedSubtitle" | "Metadata" | "FFmpegMetadata" => {
            "Embedding metadata..."
        }
        "SponsorBlock" | "ModifyChapters" => "Removing segments...",
        _ => "Finalizing...",
    }
}

pub fn summarize_for_console(data: &YtdlpProgress) -> Option<String> {
    if let Some(postprocessor) = data.postprocessor.as_deref() {
        return (data.status.as_deref() == Some("started"))
            .then(|| format!("[{postprocessor}] {}", postprocess_label(postprocessor)));
    }
    let status = data.status.as_deref()?;
    if status != "downloading" && status != "finished" {
        return None;
    }
    let (_, details) = format_summary(data, json_to_phase_percent(data));
    let prefix = if status == "finished" {
        "[download] Complete"
    } else {
        "[download]"
    };
    Some(format!("{prefix} {details}"))
}

fn span(start: f64, end: f64, percent: f64) -> f64 {
    start + (percent / 100.0) * (end - start)
}

pub fn compute_item_overall(phase: Phase, phase_percent: f64, plan: Plan) -> f64 {
    let clamped = if phase_percent.is_finite() {
        phase_percent.clamp(0.0, 100.0)
    } else {
        0.0
    };
    let done = |phase: Phase| if phase == Phase::Idle { 0.0 } else { 100.0 };
    match (plan.expect_merge, plan.expect_convert) {
        (false, false) => match phase {
            Phase::Download => clamped,
            other => done(other),
        },
        (true, false) => match phase {
            Phase::Download => span(0.0, PHASE_DOWNLOAD_END, clamped),
            Phase::Merge => span(PHASE_DOWNLOAD_END, PHASE_MERGE_END, clamped),
            other => done(other),
        },
        (false, true) => match phase {
            Phase::Download => span(0.0, PHASE_DOWNLOAD_END, clamped),
            Phase::Convert => span(PHASE_DOWNLOAD_END, PHASE_CONVERT_END, clamped),
            other => done(other),
        },
        (true, true) => match phase {
            Phase::Download => span(0.0, PHASE_DOWNLOAD_END, clamped),
            Phase::Merge => span(PHASE_DOWNLOAD_END, PHASE_MERGE_END, clamped),
            Phase::Convert => span(PHASE_MERGE_END, PHASE_CONVERT_END, clamped),
            Phase::Idle => 0.0,
        },
    }
}

pub fn apply_queue_weighting(item_overall: f64, queue: Option<&QueueProgress>) -> f64 {
    let item = item_overall.clamp(0.0, 100.0);
    match queue {
        Some(queue) if queue.queue_total > 0 => {
            let blended =
                (queue.completed_items as f64 + item / 100.0) / queue.queue_total as f64 * 100.0;
            blended.clamp(0.0, 100.0)
        }
        _ => item,
    }
}

fn non_negative(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value >= 0.0)
}

#[allow(clippy::too_many_arguments)]
pub fn build_event(
    phase: Phase,
    phase_percent: f64,
    plan: Plan,
    queue: Option<&QueueProgress>,
    status: &str,
    details: Option<String>,
    indeterminate: Option<bool>,
    metrics: Metrics,
) -> JobProgressEvent {
    let item_overall_percent = compute_item_overall(phase, phase_percent, plan);
    let overall_percent = apply_queue_weighting(item_overall_percent, queue);
    let indeterminate = match indeterminate {
        Some(value) => value,
        None => !phase_percent.is_finite(),
    };
    JobProgressEvent {
        phase,
        phase_percent: phase_percent.is_finite().then_some(phase_percent),
        item_overall_percent,
        overall_percent,
        queue_item_id: queue.and_then(|queue| queue.queue_item_id.clone()),
        status: status.to_string(),
        details,
        indeterminate,
        downloaded_bytes: non_negative(metrics.downloaded_bytes),
        total_bytes: non_negative(metrics.total_bytes),
        speed_bytes_per_second: non_negative(metrics.speed_bytes_per_second),
        eta_seconds: non_negative(metrics.eta_seconds),
    }
}

pub fn idle_event(queue: Option<&QueueProgress>) -> JobProgressEvent {
    JobProgressEvent {
        phase: Phase::Idle,
        phase_percent: Some(0.0),
        item_overall_percent: 0.0,
        overall_percent: 0.0,
        queue_item_id: queue.and_then(|queue| queue.queue_item_id.clone()),
        status: "Ready".to_string(),
        details: None,
        indeterminate: false,
        downloaded_bytes: None,
        total_bytes: None,
        speed_bytes_per_second: None,
        eta_seconds: None,
    }
}

pub fn parse_ffmpeg_duration(stderr: &str) -> Option<f64> {
    let start = stderr.find("Duration:")? + "Duration:".len();
    let clock = stderr[start..]
        .trim_start()
        .split([',', ' ', '\n'])
        .next()?;
    let mut parts = clock.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    let total = hours * 3600.0 + minutes * 60.0 + seconds;
    total.is_finite().then_some(total)
}

pub struct FfmpegProgressState {
    buffer: String,
    duration_seconds: Option<f64>,
}

impl FfmpegProgressState {
    pub fn new(duration_seconds: Option<f64>) -> Self {
        Self {
            buffer: String::new(),
            duration_seconds,
        }
    }

    /// Feed one `-progress pipe:1` chunk; returns a percent when known.
    /// `out_time_ms` is microseconds despite its name, like `out_time_us`.
    pub fn push(&mut self, chunk: &str) -> Option<f64> {
        self.buffer.push_str(chunk);
        let mut out_time_us = None;
        while let Some(index) = self.buffer.find('\n') {
            let line: String = self.buffer.drain(..=index).collect();
            let line = line.trim();
            if let Some(raw) = line.strip_prefix("out_time_us=") {
                if let Ok(value) = raw.parse::<f64>() {
                    out_time_us = Some(value);
                }
            } else if let Some(raw) = line.strip_prefix("out_time_ms=") {
                if out_time_us.is_none() {
                    if let Ok(value) = raw.parse::<f64>() {
                        out_time_us = Some(value);
                    }
                }
            }
        }
        let duration = self.duration_seconds.filter(|duration| *duration > 0.0)?;
        let elapsed = out_time_us? / 1_000_000.0;
        elapsed
            .is_finite()
            .then(|| (elapsed / duration * 100.0).min(100.0))
    }
}

/// Phase weights follow the effective quality flags (derived from the profile,
/// then request overrides), not only the -f string.
pub fn resolve_plan(settings: &Settings) -> Plan {
    Plan {
        expect_merge: !settings.audio_only && (settings.best_quality || settings.advanced_options),
        expect_convert: settings.convert_enabled,
    }
}

/// Throttles job-progress emission to one event per 200 ms unless the
/// rounded overall percent changes or the event is indeterminate.
pub struct Reporter {
    pub plan: Plan,
    pub queue: Option<QueueProgress>,
    pub show_taskbar: bool,
    last_emit: Option<Instant>,
    last_overall: f64,
}

impl Reporter {
    pub fn new(plan: Plan, queue: Option<QueueProgress>, show_taskbar: bool) -> Self {
        Self {
            plan,
            queue,
            show_taskbar,
            last_emit: None,
            last_overall: -1.0,
        }
    }

    pub fn should_emit(&mut self, event: &JobProgressEvent) -> bool {
        let rounded = (event.overall_percent * 10.0).round() / 10.0;
        let recent = self
            .last_emit
            .is_some_and(|at| at.elapsed() < EMIT_INTERVAL);
        if recent && rounded == self.last_overall && !event.indeterminate {
            return false;
        }
        self.last_emit = Some(Instant::now());
        self.last_overall = rounded;
        true
    }
}
