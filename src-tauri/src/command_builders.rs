//! yt-dlp and FFmpeg argument builders plus the codec probe used to decide
//! stream copy vs re-encode during conversion.

use crate::constants::*;
use crate::types::{DownloadRequestOptions, Settings};
use std::path::Path;

#[derive(Clone, Debug, Default)]
pub struct SourceCodecs {
    pub video: Option<String>,
    pub audio: Option<String>,
    pub subtitles: Vec<String>,
    pub has_attached_pictures: bool,
    pub duration_seconds: Option<f64>,
}

fn codec_after(stderr: &str, marker: &str, exclude_attached_pictures: bool) -> Option<String> {
    for line in stderr.lines() {
        if !line.contains("Stream #") {
            continue;
        }
        if exclude_attached_pictures && line.contains("(attached pic)") {
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
        video: codec_after(stderr, ": Video: ", true),
        has_attached_pictures: stderr
            .lines()
            .any(|line| line.contains("Stream #") && line.contains("(attached pic)")),
        audio: codec_after(stderr, ": Audio: ", false),
        subtitles: stderr
            .lines()
            .filter(|line| line.contains("Stream #"))
            .filter_map(|line| line.split_once(": Subtitle: ").map(|(_, codec)| codec))
            .filter_map(|codec| {
                let codec = codec
                    .chars()
                    .take_while(|character| character.is_ascii_alphanumeric() || *character == '_')
                    .collect::<String>();
                (!codec.is_empty()).then_some(codec)
            })
            .collect(),
        duration_seconds: crate::progress::parse_ffmpeg_duration(stderr),
    }
}

const CONTAINER_COMPATIBLE_VIDEO: &[&str] =
    &["h264", "avc1", "hevc", "h265", "av1", "av01", "mpeg4"];
const CONTAINER_COMPATIBLE_AUDIO: &[&str] = &["aac", "mp4a", "mp3", "ac3", "alac"];
const MP4_TEXT_SUBTITLES: &[&str] = &["subrip", "ass", "ssa", "webvtt", "mov_text"];

pub fn target_subtitle_codec(target_format: &str, source: &SourceCodecs) -> Option<&'static str> {
    let target = target_format.to_ascii_lowercase();
    if source.subtitles.is_empty() {
        return None;
    }
    if ["mp4", "m4v", "mov"].contains(&target.as_str())
        && source.subtitles.iter().all(|codec| {
            MP4_TEXT_SUBTITLES
                .iter()
                .any(|known| known.eq_ignore_ascii_case(codec))
        })
    {
        return Some("mov_text");
    }
    if target == "mkv" {
        return Some("copy");
    }
    None
}

/// Conversion currently maps primary media and supported captions, not artwork.
/// Keep a recoverable original whenever any source content would be omitted.
pub fn must_preserve_original(target: &str, source: &SourceCodecs, probe_complete: bool) -> bool {
    !probe_complete
        || source.has_attached_pictures
        || (!source.subtitles.is_empty() && target_subtitle_codec(target, source).is_none())
}

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
        return "libx264".to_string();
    }
    match resolve_gpu_video_encoder(settings) {
        "libx264" => "libx264".to_string(),
        encoder => encoder.to_string(),
    }
}

/// Validated browser-cookie arguments shared by downloads and read-only
/// discovery commands. Invalid persisted values fail closed to no cookies.
pub fn build_browser_cookie_args(hook_browser: bool, browser: &str) -> Vec<String> {
    let browser = browser.trim().to_lowercase();
    if hook_browser && allowed(ALLOWED_BROWSERS, &browser) {
        vec!["--cookies-from-browser".into(), browser]
    } else {
        Vec::new()
    }
}

/// Runtime flags shared by every yt-dlp operation. Configuration files and
/// plugin discovery are disabled so user-controlled downloader settings
/// cannot replace the attempt-owned proxy or add a network path around it.
pub fn build_ytdlp_runtime_args() -> Vec<String> {
    let args = vec![
        "--ignore-config".into(),
        "--no-plugin-dirs".into(),
        // HlsFD may bypass its selected native downloader and instantiate
        // FFmpegFD directly for unsupported manifests. Keep that external
        // downloader local-only; ordinary HLS stays on HlsFD and uses the
        // attempt proxy for its HTTP segment requests.
        "--downloader-args".into(),
        "ffmpeg:-protocol_whitelist file,pipe".into(),
        // Restrict configured yt-dlp postprocessor inputs, including both
        // sides of multi-format merges. The per-operation launcher also
        // covers yt-dlp's direct ffprobe subprocesses that bypass these args.
        "--postprocessor-args".into(),
        "ffmpeg_i:-protocol_whitelist file,pipe".into(),
        "--postprocessor-args".into(),
        "ffprobe_i:-protocol_whitelist file,pipe".into(),
        "--downloader".into(),
        "m3u8:native".into(),
        "--downloader".into(),
        "dash:native".into(),
    ];
    #[cfg(feature = "e2e")]
    {
        let mut args = args;
        if ytdlp_e2e_ca_path().is_some() {
            args.extend(["--compat-options".into(), "no-certifi".into()]);
        }
        args
    }
    #[cfg(not(feature = "e2e"))]
    args
}

/// Test-only CA path for yt-dlp's Python SSLContext. The caller passes it as
/// `SSL_CERT_FILE` only to yt-dlp; app-owned FFmpeg/ffprobe keep a scrubbed env.
pub fn ytdlp_e2e_ca_path() -> Option<String> {
    #[cfg(feature = "e2e")]
    {
        std::env::var("ROSI_E2E_TLS_CA")
            .ok()
            .filter(|value| !value.trim().is_empty())
    }
    #[cfg(not(feature = "e2e"))]
    {
        None
    }
}

const SAFE_FORMAT_PROTOCOLS: &str = "^(https?|m3u8|m3u8_native|http_dash_segments)$";

fn protocol_guarded_format(format: &str) -> String {
    format!("{format}[protocol~='{SAFE_FORMAT_PROTOCOLS}']")
}

fn default_video_format(best_quality: bool) -> String {
    if best_quality {
        format!(
            "bestvideo[protocol~='{SAFE_FORMAT_PROTOCOLS}']+bestaudio[protocol~='{SAFE_FORMAT_PROTOCOLS}']/best[protocol~='{SAFE_FORMAT_PROTOCOLS}']"
        )
    } else {
        format!(
            "best[ext=mp4][protocol~='{SAFE_FORMAT_PROTOCOLS}']/best[ext=webm][protocol~='{SAFE_FORMAT_PROTOCOLS}']/best[protocol~='{SAFE_FORMAT_PROTOCOLS}']"
        )
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
            "-protocol_whitelist",
            "file,pipe",
            "-i",
            &input,
            "-map",
            "0:a:0?",
            "-vn",
            "-c:a",
            if can_copy { "copy" } else { target_codec },
            "-n",
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
    let mut args = vec![
        "-progress",
        "pipe:1",
        "-nostats",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        &input,
        "-map",
        "0:V:0?",
        "-map",
        "0:a:0?",
        "-c:v",
        video,
        "-c:a",
        audio,
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<Vec<_>>();
    if let Some(codec) = source.and_then(|source| target_subtitle_codec(target_format, source)) {
        if let Some(source) = source {
            for index in 0..source.subtitles.len() {
                args.extend(["-map".to_string(), format!("0:s:{index}?")]);
            }
        }
        args.extend(["-c:s".to_string(), codec.to_string()]);
    }
    if ["mp4", "m4v", "mov"].contains(&target_format.to_ascii_lowercase().as_str()) {
        args.extend(["-movflags".to_string(), "+faststart".to_string()]);
    }
    args.extend(["-n".to_string(), output]);
    args
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
    let profile = options
        .profile
        .clone()
        .or_else(|| Some(settings.download_mode.clone()));
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
        Some("compatible" | "custom") => {
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

    let mut args = build_ytdlp_runtime_args();
    args.extend([
        "--no-overwrites".into(),
        "-P".into(),
        download_dir.to_string_lossy().into_owned(),
    ]);
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
            "",
            "--",
            url,
        ]
        .iter()
        .map(|arg| arg.to_string()),
    );
    let default_format = default_video_format(best_quality);
    let format_index = args.iter().position(|arg| arg == "-f").unwrap_or(0);
    args[format_index + 1] = default_format;
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
            args[format_index + 1] = format!(
                "{}+{}",
                protocol_guarded_format(video),
                protocol_guarded_format(audio)
            );
            status.push(format!("📹 Using formats: video={video}, audio={audio}"));
        }
        (Some(video), None) => {
            args[format_index + 1] = protocol_guarded_format(video);
            status.push(format!("📹 Using video format: {video}"));
        }
        (None, Some(audio)) => {
            args[format_index + 1] = protocol_guarded_format(audio);
            status.push(format!("🎵 Using audio format: {audio}"));
        }
        (None, None) => {}
    }

    if audio_only && video.is_none() && audio.is_none() {
        // Some direct media URLs expose a single combined format instead of
        // a separate `bestaudio` entry. Prefer the audio-only stream when it
        // exists, then fall back to the guarded combined stream so FFmpeg can
        // extract audio from either shape.
        args[format_index + 1] = format!(
            "{}/{}",
            protocol_guarded_format("bestaudio"),
            protocol_guarded_format("best")
        );
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
        .to_string();
    let cookie_args = build_browser_cookie_args(hook_browser, &browser);
    if !cookie_args.is_empty() {
        insert_before_url(
            &mut args,
            &cookie_args.iter().map(String::as_str).collect::<Vec<_>>(),
        );
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

#[cfg(test)]
mod audit4_tests {
    use super::*;
    #[test]
    fn retain_artwork_and_captions_without_retaining_ordinary_audio() {
        let artwork = parse_codecs(
            "Input #0\n  Stream #0:0: Audio: aac\n  Stream #0:1: Video: mjpeg (attached pic)\n",
        );
        assert_eq!(artwork.video, None);
        assert!(must_preserve_original("mp3", &artwork, true));
        let ordinary = parse_codecs("Input #0\n  Stream #0:0: Audio: aac\n");
        assert!(!must_preserve_original("mp3", &ordinary, true));
        assert!(must_preserve_original("mp3", &ordinary, false));
        let captions =
            parse_codecs("Input #0\n Stream #0:0: Video: h264\n Stream #0:1: Subtitle: subrip\n");
        assert!(must_preserve_original("mp3", &captions, true));
        assert!(!must_preserve_original("mp4", &captions, true));
    }
}
