import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const {
  loadSettingsMock,
  getEffectiveFfmpegPathMock,
  spawnWithEnvMock,
  logErrorMock,
  logWarnMock,
} = vi.hoisted(() => {
  return {
    loadSettingsMock: vi.fn(),
    getEffectiveFfmpegPathMock: vi.fn(),
    spawnWithEnvMock: vi.fn(),
    logErrorMock: vi.fn(),
    logWarnMock: vi.fn(),
  };
});

vi.mock('../main/settings', () => ({
  loadSettings: loadSettingsMock,
}));

vi.mock('../main/platform', () => ({
  getEffectiveFfmpegPath: getEffectiveFfmpegPathMock,
  spawnWithEnv: spawnWithEnvMock,
}));

vi.mock('electron-log/main.js', () => ({
  default: {
    error: logErrorMock,
    warn: logWarnMock,
  },
}));

import { detectGpu, clearGpuCache } from '../main/gpu';

function createProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (signal?: string) => void;
    killed: boolean;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn();
  return proc;
}

// Maps an ffmpeg arg list to the encoder being probed.
function encoderFromArgs(args: string[]): string {
  const idx = args.indexOf('-c:v');
  return idx >= 0 ? (args[idx + 1] ?? '') : '';
}

// Returns a spawn implementation that produces a proc per encoder probe and
// immediately resolves each with the supplied exit code map.
function mockProbes(exitCodes: Record<string, number>) {
  const procs: Record<string, ReturnType<typeof createProc>> = {};
  spawnWithEnvMock.mockImplementation((_cmd: string, args: string[]) => {
    const encoder = encoderFromArgs(args);
    const proc = createProc();
    procs[encoder] = proc;
    queueMicrotask(() => {
      proc.emit('close', exitCodes[encoder] ?? 1);
    });
    return proc;
  });
  return procs;
}

describe('gpu detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearGpuCache();
    loadSettingsMock.mockReturnValue({
      ffmpegPath: '',
    });
    getEffectiveFfmpegPathMock.mockReturnValue('ffmpeg');
  });

  it('detects GPU encoders that successfully probe-encode', async () => {
    mockProbes({ h264_nvenc: 0, h264_amf: 0, h264_qsv: 0 });

    const result = await detectGpu();
    expect(result).toEqual({ nvidia: true, amd: true, intel: true });
    expect(spawnWithEnvMock).toHaveBeenCalledTimes(3);
  });

  it('marks encoders that fail the probe as unavailable', async () => {
    mockProbes({ h264_nvenc: 0, h264_amf: 1, h264_qsv: 1 });

    const result = await detectGpu();
    expect(result).toEqual({ nvidia: true, amd: false, intel: false });
  });

  it('returns all false when probes error', async () => {
    spawnWithEnvMock.mockImplementation(() => {
      const proc = createProc();
      queueMicrotask(() => proc.emit('error', new Error('spawn failed')));
      return proc;
    });

    const result = await detectGpu();
    expect(result).toEqual({ nvidia: false, amd: false, intel: false });
  });

  it('returns all false and kills processes on timeout', async () => {
    vi.useFakeTimers();
    try {
      const procs: ReturnType<typeof createProc>[] = [];
      spawnWithEnvMock.mockImplementation(() => {
        const proc = createProc();
        procs.push(proc);
        return proc;
      });

      const pending = detectGpu();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toEqual({
        nvidia: false,
        amd: false,
        intel: false,
      });
      await vi.advanceTimersByTimeAsync(2000);
      procs.forEach((proc) => {
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
        expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs and returns default result if spawn throws', async () => {
    spawnWithEnvMock.mockImplementation(() => {
      throw new Error('unexpected');
    });

    const result = await detectGpu();
    expect(result).toEqual({ nvidia: false, amd: false, intel: false });
    expect(logWarnMock).toHaveBeenCalled();
  });

  it('returns cached result on second call within TTL', async () => {
    mockProbes({ h264_nvenc: 0, h264_amf: 1, h264_qsv: 1 });

    const first = await detectGpu();
    expect(first).toEqual({ nvidia: true, amd: false, intel: false });

    const second = await detectGpu();
    expect(second).toEqual({ nvidia: true, amd: false, intel: false });
    expect(spawnWithEnvMock).toHaveBeenCalledTimes(3);
  });

  it('re-detects after cache TTL expires', async () => {
    vi.useFakeTimers();
    try {
      mockProbes({ h264_nvenc: 0, h264_amf: 1, h264_qsv: 1 });
      const first = await detectGpu();
      expect(first).toEqual({ nvidia: true, amd: false, intel: false });

      vi.advanceTimersByTime(300_001);

      mockProbes({ h264_nvenc: 1, h264_amf: 0, h264_qsv: 1 });
      const second = await detectGpu();
      expect(second).toEqual({ nvidia: false, amd: true, intel: false });
      expect(spawnWithEnvMock).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
