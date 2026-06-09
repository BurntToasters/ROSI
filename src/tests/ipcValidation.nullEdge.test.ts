import { describe, it, expect } from 'vitest';
import {
  validateDownloadRequestPayload,
  validateNotificationPayload,
  validateSettingsPatchPayload,
  validateFileLocationPayload,
  validateExternalUrlPayload,
} from '../utils/ipcValidation';

describe('ipc validation null and edge-case handling', () => {
  const validBase = {
    url: 'https://example.com/video',
    outputPath: '/tmp/downloads',
  };

  describe('validateDownloadRequestPayload null inputs', () => {
    it('rejects null convertFormat', () => {
      const result = validateDownloadRequestPayload({
        ...validBase,
        convertFormat: null,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('convertFormat must be a string');
      }
    });

    it('rejects null videoFormat', () => {
      const result = validateDownloadRequestPayload({
        ...validBase,
        videoFormat: null,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('videoFormat must be a string');
      }
    });

    it('rejects null audioFormat', () => {
      const result = validateDownloadRequestPayload({
        ...validBase,
        audioFormat: null,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('audioFormat must be a string');
      }
    });

    it('rejects null ffmpegPath', () => {
      const result = validateDownloadRequestPayload({
        ...validBase,
        ffmpegPath: null,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('ffmpegPath must be a string');
      }
    });

    it('rejects null keepOriginal', () => {
      const result = validateDownloadRequestPayload({
        ...validBase,
        keepOriginal: null,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('keepOriginal must be a boolean');
      }
    });

    it('accepts undefined for all optional fields', () => {
      const result = validateDownloadRequestPayload({
        ...validBase,
        convertFormat: undefined,
        videoFormat: undefined,
        audioFormat: undefined,
        ffmpegPath: undefined,
        keepOriginal: undefined,
      });
      expect(result.ok).toBe(true);
    });

    it('accepts omitted optional fields', () => {
      const result = validateDownloadRequestPayload(validBase);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.convertFormat).toBeUndefined();
        expect(result.data.videoFormat).toBeUndefined();
        expect(result.data.audioFormat).toBeUndefined();
        expect(result.data.ffmpegPath).toBeUndefined();
        expect(result.data.keepOriginal).toBeUndefined();
      }
    });

    it('rejects numeric types for string fields', () => {
      expect(validateDownloadRequestPayload({ ...validBase, convertFormat: 42 }).ok).toBe(false);
      expect(validateDownloadRequestPayload({ ...validBase, videoFormat: 137 }).ok).toBe(false);
      expect(validateDownloadRequestPayload({ ...validBase, audioFormat: 140 }).ok).toBe(false);
      expect(validateDownloadRequestPayload({ ...validBase, ffmpegPath: 0 }).ok).toBe(false);
    });

    it('rejects boolean types for string fields', () => {
      expect(validateDownloadRequestPayload({ ...validBase, convertFormat: true }).ok).toBe(false);
      expect(validateDownloadRequestPayload({ ...validBase, videoFormat: false }).ok).toBe(false);
    });

    it('rejects array types for any field', () => {
      expect(validateDownloadRequestPayload({ ...validBase, convertFormat: [] }).ok).toBe(false);
      expect(validateDownloadRequestPayload({ ...validBase, keepOriginal: [] }).ok).toBe(false);
    });

    it('rejects empty string convertFormat after trim', () => {
      const result = validateDownloadRequestPayload({
        ...validBase,
        convertFormat: '   ',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.convertFormat).toBeUndefined();
      }
    });

    it('rejects non-allowed convertFormat values', () => {
      const result = validateDownloadRequestPayload({
        ...validBase,
        convertFormat: 'avi',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('convertFormat must be one of');
      }
    });

    it('accepts non-numeric yt-dlp format IDs', () => {
      expect(validateDownloadRequestPayload({ ...validBase, videoFormat: 'hls-1080' }).ok).toBe(
        true
      );
      expect(validateDownloadRequestPayload({ ...validBase, videoFormat: '136-drc' }).ok).toBe(
        true
      );
      expect(validateDownloadRequestPayload({ ...validBase, audioFormat: 'sb0' }).ok).toBe(true);
    });

    it('rejects format IDs containing whitespace or shell metacharacters', () => {
      const bad = validateDownloadRequestPayload({ ...validBase, videoFormat: '137; rm -rf /' });
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(bad.error.message).toContain('videoFormat must be a valid yt-dlp format ID');
      }
      expect(validateDownloadRequestPayload({ ...validBase, audioFormat: 'best audio' }).ok).toBe(
        false
      );
    });

    it('rejects non-http URL schemes', () => {
      expect(
        validateDownloadRequestPayload({
          url: 'ftp://example.com/video',
          outputPath: '/tmp',
        }).ok
      ).toBe(false);
    });

    it('rejects non-object payloads', () => {
      expect(validateDownloadRequestPayload(undefined).ok).toBe(false);
      expect(validateDownloadRequestPayload('string').ok).toBe(false);
      expect(validateDownloadRequestPayload(42).ok).toBe(false);
      expect(validateDownloadRequestPayload([]).ok).toBe(false);
      expect(validateDownloadRequestPayload(true).ok).toBe(false);
    });
  });

  describe('validateNotificationPayload null inputs', () => {
    it('rejects null title', () => {
      const result = validateNotificationPayload({ title: null });
      expect(result.ok).toBe(false);
    });

    it('rejects null body', () => {
      const result = validateNotificationPayload({ body: null });
      expect(result.ok).toBe(false);
    });

    it('rejects null filePath', () => {
      const result = validateNotificationPayload({ filePath: null });
      expect(result.ok).toBe(false);
    });

    it('accepts empty object', () => {
      const result = validateNotificationPayload({});
      expect(result.ok).toBe(true);
    });

    it('rejects oversized title', () => {
      const result = validateNotificationPayload({ title: 'x'.repeat(257) });
      expect(result.ok).toBe(false);
    });

    it('rejects oversized body', () => {
      const result = validateNotificationPayload({ body: 'x'.repeat(1025) });
      expect(result.ok).toBe(false);
    });

    it('rejects oversized filePath', () => {
      const result = validateNotificationPayload({ filePath: '/'.concat('x'.repeat(4097)) });
      expect(result.ok).toBe(false);
    });
  });

  describe('validateSettingsPatchPayload null inputs', () => {
    it('rejects null boolean fields', () => {
      expect(validateSettingsPatchPayload({ showConsoleOutput: null }).ok).toBe(false);
      expect(validateSettingsPatchPayload({ audioOnly: null }).ok).toBe(false);
      expect(validateSettingsPatchPayload({ convertEnabled: null }).ok).toBe(false);
      expect(validateSettingsPatchPayload({ gpuAcceleration: null }).ok).toBe(false);
    });

    it('rejects null enum fields', () => {
      expect(validateSettingsPatchPayload({ theme: null }).ok).toBe(false);
      expect(validateSettingsPatchPayload({ gpuType: null }).ok).toBe(false);
      expect(validateSettingsPatchPayload({ updateChannel: null }).ok).toBe(false);
      expect(validateSettingsPatchPayload({ audioFormat: null }).ok).toBe(false);
    });

    it('rejects null string fields', () => {
      expect(validateSettingsPatchPayload({ browserChoice: null }).ok).toBe(false);
      expect(validateSettingsPatchPayload({ ffmpegPath: null }).ok).toBe(false);
    });

    it('rejects oversized string values', () => {
      const result = validateSettingsPatchPayload({
        browserChoice: 'x'.repeat(1025),
      });
      expect(result.ok).toBe(false);
    });

    it('ignores unknown keys', () => {
      const result = validateSettingsPatchPayload({ notARealKey: 'value' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Object.keys(result.data)).toHaveLength(0);
      }
    });

    it('validates settingsVersion bounds', () => {
      expect(validateSettingsPatchPayload({ settingsVersion: 0 }).ok).toBe(false);
      expect(validateSettingsPatchPayload({ settingsVersion: 999 }).ok).toBe(false);
      expect(validateSettingsPatchPayload({ settingsVersion: 1.5 }).ok).toBe(false);
      expect(validateSettingsPatchPayload({ settingsVersion: 'one' }).ok).toBe(false);
    });
  });

  describe('validateFileLocationPayload edge cases', () => {
    it('rejects null', () => {
      expect(validateFileLocationPayload(null).ok).toBe(false);
    });

    it('rejects undefined', () => {
      expect(validateFileLocationPayload(undefined).ok).toBe(false);
    });

    it('rejects relative paths', () => {
      expect(validateFileLocationPayload('relative/path.mp4').ok).toBe(false);
    });

    it('rejects paths over 4096 characters', () => {
      expect(validateFileLocationPayload('/' + 'x'.repeat(4096)).ok).toBe(false);
    });

    it('accepts Windows absolute paths', () => {
      const result = validateFileLocationPayload('C:\\Users\\test\\file.mp4');
      expect(result.ok).toBe(true);
    });

    it('accepts Unix absolute paths', () => {
      const result = validateFileLocationPayload('/home/user/file.mp4');
      expect(result.ok).toBe(true);
    });
  });

  describe('validateExternalUrlPayload edge cases', () => {
    it('rejects null', () => {
      expect(validateExternalUrlPayload(null).ok).toBe(false);
    });

    it('rejects undefined', () => {
      expect(validateExternalUrlPayload(undefined).ok).toBe(false);
    });

    it('rejects numbers', () => {
      expect(validateExternalUrlPayload(42).ok).toBe(false);
    });

    it('rejects javascript: protocol', () => {
      expect(validateExternalUrlPayload('javascript:alert(1)').ok).toBe(false);
    });

    it('rejects data: protocol', () => {
      expect(validateExternalUrlPayload('data:text/html,<h1>hi</h1>').ok).toBe(false);
    });
  });
});
