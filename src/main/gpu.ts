import log from 'electron-log/main';
import { spawnWithEnv } from './platform';
import { loadSettings } from './settings';
import { resolveFfmpegPath } from './platform';
import { GPU_DETECT_TIMEOUT_MS, MAX_ERROR_BUFFER } from './constants';
import type { GpuDetectionResult } from '../types';

export async function detectGpu(): Promise<GpuDetectionResult> {
  const result: GpuDetectionResult = { nvidia: false, amd: false, intel: false };
  const settings = loadSettings();
  const ffmpegCommand = resolveFfmpegPath(settings.ffmpegPath) || 'ffmpeg';

  try {
    const proc = spawnWithEnv(ffmpegCommand, ['-hide_banner', '-encoders'], { shell: false });
    const output = await new Promise<string>((resolve) => {
      let buf = '';
      const timeout = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        resolve('');
      }, GPU_DETECT_TIMEOUT_MS);

      proc.stdout?.on('data', (data) => {
        if (buf.length < MAX_ERROR_BUFFER) buf += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        if (buf.length < MAX_ERROR_BUFFER) buf += data.toString();
      });
      proc.on('close', () => {
        clearTimeout(timeout);
        resolve(buf);
      });
      proc.on('error', () => {
        clearTimeout(timeout);
        resolve('');
      });
    });

    result.nvidia = output.includes('h264_nvenc');
    result.amd = output.includes('h264_amf');
    result.intel = output.includes('h264_qsv');
  } catch (err) {
    log.error('GPU detection error:', err);
  }

  return result;
}
