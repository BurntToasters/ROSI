import log from 'electron-log/main.js';
import type { DownloadRequestOptions, GpuDetectionResult, Settings } from '../../types';
import { detectGpu } from '../gpu';
import { spawnWithEnv } from '../platform';
import {
  ALLOWED_AUDIO_FORMATS,
  ALLOWED_BROWSERS,
  FORMAT_ID_PATTERN,
  MAX_ERROR_BUFFER,
  MAX_PLAYLIST_ITEM_INDEX,
  SUBTITLE_LANGS_PATTERN,
} from '../constants';
import { parseFfmpegDurationFromProbe } from '../../utils/downloadJobProgress';

const VALID_FORMAT_ID = FORMAT_ID_PATTERN;
const CODEC_PROBE_TIMEOUT_MS = 30_000;
export { ALLOWED_BROWSERS };

export interface SourceCodecs {
  video?: string;
  audio?: string;
  durationSeconds?: number | null;
}

export function probeMediaCodecs(ffmpegCommand: string, inputPath: string): Promise<SourceCodecs> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    let proc: ReturnType<typeof spawnWithEnv>;
    const finish = (codecs: SourceCodecs) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(codecs);
    };

    const parse = (): SourceCodecs => {
      const codecs: SourceCodecs = {};
      const videoMatch = stderr.match(/Stream #\d+:\d+.*: Video: (\w+)/);
      const audioMatch = stderr.match(/Stream #\d+:\d+.*: Audio: (\w+)/);
      if (videoMatch?.[1]) codecs.video = videoMatch[1];
      if (audioMatch?.[1]) codecs.audio = audioMatch[1];
      codecs.durationSeconds = parseFfmpegDurationFromProbe(stderr);
      return codecs;
    };

    const timeout = setTimeout(() => {
      try {
        proc?.kill('SIGKILL');
      } catch {}
      finish(parse());
    }, CODEC_PROBE_TIMEOUT_MS);

    try {
      proc = spawnWithEnv(ffmpegCommand, ['-hide_banner', '-i', inputPath], { shell: false });
    } catch (err) {
      log.warn('Failed to spawn ffmpeg codec probe:', err);
      finish({});
      return;
    }

    proc.stderr?.on('data', (data: Buffer) => {
      if (stderr.length < MAX_ERROR_BUFFER) stderr += data.toString();
    });
    proc.on('close', () => finish(parse()));
    proc.on('error', (err) => {
      log.warn('ffmpeg codec probe error:', err);
      finish({});
    });
  });
}

const CONTAINER_COMPATIBLE_VIDEO = new Set([
  'h264',
  'avc1',
  'hevc',
  'h265',
  'av1',
  'av01',
  'mpeg4',
]);
const CONTAINER_COMPATIBLE_AUDIO = new Set(['aac', 'mp4a', 'mp3', 'ac3', 'alac']);

export async function resolveGpuVideoEncoder(settings: Settings): Promise<string> {
  if (settings.gpuType === 'nvidia') return 'h264_nvenc';
  if (settings.gpuType === 'amd') return 'h264_amf';
  if (settings.gpuType === 'intel') return 'h264_qsv';

  const detected: GpuDetectionResult = await detectGpu();
  if (detected.nvidia) return 'h264_nvenc';
  if (detected.amd) return 'h264_amf';
  if (detected.intel) return 'h264_qsv';
  return 'libx264';
}

export async function resolveVideoEncoder(settings: Settings): Promise<string> {
  if (!settings.gpuAcceleration) return 'copy';
  const encoder = await resolveGpuVideoEncoder(settings);
  return encoder === 'libx264' ? 'copy' : encoder;
}

export function buildFfmpegArgs(
  inputPath: string,
  outputPath: string,
  targetFormat: string,
  videoEncoder: string,
  srcCodecs?: SourceCodecs
): string[] {
  if (targetFormat === 'mp3' || targetFormat === 'm4a') {
    const targetCodec = targetFormat === 'mp3' ? 'libmp3lame' : 'aac';
    const srcAudio = srcCodecs?.audio?.toLowerCase();
    const canCopyAudio =
      (targetFormat === 'm4a' && (srcAudio === 'aac' || srcAudio === 'mp4a')) ||
      (targetFormat === 'mp3' && srcAudio === 'mp3');
    return [
      '-progress',
      'pipe:1',
      '-nostats',
      '-i',
      inputPath,
      '-vn',
      '-c:a',
      canCopyAudio ? 'copy' : targetCodec,
      '-y',
      outputPath,
    ];
  }

  const srcVideo = srcCodecs?.video?.toLowerCase();
  const srcAudio = srcCodecs?.audio?.toLowerCase();
  const videoCanCopy = !!srcVideo && CONTAINER_COMPATIBLE_VIDEO.has(srcVideo);
  const resolvedVideo = srcCodecs ? (videoCanCopy ? 'copy' : videoEncoder) : videoEncoder;
  const resolvedAudio =
    srcCodecs && srcAudio && CONTAINER_COMPATIBLE_AUDIO.has(srcAudio) ? 'copy' : 'aac';

  return [
    '-progress',
    'pipe:1',
    '-nostats',
    '-i',
    inputPath,
    '-c:v',
    resolvedVideo,
    '-c:a',
    resolvedAudio,
    '-movflags',
    '+faststart',
    '-y',
    outputPath,
  ];
}

interface BuildYtdlpArgsInput {
  normalizedDownloadDir: string;
  url: string;
  settings: Settings;
  options: DownloadRequestOptions;
  ffmpegLocation: string | null;
  pathOutputFile?: string | null;
}

export interface BuildYtdlpArgsResult {
  args: string[];
  statusMessages: string[];
}

function insertBeforeUrlSeparator(args: string[], ...items: string[]): void {
  const separatorIndex = args.indexOf('--');
  if (separatorIndex === -1) {
    args.splice(args.length - 1, 0, ...items);
    return;
  }
  args.splice(separatorIndex, 0, ...items);
}

function buildPlaylistArgs(options: DownloadRequestOptions): string[] {
  const selection = options.playlist;
  if (!selection || selection.mode === 'current') {
    return ['--no-playlist'];
  }
  if (selection.mode === 'all') {
    return ['--yes-playlist'];
  }
  const { start, end } = selection;
  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    (start as number) >= 1 &&
    (end as number) >= (start as number) &&
    (end as number) <= MAX_PLAYLIST_ITEM_INDEX
  ) {
    return ['--yes-playlist', '--playlist-items', `${start as number}-${end as number}`];
  }
  return ['--no-playlist'];
}

export function buildYtdlpArgs({
  normalizedDownloadDir,
  url,
  settings,
  options,
  ffmpegLocation,
  pathOutputFile,
}: BuildYtdlpArgsInput): BuildYtdlpArgsResult {
  const configuredProfile = settings.downloadProfilesEnabled ? settings.downloadMode : null;
  const requestProfile = options.profileEnabled === false ? null : options.profile;
  const profile = requestProfile ?? configuredProfile;
  let bestQuality = settings.bestQuality;
  let audioOnly = settings.audioOnly;

  if (profile === 'best-video') {
    bestQuality = true;
    audioOnly = false;
  } else if (profile === 'audio') {
    bestQuality = false;
    audioOnly = true;
  } else if (profile === 'custom') {
    bestQuality = false;
    audioOnly = false;
  }
  if (typeof options.bestQuality === 'boolean') bestQuality = options.bestQuality;
  if (typeof options.audioOnly === 'boolean') audioOnly = options.audioOnly;

  const args = [
    '-P',
    normalizedDownloadDir,
    ...buildPlaylistArgs(options),
    '--print',
    'after_move:filepath',
    '--newline',
    '--progress',
    '--progress-delta',
    '1',
    '--progress-template',
    'download:%(progress)j',
    '--progress-template',
    'postprocess:%(progress)j',
    '-f',
    bestQuality ? 'bestvideo+bestaudio/best' : 'best[ext=mp4]/best[ext=webm]/best',
    '--',
    url,
  ];
  const statusMessages: string[] = [];

  if (pathOutputFile) {
    insertBeforeUrlSeparator(args, '--print-to-file', 'after_move:filepath', pathOutputFile);
  }

  if (ffmpegLocation) {
    insertBeforeUrlSeparator(args, '--ffmpeg-location', ffmpegLocation);
  }

  const formatFlagIndex = args.indexOf('-f');
  const videoFmt = options.videoFormat;
  const audioFmt = options.audioFormat;
  const validVideo = videoFmt && VALID_FORMAT_ID.test(videoFmt);
  const validAudio = audioFmt && VALID_FORMAT_ID.test(audioFmt);
  if (validVideo && validAudio) {
    args[formatFlagIndex + 1] = `${videoFmt}+${audioFmt}`;
    statusMessages.push(`📹 Using formats: video=${videoFmt}, audio=${audioFmt}`);
  } else if (validVideo) {
    args[formatFlagIndex + 1] = videoFmt;
    statusMessages.push(`📹 Using video format: ${videoFmt}`);
  } else if (validAudio) {
    args[formatFlagIndex + 1] = audioFmt;
    statusMessages.push(`🎵 Using audio format: ${audioFmt}`);
  }

  if (audioOnly && !validVideo && !validAudio) {
    args.splice(formatFlagIndex, 2);
    const requestedAudioFormat = options.audioOutputFormat ?? settings.audioFormat;
    const audioOutputFmt = ALLOWED_AUDIO_FORMATS.has(requestedAudioFormat)
      ? requestedAudioFormat
      : 'mp3';
    insertBeforeUrlSeparator(args, '-x', '--audio-format', audioOutputFmt, '--audio-quality', '0');
    statusMessages.push(`🎵 Audio-only mode enabled (${audioOutputFmt.toUpperCase()})`);
  }

  const hookBrowser = options.hookBrowser ?? settings.hookBrowser;
  const browserChoice = options.browserChoice ?? settings.browserChoice;
  if (hookBrowser && browserChoice) {
    const normalized = browserChoice.toLowerCase();
    if (ALLOWED_BROWSERS.has(normalized)) {
      insertBeforeUrlSeparator(args, '--cookies-from-browser', normalized);
    }
  }

  const writeSubtitles = options.writeSubtitles ?? settings.writeSubtitles;
  if (writeSubtitles) {
    const requestedLangs = options.subtitleLangs ?? settings.subtitleLangs;
    const langs = SUBTITLE_LANGS_PATTERN.test(requestedLangs) ? requestedLangs : 'en';
    insertBeforeUrlSeparator(args, '--write-subs', '--embed-subs', '--sub-langs', langs);
    statusMessages.push(`💬 Subtitles enabled (${langs})`);
  }

  if (options.embedThumbnail ?? settings.embedThumbnail) {
    insertBeforeUrlSeparator(args, '--embed-thumbnail');
    statusMessages.push('🖼️ Embedding thumbnail');
  }

  if (options.embedMetadata ?? settings.embedMetadata) {
    insertBeforeUrlSeparator(args, '--embed-metadata');
    statusMessages.push('🏷️ Embedding metadata');
  }

  if (options.sponsorblockRemove ?? settings.sponsorblockRemove) {
    insertBeforeUrlSeparator(args, '--sponsorblock-remove', 'default');
    statusMessages.push('⏭️ SponsorBlock: removing segments');
  }

  return { args, statusMessages };
}
