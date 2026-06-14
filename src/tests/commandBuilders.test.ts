import { EventEmitter } from 'events';
import { beforeEach, describe, it, expect, vi } from 'vitest';

const { detectGpuMock, spawnWithEnvMock } = vi.hoisted(() => ({
  detectGpuMock: vi.fn(),
  spawnWithEnvMock: vi.fn(),
}));

vi.mock('../main/gpu', () => ({
  detectGpu: detectGpuMock,
}));

vi.mock('../main/platform', () => ({
  spawnWithEnv: spawnWithEnvMock,
}));

vi.mock('electron-log/main.js', () => ({
  default: { warn: vi.fn(), error: vi.fn() },
}));

import {
  buildFfmpegArgs,
  buildYtdlpArgs,
  probeMediaCodecs,
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
    writeSubtitles: false,
    subtitleLangs: 'en',
    embedThumbnail: false,
    embedMetadata: false,
    sponsorblockRemove: false,
    ...overrides,
  };
}

function createProbeProc(stderrLines: string[]) {
  const proc = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    kill: (signal?: string) => void;
  };
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  spawnWithEnvMock.mockReturnValue(proc);
  setImmediate(() => {
    for (const line of stderrLines) {
      proc.stderr.emit('data', line);
    }
    proc.emit('close', 1);
  });
  return proc;
}

describe('command builders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('probeMediaCodecs parses video and audio codecs from ffmpeg stderr', async () => {
    createProbeProc([
      'Input #0, matroska, from input.mkv:\n',
      '  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080\n',
      '  Stream #0:1: Audio: aac (LC), 48000 Hz, stereo\n',
    ]);

    await expect(probeMediaCodecs('ffmpeg', '/tmp/input.mkv')).resolves.toEqual({
      video: 'h264',
      audio: 'aac',
    });
    expect(spawnWithEnvMock).toHaveBeenCalledWith(
      'ffmpeg',
      ['-hide_banner', '-i', '/tmp/input.mkv'],
      { shell: false }
    );
  });

  it('probeMediaCodecs returns partial codecs when only one stream is present', async () => {
    createProbeProc(['  Stream #0:0: Video: vp9, yuv420p, 1280x720\n']);

    await expect(probeMediaCodecs('ffmpeg', '/tmp/input.webm')).resolves.toEqual({
      video: 'vp9',
    });
  });

  it('probeMediaCodecs returns empty object when stderr has no stream info', async () => {
    createProbeProc(['ffmpeg version 6.0\n']);

    await expect(probeMediaCodecs('ffmpeg', '/tmp/input.mp4')).resolves.toEqual({});
  });

  it('probeMediaCodecs returns empty object when spawn errors', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      kill: (signal?: string) => void;
    };
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    spawnWithEnvMock.mockReturnValue(proc);
    setImmediate(() => proc.emit('error', new Error('spawn failed')));

    await expect(probeMediaCodecs('ffmpeg', '/tmp/input.mp4')).resolves.toEqual({});
  });

  it('probeMediaCodecs kills hung probe and returns partial codecs on timeout', async () => {
    vi.useFakeTimers();
    const proc = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      kill: (signal?: string) => void;
    };
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    spawnWithEnvMock.mockReturnValue(proc);

    const pending = probeMediaCodecs('ffmpeg', '/tmp/input.mkv');
    proc.stderr.emit('data', '  Stream #0:0: Video: h264 (High), yuv420p\n');
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(pending).resolves.toEqual({ video: 'h264' });
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
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
      ffmpegLocation: '/usr/bin',
    });

    expect(result.args).toContain('--ffmpeg-location');
    expect(result.args).toContain('/usr/bin');
    expect(result.args).toContain('--cookies-from-browser');
    expect(result.args).toContain('firefox');
    expect(result.args).toContain('137+140');
    expect(result.statusMessages).toContain('📹 Using formats: video=137, audio=140');
  });

  it('places optional flags before the URL separator, not after it', () => {
    const url = 'https://example.com/video';
    const result = buildYtdlpArgs({
      normalizedDownloadDir: '/tmp/downloads',
      url,
      settings: createSettings({
        hookBrowser: true,
        browserChoice: 'Firefox',
        writeSubtitles: true,
        embedThumbnail: true,
        embedMetadata: true,
        sponsorblockRemove: true,
      }),
      options: {
        url,
        outputPath: '/tmp/downloads',
        videoFormat: '271',
        audioFormat: '251',
      },
      ffmpegLocation: '/Applications/Rosi.app/Contents/Resources/ffmpeg',
      pathOutputFile: '/tmp/rosi-path.txt',
    });

    const separatorIndex = result.args.indexOf('--');
    expect(separatorIndex).toBeGreaterThan(-1);
    expect(result.args[separatorIndex + 1]).toBe(url);
    expect(result.args[result.args.length - 1]).toBe(url);

    for (const flag of [
      '--print-to-file',
      '--ffmpeg-location',
      '--cookies-from-browser',
      '--write-subs',
      '--embed-thumbnail',
      '--embed-metadata',
      '--sponsorblock-remove',
    ]) {
      expect(result.args.indexOf(flag)).toBeGreaterThan(-1);
      expect(result.args.indexOf(flag)).toBeLessThan(separatorIndex);
    }
    expect(result.args[result.args.indexOf('--ffmpeg-location') + 1]).toBe(
      '/Applications/Rosi.app/Contents/Resources/ffmpeg'
    );
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

  it('adds enhancement flags when enabled', () => {
    const result = buildYtdlpArgs({
      normalizedDownloadDir: '/tmp/downloads',
      url: 'https://example.com/video',
      settings: createSettings({
        writeSubtitles: true,
        subtitleLangs: 'en,es',
        embedThumbnail: true,
        embedMetadata: true,
        sponsorblockRemove: true,
      }),
      options: { url: 'https://example.com/video', outputPath: '/tmp/downloads' },
      ffmpegLocation: null,
    });

    expect(result.args).toContain('--write-subs');
    expect(result.args).toContain('--embed-subs');
    expect(result.args).toContain('--sub-langs');
    expect(result.args).toContain('en,es');
    expect(result.args).toContain('--embed-thumbnail');
    expect(result.args).toContain('--embed-metadata');
    expect(result.args).toContain('--sponsorblock-remove');
    expect(result.args).toContain('default');
    expect(result.args[result.args.length - 1]).toBe('https://example.com/video');
  });

  it('omits enhancement flags when disabled', () => {
    const result = buildYtdlpArgs({
      normalizedDownloadDir: '/tmp/downloads',
      url: 'https://example.com/video',
      settings: createSettings(),
      options: { url: 'https://example.com/video', outputPath: '/tmp/downloads' },
      ffmpegLocation: null,
    });

    expect(result.args).not.toContain('--write-subs');
    expect(result.args).not.toContain('--embed-thumbnail');
    expect(result.args).not.toContain('--embed-metadata');
    expect(result.args).not.toContain('--sponsorblock-remove');
  });

  it('falls back to en for malformed subtitle languages', () => {
    const result = buildYtdlpArgs({
      normalizedDownloadDir: '/tmp/downloads',
      url: 'https://example.com/video',
      settings: createSettings({ writeSubtitles: true, subtitleLangs: 'en; rm -rf /' }),
      options: { url: 'https://example.com/video', outputPath: '/tmp/downloads' },
      ffmpegLocation: null,
    });

    const idx = result.args.indexOf('--sub-langs');
    expect(idx).toBeGreaterThan(-1);
    expect(result.args[idx + 1]).toBe('en');
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
