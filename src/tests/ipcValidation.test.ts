import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
  errorResult,
  okResult,
  validateDownloadRequestPayload,
  validateExternalUrlPayload,
  validateFileLocationPayload,
  validateNotificationPayload,
  validateSettingsPatchPayload,
} from '../utils/ipcValidation';

function pathOutsideAllowedDownloadBases(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Temp', 'rosi-outside-test');
  }
  return '/tmp/rosi-outside-test';
}

describe('ipc validation helpers', () => {
  it('builds typed ok and error result wrappers', () => {
    expect(okResult({ started: true })).toEqual({
      ok: true,
      data: { started: true },
    });

    expect(errorResult('VALIDATION_ERROR', 'bad payload', 'details')).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'bad payload',
        details: 'details',
      },
    });
  });

  it('accepts valid download requests', () => {
    const outputPath = path.join(os.homedir(), 'Downloads');
    const result = validateDownloadRequestPayload({
      url: '  https://example.com/video  ',
      outputPath: `  ${outputPath}  `,
      ffmpegPath: 'ffmpeg',
      convertFormat: '  mp4  ',
      keepOriginal: true,
      videoFormat: '  137  ',
      audioFormat: '  140  ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.url).toBe('https://example.com/video');
    expect(result.data.outputPath).toBe(outputPath);
    expect(result.data.ffmpegPath).toBe('ffmpeg');
    expect(result.data.convertFormat).toBe('mp4');
    expect(result.data.videoFormat).toBe('137');
    expect(result.data.audioFormat).toBe('140');
  });

  it('rejects outputPath outside the user home directory', () => {
    const result = validateDownloadRequestPayload({
      url: 'https://example.com',
      outputPath: pathOutsideAllowedDownloadBases(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('within your home directory');
    }
  });

  it('rejects invalid ffmpegPath values in download requests', () => {
    expect(
      validateDownloadRequestPayload({
        url: 'https://example.com',
        outputPath: path.join(os.homedir(), 'Downloads'),
        ffmpegPath: 'relative/ffmpeg',
      }).ok
    ).toBe(false);
    expect(
      validateDownloadRequestPayload({
        url: 'https://example.com',
        outputPath: path.join(os.homedir(), 'Downloads'),
        ffmpegPath: path.join(os.homedir(), 'bin', 'ffprobe'),
      }).ok
    ).toBe(false);
    expect(
      validateDownloadRequestPayload({
        url: 'https://example.com',
        outputPath: path.join(os.homedir(), 'Downloads'),
        ffmpegPath: path.join(os.homedir(), 'missing-ffmpeg-dir', 'ffmpeg'),
      }).ok
    ).toBe(false);
  });

  it('accepts ffmpeg sentinel and empty ffmpegPath in download requests', () => {
    const homeDownloads = path.join(os.homedir(), 'Downloads');
    const sentinel = validateDownloadRequestPayload({
      url: 'https://example.com',
      outputPath: homeDownloads,
      ffmpegPath: 'ffmpeg',
    });
    expect(sentinel.ok).toBe(true);
    if (sentinel.ok) expect(sentinel.data.ffmpegPath).toBe('ffmpeg');

    const empty = validateDownloadRequestPayload({
      url: 'https://example.com',
      outputPath: homeDownloads,
      ffmpegPath: '   ',
    });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.data.ffmpegPath).toBeUndefined();
  });

  it('rejects malformed download request payloads by field', () => {
    expect(validateDownloadRequestPayload(null).ok).toBe(false);
    expect(
      validateDownloadRequestPayload({
        url: 'javascript:alert(1)',
        outputPath: '/tmp',
      }).ok
    ).toBe(false);
    expect(
      validateDownloadRequestPayload({
        url: 'https://example.com',
        outputPath: '',
      }).ok
    ).toBe(false);
    expect(
      validateDownloadRequestPayload({
        url: 'https://example.com',
        outputPath: '/tmp',
        ffmpegPath: 42,
      }).ok
    ).toBe(false);
    expect(
      validateDownloadRequestPayload({
        url: 'https://example.com',
        outputPath: '/tmp',
        convertFormat: 42,
      }).ok
    ).toBe(false);
    expect(
      validateDownloadRequestPayload({
        url: 'https://example.com',
        outputPath: '/tmp',
        convertFormat: '../../bad',
      }).ok
    ).toBe(false);
    expect(
      validateDownloadRequestPayload({
        url: 'https://example.com',
        outputPath: '/tmp',
        keepOriginal: 'yes',
      }).ok
    ).toBe(false);
    expect(
      validateDownloadRequestPayload({
        url: 'https://example.com',
        outputPath: '/tmp',
        videoFormat: 137,
      }).ok
    ).toBe(false);
    expect(
      validateDownloadRequestPayload({
        url: 'https://example.com',
        outputPath: '/tmp',
        audioFormat: 140,
      }).ok
    ).toBe(false);
  });

  it('validates settings patch payloads', () => {
    expect(validateSettingsPatchPayload('bad').ok).toBe(false);

    const valid = validateSettingsPatchPayload({
      settingsVersion: 1,
      theme: 'system',
      showConsoleOutput: true,
      flatUi: true,
      browserChoice: 'firefox',
      updateChannel: 'stable',
      gpuType: 'intel',
      unknownField: 'ignored',
    });
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.data.settingsVersion).toBe(1);
    expect(valid.data.theme).toBe('system');
    expect(valid.data.flatUi).toBe(true);
    expect(valid.data.browserChoice).toBe('firefox');
    expect(Object.keys(valid.data)).not.toContain('unknownField');

    expect(validateSettingsPatchPayload({ settingsVersion: 0 }).ok).toBe(false);
    expect(validateSettingsPatchPayload({ theme: 'night' }).ok).toBe(false);
    expect(validateSettingsPatchPayload({ audioOnly: 'true' }).ok).toBe(false);
    expect(validateSettingsPatchPayload({ flatUi: 'true' }).ok).toBe(false);
    expect(validateSettingsPatchPayload({ browserChoice: 123 }).ok).toBe(false);
    expect(validateSettingsPatchPayload({ browserChoice: 'curl' }).ok).toBe(false);
    expect(validateSettingsPatchPayload({ convertFormat: '../../bad' }).ok).toBe(false);

    const normalizedBrowser = validateSettingsPatchPayload({ browserChoice: 'Firefox' });
    expect(normalizedBrowser.ok).toBe(true);
    if (normalizedBrowser.ok) expect(normalizedBrowser.data.browserChoice).toBe('firefox');

    const invalid = validateSettingsPatchPayload({
      updateChannel: 'nightly',
    });
    expect(invalid.ok).toBe(false);
  });

  it('validates audioFormat in settings patch payload', () => {
    const valid = validateSettingsPatchPayload({ audioFormat: 'flac' });
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.data.audioFormat).toBe('flac');

    expect(validateSettingsPatchPayload({ audioFormat: 'invalid' }).ok).toBe(false);
    expect(validateSettingsPatchPayload({ audioFormat: 42 }).ok).toBe(false);
  });

  it('validates enhancement settings in patch payload', () => {
    const valid = validateSettingsPatchPayload({
      writeSubtitles: true,
      subtitleLangs: 'en,es,fr',
      embedThumbnail: true,
      embedMetadata: true,
      sponsorblockRemove: true,
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.data.subtitleLangs).toBe('en,es,fr');
      expect(valid.data.embedThumbnail).toBe(true);
    }

    expect(validateSettingsPatchPayload({ subtitleLangs: 'en; rm -rf /' }).ok).toBe(false);
    expect(validateSettingsPatchPayload({ subtitleLangs: 42 }).ok).toBe(false);
    expect(validateSettingsPatchPayload({ embedThumbnail: 'yes' }).ok).toBe(false);
  });

  it('validates external URL and file path payloads', () => {
    expect(validateExternalUrlPayload('  https://example.com  ').ok).toBe(true);
    expect(validateExternalUrlPayload(42).ok).toBe(false);
    expect(validateExternalUrlPayload('file:///tmp').ok).toBe(false);

    const allowedFile = path.join(os.homedir(), 'file.mp4');
    const filePath = validateFileLocationPayload(`  ${allowedFile}  `);
    expect(filePath.ok).toBe(true);
    if (filePath.ok) expect(filePath.data).toBe(path.resolve(allowedFile));
    expect(validateFileLocationPayload('').ok).toBe(false);
  });

  it('validates downloadFolder in settings patch payload', () => {
    const homeFolder = path.join(os.homedir(), 'Downloads', 'rosi');
    const valid = validateSettingsPatchPayload({ downloadFolder: `  ${homeFolder}  ` });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.data.downloadFolder).toBe(path.resolve(homeFolder));
    }

    const empty = validateSettingsPatchPayload({ downloadFolder: '   ' });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.data.downloadFolder).toBe('');

    expect(validateSettingsPatchPayload({ downloadFolder: null }).ok).toBe(false);
    expect(validateSettingsPatchPayload({ downloadFolder: 42 }).ok).toBe(false);
    expect(validateSettingsPatchPayload({ downloadFolder: 'relative/path' }).ok).toBe(false);
    expect(
      validateSettingsPatchPayload({ downloadFolder: pathOutsideAllowedDownloadBases() }).ok
    ).toBe(false);
    expect(validateSettingsPatchPayload({ downloadFolder: 'x'.repeat(4097) }).ok).toBe(false);
  });

  it('validates notification payload shape', () => {
    const notificationFile = path.join(os.homedir(), 'out.mp4');
    const valid = validateNotificationPayload({
      title: ' Done ',
      body: ' Finished ',
      filePath: ` ${notificationFile} `,
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.data).toEqual({
        title: 'Done',
        body: 'Finished',
        filePath: path.resolve(notificationFile),
      });
    }

    expect(validateNotificationPayload('oops').ok).toBe(false);
    expect(validateNotificationPayload({ title: 42 }).ok).toBe(false);
  });
});
