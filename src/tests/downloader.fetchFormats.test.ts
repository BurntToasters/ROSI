import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const { existsSyncMock, statSyncMock, mkdirSyncMock, spawnWithEnvMock } = vi.hoisted(() => {
  return {
    existsSyncMock: vi.fn(),
    statSyncMock: vi.fn(),
    mkdirSyncMock: vi.fn(),
    spawnWithEnvMock: vi.fn(),
  };
});

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  mkdirSync: mkdirSyncMock,
}));

vi.mock('../main/platform', () => ({
  spawnWithEnv: spawnWithEnvMock,
  resolveFfmpegPath: vi.fn(() => null),
  ytdlpBinary: 'yt-dlp',
  isWindows: process.platform === 'win32',
}));

vi.mock('../main/settings', () => ({
  loadSettings: vi.fn(() => ({
    settingsVersion: 1,
    showConsoleOutput: false,
    consoleCollapsed: false,
    advancedOptions: false,
    audioOnly: false,
    convertEnabled: false,
    convertFormat: 'mp4',
    keepOriginalAfterConvert: true,
    firstLaunch: false,
    hookBrowser: false,
    browserChoice: 'Chrome',
    animateBackground: true,
    notifications: true,
    denoReminderDismissed: false,
    gpuAcceleration: false,
    gpuType: 'auto',
    bestQuality: false,
    ffmpegPath: '',
    hideSupportModal: false,
    checkUpdatesOnStartup: true,
    updateChannel: 'auto',
  })),
}));

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: vi.fn(),
  },
}));

import {
  cancelActiveSession,
  cancelFormats,
  fetchFormats,
  startDownload,
} from '../main/downloader';

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

describe('downloader format fetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ isDirectory: () => true });
  });

  afterEach(() => {
    cancelFormats();
    cancelActiveSession(false);
    vi.useRealTimers();
  });

  it('rejects invalid URL values', async () => {
    await expect(fetchFormats('/tmp/ytdlp', 'not-a-url')).rejects.toContain('Invalid URL');
  });

  it('rejects when yt-dlp binary is missing', async () => {
    existsSyncMock.mockReturnValue(false);
    await expect(fetchFormats('/missing/ytdlp', 'https://example.com')).rejects.toContain(
      'binary not found'
    );
  });

  it('resolves output when process exits successfully', async () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = fetchFormats('/tmp/ytdlp', 'https://example.com');
    proc.stdout.emit('data', 'format output');
    proc.emit('close', 0);

    await expect(pending).resolves.toContain('format output');
  });

  it('rejects with process details when process exits non-zero', async () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = fetchFormats('/tmp/ytdlp', 'https://example.com');
    proc.stdout.emit('data', 'output');
    proc.stderr.emit('data', 'stderr output');
    proc.emit('close', 2);

    await expect(pending).rejects.toContain('yt-dlp exited with code 2');
  });

  it('supports cancellation via cancelFormats', async () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = fetchFormats('/tmp/ytdlp', 'https://example.com');
    cancelFormats();
    await expect(pending).rejects.toContain('cancelled');
  });

  it('rejects on timeout', async () => {
    vi.useFakeTimers();
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = fetchFormats('/tmp/ytdlp', 'https://example.com');
    const rejection = expect(pending).rejects.toContain('timed out after 60 seconds');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
  });

  it('rejects startDownload with invalid URL', () => {
    const send = vi.fn();
    startDownload(
      '/tmp/ytdlp',
      {
        isDestroyed: () => false,
        send,
      } as any,
      { url: 'not-a-url', outputPath: '/tmp/downloads' },
      null
    );

    expect(send).toHaveBeenCalledWith('progress', '⚠️ Invalid or missing URL.');
    expect(send).toHaveBeenCalledWith('complete', '❌ Failed (Invalid URL).');
  });

  it('rejects startDownload with invalid folder', () => {
    const send = vi.fn();
    startDownload(
      '/tmp/ytdlp',
      {
        isDestroyed: () => false,
        send,
      } as any,
      { url: 'https://example.com', outputPath: '' },
      null
    );

    expect(send).toHaveBeenCalledWith('progress', '⚠️ Invalid or missing download folder.');
    expect(send).toHaveBeenCalledWith('complete', '❌ Failed (Invalid Folder).');
  });

  it('rejects startDownload when yt-dlp binary is missing', () => {
    existsSyncMock.mockImplementation((target: string) => target !== '/missing/ytdlp');
    const send = vi.fn();

    startDownload(
      '/missing/ytdlp',
      {
        isDestroyed: () => false,
        send,
      } as any,
      { url: 'https://example.com', outputPath: '/tmp/downloads' },
      null
    );

    expect(send).toHaveBeenCalledWith(
      'progress',
      '❌ Error: yt-dlp binary not found at /missing/ytdlp'
    );
    expect(send).toHaveBeenCalledWith('complete', '❌ Failed (Missing Dependency).');
  });

  it('rejects startDownload when output path is not a directory', () => {
    statSyncMock.mockReturnValue({ isDirectory: () => false });
    const send = vi.fn();

    startDownload(
      '/tmp/ytdlp',
      {
        isDestroyed: () => false,
        send,
      } as any,
      { url: 'https://example.com', outputPath: '/tmp/not-a-dir' },
      null
    );

    expect(send).toHaveBeenCalledWith(
      'progress',
      expect.stringContaining('Download path is not a directory')
    );
    expect(send).toHaveBeenCalledWith('complete', '❌ Failed (Invalid Folder).');
  });

  it('starts download and completes when conversion is disabled', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const send = vi.fn();

    startDownload(
      '/tmp/ytdlp',
      {
        isDestroyed: () => false,
        send,
      } as any,
      { url: 'https://example.com/video', outputPath: '/tmp/downloads' },
      null
    );

    proc.stdout.emit('data', '[download] 10%\n');
    proc.stdout.emit('data', '/tmp/downloads/video.mp4\n');
    proc.emit('close', 0);

    expect(send).toHaveBeenCalledWith('complete', '✅ Download complete (no conversion).');
    expect(spawnWithEnvMock).toHaveBeenCalledWith(
      '/tmp/ytdlp',
      expect.arrayContaining(['https://example.com/video']),
      expect.any(Object)
    );
  });

  it('creates missing output directory before starting download', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    existsSyncMock.mockImplementation((target: string) => {
      if (target === '/tmp/ytdlp') return true;
      if (target.includes('new-downloads')) return false;
      return true;
    });
    const send = vi.fn();

    startDownload(
      '/tmp/ytdlp',
      {
        isDestroyed: () => false,
        send,
      } as any,
      { url: 'https://example.com/video', outputPath: '/tmp/new-downloads' },
      null
    );

    proc.stdout.emit('data', '/tmp/new-downloads/video.mp4\n');
    proc.emit('close', 0);
    expect(mkdirSyncMock).toHaveBeenCalledWith(expect.stringContaining('new-downloads'), {
      recursive: true,
    });
    expect(send).toHaveBeenCalledWith('complete', '✅ Download complete (no conversion).');
  });

  it('completes with failure when yt-dlp exits non-zero', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const send = vi.fn();

    startDownload(
      '/tmp/ytdlp',
      {
        isDestroyed: () => false,
        send,
      } as any,
      { url: 'https://example.com/video', outputPath: '/tmp/downloads' },
      null
    );

    proc.emit('close', 2);
    expect(send).toHaveBeenCalledWith('complete', '❌ Download failed.');
  });

  it('fails when yt-dlp does not emit a filepath', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const send = vi.fn();

    startDownload(
      '/tmp/ytdlp',
      {
        isDestroyed: () => false,
        send,
      } as any,
      { url: 'https://example.com/video', outputPath: '/tmp/downloads' },
      null
    );

    proc.stdout.emit('data', ' ');
    proc.emit('close', 0);
    expect(send).toHaveBeenCalledWith('complete', '❌ Failed (File Path Error).');
  });

  it('completes with spawn error when yt-dlp process fails to start', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const send = vi.fn();

    startDownload(
      '/tmp/ytdlp',
      {
        isDestroyed: () => false,
        send,
      } as any,
      { url: 'https://example.com/video', outputPath: '/tmp/downloads' },
      null
    );

    proc.emit('error', new Error('spawn failed'));
    expect(send).toHaveBeenCalledWith('complete', '❌ Download failed (process spawn error).');
  });
});
