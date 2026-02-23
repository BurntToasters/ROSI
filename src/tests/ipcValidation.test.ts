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
    const result = validateDownloadRequestPayload({
      url: '  https://example.com/video  ',
      outputPath: '  /tmp  ',
      ffmpegPath: '  /usr/bin/ffmpeg  ',
      convertFormat: '  mp4  ',
      keepOriginal: true,
      videoFormat: '  137  ',
      audioFormat: '  140  ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.url).toBe('https://example.com/video');
    expect(result.data.outputPath).toBe('/tmp');
    expect(result.data.ffmpegPath).toBe('/usr/bin/ffmpeg');
    expect(result.data.convertFormat).toBe('mp4');
    expect(result.data.videoFormat).toBe('137');
    expect(result.data.audioFormat).toBe('140');
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
      showConsoleOutput: true,
      browserChoice: 'Firefox',
      updateChannel: 'stable',
      gpuType: 'intel',
      unknownField: 'ignored',
    });
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.data.settingsVersion).toBe(1);
    expect(valid.data.browserChoice).toBe('Firefox');
    expect(Object.keys(valid.data)).not.toContain('unknownField');

    expect(validateSettingsPatchPayload({ settingsVersion: 0 }).ok).toBe(false);
    expect(validateSettingsPatchPayload({ audioOnly: 'true' }).ok).toBe(false);
    expect(validateSettingsPatchPayload({ browserChoice: 123 }).ok).toBe(false);

    const invalid = validateSettingsPatchPayload({
      updateChannel: 'nightly',
    });
    expect(invalid.ok).toBe(false);
  });

  it('validates external URL and file path payloads', () => {
    expect(validateExternalUrlPayload('  https://example.com  ').ok).toBe(true);
    expect(validateExternalUrlPayload(42).ok).toBe(false);
    expect(validateExternalUrlPayload('file:///tmp').ok).toBe(false);

    const filePath = validateFileLocationPayload('  /tmp/file.mp4  ');
    expect(filePath.ok).toBe(true);
    if (filePath.ok) expect(filePath.data).toBe('/tmp/file.mp4');
    expect(validateFileLocationPayload('').ok).toBe(false);
  });

  it('validates notification payload shape', () => {
    const valid = validateNotificationPayload({
      title: ' Done ',
      body: ' Finished ',
      filePath: ' /tmp/out.mp4 ',
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.data).toEqual({
        title: 'Done',
        body: 'Finished',
        filePath: '/tmp/out.mp4',
      });
    }

    expect(validateNotificationPayload('oops').ok).toBe(false);
    expect(validateNotificationPayload({ title: 42 }).ok).toBe(false);
  });
});
