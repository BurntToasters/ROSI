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

vi.mock('electron-log/main', () => ({
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
    kill: () => void;
    killed: boolean;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn();
  return proc;
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

  it('detects supported GPU encoders from ffmpeg output', async () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = detectGpu();
    proc.stdout.emit('data', Buffer.from('h264_nvenc\nh264_qsv\n'));
    proc.stderr.emit('data', Buffer.from('h264_amf\n'));
    proc.emit('close', 0);

    const result = await pending;
    expect(result).toEqual({
      nvidia: true,
      amd: true,
      intel: true,
    });
    expect(spawnWithEnvMock).toHaveBeenCalled();
  });

  it('returns all false on process error', async () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = detectGpu();
    proc.emit('error', new Error('spawn failed'));

    const result = await pending;
    expect(result).toEqual({
      nvidia: false,
      amd: false,
      intel: false,
    });
  });

  it('returns all false and kills process on timeout', async () => {
    vi.useFakeTimers();
    try {
      const proc = createProc();
      spawnWithEnvMock.mockReturnValue(proc);

      const pending = detectGpu();
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(pending).resolves.toEqual({
        nvidia: false,
        amd: false,
        intel: false,
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs timeout kill failures', async () => {
    vi.useFakeTimers();
    try {
      const proc = createProc();
      proc.kill = vi.fn(() => {
        throw new Error('kill denied');
      });
      spawnWithEnvMock.mockReturnValue(proc);

      const pending = detectGpu();
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;

      expect(logWarnMock).toHaveBeenCalledWith(
        'Error killing GPU detection process on timeout:',
        expect.any(Error)
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs and returns default result if spawn throws', async () => {
    spawnWithEnvMock.mockImplementation(() => {
      throw new Error('unexpected');
    });

    const result = await detectGpu();
    expect(result).toEqual({
      nvidia: false,
      amd: false,
      intel: false,
    });
    expect(logErrorMock).toHaveBeenCalled();
  });

  it('returns cached result on second call within TTL', async () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = detectGpu();
    proc.stdout.emit('data', Buffer.from('h264_nvenc\n'));
    proc.emit('close', 0);
    await pending;

    const second = await detectGpu();
    expect(second).toEqual({ nvidia: true, amd: false, intel: false });
    expect(spawnWithEnvMock).toHaveBeenCalledTimes(1);
  });

  it('re-detects after cache TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const proc1 = createProc();
      spawnWithEnvMock.mockReturnValue(proc1);

      const pending1 = detectGpu();
      proc1.stdout.emit('data', Buffer.from('h264_nvenc\n'));
      proc1.emit('close', 0);
      await pending1;

      vi.advanceTimersByTime(300_001);

      const proc2 = createProc();
      spawnWithEnvMock.mockReturnValue(proc2);

      const pending2 = detectGpu();
      proc2.stdout.emit('data', Buffer.from('h264_amf\n'));
      proc2.emit('close', 0);
      const result = await pending2;

      expect(result).toEqual({ nvidia: false, amd: true, intel: false });
      expect(spawnWithEnvMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
