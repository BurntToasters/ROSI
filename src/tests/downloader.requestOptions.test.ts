import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import type { DownloadCompletion, DownloadPreset, Settings } from '../types';

const { existsSyncMock, statSyncMock, spawnWithEnvMock, loadSettingsMock, recordDownloadMock } =
  vi.hoisted(() => ({
    existsSyncMock: vi.fn(),
    statSyncMock: vi.fn(),
    spawnWithEnvMock: vi.fn(),
    loadSettingsMock: vi.fn(),
    recordDownloadMock: vi.fn(),
  }));

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('../main/platform', () => ({
  spawnWithEnv: spawnWithEnvMock,
  getEffectiveFfmpegPath: vi.fn(() => 'ffmpeg'),
  resolveFfmpegLocationForYtdlp: vi.fn(() => null),
  ytdlpBinary: 'yt-dlp',
  isWindows: process.platform === 'win32',
  isMac: process.platform === 'darwin',
}));

vi.mock('../main/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/settings')>();
  return {
    downloadPresetToRequestOptions: actual.downloadPresetToRequestOptions,
    loadSettings: loadSettingsMock,
    recordDownload: recordDownloadMock,
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/rosi-tests' },
  dialog: { showMessageBox: vi.fn(), showErrorBox: vi.fn() },
}));

vi.mock('electron-log/main.js', () => ({
  default: { initialize: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { cancelActiveSession, startDownload } from '../main/downloader';

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    settingsVersion: 7,
    theme: 'system',
    showConsoleOutput: false,
    consoleCollapsed: false,
    queueCollapsed: false,
    downloadProfilesEnabled: false,
    downloadMode: 'best-video',
    downloadPresets: [],
    askDownloadLocation: false,
    advancedOptions: false,
    audioOnly: false,
    audioFormat: 'mp3',
    convertEnabled: false,
    convertFormat: 'mp4',
    keepOriginalAfterConvert: true,
    firstLaunch: false,
    hookBrowser: false,
    browserChoice: 'chrome',
    animateBackground: true,
    flatUi: false,
    notifications: true,
    denoReminderDismissed: true,
    gpuAcceleration: false,
    gpuType: 'auto',
    bestQuality: false,
    ffmpegPath: '',
    downloadFolder: '',
    hideSupportModal: true,
    checkUpdatesOnStartup: false,
    updateChannel: 'auto',
    writeSubtitles: false,
    subtitleLangs: 'en',
    embedThumbnail: false,
    embedMetadata: false,
    sponsorblockRemove: false,
    showTaskbarProgress: true,
    ...overrides,
  };
}

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
  proc.pid = 4321;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  return proc;
}

function createSender() {
  return {
    send: vi.fn(),
    isDestroyed: () => false,
  } as unknown as Electron.WebContents;
}

function lastYtdlpArgs(): string[] {
  const call = spawnWithEnvMock.mock.calls.at(-1);
  return (call?.[1] ?? []) as string[];
}

describe('downloader request options and presets', () => {
  const outputPath = path.join(os.homedir(), 'Downloads', 'rosi-request-test');

  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockImplementation((target: string) => {
      const normalized = String(target).replace(/\\/g, '/');
      return normalized.includes('yt-dlp') || normalized.includes('rosi-request-test');
    });
    statSyncMock.mockReturnValue({ isDirectory: () => true, isFile: () => true, size: 2048 });
    spawnWithEnvMock.mockReturnValue(createProc());
    loadSettingsMock.mockReturnValue(baseSettings());
  });

  afterEach(() => {
    cancelActiveSession(false);
  });

  it('applies per-request enhancement and profile overrides over saved settings', () => {
    startDownload('/tmp/yt-dlp', createSender(), {
      url: 'https://example.com/video',
      outputPath,
      profileEnabled: true,
      profile: 'audio',
      audioOutputFormat: 'flac',
      writeSubtitles: true,
      subtitleLangs: 'en,es',
      embedThumbnail: true,
      embedMetadata: true,
      sponsorblockRemove: true,
      hookBrowser: true,
      browserChoice: 'firefox',
    });

    const args = lastYtdlpArgs();
    expect(args).toContain('-x');
    expect(args).toContain('--audio-format');
    expect(args).toContain('flac');
    expect(args).toContain('--sub-langs');
    expect(args).toContain('en,es');
    expect(args).toContain('--embed-thumbnail');
    expect(args).toContain('--embed-metadata');
    expect(args).toContain('--sponsorblock-remove');
    expect(args).toContain('--cookies-from-browser');
    expect(args).toContain('firefox');
  });

  it('resolves a saved preset by id into the effective request', () => {
    const preset: DownloadPreset = {
      id: 'audio-preset',
      name: 'Audio preset',
      profile: 'audio',
      audioFormat: 'opus',
      embedMetadata: true,
      playlist: { mode: 'range', start: 2, end: 3 },
    };
    loadSettingsMock.mockReturnValue(baseSettings({ downloadPresets: [preset] }));

    startDownload('/tmp/yt-dlp', createSender(), {
      url: 'https://example.com/watch?v=a&list=PL1',
      outputPath,
      presetId: 'audio-preset',
    });

    const args = lastYtdlpArgs();
    expect(args).toContain('opus');
    expect(args).toContain('--embed-metadata');
    expect(args).toContain('--yes-playlist');
    expect(args[args.indexOf('--playlist-items') + 1]).toBe('2-3');
  });

  it('ignores an unknown preset id and keeps the explicit request options', () => {
    startDownload('/tmp/yt-dlp', createSender(), {
      url: 'https://example.com/video',
      outputPath,
      presetId: 'does-not-exist',
      profileEnabled: false,
      audioOnly: false,
    });

    const args = lastYtdlpArgs();
    expect(args).not.toContain('-x');
    expect(args).toContain('--no-playlist');
  });

  it('reports structured completion metadata for failures', () => {
    const completions: DownloadCompletion[] = [];
    const proc = createProc();
    spawnWithEnvMock.mockReturnValue(proc);

    startDownload(
      '/tmp/yt-dlp',
      createSender(),
      {
        url: 'https://example.com/video',
        outputPath,
        profile: 'best-video',
        presetId: 'p1',
        presetName: 'P1',
      },
      null,
      undefined,
      'queue',
      { completedItems: 0, queueTotal: 1, queueItemId: 'q_1' },
      (completion) => completions.push(completion)
    );

    proc.emit('close', 1);

    expect(completions).toHaveLength(1);
    const completion = completions[0]!;
    expect(completion.outcome).toBe('failed');
    expect(completion.owner).toBe('queue');
    expect(completion.queueItemId).toBe('q_1');
    expect(completion.url).toBe('https://example.com/video');
    expect(completion.presetId).toBe('p1');
    expect(completion.presetName).toBe('P1');
    expect(completion.error).toBeTruthy();
    expect(completion.request.outputPath).toBe(path.resolve(outputPath));
    expect(completion.completedAt).toBeGreaterThanOrEqual(completion.startedAt);
    expect(recordDownloadMock).toHaveBeenCalledWith('failed');
  });

  it('reports structured completion metadata for cancellations', () => {
    const completions: DownloadCompletion[] = [];
    startDownload(
      '/tmp/yt-dlp',
      createSender(),
      { url: 'https://example.com/video', outputPath },
      null,
      undefined,
      'manual',
      null,
      (completion) => completions.push(completion)
    );

    cancelActiveSession(true);

    expect(completions).toHaveLength(1);
    expect(completions[0]!.outcome).toBe('cancelled');
    expect(completions[0]!.error).toBeUndefined();
  });
});
