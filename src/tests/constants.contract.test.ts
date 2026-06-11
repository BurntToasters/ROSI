import { describe, expect, it } from 'vitest';
import {
  ALLOWED_AUDIO_FORMATS,
  ALLOWED_BROWSERS,
  ALLOWED_CONVERT_FORMATS,
  CURRENT_SETTINGS_VERSION,
  FORMAT_ID_PATTERN,
  MAX_QUEUE_SIZE,
  SUBTITLE_LANGS_PATTERN,
} from '../main/constants';

describe('constants contracts', () => {
  it('accepts valid yt-dlp format IDs', () => {
    expect(FORMAT_ID_PATTERN.test('137')).toBe(true);
    expect(FORMAT_ID_PATTERN.test('hls-1080')).toBe(true);
    expect(FORMAT_ID_PATTERN.test('136-drc')).toBe(true);
    expect(FORMAT_ID_PATTERN.test('137; rm -rf /')).toBe(false);
    expect(FORMAT_ID_PATTERN.test('best audio')).toBe(false);
  });

  it('accepts valid subtitle language lists', () => {
    expect(SUBTITLE_LANGS_PATTERN.test('en')).toBe(true);
    expect(SUBTITLE_LANGS_PATTERN.test('en,es,fr')).toBe(true);
    expect(SUBTITLE_LANGS_PATTERN.test('en.*')).toBe(true);
    expect(SUBTITLE_LANGS_PATTERN.test('en; rm -rf /')).toBe(false);
  });

  it('keeps allowed format and browser sets aligned with validation', () => {
    expect(ALLOWED_CONVERT_FORMATS.has('mp4')).toBe(true);
    expect(ALLOWED_CONVERT_FORMATS.has('avi')).toBe(false);
    expect(ALLOWED_AUDIO_FORMATS.has('m4a')).toBe(true);
    expect(ALLOWED_AUDIO_FORMATS.has('wma')).toBe(false);
    expect(ALLOWED_BROWSERS.has('firefox')).toBe(true);
    expect(ALLOWED_BROWSERS.has('internet explorer')).toBe(false);
  });

  it('keeps queue and settings version contracts stable', () => {
    expect(MAX_QUEUE_SIZE).toBe(500);
    expect(CURRENT_SETTINGS_VERSION).toBeGreaterThanOrEqual(1);
  });
});
