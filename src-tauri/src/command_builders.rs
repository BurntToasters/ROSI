//! yt-dlp and FFmpeg argument builders plus the codec probe used to decide
//! stream copy vs re-encode during conversion.

use crate::constants::*;
use crate::types::{DownloadRequestOptions, Settings};
use std::path::Path;

#[derive(Clone, Debug, Default)]
pub struct SourceCodecs {
    pub video: Option<String>,
    pub audio: Option<String>,
    pub duration_seconds: Option<f64>,
}

fn codec_after(stderr: &str, marker: &str) -> Option<String> {
    for line in stderr.lines() {
        if !line.contains("Stream #") {
            continue;
        }
        if let Some(index) = line.find(marker) {
            let codec: String = line[index + marker.len()..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if !codec.is_empty() {
                return Some(codec);
            }
        }
    }
    None
}

pub fn parse_codecs(stderr: &str) -> SourceCodecs {
    SourceCodecs {
        video: codec_after(stderr, ": Video: "),
        audio: codec_after(stderr, ": Audio: "),
        duration_seconds: crate::progress::parse_ffmpeg_duration(stderr),
    }
}

pub fn probe_media_codecs(ffmpeg: &Path, input: &Path) -> SourceCodecs {
    let args = vec![
        "-hide_banner".to_string(),
        "-i".to_string(),
        input.to_string_lossy().into_owned(),
    ];
    let mut command = crate::process_util::command(ffmpeg, &args, &[], true);
    match crate::process_util::run_with_timeout(
        &mut command,
        CODEC_PROBE_TIMEOUT,
        4096,
        MAX_ERROR_BUFFER,
    ) {
        Ok(output) => parse_codecs(&output.stderr),
        Err(error) => {
            crate::logging::warn(&format!("Failed to spawn ffmpeg codec probe: {error}"));
            SourceCodecs::default()
        }
    }
}

const CONTAINER_COMPATIBLE_VIDEO: &[&str] =
    &["h264", "avc1", "hevc", "h265", "av1", "av01", "mpeg4"];
const CONTAINER_COMPATIBLE_AUDIO: &[&str] = &["aac", "mp4a", "mp3", "ac3", "alac"];

fn resolve_gpu_video_encoder(settings: &Settings) -> &'static str {
    match settings.gpu_type.as_str() {
        "nvidia" => return "h264_nvenc",
        "amd" => return "h264_amf",
        "intel" => return "h264_qsv",
        _ => {}
    }
    let detected = crate::gpu::detect();
    if detected.nvidia {
        "h264_nvenc"
    } else if detected.amd {
        "h264_amf"
    } else if detected.intel {
        "h264_qsv"
    } else {
        "libx264"
    }
}

pub fn resolve_video_encoder(settings: &Settings) -> String {
    if !settings.gpu_acceleration {
        return "copy".to_string();
    }
    match resolve_gpu_video_encoder(settings) {
        "libx264" => "copy".to_string(),
        encoder => encoder.to_string(),
    }
}

pub fn build_ffmpeg_args(
    input: &Path,
    output: &Path,
    target_format: &str,
    video_encoder: &str,
    source: Option<&SourceCodecs>,
) -> Vec<String> {
    let input = input.to_string_lossy().into_owned();
    let output = output.to_string_lossy().into_owned();
    let lower = |value: &Option<String>| value.as_deref().map(str::to_lowercase);
    if target_format == "mp3" || target_format == "m4a" {
        let target_codec = if target_format == "mp3" {
            "libmp3lame"
        } else {
            "aac"
        };
        let source_audio = source.and_then(|codecs| lower(&codecs.audio));
        let can_copy = matches!(
            (target_format, source_audio.as_deref()),
            ("m4a", Some("aac" | "mp4a")) | ("mp3", Some("mp3"))
        );
        return [
            "-progress",
            "pipe:1",
            "-nostats",
            "-i",
            &input,
            "-vn",
            "-c:a",
            if can_copy { "copy" } else { target_codec },
            "-y",
            &output,
        ]
        .iter()
        .map(|arg| arg.to_string())
        .collect();
    }
    let source_video = source.and_then(|codecs| lower(&codecs.video));
    let source_audio = source.and_then(|codecs| lower(&codecs.audio));
    let video = match (source, source_video.as_deref()) {
        (Some(_), Some(codec)) if CONTAINER_COMPATIBLE_VIDEO.contains(&codec) => "copy",
        _ => video_encoder,
    };
    let audio = match (source, source_audio.as_deref()) {
        (Some(_), Some(codec)) if CONTAINER_COMPATIBLE_AUDIO.contains(&codec) => "copy",
        _ => "aac",
    };
    [
        "-progress",
        "pipe:1",
        "-nostats",
        "-i",
        &input,
        "-c:v",
        video,
        "-c:a",
        audio,
        "-movflags",
        "+faststart",
        "-y",
        &output,
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect()
}

pub struct YtdlpArgsInput<'a> {
    pub download_dir: &'a Path,
    pub url: &'a str,
    pub settings: &'a Settings,
    pub options: &'a DownloadRequestOptions,
    pub ffmpeg_location: Option<&'a str>,
    pub path_output_file: Option<&'a Path>,
}

fn insert_before_url(args: &mut Vec<String>, items: &[&str]) {
    let index = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len().saturating_sub(1));
    for (offset, item) in items.iter().enumerate() {
        args.insert(index + offset, item.to_string());
    }
}

fn playlist_args(options: &DownloadRequestOptions) -> Vec<String> {
    let Some(selection) = &options.playlist else {
        return vec!["--no-playlist".into()];
    };
    match selection.mode.as_str() {
        "all" => vec!["--yes-playlist".into()],
        "range" => match (selection.start, selection.end) {
            (Some(start), Some(end))
                if start >= 1 && end >= start && end <= MAX_PLAYLIST_ITEM_INDEX =>
            {
                vec![
                    "--yes-playlist".into(),
                    "--playlist-items".into(),
                    format!("{start}-{end}"),
                ]
            }
            _ => vec!["--no-playlist".into()],
        },
        _ => vec!["--no-playlist".into()],
    }
}

pub fn build_ytdlp_args(input: YtdlpArgsInput<'_>) -> (Vec<String>, Vec<String>) {
    let YtdlpArgsInput {
        download_dir,
        url,
        settings,
        options,
        ffmpeg_location,
        path_output_file,
    } = input;
    let configured_profile = settings
        .download_profiles_enabled
        .then(|| settings.download_mode.clone());
    let request_profile = if options.profile_enabled == Some(false) {
        None
    } else {
        options.profile.clone()
    };
    let profile = request_profile.or(configured_profile);
    let mut best_quality = settings.best_quality;
    let mut audio_only = settings.audio_only;
    match profile.as_deref() {
        Some("best-video") => {
            best_quality = true;
            audio_only = false;
        }
        Some("audio") => {
            best_quality = false;
            audio_only = true;
        }
        Some("custom") => {
            best_quality = false;
            audio_only = false;
        }
        _ => {}
    }
    if let Some(value) = options.best_quality {
        best_quality = value;
    }
    if let Some(value) = options.audio_only {
        audio_only = value;
    }

    let mut args: Vec<String> = vec!["-P".into(), download_dir.to_string_lossy().into_owned()];
    args.extend(playlist_args(options));
    args.extend(
        [
            "--print",
            "after_move:filepath",
            "--newline",
            "--progress",
            "--progress-delta",
            "1",
            "--progress-template",
            "download:%(progress)j",
            "--progress-template",
            "postprocess:%(progress)j",
            "-f",
            if best_quality {
                "bestvideo+bestaudio/best"
            } else {
                "best[ext=mp4]/best[ext=webm]/best"
            },
            "--",
            url,
        ]
        .iter()
        .map(|arg| arg.to_string()),
    );
    let mut status = Vec::new();

    if let Some(path) = path_output_file {
        let path = path.to_string_lossy().into_owned();
        insert_before_url(
            &mut args,
            &["--print-to-file", "after_move:filepath", &path],
        );
    }
    if let Some(location) = ffmpeg_location {
        insert_before_url(&mut args, &["--ffmpeg-location", location]);
    }

    let format_index = args.iter().position(|arg| arg == "-f").unwrap_or(0);
    let video = options
        .video_format
        .as_deref()
        .filter(|id| is_format_id(id));
    let audio = options
        .audio_format
        .as_deref()
        .filter(|id| is_format_id(id));
    match (video, audio) {
        (Some(video), Some(audio)) => {
            args[format_index + 1] = format!("{video}+{audio}");
            status.push(format!("📹 Using formats: video={video}, audio={audio}"));
        }
        (Some(video), None) => {
            args[format_index + 1] = video.to_string();
            status.push(format!("📹 Using video format: {video}"));
        }
        (None, Some(audio)) => {
            args[format_index + 1] = audio.to_string();
            status.push(format!("🎵 Using audio format: {audio}"));
        }
        (None, None) => {}
    }

    if audio_only && video.is_none() && audio.is_none() {
        args.drain(format_index..format_index + 2);
        let requested = options
            .audio_output_format
            .as_deref()
            .unwrap_or(&settings.audio_format);
        let output_format = if allowed(ALLOWED_AUDIO_FORMATS, requested) {
            requested
        } else {
            "mp3"
        };
        insert_before_url(
            &mut args,
            &[
                "-x",
                "--audio-format",
                output_format,
                "--audio-quality",
                "0",
            ],
        );
        status.push(format!(
            "🎵 Audio-only mode enabled ({})",
            output_format.to_uppercase()
        ));
    }

    let hook_browser = options.hook_browser.unwrap_or(settings.hook_browser);
    let browser = options
        .browser_choice
        .as_deref()
        .unwrap_or(&settings.browser_choice)
        .to_lowercase();
    if hook_browser && !browser.is_empty() && allowed(ALLOWED_BROWSERS, &browser) {
        insert_before_url(&mut args, &["--cookies-from-browser", &browser]);
    }

    if options.write_subtitles.unwrap_or(settings.write_subtitles) {
        let requested = options
            .subtitle_langs
            .as_deref()
            .unwrap_or(&settings.subtitle_langs);
        let langs = if is_subtitle_langs(requested) {
            requested
        } else {
            "en"
        };
        insert_before_url(
            &mut args,
            &["--write-subs", "--embed-subs", "--sub-langs", langs],
        );
        status.push(format!("💬 Subtitles enabled ({langs})"));
    }
    if options.embed_thumbnail.unwrap_or(settings.embed_thumbnail) {
        insert_before_url(&mut args, &["--embed-thumbnail"]);
        status.push("🖼️ Embedding thumbnail".into());
    }
    if options.embed_metadata.unwrap_or(settings.embed_metadata) {
        insert_before_url(&mut args, &["--embed-metadata"]);
        status.push("🏷️ Embedding metadata".into());
    }
    if options
        .sponsorblock_remove
        .unwrap_or(settings.sponsorblock_remove)
    {
        insert_before_url(&mut args, &["--sponsorblock-remove", "default"]);
        status.push("⏭️ SponsorBlock: removing segments".into());
    }
    (args, status)
}
