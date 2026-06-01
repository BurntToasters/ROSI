import { beforeEach, describe, it, expect, vi } from 'vitest';

const detectGpuMock = vi.hoisted(() => vi.fn());

vi.mock('../main/gpu', () => ({
  detectGpu: detectGpuMock,
}));

vi.mock('../main/platform', () => ({
  spawnWithEnv: vi.fn(),
}));

vi.mock('electron-log/main.js', () => ({
  default: { warn: vi.fn(), error: vi.fn() },
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

  it('builds ffmpeg args for m4a audio extraction', () => {
    const args = buildFfmpegArgs('input.mp4', 'output.m4a', 'm4a', 'copy');
    expect(args).toEqual(['-i', 'input.mp4', '-vn', '-c:a', 'aac', '-y', 'output.m4a']);
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

  it('copies a container-compatible video stream instead of re-encoding', () => {
    const args = buildFfmpegArgs('input.mkv', 'output.mp4', 'mp4', 'h264_nvenc', {
      video: 'h264',
      audio: 'aac',
    });
    expect(args).toEqual([
      '-i',
      'input.mkv',
      '-c:v',
      'copy',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      '-y',
      'output.mp4',
    ]);
  });

  it('re-encodes an incompatible video stream with the chosen encoder', () => {
    const args = buildFfmpegArgs('input.webm', 'output.mp4', 'mp4', 'h264_nvenc', {
      video: 'vp9',
      audio: 'opus',
    });
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

  it('copies already-aac audio when extracting to m4a', () => {
    const args = buildFfmpegArgs('input.mp4', 'output.m4a', 'm4a', 'copy', { audio: 'aac' });
    expect(args).toEqual(['-i', 'input.mp4', '-vn', '-c:a', 'copy', '-y', 'output.m4a']);
  });

  it('re-encodes non-aac audio when extracting to m4a', () => {
    const args = buildFfmpegArgs('input.webm', 'output.m4a', 'm4a', 'copy', { audio: 'opus' });
    expect(args).toEqual(['-i', 'input.webm', '-vn', '-c:a', 'aac', '-y', 'output.m4a']);
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
    expect(result.args).toContain('firefox');
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
    expect(result.statusMessages).toContain('🎵 Audio-only mode enabled (MP3)');
  });

  it('builds yt-dlp args for audio-only mode with custom audio format', () => {
    const result = buildYtdlpArgs({
      normalizedDownloadDir: '/tmp/downloads',
      url: 'https://example.com/video',
      settings: createSettings({ audioOnly: true, audioFormat: 'flac' }),
      options: {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      ffmpegLocation: null,
    });

    expect(result.args).toContain('-x');
    expect(result.args).toContain('--audio-format');
    expect(result.args).toContain('flac');
    expect(result.statusMessages).toContain('🎵 Audio-only mode enabled (FLAC)');
  });

  it('rejects unsafe format IDs and uses default format', () => {
    const result = buildYtdlpArgs({
      normalizedDownloadDir: '/tmp/downloads',
      url: 'https://example.com/video',
      settings: createSettings(),
      options: {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
        videoFormat: '137; rm -rf /',
        audioFormat: 'best audio',
      },
      ffmpegLocation: null,
    });

    expect(result.args).not.toContain('137; rm -rf /');
    expect(result.args).not.toContain('best audio');
    const fIdx = result.args.indexOf('-f');
    expect(result.args[fIdx + 1]).toContain('best');
  });

  it('accepts non-numeric yt-dlp format IDs', () => {
    const result = buildYtdlpArgs({
      normalizedDownloadDir: '/tmp/downloads',
      url: 'https://example.com/video',
      settings: createSettings(),
      options: {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
        videoFormat: 'hls-1080',
        audioFormat: '233-drc',
      },
      ffmpegLocation: null,
    });

    expect(result.args).toContain('hls-1080+233-drc');
  });

  it('accepts valid numeric format IDs', () => {
    const result = buildYtdlpArgs({
      normalizedDownloadDir: '/tmp/downloads',
      url: 'https://example.com/video',
      settings: createSettings(),
      options: {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
        videoFormat: '137',
        audioFormat: '140',
      },
      ffmpegLocation: null,
    });

    expect(result.args).toContain('137+140');
  });

  it('builds yt-dlp args for video-only format override', () => {
    const result = buildYtdlpArgs({
      normalizedDownloadDir: '/tmp/downloads',
      url: 'https://example.com/video',
      settings: createSettings({ bestQuality: true }),
      options: {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
        videoFormat: '248',
      },
      ffmpegLocation: null,
    });

    expect(result.args).toContain('248');
    expect(result.statusMessages).toContain('📹 Using video format: 248');
  });

  it('builds yt-dlp args for audio-only format override', () => {
    const result = buildYtdlpArgs({
      normalizedDownloadDir: '/tmp/downloads',
      url: 'https://example.com/video',
      settings: createSettings({ audioOnly: true }),
      options: {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
        audioFormat: '251',
      },
      ffmpegLocation: null,
    });

    expect(result.args).toContain('251');
    expect(result.args).not.toContain('-x');
    expect(result.statusMessages).toContain('🎵 Using audio format: 251');
  });

  it('ignores unrecognised browser names', () => {
    const result = buildYtdlpArgs({
      normalizedDownloadDir: '/tmp/downloads',
      url: 'https://example.com/video',
      settings: createSettings({ hookBrowser: true, browserChoice: 'curl' }),
      options: {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      ffmpegLocation: null,
    });

    expect(result.args).not.toContain('--cookies-from-browser');
    expect(result.args).not.toContain('curl');
  });

  it('normalises allowed browser name to lowercase', () => {
    const result = buildYtdlpArgs({
      normalizedDownloadDir: '/tmp/downloads',
      url: 'https://example.com/video',
      settings: createSettings({ hookBrowser: true, browserChoice: 'Firefox' }),
      options: {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      ffmpegLocation: null,
    });

    expect(result.args).toContain('--cookies-from-browser');
    expect(result.args).toContain('firefox');
  });

  it('falls back to mp3 for unrecognised audio format in audio-only mode', () => {
    const result = buildYtdlpArgs({
      normalizedDownloadDir: '/tmp/downloads',
      url: 'https://example.com/video',
      settings: createSettings({ audioOnly: true, audioFormat: 'exe' as 'mp3' }),
      options: {
        url: 'https://example.com/video',
        outputPath: '/tmp/downloads',
      },
      ffmpegLocation: null,
    });

    expect(result.args).toContain('--audio-format');
    expect(result.args).toContain('mp3');
    expect(result.statusMessages).toContain('🎵 Audio-only mode enabled (MP3)');
  });
});
