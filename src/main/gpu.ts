import log from 'electron-log/main.js';
import { spawnWithEnv } from './platform';
import { loadSettings } from './settings';
import { getEffectiveFfmpegPath } from './platform';
import { GPU_DETECT_TIMEOUT_MS } from './constants';
import type { GpuDetectionResult } from '../types';

let cachedGpuResult: GpuDetectionResult | null = null;
let gpuCacheTimestamp = 0;
const GPU_CACHE_TTL_MS = 300_000;

export function clearGpuCache(): void {
  cachedGpuResult = null;
  gpuCacheTimestamp = 0;
}

function probeEncoder(ffmpegCommand: string, encoder: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let proc: ReturnType<typeof spawnWithEnv>;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };

    const timeout = setTimeout(() => {
      try {
        proc?.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (proc && !proc.killed) proc.kill('SIGKILL');
          } catch {}
        }, 2000);
      } catch (killErr) {
        log.warn(`Error killing GPU probe (${encoder}):`, killErr);
      }
      finish(false);
    }, GPU_DETECT_TIMEOUT_MS);

    try {
      proc = spawnWithEnv(
        ffmpegCommand,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'nullsrc=s=64x64:d=0.1',
          '-c:v',
          encoder,
          '-f',
          'null',
          '-',
        ],
        { shell: false }
      );
    } catch (err) {
      log.warn(`Failed to spawn GPU probe (${encoder}):`, err);
      finish(false);
      return;
    }

    proc.on('close', (code) => finish(code === 0));
    proc.on('error', () => finish(false));
  });
}

export async function detectGpu(): Promise<GpuDetectionResult> {
  if (cachedGpuResult && Date.now() - gpuCacheTimestamp < GPU_CACHE_TTL_MS) return cachedGpuResult;
  const result: GpuDetectionResult = { nvidia: false, amd: false, intel: false };
  const settings = loadSettings();
  const ffmpegCommand = getEffectiveFfmpegPath(settings.ffmpegPath);

  try {
    const [nvidia, amd, intel] = await Promise.all([
      probeEncoder(ffmpegCommand, 'h264_nvenc'),
      probeEncoder(ffmpegCommand, 'h264_amf'),
      probeEncoder(ffmpegCommand, 'h264_qsv'),
    ]);
    result.nvidia = nvidia;
    result.amd = amd;
    result.intel = intel;
  } catch (err) {
    log.error('GPU detection error:', err);
  }

  cachedGpuResult = result;
  gpuCacheTimestamp = Date.now();
  return result;
}
