//! FFmpeg conversion for a download session: per-entry conversion, progress,
//! and the batch result reported at the end of a run.

use super::publication::{
    publish_caption_sidecars, publish_pending_sources, publish_same_extension_for_session,
    publish_staged_source, publish_staged_source_with_captions, push_completed_path,
    retire_staged_source, PendingSourcePublication,
};
use super::{
    active_not_cancelled, append_bounded, complete_session, emit_phase, output_format_from_path,
    read_lines, sanitize_filename, send_progress, wait_for_readers, with_session, CompletionMeta,
    CANCELLED_PROGRESS, CANCELLED_STATUS,
};
use crate::command_builders::{build_ffmpeg_args, resolve_video_encoder};
use crate::constants::*;
use crate::progress;
use crate::staging::{install_no_replace, sync_staged_file, DownloadStage};
use crate::types::{Outcome, Phase, Settings};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

fn emit_convert_progress(id: u64, percent: Option<f64>, status: &str) {
    let value = percent.unwrap_or(f64::NAN);
    emit_phase(
        id,
        Phase::Convert,
        value,
        status,
        Some(percent.is_none() || !value.is_finite()),
    );
}

fn show_ffmpeg_missing_dialog(ffmpeg: &Path) {
    crate::notices::show(
        "FFmpeg Error",
        &format!(
            "Failed to start conversion: FFmpeg not found at {}.\n\nROSI uses bundled FFmpeg by default. If you set a custom FFmpeg path, make sure it points to a valid FFmpeg binary.",
            ffmpeg.display()
        ),
        crate::notices::NoticeKind::Error,
        true,
    );
}

#[derive(Debug)]
pub(super) enum ConversionFailure {
    Cancelled,
    TimedOut,
    Spawn(std::io::Error),
    Exit(Option<i32>, String),
    Setup(String),
    SetupPublished { message: String, path: PathBuf },
}

fn install_conversion_output_for_session(
    id: u64,
    temp: &Path,
    input: &Path,
    target: &str,
    download_dir: &Path,
) -> Result<PathBuf, ConversionFailure> {
    if !active_not_cancelled(id) {
        return Err(ConversionFailure::Cancelled);
    }
    // File installation and fsync run without the session lock, so close
    // requests, cancellation and progress never wait on disk flushes. A cancel
    // that lands meanwhile still sees this output in the batch result.
    let output = install_conversion_output(temp, input, target, download_dir)
        .map_err(ConversionFailure::Setup)?;
    with_session(id, |session| {
        session.conversion_format = Some(target.to_string());
        session.completed_paths.push(output.clone());
    });
    Ok(output)
}

fn record_conversion_failure(id: u64, path: &Path, detail: &str) {
    with_session(id, |session| {
        if !session.cancelled {
            session.failed_paths.push(path.to_path_buf());
            session
                .conversion_failures
                .push(format!("{}: {detail}", path.display()));
        }
    });
}

struct ConversionTemp {
    directory: PathBuf,
    output: PathBuf,
}

impl Drop for ConversionTemp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.output);
        let _ = std::fs::remove_dir(&self.directory);
    }
}

fn reserve_conversion_temp(input: &Path, target: &str) -> Result<ConversionTemp, String> {
    let parent = input.parent().unwrap_or_else(|| Path::new("."));
    for _ in 0..32 {
        let directory = parent.join(format!(".rosi-convert-{}", crate::fs_util::uuid_v4()));
        match crate::fs_util::private_dir_builder().create(&directory) {
            Ok(()) => {
                crate::staging::hide_on_windows(&directory);
                return Ok(ConversionTemp {
                    output: directory.join(format!("output.{target}")),
                    directory,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not reserve a unique conversion staging path.".to_string())
}

fn install_conversion_output(
    temp: &Path,
    input: &Path,
    target: &str,
    download_dir: &Path,
) -> Result<PathBuf, String> {
    let raw_stem = input
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut stem = sanitize_filename(&raw_stem);
    if stem.trim().is_empty() {
        stem = format!("download_{}", crate::fs_util::uuid_v4());
    }
    // Leave room for the largest collision suffix (` (9999)`) and the
    // longest supported extension so every installed component stays within
    // common 255-byte filesystem limits.
    let max_stem_bytes = 255usize.saturating_sub(7 + 1 + target.len());
    let mut end = stem.len().min(max_stem_bytes);
    while end > 0 && !stem.is_char_boundary(end) {
        end -= 1;
    }
    stem.truncate(end);
    sync_staged_file(temp).map_err(|error| {
        format!(
            "Could not sync converted output {}: {error}",
            temp.display()
        )
    })?;
    for suffix in 0..10_000u32 {
        let name = if suffix == 0 {
            format!("{stem}.{target}")
        } else {
            format!("{stem} ({suffix}).{target}")
        };
        let candidate = download_dir.join(name);
        match install_no_replace(temp, &candidate) {
            Ok(()) => {
                crate::fs_util::sync_directory(download_dir).map_err(|error| {
                    format!(
                        "Could not sync output directory {} after installing {}: {error}",
                        download_dir.display(),
                        candidate.display()
                    )
                })?;
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                "Could not atomically install converted output {} without replacing it: {error}",
                candidate.display()
            ))
            }
        }
    }
    Err("Could not find an unused filename for the converted output.".to_string())
}

fn execute_ffmpeg(
    id: u64,
    ffmpeg: &Path,
    args: &[String],
    duration_seconds: Option<f64>,
    progress_start: f64,
    progress_span: f64,
) -> Result<(), ConversionFailure> {
    if !active_not_cancelled(id) {
        return Err(ConversionFailure::Cancelled);
    }
    let mut command = crate::process_util::command(ffmpeg, args, &[], true);
    let child = crate::process_util::spawn(&mut command).map_err(ConversionFailure::Spawn)?;
    let registered = with_session(id, |session| {
        if session.cancelled {
            false
        } else {
            session.ffmpeg = Some(Arc::clone(&child));
            true
        }
    })
    .unwrap_or(false);
    if !registered {
        crate::process_util::terminate_tree(&child);
        return Err(ConversionFailure::Cancelled);
    }

    let progress_state = Arc::new(Mutex::new(progress::FfmpegProgressState::new(
        duration_seconds,
    )));
    let last_output = Arc::new(Mutex::new(std::time::Instant::now()));
    let stdout_reader = {
        let state = Arc::clone(&progress_state);
        let last_output = Arc::clone(&last_output);
        read_lines(child.take_stdout(), move |line| {
            if let Ok(mut at) = last_output.lock() {
                *at = std::time::Instant::now();
            }
            if !active_not_cancelled(id) {
                return;
            }
            let percent = state
                .lock()
                .ok()
                .and_then(|mut state| state.push(&format!("{line}\n")));
            if let Some(percent) = percent {
                let aggregate =
                    progress_start + (percent.clamp(0.0, 100.0) / 100.0) * progress_span;
                emit_convert_progress(id, Some(aggregate), "Converting...");
            }
        })
    };
    let stderr = Arc::new(Mutex::new(String::new()));
    let stderr_reader = {
        let stderr = Arc::clone(&stderr);
        let last_output = Arc::clone(&last_output);
        read_lines(child.take_stderr(), move |line| {
            if let Ok(mut at) = last_output.lock() {
                *at = std::time::Instant::now();
            }
            let text = line.trim();
            if !text.is_empty() {
                append_bounded(&stderr, text, MAX_ERROR_BUFFER, true);
                send_progress(id, format!("[ffmpeg] {text}"));
            }
        })
    };

    let mut timed_out = false;
    // `-progress` reports about twice a second, so silence means a stall.
    let waited = loop {
        match child.wait_timeout(std::time::Duration::from_secs(1)) {
            Ok(None) => {
                let silent_for = last_output
                    .lock()
                    .map(|at| at.elapsed())
                    .unwrap_or_default();
                if silent_for >= FFMPEG_STALL_TIMEOUT {
                    break Ok(None);
                }
            }
            other => break other,
        }
    };
    let status = match waited {
        Ok(Some(status)) => Some(status),
        Ok(None) => {
            timed_out = true;
            if with_session(id, |session| {
                session
                    .ffmpeg
                    .as_ref()
                    .is_some_and(|owned| Arc::ptr_eq(owned, &child))
            })
            .unwrap_or(false)
            {
                send_progress(
                    id,
                    "❌ Conversion stopped: FFmpeg made no progress for 10 minutes.",
                );
            }
            crate::process_util::terminate_tree(&child);
            child.wait().ok()
        }
        Err(_) => {
            crate::process_util::terminate_tree(&child);
            child.wait().ok()
        }
    };
    let readers_complete = wait_for_readers([stdout_reader, stderr_reader]);
    timed_out |= !readers_complete;
    let was_cancelled = with_session(id, |session| {
        if session
            .ffmpeg
            .as_ref()
            .is_some_and(|owned| Arc::ptr_eq(owned, &child))
        {
            session.ffmpeg = None;
        }
        session.cancelled
    })
    .unwrap_or(true);
    if was_cancelled {
        return Err(ConversionFailure::Cancelled);
    }
    if timed_out {
        return Err(ConversionFailure::TimedOut);
    }
    let Some(status) = status else {
        return Err(ConversionFailure::Setup(
            "Could not read FFmpeg's exit status.".to_string(),
        ));
    };
    if status.success() {
        Ok(())
    } else {
        Err(ConversionFailure::Exit(
            status.code(),
            stderr.lock().map(|text| text.clone()).unwrap_or_default(),
        ))
    }
}

fn probe_media_codecs_for_session(
    id: u64,
    ffmpeg: &Path,
    input: &Path,
) -> Result<crate::command_builders::SourceCodecs, String> {
    let args = vec![
        "-hide_banner".to_string(),
        "-protocol_whitelist".to_string(),
        "file".to_string(),
        "-i".to_string(),
        input.to_string_lossy().into_owned(),
    ];
    let mut command = crate::process_util::command(ffmpeg, &args, &[], true);
    let child = match crate::process_util::spawn(&mut command) {
        Ok(child) => child,
        Err(error) => {
            crate::logging::warn(&format!("Failed to spawn ffmpeg codec probe: {error}"));
            return Err(format!("Could not start the codec probe: {error}"));
        }
    };
    let registered = with_session(id, |session| {
        if session.cancelled {
            false
        } else {
            session.ffmpeg = Some(Arc::clone(&child));
            true
        }
    })
    .unwrap_or(false);
    if !registered {
        crate::process_util::terminate_tree(&child);
        return Err("The download session ended before its codec probe completed.".into());
    }

    let output =
        crate::process_util::wait_with_output(&child, CODEC_PROBE_TIMEOUT, 4096, MAX_ERROR_BUFFER);
    let cancelled = with_session(id, |session| {
        if session
            .ffmpeg
            .as_ref()
            .is_some_and(|owned| Arc::ptr_eq(owned, &child))
        {
            session.ffmpeg = None;
        }
        session.cancelled
    })
    .unwrap_or(true);
    if cancelled {
        return Err("The download session was cancelled during its codec probe.".into());
    }
    match output {
        Ok(output) if output.timed_out => {
            crate::logging::warn("FFmpeg codec probe timed out or left output pipes open.");
            Err("The codec probe timed out or left output pipes open.".into())
        }
        Ok(output) if output.stderr.len() >= MAX_ERROR_BUFFER => {
            crate::logging::warn("FFmpeg codec probe diagnostics reached the capture limit.");
            Err("The codec probe diagnostics were truncated at the capture limit.".into())
        }
        Ok(output) if !output.stderr.contains("Input #") || !output.stderr.contains("Stream #") => {
            crate::logging::warn(
                "FFmpeg codec probe returned no complete input stream diagnostics.",
            );
            Err("The codec probe did not identify the input streams.".into())
        }
        Ok(output) => Ok(crate::command_builders::parse_codecs(&output.stderr)),
        Err(error) => {
            crate::logging::warn(&format!("Failed to run ffmpeg codec probe: {error}"));
            Err(format!("Failed to run the codec probe: {error}"))
        }
    }
}

struct ConversionPosition {
    index: usize,
    count: usize,
}

struct ConvertedOutput {
    path: PathBuf,
    unchanged: bool,
    preserve_original: bool,
}

fn convert_one(
    id: u64,
    input: &Path,
    download_dir: &Path,
    target: &str,
    effective: &Settings,
    ffmpeg: &Path,
    position: ConversionPosition,
) -> Result<ConvertedOutput, ConversionFailure> {
    let input_ext = input
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let progress_start = position.index as f64 * 100.0 / position.count.max(1) as f64;
    let progress_span = 100.0 / position.count.max(1) as f64;
    if input_ext == target {
        send_progress(
            id,
            format!(
                "ℹ️ {} is already {}. Skipping conversion.",
                input.file_name().unwrap_or_default().to_string_lossy(),
                target.to_uppercase()
            ),
        );
        emit_convert_progress(id, Some(progress_start + progress_span), "Entry complete");
        return Ok(ConvertedOutput {
            path: input.to_path_buf(),
            unchanged: true,
            preserve_original: false,
        });
    }
    send_progress(
        id,
        format!(
            "🎬 Converting {} to {}...",
            input.file_name().unwrap_or_default().to_string_lossy(),
            target.to_uppercase()
        ),
    );
    let (codecs, probe_complete) = match probe_media_codecs_for_session(id, ffmpeg, input) {
        Ok(codecs) => (codecs, true),
        Err(error) => {
            crate::logging::warn(&format!(
                "Could not reliably inspect codecs for {}; retaining the original after conversion: {error}",
                input.display()
            ));
            (crate::command_builders::SourceCodecs::default(), false)
        }
    };
    if !active_not_cancelled(id) {
        return Err(ConversionFailure::Cancelled);
    }
    let preserve_original =
        crate::command_builders::must_preserve_original(target, &codecs, probe_complete);
    let selected_encoder = resolve_video_encoder(effective);
    let original_args = build_ffmpeg_args(input, input, target, &selected_encoder, Some(&codecs));
    let gpu_encoder_used = effective.gpu_acceleration
        && selected_encoder != "copy"
        && original_args
            .windows(2)
            .any(|pair| pair[0] == "-c:v" && pair[1] == selected_encoder);
    let encoders = if gpu_encoder_used {
        vec![selected_encoder.clone(), "libx264".to_string()]
    } else {
        vec![selected_encoder]
    };
    for (attempt, encoder) in encoders.iter().enumerate() {
        let staging = reserve_conversion_temp(input, target).map_err(ConversionFailure::Setup)?;
        let temp = &staging.output;
        let args = build_ffmpeg_args(input, temp, target, encoder, Some(&codecs));
        if *encoder != "libx264" && *encoder != "copy" {
            send_progress(id, format!("🖥️ Using GPU acceleration ({encoder})"));
        } else if attempt > 0 {
            send_progress(
                id,
                "⚠️ GPU encoder failed. Retrying conversion on the CPU (libx264).",
            );
        }
        match execute_ffmpeg(
            id,
            ffmpeg,
            &args,
            codecs.duration_seconds,
            progress_start,
            progress_span,
        ) {
            Ok(()) => {
                if !active_not_cancelled(id) {
                    let _ = std::fs::remove_file(temp);
                    return Err(ConversionFailure::Cancelled);
                }
                if !std::fs::symlink_metadata(temp)
                    .is_ok_and(|metadata| metadata.file_type().is_file())
                    || crate::fs_util::file_size(temp).unwrap_or(0) == 0
                {
                    let _ = std::fs::remove_file(temp);
                    return Err(ConversionFailure::Setup(
                        "FFmpeg reported success without creating a non-empty output.".to_string(),
                    ));
                }
                let output = match install_conversion_output_for_session(
                    id,
                    temp,
                    input,
                    target,
                    download_dir,
                ) {
                    Ok(output) => output,
                    Err(error) => {
                        let _ = std::fs::remove_file(temp);
                        return Err(error);
                    }
                };
                emit_convert_progress(id, Some(progress_start + progress_span), "Entry complete");
                return Ok(ConvertedOutput {
                    path: output,
                    unchanged: false,
                    preserve_original,
                });
            }
            Err(ConversionFailure::Exit(code, _stderr)) if attempt + 1 < encoders.len() => {
                let _ = std::fs::remove_file(temp);
                send_progress(
                    id,
                    format!(
                        "⚠️ GPU FFmpeg attempt exited with code {}; trying CPU encoder.",
                        code.map_or("null".to_string(), |value| value.to_string())
                    ),
                );
            }
            Err(error) => {
                let _ = std::fs::remove_file(temp);
                return Err(error);
            }
        }
    }
    Err(ConversionFailure::Setup(
        "No compatible FFmpeg encoder attempt completed.".to_string(),
    ))
}

fn failure_message(failure: &ConversionFailure) -> String {
    match failure {
        ConversionFailure::Cancelled => "Conversion cancelled.".into(),
        ConversionFailure::TimedOut => "FFmpeg made no progress for 10 minutes.".into(),
        ConversionFailure::Spawn(error) if error.kind() == std::io::ErrorKind::NotFound => {
            "FFmpeg was not found at the configured path.".into()
        }
        ConversionFailure::Spawn(error) => format!("Could not start FFmpeg: {error}"),
        ConversionFailure::Exit(code, details) => format!(
            "FFmpeg exited with code {}. {}",
            code.map_or("null".to_string(), |value| value.to_string()),
            details
                .lines()
                .rev()
                .take(8)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join(" | ")
        ),
        ConversionFailure::Setup(message) => message.clone(),
        ConversionFailure::SetupPublished { message, .. } => message.clone(),
    }
}

fn complete_conversion_batch(
    id: u64,
    target: String,
    total_entries: usize,
    completed: Vec<PathBuf>,
    failed: Vec<PathBuf>,
    failures: Vec<String>,
    cancelled: bool,
) {
    let final_path = completed.last().cloned();
    let format = final_path
        .as_deref()
        .and_then(output_format_from_path)
        .or_else(|| Some(target.clone()));
    let bytes = completed
        .iter()
        .filter_map(|path| crate::fs_util::file_size(path))
        .fold(0u64, u64::saturating_add);
    // Silent cancellations (queue shutdown, replaced sessions) stay silent,
    // matching the download-phase cancellation path.
    let notify = cancelled && with_session(id, |session| session.cancel_notify).unwrap_or(false);
    let meta = CompletionMeta {
        format,
        bytes: (!completed.is_empty()).then_some(bytes),
        file_path: final_path,
        output_paths: (!completed.is_empty()).then_some(completed),
        failed_paths: (!failed.is_empty()).then_some(failed.clone()),
        error: (!failures.is_empty()).then(|| failures.join("; ")),
        progress_message: notify.then(|| CANCELLED_PROGRESS.into()),
        suppress_legacy_complete: cancelled && !notify,
    };
    if cancelled {
        complete_session(id, CANCELLED_STATUS, Outcome::Cancelled, meta);
    } else if failed.is_empty() {
        complete_session(id, "🎬 Conversion complete.", Outcome::Success, meta);
    } else {
        let status = format!(
            "❌ Conversion partially failed ({} of {} entries).",
            failed.len(),
            total_entries
        );
        complete_session(id, &status, Outcome::Failed, meta);
    }
}

pub(super) fn run_conversion(
    id: u64,
    downloaded: Vec<PathBuf>,
    mut stage: DownloadStage,
    download_dir: PathBuf,
    effective: Settings,
    ffmpeg: PathBuf,
) {
    std::thread::spawn(move || {
        send_progress(id, "⏳ Checking if conversion is needed...");
        let target = if effective.convert_format.trim().is_empty() {
            "mp4".to_string()
        } else {
            effective.convert_format.trim().to_lowercase()
        };
        let count = downloaded.len();
        let total_entries = count;
        let mut completed = Vec::new();
        let mut failed = Vec::new();
        let mut failures = Vec::new();
        let mut missing_ffmpeg = false;
        for (index, input) in downloaded.iter().enumerate() {
            if !active_not_cancelled(id) {
                publish_pending_sources(PendingSourcePublication {
                    id,
                    inputs: &downloaded[index..],
                    download_dir: &download_dir,
                    stage: &mut stage,
                    write_subtitles: effective.write_subtitles,
                    completed: &mut completed,
                    failed: &mut failed,
                    failures: &mut failures,
                });
                complete_conversion_batch(
                    id,
                    target,
                    total_entries,
                    completed,
                    failed,
                    failures,
                    true,
                );
                return;
            }
            match convert_one(
                id,
                input,
                &download_dir,
                &target,
                &effective,
                &ffmpeg,
                ConversionPosition { index, count },
            ) {
                Ok(result) if result.unchanged => {
                    match publish_same_extension_for_session(
                        id,
                        input,
                        &target,
                        &download_dir,
                        &mut stage,
                        effective.write_subtitles,
                    ) {
                        Ok(output) => {
                            completed.push(output);
                        }
                        Err(ConversionFailure::Cancelled) => {
                            publish_pending_sources(PendingSourcePublication {
                                id,
                                inputs: &downloaded[index..],
                                download_dir: &download_dir,
                                stage: &mut stage,
                                write_subtitles: effective.write_subtitles,
                                completed: &mut completed,
                                failed: &mut failed,
                                failures: &mut failures,
                            });
                            complete_conversion_batch(
                                id,
                                target,
                                total_entries,
                                completed,
                                failed,
                                failures,
                                true,
                            );
                            return;
                        }
                        Err(error) => {
                            let detail = failure_message(&error);
                            let failed_path = match &error {
                                ConversionFailure::SetupPublished { path, .. } => {
                                    push_completed_path(&mut completed, path.clone());
                                    path.clone()
                                }
                                _ => input.clone(),
                            };
                            failed.push(failed_path.clone());
                            failures.push(format!("{}: {detail}", failed_path.display()));
                            record_conversion_failure(id, &failed_path, &detail);
                            if input.exists() {
                                stage.preserve_on_drop = true;
                            }
                        }
                    }
                }
                Ok(result) => {
                    let output = result.path;
                    if !active_not_cancelled(id) {
                        publish_pending_sources(PendingSourcePublication {
                            id,
                            inputs: &downloaded[index..],
                            download_dir: &download_dir,
                            stage: &mut stage,
                            write_subtitles: effective.write_subtitles,
                            completed: &mut completed,
                            failed: &mut failed,
                            failures: &mut failures,
                        });
                        if output.exists() && !completed.contains(&output) {
                            completed.push(output);
                        }
                        complete_conversion_batch(
                            id,
                            target,
                            total_entries,
                            completed,
                            failed,
                            failures,
                            true,
                        );
                        return;
                    }
                    let should_preserve_original = result.preserve_original;
                    let mut preserve_publication_failed = false;
                    if should_preserve_original {
                        match publish_staged_source_with_captions(
                            input,
                            &download_dir,
                            &mut stage,
                            effective.write_subtitles,
                        ) {
                            Ok(path) => {
                                send_progress(
                                    id,
                                    format!(
                                        "ℹ️ Retained original to preserve artwork or unsupported or unverified captions: {}",
                                        path.display()
                                    ),
                                );
                                push_completed_path(&mut completed, path);
                            }
                            Err(error) => {
                                preserve_publication_failed = true;
                                let failed_path =
                                    error.media_path.clone().unwrap_or_else(|| input.clone());
                                if error.media_path.is_some() {
                                    push_completed_path(&mut completed, failed_path.clone());
                                }
                                failed.push(failed_path.clone());
                                failures.push(format!(
                                    "{}: {}",
                                    failed_path.display(),
                                    error.detail
                                ));
                                record_conversion_failure(id, &failed_path, &error.detail);
                            }
                        }
                    } else if effective.write_subtitles {
                        if let Err(error) =
                            publish_caption_sidecars(input, &output, &download_dir, &mut stage)
                        {
                            let detail = format!("Could not publish requested captions: {error}");
                            let preserved = publish_staged_source_with_captions(
                                input,
                                &download_dir,
                                &mut stage,
                                true,
                            );
                            preserve_publication_failed = true;
                            let (failed_path, detail) = match preserved {
                                Ok(path) => {
                                    push_completed_path(&mut completed, path.clone());
                                    (path, detail)
                                }
                                Err(preserve_error) => {
                                    let failed_path = preserve_error
                                        .media_path
                                        .clone()
                                        .unwrap_or_else(|| input.clone());
                                    if preserve_error.media_path.is_some() {
                                        push_completed_path(&mut completed, failed_path.clone());
                                    }
                                    (failed_path, format!("{detail}; {}", preserve_error.detail))
                                }
                            };
                            failed.push(failed_path.clone());
                            failures.push(format!("{}: {detail}", failed_path.display()));
                            record_conversion_failure(id, &failed_path, &detail);
                        }
                    }
                    if !should_preserve_original
                        && !effective.keep_original_after_convert
                        && !preserve_publication_failed
                    {
                        match retire_staged_source(input, &download_dir, &mut stage) {
                            Ok(None) => send_progress(
                                id,
                                format!("🗑️ Deleted owned original: {}", input.display()),
                            ),
                            Ok(Some(path)) => {
                                send_progress(
                                    id,
                                    format!(
                                        "ℹ️ Preserved replaced original file: {}",
                                        path.display()
                                    ),
                                );
                                push_completed_path(&mut completed, path);
                            }
                            Err(error) => {
                                send_progress(
                                    id,
                                    format!(
                                        "⚠️ Could not retire original safely: {}",
                                        error.detail
                                    ),
                                );
                                let failed_path =
                                    error.media_path.clone().unwrap_or_else(|| input.clone());
                                if error.media_path.is_some() {
                                    push_completed_path(&mut completed, failed_path.clone());
                                }
                                failed.push(failed_path.clone());
                                failures.push(format!(
                                    "{}: {}",
                                    failed_path.display(),
                                    error.detail
                                ));
                                record_conversion_failure(id, &failed_path, &error.detail);
                            }
                        }
                    } else if !should_preserve_original
                        && effective.keep_original_after_convert
                        && !preserve_publication_failed
                    {
                        match publish_staged_source(input, &download_dir, &mut stage) {
                            Ok(path) => {
                                send_progress(
                                    id,
                                    format!("ℹ️ Keeping original file: {}", path.display()),
                                );
                                push_completed_path(&mut completed, path);
                            }
                            Err(error) => {
                                let failed_path =
                                    error.media_path.clone().unwrap_or_else(|| input.clone());
                                if error.media_path.is_some() {
                                    push_completed_path(&mut completed, failed_path.clone());
                                }
                                failed.push(failed_path.clone());
                                failures.push(format!(
                                    "{}: {}",
                                    failed_path.display(),
                                    error.detail
                                ));
                                record_conversion_failure(id, &failed_path, &error.detail);
                            }
                        }
                    }
                    send_progress(
                        id,
                        format!("🎉 Successfully converted to {}", output.display()),
                    );
                    push_completed_path(&mut completed, output);
                }
                Err(ConversionFailure::Cancelled) => {
                    publish_pending_sources(PendingSourcePublication {
                        id,
                        inputs: &downloaded[index..],
                        download_dir: &download_dir,
                        stage: &mut stage,
                        write_subtitles: effective.write_subtitles,
                        completed: &mut completed,
                        failed: &mut failed,
                        failures: &mut failures,
                    });
                    complete_conversion_batch(
                        id,
                        target,
                        total_entries,
                        completed,
                        failed,
                        failures,
                        true,
                    );
                    return;
                }
                Err(error) => {
                    if matches!(&error, ConversionFailure::Spawn(spawn) if spawn.kind() == std::io::ErrorKind::NotFound)
                    {
                        missing_ffmpeg = true;
                    }
                    let detail = failure_message(&error);
                    let preserved = publish_staged_source_with_captions(
                        input,
                        &download_dir,
                        &mut stage,
                        effective.write_subtitles,
                    );
                    let failed_path = match preserved {
                        Ok(path) => {
                            send_progress(
                                id,
                                format!("❌ Conversion failed for {}: {detail}", path.display()),
                            );
                            push_completed_path(&mut completed, path.clone());
                            path
                        }
                        Err(preserve_error) => {
                            let failed_path = preserve_error
                                .media_path
                                .clone()
                                .unwrap_or_else(|| input.clone());
                            if preserve_error.media_path.is_some() {
                                push_completed_path(&mut completed, failed_path.clone());
                            }
                            let detail = format!("{detail}; {}", preserve_error.detail);
                            send_progress(
                                id,
                                format!(
                                    "❌ Conversion failed for {}: {detail}",
                                    failed_path.display()
                                ),
                            );
                            failures.push(format!("{}: {detail}", failed_path.display()));
                            record_conversion_failure(id, &failed_path, &detail);
                            failed.push(failed_path);
                            continue;
                        }
                    };
                    record_conversion_failure(id, &failed_path, &detail);
                    failed.push(failed_path.clone());
                    failures.push(format!("{}: {detail}", failed_path.display()));
                }
            }
        }
        if missing_ffmpeg {
            send_progress(
                id,
                format!("❌ FFmpeg was not found at {}.", ffmpeg.display()),
            );
            show_ffmpeg_missing_dialog(&ffmpeg);
        }
        if failed.is_empty() {
            emit_convert_progress(id, Some(100.0), "Conversion complete");
        }
        complete_conversion_batch(
            id,
            target,
            total_entries,
            completed,
            failed,
            failures,
            false,
        );
    });
}
