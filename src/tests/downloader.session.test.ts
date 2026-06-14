import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';

const { existsSyncMock, statSyncMock, mkdirSyncMock, spawnWithEnvMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  spawnWithEnvMock: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  mkdirSync: mkdirSyncMock,
  rmSync: vi.fn(),
}));

vi.mock('../main/platform', () => ({
  spawnWithEnv: spawnWithEnvMock,
  getEffectiveFfmpegPath: vi.fn(() => 'ffmpeg'),
  resolveFfmpegLocationForYtdlp: vi.fn(() => null),
  ytdlpBinary: 'yt-dlp',
  isWindows: process.platform === 'win32',
  isMac: process.platform === 'darwin',
}));

vi.mock('../main/settings', () => ({
  loadSettings: vi.fn(() => ({
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
  })),
  recordDownload: vi.fn(),
}));

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: vi.fn(),
  },
}));

vi.mock('electron-log/main.js', () => ({
  default: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  canStartDownload,
  cancelActiveSession,
  getDownloadSessionOwner,
  isDownloadBusy,
  startDownload,
} from '../main/downloader';

function createProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
    killed: boolean;
    pid: number;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 1234;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    setImmediate(() => proc.emit('close', 1));
  });
  return proc;
}

function createSender() {
  return {
    send: vi.fn(),
    isDestroyed: () => false,
  } as unknown as Electron.WebContents;
}

describe('downloader session state', () => {
  const outputPath = path.join(os.homedir(), 'Downloads', 'rosi-session-test');

  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockImplementation((target: string) => {
      const normalized = String(target).replace(/\\/g, '/');
      return normalized.includes('yt-dlp') || normalized.includes('rosi-session-test');
    });
    statSyncMock.mockReturnValue({ isDirectory: () => true });
    spawnWithEnvMock.mockReturnValue(createProc());
  });

  afterEach(() => {
    cancelActiveSession(false);
  });

  it('starts idle with no active owner', () => {
    expect(isDownloadBusy()).toBe(false);
    expect(getDownloadSessionOwner()).toBeNull();
    expect(canStartDownload('manual')).toBe(true);
    expect(canStartDownload('queue')).toBe(true);
  });

  it('tracks the active owner while a download is running', () => {
    startDownload(
      '/tmp/yt-dlp',
      createSender(),
      { url: 'https://example.com/video', outputPath },
      null,
      undefined,
      'manual'
    );

    expect(isDownloadBusy()).toBe(true);
    expect(getDownloadSessionOwner()).toBe('manual');
    expect(canStartDownload('manual')).toBe(true);
    expect(canStartDownload('queue')).toBe(false);
  });

  it('rejects starting a queue download while manual owns the session', () => {
    startDownload(
      '/tmp/yt-dlp',
      createSender(),
      { url: 'https://example.com/video', outputPath },
      null,
      undefined,
      'manual'
    );

    expect(() =>
      startDownload(
        '/tmp/yt-dlp',
        createSender(),
        { url: 'https://example.com/other', outputPath },
        null,
        undefined,
        'queue'
      )
    ).toThrow('Download session already active with a different owner.');
  });

  it('clears session state when cancelled', () => {
    startDownload(
      '/tmp/yt-dlp',
      createSender(),
      { url: 'https://example.com/video', outputPath },
      null,
      undefined,
      'queue'
    );

    expect(isDownloadBusy()).toBe(true);
    cancelActiveSession(false);
    expect(isDownloadBusy()).toBe(false);
    expect(getDownloadSessionOwner()).toBeNull();
  });
});
