import { beforeEach, describe, it, expect, vi } from 'vitest';

const detectGpuMock = vi.hoisted(() => vi.fn());

vi.mock('../main/gpu', () => ({
  detectGpu: detectGpuMock,
}));

import {
  buildFfmpegArgs,
  buildYtdlpArgs,
  resolveVideoEncoder,
} from '../main/download/commandBuilders';
import type { Settings } from '../types';

function createSettings(overrides: Partial<Settings> = {}): Settings {
  return {
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
    ...overrides,
  };
}

describe('command builders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves GPU encoder based on settings', async () => {
    expect(await resolveVideoEncoder(createSettings({ gpuAcceleration: false }))).toBe('copy');
    expect(
      await resolveVideoEncoder(createSettings({ gpuAcceleration: true, gpuType: 'nvidia' }))
    ).toBe('h264_nvenc');
    expect(
      await resolveVideoEncoder(createSettings({ gpuAcceleration: true, gpuType: 'amd' }))
    ).toBe('h264_amf');
    expect(
      await resolveVideoEncoder(createSettings({ gpuAcceleration: true, gpuType: 'intel' }))
    ).toBe('h264_qsv');
  });

  it('auto-detects GPU encoder when gpuType is auto', async () => {
    detectGpuMock.mockResolvedValue({ nvidia: true, amd: false, intel: false });
    expect(
      await resolveVideoEncoder(createSettings({ gpuAcceleration: true, gpuType: 'auto' }))
    ).toBe('h264_nvenc');

    detectGpuMock.mockResolvedValue({ nvidia: false, amd: true, intel: false });
    expect(
      await resolveVideoEncoder(createSettings({ gpuAcceleration: true, gpuType: 'auto' }))
    ).toBe('h264_amf');

    detectGpuMock.mockResolvedValue({ nvidia: false, amd: false, intel: true });
    expect(
      await resolveVideoEncoder(createSettings({ gpuAcceleration: true, gpuType: 'auto' }))
    ).toBe('h264_qsv');
  });

  it('falls back to copy when auto-detect finds no GPU', async () => {
    detectGpuMock.mockResolvedValue({ nvidia: false, amd: false, intel: false });
    expect(
      await resolveVideoEncoder(createSettings({ gpuAcceleration: true, gpuType: 'auto' }))
    ).toBe('copy');
  });

  it('builds ffmpeg args for audio extraction', () => {
    const args = buildFfmpegArgs('input.mp4', 'output.mp3', 'mp3', 'copy');
    expect(args).toEqual(['-i', 'input.mp4', '-vn', '-c:a', 'libmp3lame', '-y', 'output.mp3']);
  });

  it('builds ffmpeg args for video conversion', () => {
    const args = buildFfmpegArgs('input.webm', 'output.mp4', 'mp4', 'h264_nvenc');
    expect(args).toEqual([
      '-i',
      'input.webm',
      '-c:v',
      'h264_nvenc',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      '-y',
      'output.mp4',
    ]);
  });

  it('builds yt-dlp args for selected audio/video formats', () => {
    const result = buildYtdlpArgs({
      normalizedDownloadDir: '/tmp/downloads',
      url: 'https://example.com/video',
      settings: createSettings({ hookBrowser: true, browserChoice: 'Firefox' }),
      options: {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
        videoFormat: '137',
        audioFormat: '140',
      },
      ffmpegLocation: '/usr/bin/ffmpeg',
    });

    expect(result.args).toContain('--ffmpeg-location');
    expect(result.args).toContain('/usr/bin/ffmpeg');
    expect(result.args).toContain('--cookies-from-browser');
    expect(result.args).toContain('Firefox');
    expect(result.args).toContain('137+140');
    expect(result.statusMessages).toContain('📹 Using formats: video=137, audio=140');
  });

  it('builds yt-dlp args for audio-only mode when no format override is provided', () => {
    const result = buildYtdlpArgs({
      normalizedDownloadDir: '/tmp/downloads',
      url: 'https://example.com/video',
      settings: createSettings({ audioOnly: true }),
      options: {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      ffmpegLocation: null,
    });

    expect(result.args).toContain('-x');
    expect(result.args).toContain('--audio-format');
    expect(result.args).toContain('mp3');
    expect(result.statusMessages).toContain('🎵 Audio-only mode enabled');
  });
});
