import type { DownloadRequestOptions, GpuDetectionResult, Settings } from '../../types';
import { detectGpu } from '../gpu';
import { ALLOWED_AUDIO_FORMATS } from '../constants';

const VALID_FORMAT_ID = /^\d{1,8}$/;
const ALLOWED_BROWSERS = new Set([
  'brave',
  'chrome',
  'chromium',
  'edge',
  'firefox',
  'opera',
  'safari',
  'vivaldi',
  'whale',
]);

export async function resolveVideoEncoder(settings: Settings): Promise<string> {
  if (!settings.gpuAcceleration) return 'copy';
  if (settings.gpuType === 'nvidia') return 'h264_nvenc';
  if (settings.gpuType === 'amd') return 'h264_amf';
  if (settings.gpuType === 'intel') return 'h264_qsv';

  const detected: GpuDetectionResult = await detectGpu();
  if (detected.nvidia) return 'h264_nvenc';
  if (detected.amd) return 'h264_amf';
  if (detected.intel) return 'h264_qsv';
  return 'copy';
}

export function buildFfmpegArgs(
  inputPath: string,
  outputPath: string,
  targetFormat: string,
  videoEncoder: string
): string[] {
  if (targetFormat === 'mp3' || targetFormat === 'm4a') {
    return [
      '-i',
      inputPath,
      '-vn',
      '-c:a',
      targetFormat === 'mp3' ? 'libmp3lame' : 'aac',
      '-y',
      outputPath,
    ];
  }

  return [
    '-i',
    inputPath,
    '-c:v',
    videoEncoder,
    '-c:a',
    'aac',
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
}

export interface BuildYtdlpArgsResult {
  args: string[];
  statusMessages: string[];
}

export function buildYtdlpArgs({
  normalizedDownloadDir,
  url,
  settings,
  options,
  ffmpegLocation,
}: BuildYtdlpArgsInput): BuildYtdlpArgsResult {
  const args = [
    '-P',
    normalizedDownloadDir,
    '--no-playlist',
    '--print',
    'after_move:filepath',
    '--newline',
    '--progress',
    '--progress-delta',
    '1',
    '-f',
    settings.bestQuality ? 'bestvideo+bestaudio/best' : 'best[ext=mp4]/best[ext=webm]/best',
    '--',
    url,
  ];
  const statusMessages: string[] = [];

  if (ffmpegLocation) {
    args.splice(args.length - 1, 0, '--ffmpeg-location', ffmpegLocation);
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

  if (settings.audioOnly && !validVideo && !validAudio) {
    args.splice(formatFlagIndex, 2);
    const audioOutputFmt = ALLOWED_AUDIO_FORMATS.has(settings.audioFormat)
      ? settings.audioFormat
      : 'mp3';
    args.splice(-1, 0, '-x', '--audio-format', audioOutputFmt, '--audio-quality', '0');
    statusMessages.push(`🎵 Audio-only mode enabled (${audioOutputFmt.toUpperCase()})`);
  }

  if (settings.hookBrowser && settings.browserChoice) {
    const normalized = settings.browserChoice.toLowerCase();
    if (ALLOWED_BROWSERS.has(normalized)) {
      args.splice(-1, 0, '--cookies-from-browser', normalized);
    }
  }

  return { args, statusMessages };
}
