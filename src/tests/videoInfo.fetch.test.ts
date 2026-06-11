import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const { existsSyncMock, spawnWithEnvMock, logWarnMock } = vi.hoisted(() => {
  return {
    existsSyncMock: vi.fn(),
    spawnWithEnvMock: vi.fn(),
    logWarnMock: vi.fn(),
  };
});

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
}));

vi.mock('../main/platform', () => ({
  spawnWithEnv: spawnWithEnvMock,
}));

vi.mock('electron-log/main.js', () => ({
  default: {
    warn: logWarnMock,
  },
}));

import { cancelVideoInfo, fetchVideoInfo } from '../main/download/videoInfo';

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
  proc.kill = vi.fn(() => {
    proc.killed = true;
    setImmediate(() => proc.emit('close', 1));
  });
  return proc;
}

const validJson =
  '{"title":"Test Video","uploader":"Channel","duration":120,"ext":"mp4","view_count":1000}';

describe('fetchVideoInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
  });

  afterEach(() => {
    cancelVideoInfo();
    vi.useRealTimers();
  });

  it('rejects invalid URL values', async () => {
    await expect(fetchVideoInfo('/tmp/ytdlp', 'not-a-url')).rejects.toContain('Invalid URL');
  });

  it('rejects when yt-dlp binary is missing', async () => {
    existsSyncMock.mockReturnValue(false);
    await expect(fetchVideoInfo('/missing/ytdlp', 'https://example.com')).rejects.toContain(
      'binary not found'
    );
  });

  it('resolves parsed video info when process exits successfully', async () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = fetchVideoInfo('/tmp/ytdlp', 'https://example.com');
    proc.stdout.emit('data', validJson);
    proc.emit('close', 0);

    await expect(pending).resolves.toMatchObject({
      title: 'Test Video',
      uploader: 'Channel',
      durationSeconds: 120,
      ext: 'mp4',
      viewCount: 1000,
    });
  });

  it('rejects with process details when process exits non-zero', async () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = fetchVideoInfo('/tmp/ytdlp', 'https://example.com');
    proc.stderr.emit('data', 'stderr output');
    proc.emit('close', 2);

    await expect(pending).rejects.toContain('yt-dlp exited with code 2');
  });

  it('rejects when output cannot be parsed', async () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = fetchVideoInfo('/tmp/ytdlp', 'https://example.com');
    proc.stdout.emit('data', 'not json');
    proc.emit('close', 0);

    await expect(pending).rejects.toContain('Could not parse video information');
  });

  it('rejects when process fails to start', async () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = fetchVideoInfo('/tmp/ytdlp', 'https://example.com');
    proc.emit('error', new Error('spawn failed'));

    await expect(pending).rejects.toContain('Failed to start yt-dlp: spawn failed');
  });

  it('cancels previous info process before starting another', async () => {
    const firstProc = createProc();
    const secondProc = createProc();
    spawnWithEnvMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const firstPending = fetchVideoInfo('/tmp/ytdlp', 'https://example.com/one');
    const secondPending = fetchVideoInfo('/tmp/ytdlp', 'https://example.com/two');

    expect(firstProc.kill).toHaveBeenCalled();
    firstProc.emit('close', 1);
    secondProc.stdout.emit('data', validJson);
    secondProc.emit('close', 0);

    await expect(firstPending).rejects.toContain('yt-dlp exited with code 1');
    await expect(secondPending).resolves.toMatchObject({ title: 'Test Video' });
  });

  it('logs warning when previous info process cannot be killed', async () => {
    const firstProc = createProc();
    const secondProc = createProc();
    firstProc.kill = vi.fn(() => {
      throw new Error('kill denied');
    });
    spawnWithEnvMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const firstPending = fetchVideoInfo('/tmp/ytdlp', 'https://example.com/one');
    const secondPending = fetchVideoInfo('/tmp/ytdlp', 'https://example.com/two');

    firstProc.emit('close', 1);
    secondProc.stdout.emit('data', validJson);
    secondProc.emit('close', 0);

    await expect(firstPending).rejects.toContain('yt-dlp exited with code 1');
    await expect(secondPending).resolves.toMatchObject({ title: 'Test Video' });
    expect(logWarnMock).toHaveBeenCalledWith(
      'Error killing previous video info process:',
      expect.any(Error)
    );
  });

  it('supports cancellation via cancelVideoInfo', async () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = fetchVideoInfo('/tmp/ytdlp', 'https://example.com');
    cancelVideoInfo();
    await expect(pending).rejects.toContain('cancelled');
  });

  it('rejects on timeout', async () => {
    vi.useFakeTimers();
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = fetchVideoInfo('/tmp/ytdlp', 'https://example.com');
    const rejection = expect(pending).rejects.toContain('timed out');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
  });

  it('logs warning when timeout kill throws', async () => {
    vi.useFakeTimers();
    const proc = createProc();
    proc.kill = vi.fn(() => {
      throw new Error('timeout kill denied');
    });
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = fetchVideoInfo('/tmp/ytdlp', 'https://example.com');
    const rejection = expect(pending).rejects.toContain('timed out');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(logWarnMock).toHaveBeenCalledWith(
      'Error killing video info process on timeout:',
      expect.any(Error)
    );
  });

  it('logs warning when cancelVideoInfo kill throws', async () => {
    const proc = createProc();
    proc.kill = vi.fn(() => {
      throw new Error('cancel kill denied');
    });
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = fetchVideoInfo('/tmp/ytdlp', 'https://example.com');
    cancelVideoInfo();
    proc.emit('close', 1);

    await expect(pending).rejects.toContain('cancelled');
    expect(logWarnMock).toHaveBeenCalledWith(
      'Error killing video info process:',
      expect.any(Error)
    );
  });
});
