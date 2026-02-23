import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const { loadSettingsMock, resolveFfmpegPathMock, spawnWithEnvMock, logErrorMock } = vi.hoisted(
  () => {
    return {
      loadSettingsMock: vi.fn(),
      resolveFfmpegPathMock: vi.fn(),
      spawnWithEnvMock: vi.fn(),
      logErrorMock: vi.fn(),
    };
  }
);

vi.mock('../main/settings', () => ({
  loadSettings: loadSettingsMock,
}));

vi.mock('../main/platform', () => ({
  resolveFfmpegPath: resolveFfmpegPathMock,
  spawnWithEnv: spawnWithEnvMock,
}));

vi.mock('electron-log/main', () => ({
  default: {
    error: logErrorMock,
  },
}));

import { detectGpu } from '../main/gpu';

function createProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

describe('gpu detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadSettingsMock.mockReturnValue({
      ffmpegPath: '',
    });
    resolveFfmpegPathMock.mockReturnValue(null);
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
});
