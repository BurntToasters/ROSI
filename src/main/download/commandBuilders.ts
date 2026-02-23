import type { DownloadRequestOptions, GpuDetectionResult, Settings } from '../../types';
import { detectGpu } from '../gpu';

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
    url,
  ];
  const statusMessages: string[] = [];

  if (ffmpegLocation) {
    args.splice(args.length - 1, 0, '--ffmpeg-location', ffmpegLocation);
  }

  const formatFlagIndex = args.indexOf('-f');
  if (options.videoFormat && options.audioFormat) {
    args[formatFlagIndex + 1] = `${options.videoFormat}+${options.audioFormat}`;
    statusMessages.push(
      `📹 Using formats: video=${options.videoFormat}, audio=${options.audioFormat}`
    );
  } else if (options.videoFormat) {
    args[formatFlagIndex + 1] = options.videoFormat;
    statusMessages.push(`📹 Using video format: ${options.videoFormat}`);
  } else if (options.audioFormat) {
    args[formatFlagIndex + 1] = options.audioFormat;
    statusMessages.push(`🎵 Using audio format: ${options.audioFormat}`);
  }

  if (settings.audioOnly && !options.videoFormat && !options.audioFormat) {
    args.splice(formatFlagIndex, 2);
    args.splice(-1, 0, '-x', '--audio-format', 'mp3', '--audio-quality', '0');
    statusMessages.push('🎵 Audio-only mode enabled');
  }

  if (settings.hookBrowser && settings.browserChoice) {
    args.splice(-1, 0, '--cookies-from-browser', settings.browserChoice);
  }

  return { args, statusMessages };
}
