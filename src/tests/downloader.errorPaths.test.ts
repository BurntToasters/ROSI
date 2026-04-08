import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const {
  existsSyncMock,
  statSyncMock,
  mkdirSyncMock,
  renameSyncMock,
  unlinkSyncMock,
  spawnWithEnvMock,
  recordDownloadMock,
  loadSettingsMock,
  getEffectiveFfmpegPathMock,
  resolveVideoEncoderMock,
  buildFfmpegArgsMock,
} = vi.hoisted(() => {
  return {
    existsSyncMock: vi.fn(),
    statSyncMock: vi.fn(),
    mkdirSyncMock: vi.fn(),
    renameSyncMock: vi.fn(),
    unlinkSyncMock: vi.fn(),
    spawnWithEnvMock: vi.fn(),
    recordDownloadMock: vi.fn(),
    loadSettingsMock: vi.fn(),
    getEffectiveFfmpegPathMock: vi.fn(() => 'ffmpeg'),
    resolveVideoEncoderMock: vi.fn(async () => 'copy'),
    buildFfmpegArgsMock: vi.fn(() => ['-i', 'in.mp4', '-c:v', 'copy', '-y', 'out.mp4']),
  };
});

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  mkdirSync: mkdirSyncMock,
  renameSync: renameSyncMock,
  unlinkSync: unlinkSyncMock,
}));

vi.mock('../main/platform', () => ({
  spawnWithEnv: spawnWithEnvMock,
  getEffectiveFfmpegPath: getEffectiveFfmpegPathMock,
  ytdlpBinary: 'yt-dlp',
  isWindows: process.platform === 'win32',
  isMac: process.platform === 'darwin',
}));

vi.mock('../main/settings', () => ({
  loadSettings: loadSettingsMock,
  recordDownload: recordDownloadMock,
}));

vi.mock('../main/download/commandBuilders', () => ({
  resolveVideoEncoder: resolveVideoEncoderMock,
  buildFfmpegArgs: buildFfmpegArgsMock,
  buildYtdlpArgs: vi.fn(({ url }: { url: string }) => ({
    args: ['--print', 'after_move:filepath', '-o', '%(title)s.%(ext)s', url],
    statusMessages: [],
  })),
}));

vi.mock('electron', () => ({
  dialog: { showMessageBox: vi.fn() },
}));

vi.mock('sanitize-filename', () => ({
  default: vi.fn((name: string) => name.replace(/[<>:"/\\|?*]/g, '_')),
}));

import { cancelActiveSession, cancelFormats, startDownload } from '../main/downloader';

function createProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
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

function createSender() {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
  } as any;
}

describe('download error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ isDirectory: () => true });
    loadSettingsMock.mockReturnValue({
      settingsVersion: 1,
      theme: 'system',
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
      audioFormat: 'mp3',
    });
  });

  afterEach(() => {
    cancelFormats();
    cancelActiveSession(false);
    vi.useRealTimers();
  });

  it('reports yt-dlp process spawn error', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const sender = createSender();

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null
    );

    proc.emit('error', new Error('ENOENT'));

    expect(sender.send).toHaveBeenCalledWith(
      'complete',
      '❌ Download failed (process spawn error).'
    );
  });

  it('reports failure when yt-dlp exits with non-zero code', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const sender = createSender();

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null
    );

    proc.stdout.emit('data', '[download] error\n');
    proc.emit('close', 1);

    expect(sender.send).toHaveBeenCalledWith('complete', '❌ Download failed.');
  });

  it('reports failure when downloaded file path cannot be determined', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const sender = createSender();

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null
    );

    proc.stdout.emit('data', '[download] 100%\n');
    proc.emit('close', 0);

    expect(sender.send).toHaveBeenCalledWith('complete', '❌ Failed (File Path Error).');
  });

  it('calls onComplete callback on successful download', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const sender = createSender();
    const onComplete = vi.fn();

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null,
      onComplete
    );

    proc.stdout.emit('data', '/tmp/downloads/video.mp4\n');
    proc.emit('close', 0);

    expect(onComplete).toHaveBeenCalledWith('✅ Download complete (no conversion).');
  });

  it('calls onComplete callback on cancellation', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const sender = createSender();
    const onComplete = vi.fn();

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null,
      onComplete
    );

    cancelActiveSession(true);

    expect(onComplete).toHaveBeenCalledWith('⏹️ Cancelled.');
  });

  it('records download outcome metrics', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const sender = createSender();

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null
    );

    proc.stdout.emit('data', '/tmp/downloads/video.mp4\n');
    proc.emit('close', 0);

    expect(recordDownloadMock).toHaveBeenCalledWith('success');
  });

  it('records cancelled outcome on cancel', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const sender = createSender();

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null
    );

    cancelActiveSession(true);

    expect(recordDownloadMock).toHaveBeenCalledWith('cancelled');
  });

  it('cancels previous session when starting a new download', () => {
    const proc1 = createProc();
    const proc2 = createProc();
    spawnWithEnvMock.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);
    const sender = createSender();

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/1',
        outputPath: '/tmp/downloads',
      },
      null
    );

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/2',
        outputPath: '/tmp/downloads',
      },
      null
    );

    expect(proc1.kill).toHaveBeenCalled();
  });

  it('creates download directory if it does not exist', () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('downloads')) return false;
      return true;
    });
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const sender = createSender();

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/new-downloads',
      },
      null
    );

    expect(mkdirSyncMock).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });

  it('handles conversion enabled with valid format', () => {
    const ytProc = createProc();
    const ffProc = createProc();
    spawnWithEnvMock.mockReturnValueOnce(ytProc).mockReturnValueOnce(ffProc);
    const sender = createSender();

    loadSettingsMock.mockReturnValue({
      ...loadSettingsMock(),
      convertEnabled: true,
      convertFormat: 'mp4',
    });

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
        convertFormat: 'mp3',
      },
      null
    );

    ytProc.stdout.emit('data', '/tmp/downloads/video.webm\n');
    ytProc.emit('close', 0);

    expect(sender.send).toHaveBeenCalledWith(
      'progress',
      expect.stringContaining('Checking if conversion is needed')
    );
  });

  it('does not emit progress on destroyed sender', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const sender = {
      isDestroyed: () => true,
      send: vi.fn(),
    } as any;

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null
    );

    proc.stdout.emit('data', 'some progress\n');

    const progressCalls = sender.send.mock.calls.filter(
      ([channel]: [string]) => channel === 'progress'
    );
    expect(progressCalls.length).toBe(0);
  });
});
