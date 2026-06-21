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
  resolveFfmpegLocationForYtdlpMock,
  resolveVideoEncoderMock,
  probeMediaCodecsMock,
  buildYtdlpArgsMock,
  showMessageBoxMock,
  logErrorMock,
  logWarnMock,
  sanitizeMock,
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
    resolveFfmpegLocationForYtdlpMock: vi.fn(() => null),
    resolveVideoEncoderMock: vi.fn(async () => 'copy'),
    probeMediaCodecsMock: vi.fn(async () => ({})),
    buildYtdlpArgsMock: vi.fn(({ url }: { url: string }) => ({
      args: ['--print', 'after_move:filepath', '-o', '%(title)s.%(ext)s', url],
      statusMessages: [],
    })),
    showMessageBoxMock: vi.fn(),
    logErrorMock: vi.fn(),
    logWarnMock: vi.fn(),
    sanitizeMock: vi.fn((name: string) => name.replace(/[<>:"/\\|?*]/g, '_')),
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
  resolveFfmpegLocationForYtdlp: resolveFfmpegLocationForYtdlpMock,
  ytdlpBinary: 'yt-dlp',
  isWindows: process.platform === 'win32',
  isMac: process.platform === 'darwin',
}));

vi.mock('../main/settings', () => ({
  loadSettings: loadSettingsMock,
  recordDownload: recordDownloadMock,
}));

vi.mock('../main/download/commandBuilders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/download/commandBuilders')>();
  return {
    ...actual,
    resolveVideoEncoder: resolveVideoEncoderMock,
    buildYtdlpArgs: buildYtdlpArgsMock,
    probeMediaCodecs: probeMediaCodecsMock,
  };
});

vi.mock('electron', () => ({
  dialog: { showMessageBox: showMessageBoxMock },
}));

vi.mock('electron-log/main.js', () => ({
  default: {
    error: logErrorMock,
    warn: logWarnMock,
  },
}));

vi.mock('sanitize-filename', () => ({
  default: sanitizeMock,
}));

import {
  cancelActiveSession,
  cancelFormats,
  killAllProcesses,
  startDownload,
} from '../main/downloader';

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
  } as unknown as Electron.WebContents;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('download error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ isDirectory: () => true });
    sanitizeMock.mockImplementation((name: string) => name.replace(/[<>:"/\\|?*]/g, '_'));
    buildYtdlpArgsMock.mockImplementation(({ url }: { url: string }) => ({
      args: ['--print', 'after_move:filepath', '-o', '%(title)s.%(ext)s', url],
      statusMessages: [],
    }));
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

  it('emits status messages returned by command builder', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const sender = createSender();
    buildYtdlpArgsMock.mockReturnValueOnce({
      args: ['--print', 'after_move:filepath', 'https://example.com/video'],
      statusMessages: ['ℹ️ builder status'],
    } as any);

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

    expect(sender.send).toHaveBeenCalledWith('progress', 'ℹ️ builder status');
  });

  it('truncates oversized yt-dlp stdout buffer and still extracts filepath', () => {
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

    proc.stdout.emit('data', `${'x'.repeat(300_000)}\n`);
    proc.stdout.emit('data', '/tmp/downloads/video.mp4\n');
    proc.emit('close', 0);

    expect(sender.send).toHaveBeenCalledWith('complete', '✅ Download complete (no conversion).');
  });

  it('emits yt-dlp stderr output on progress channel', () => {
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

    proc.stderr.emit('data', 'warning\n');
    proc.stdout.emit('data', '/tmp/downloads/video.mp4\n');
    proc.emit('close', 0);

    expect(sender.send).toHaveBeenCalledWith('progress', '[yt-dlp stderr] warning');
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

  it('reports failure when downloaded path escapes output directory', () => {
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

    proc.stdout.emit('data', '/tmp/other/video.mp4\n');
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

    expect(onComplete).toHaveBeenCalledWith('✅ Download complete (no conversion).', 'success');
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

    expect(onComplete).toHaveBeenCalledWith('⏹️ Cancelled.', 'cancelled');
  });

  it('logs onComplete callback errors during silent cancellation', () => {
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
      null,
      () => {
        throw new Error('cancel callback failed');
      },
      'queue'
    );

    cancelActiveSession(false);

    expect(logErrorMock).toHaveBeenCalledWith(
      'Error in download cancellation callback:',
      expect.any(Error)
    );
    expect(recordDownloadMock).toHaveBeenCalledWith('cancelled');
  });

  it('logs onComplete callback errors without breaking completion', () => {
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
      null,
      () => {
        throw new Error('callback failed');
      }
    );

    proc.stdout.emit('data', '/tmp/downloads/video.mp4\n');
    proc.emit('close', 0);

    expect(sender.send).toHaveBeenCalledWith('complete', '✅ Download complete (no conversion).');
    expect(logErrorMock).toHaveBeenCalledWith(
      'Error in download completion callback:',
      expect.any(Error)
    );
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

    expect(recordDownloadMock).toHaveBeenCalledWith('success', 'mp4', undefined);
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

  it('fails when download directory creation throws', () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('downloads')) return false;
      return true;
    });
    mkdirSyncMock.mockImplementation(() => {
      throw new Error('mkdir denied');
    });
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

    expect(sender.send).toHaveBeenCalledWith('complete', '❌ Failed (Initial Setup Error).');
  });

  it('fails when output path exists but is not a directory', () => {
    statSyncMock.mockReturnValue({ isDirectory: () => false });
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

    expect(sender.send).toHaveBeenCalledWith('complete', '❌ Failed (Invalid Folder).');
  });

  it('uses stream copy in ffmpeg argv when probed codecs are container-compatible', async () => {
    const ytProc = createProc();
    const ffProc = createProc();
    spawnWithEnvMock.mockReturnValueOnce(ytProc).mockReturnValueOnce(ffProc);
    probeMediaCodecsMock.mockResolvedValueOnce({ video: 'h264', audio: 'aac' });
    resolveVideoEncoderMock.mockResolvedValueOnce('h264_nvenc');
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
      },
      null
    );

    ytProc.stdout.emit('data', '/tmp/downloads/video.webm\n');
    ytProc.emit('close', 0);
    await flush();

    const ffmpegArgs = spawnWithEnvMock.mock.calls[1]?.[1] as string[] | undefined;
    expect(ffmpegArgs).toEqual(expect.arrayContaining(['-c:v', 'copy', '-c:a', 'copy']));
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

  it('uses fallback filename when sanitizer removes all characters', async () => {
    const ytProc = createProc();
    const ffProc = createProc();
    spawnWithEnvMock.mockReturnValueOnce(ytProc).mockReturnValueOnce(ffProc);
    sanitizeMock.mockReturnValueOnce('');
    const sender = createSender();

    loadSettingsMock.mockReturnValue({
      ...loadSettingsMock(),
      convertEnabled: true,
      convertFormat: 'mp3',
    });

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null
    );

    ytProc.stdout.emit('data', '/tmp/downloads/????\n');
    ytProc.emit('close', 0);
    await flush();
    ffProc.emit('close', 0);

    expect(renameSyncMock.mock.calls[0]?.[0].replace(/\\/g, '/')).toMatch(
      /\/tmp\/downloads\/\?\?\?\?$/
    );
    expect(renameSyncMock.mock.calls[0]?.[1].replace(/\\/g, '/')).toContain('download_');
    expect(sender.send).toHaveBeenCalledWith(
      'progress',
      expect.stringContaining('Original filename contained only invalid characters')
    );
  });

  it('skips conversion when file already has target extension', async () => {
    const ytProc = createProc();
    spawnWithEnvMock.mockReturnValue(ytProc);
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
      },
      null
    );

    ytProc.stdout.emit('data', '/tmp/downloads/video.mp4\n');
    ytProc.emit('close', 0);
    await flush();

    expect(sender.send).toHaveBeenCalledWith('complete', '✅ Done (Already MP4).');
  });

  it('renames sanitized file and completes successful conversion', async () => {
    const ytProc = createProc();
    const ffProc = createProc();
    spawnWithEnvMock.mockReturnValueOnce(ytProc).mockReturnValueOnce(ffProc);
    const sender = createSender();

    loadSettingsMock.mockReturnValue({
      ...loadSettingsMock(),
      convertEnabled: true,
      convertFormat: 'mp3',
      keepOriginalAfterConvert: false,
    });

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null
    );

    ytProc.stdout.emit('data', '/tmp/downloads/bad:name.webm\n');
    ytProc.emit('close', 0);
    await flush();
    ffProc.stdout.emit('data', Buffer.from('ffmpeg output'));
    ffProc.stderr.emit('data', Buffer.from('ffmpeg warning'));
    ffProc.emit('close', 0);

    expect(renameSyncMock).toHaveBeenCalled();
    expect(unlinkSyncMock).toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith('complete', '🎬 Conversion complete.');
  });

  it('keeps original file after successful conversion when configured', async () => {
    const ytProc = createProc();
    const ffProc = createProc();
    spawnWithEnvMock.mockReturnValueOnce(ytProc).mockReturnValueOnce(ffProc);
    const sender = createSender();

    loadSettingsMock.mockReturnValue({
      ...loadSettingsMock(),
      convertEnabled: true,
      convertFormat: 'mp3',
      keepOriginalAfterConvert: true,
    });

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null
    );

    ytProc.stdout.emit('data', '/tmp/downloads/video.webm\n');
    ytProc.emit('close', 0);
    await flush();
    ffProc.emit('close', 0);

    expect(sender.send).toHaveBeenCalledWith(
      'progress',
      expect.stringContaining('Keeping original file')
    );
    expect(sender.send).toHaveBeenCalledWith('complete', '🎬 Conversion complete.');
  });

  it('reports conversion failure and removes partial output', async () => {
    const ytProc = createProc();
    const ffProc = createProc();
    spawnWithEnvMock.mockReturnValueOnce(ytProc).mockReturnValueOnce(ffProc);
    const sender = createSender();

    loadSettingsMock.mockReturnValue({
      ...loadSettingsMock(),
      convertEnabled: true,
      convertFormat: 'mp3',
    });

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null
    );

    ytProc.stdout.emit('data', '/tmp/downloads/video.webm\n');
    ytProc.emit('close', 0);
    await flush();
    ffProc.emit('close', 1);

    expect(unlinkSyncMock).toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith('complete', '❌ Conversion failed.');
  });

  it('shows ffmpeg not found dialog on ENOENT conversion error', async () => {
    const ytProc = createProc();
    const ffProc = createProc();
    spawnWithEnvMock.mockReturnValueOnce(ytProc).mockReturnValueOnce(ffProc);
    const sender = createSender();
    const mainWindow = { isDestroyed: () => false } as unknown as Electron.BrowserWindow;

    loadSettingsMock.mockReturnValue({
      ...loadSettingsMock(),
      convertEnabled: true,
      convertFormat: 'mp3',
    });

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      mainWindow
    );

    ytProc.stdout.emit('data', '/tmp/downloads/video.webm\n');
    ytProc.emit('close', 0);
    await flush();
    ffProc.emit('error', new Error('ENOENT'));

    expect(sender.send).toHaveBeenCalledWith(
      'complete',
      '❌ Conversion failed (FFmpeg not found).'
    );
    expect(showMessageBoxMock).toHaveBeenCalledWith(
      mainWindow,
      expect.objectContaining({
        type: 'error',
      })
    );
  });

  it('reports generic ffmpeg spawn errors', async () => {
    const ytProc = createProc();
    const ffProc = createProc();
    spawnWithEnvMock.mockReturnValueOnce(ytProc).mockReturnValueOnce(ffProc);
    const sender = createSender();

    loadSettingsMock.mockReturnValue({
      ...loadSettingsMock(),
      convertEnabled: true,
      convertFormat: 'mp3',
    });

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null
    );

    ytProc.stdout.emit('data', '/tmp/downloads/video.webm\n');
    ytProc.emit('close', 0);
    await flush();
    ffProc.emit('error', new Error('permission denied'));

    expect(sender.send).toHaveBeenCalledWith(
      'complete',
      '❌ Conversion failed (ffmpeg spawn error).'
    );
  });

  it('reports conversion setup errors', async () => {
    const ytProc = createProc();
    spawnWithEnvMock.mockReturnValue(ytProc);
    renameSyncMock.mockImplementation(() => {
      throw new Error('rename denied');
    });
    const sender = createSender();

    loadSettingsMock.mockReturnValue({
      ...loadSettingsMock(),
      convertEnabled: true,
      convertFormat: 'mp3',
    });

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null
    );

    ytProc.stdout.emit('data', '/tmp/downloads/bad:name.webm\n');
    ytProc.emit('close', 0);
    await flush();

    expect(sender.send).toHaveBeenCalledWith('complete', '❌ Conversion failed (setup error).');
  });

  it('logs send failures without throwing', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(() => {
        throw new Error('send failed');
      }),
    } as unknown as Electron.WebContents;

    expect(() =>
      startDownload(
        '/tmp/ytdlp',
        sender,
        {
          url: 'https://example.com/video',
          outputPath: '/tmp/downloads',
        },
        null
      )
    ).not.toThrow();

    expect(logWarnMock).toHaveBeenCalled();
  });

  it('logs process kill errors during cancellation', () => {
    const proc = createProc();
    proc.kill = vi.fn(() => {
      throw new Error('kill failed');
    });
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

    cancelActiveSession(false);

    expect(logErrorMock).toHaveBeenCalledWith('Error killing yt-dlp process:', expect.any(Error));
  });

  it('force kills a process that ignores SIGTERM', async () => {
    vi.useFakeTimers();
    const proc = createProc();
    proc.kill = vi.fn();
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

    cancelActiveSession(false);
    await vi.advanceTimersByTimeAsync(5000);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('clears force kill timer when process exits', async () => {
    vi.useFakeTimers();
    const proc = createProc();
    proc.kill = vi.fn();
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

    cancelActiveSession(false);
    proc.emit('exit');
    await vi.advanceTimersByTimeAsync(5000);

    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('kills active processes without emitting completion through killAllProcesses', () => {
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

    killAllProcesses();

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(sender.send).not.toHaveBeenCalledWith('complete', expect.any(String));
  });

  it('uses custom ffmpeg path and keepOriginal option overrides', async () => {
    const ytProc = createProc();
    const ffProc = createProc();
    spawnWithEnvMock.mockReturnValueOnce(ytProc).mockReturnValueOnce(ffProc);
    getEffectiveFfmpegPathMock.mockReturnValueOnce('/custom/ffmpeg');
    const sender = createSender();

    loadSettingsMock.mockReturnValue({
      ...loadSettingsMock(),
      convertEnabled: true,
      convertFormat: 'mp3',
      keepOriginalAfterConvert: true,
    });

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
        ffmpegPath: '/custom/ffmpeg',
        keepOriginal: false,
      },
      null
    );

    expect(getEffectiveFfmpegPathMock).toHaveBeenCalledWith('/custom/ffmpeg');
    ytProc.stdout.emit('data', '/tmp/downloads/video.webm\n');
    ytProc.emit('close', 0);
    await flush();
    ffProc.emit('close', 0);

    expect(unlinkSyncMock).toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith('complete', '🎬 Conversion complete.');
  });

  it('disables conversion when per-download format override is blank', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const sender = createSender();

    loadSettingsMock.mockReturnValue({
      ...loadSettingsMock(),
      convertEnabled: true,
      convertFormat: 'mp3',
    });

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
        convertFormat: '',
      },
      null
    );

    proc.stdout.emit('data', '/tmp/downloads/video.webm\n');
    proc.emit('close', 0);

    expect(spawnWithEnvMock).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith('complete', '✅ Download complete (no conversion).');
  });

  it('ignores events from superseded download sessions', () => {
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

    proc1.stdout.emit('data', '/tmp/downloads/old.mp4\n');
    proc1.stderr.emit('data', 'old error\n');
    proc1.emit('close', 0);
    proc1.emit('error', new Error('old spawn'));

    expect(sender.send).not.toHaveBeenCalledWith(
      'complete',
      '✅ Download complete (no conversion).'
    );
  });

  it('emits GPU conversion status when encoder is accelerated', async () => {
    const ytProc = createProc();
    const ffProc = createProc();
    spawnWithEnvMock.mockReturnValueOnce(ytProc).mockReturnValueOnce(ffProc);
    resolveVideoEncoderMock.mockResolvedValueOnce('h264_nvenc');
    const sender = createSender();

    loadSettingsMock.mockReturnValue({
      ...loadSettingsMock(),
      convertEnabled: true,
      convertFormat: 'mp4',
      gpuAcceleration: true,
    });

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null
    );

    ytProc.stdout.emit('data', '/tmp/downloads/video.webm\n');
    ytProc.emit('close', 0);
    await flush();
    await flush();

    expect(sender.send).toHaveBeenCalledWith('progress', '🖥️ Using GPU acceleration (h264_nvenc)');
  });

  it('times out conversion and kills ffmpeg process', async () => {
    vi.useFakeTimers();
    const ytProc = createProc();
    const ffProc = createProc();
    ffProc.kill = vi.fn();
    spawnWithEnvMock.mockReturnValueOnce(ytProc).mockReturnValueOnce(ffProc);
    const sender = createSender();

    loadSettingsMock.mockReturnValue({
      ...loadSettingsMock(),
      convertEnabled: true,
      convertFormat: 'mp3',
    });

    startDownload(
      '/tmp/ytdlp',
      sender,
      {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      null
    );

    ytProc.stdout.emit('data', '/tmp/downloads/video.webm\n');
    ytProc.emit('close', 0);
    await flush();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(sender.send).toHaveBeenCalledWith(
      'progress',
      '❌ Conversion timed out after 10 minutes.'
    );
    expect(ffProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not emit progress on destroyed sender', () => {
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);
    const sendMock = vi.fn();
    const sender = {
      isDestroyed: () => true,
      send: sendMock,
    } as unknown as Electron.WebContents;

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

    const progressCalls = sendMock.mock.calls.filter((call) => call[0] === 'progress');
    expect(progressCalls.length).toBe(0);
  });
});
