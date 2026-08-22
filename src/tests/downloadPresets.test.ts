import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/rosi-tests',
  },
  dialog: {
    showErrorBox: vi.fn(),
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
  },
}));

vi.mock('electron-log/main.js', () => ({
  default: {
    initialize: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  downloadPresetToRequestOptions,
  getDefaultSettings,
  migrateSettings,
  sanitizeDownloadPresets,
} from '../main/settings';
import { MAX_DOWNLOAD_PRESETS, MAX_PRESET_NAME_LENGTH } from '../main/constants';
import {
  validatePlaylistSelectionPayload,
  validateSettingsPatchPayload,
} from '../utils/ipcValidation';

describe('download preset sanitization', () => {
  it('defaults to an empty preset list', () => {
    expect(getDefaultSettings().downloadPresets).toEqual([]);
    expect(sanitizeDownloadPresets(undefined)).toEqual([]);
    expect(sanitizeDownloadPresets('nope')).toEqual([]);
    expect(sanitizeDownloadPresets([null, 42, 'x'])).toEqual([]);
  });

  it('keeps only known fields and generates safe ids', () => {
    const presets = sanitizeDownloadPresets([
      {
        name: '  My Best Setup  ',
        profile: 'best-video',
        convertEnabled: true,
        convertFormat: 'mp4',
        gpuType: 'nvidia',
        subtitleLangs: 'en,es',
        videoFormat: '299',
        audioFormatId: '140',
        playlist: { mode: 'range', start: 2, end: 5 },
        rmDashArgs: '--exec rm -rf /',
      },
    ]);

    expect(presets).toHaveLength(1);
    const preset = presets[0]!;
    expect(preset.name).toBe('My Best Setup');
    expect(preset.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
    expect(preset.playlist).toEqual({ mode: 'range', start: 2, end: 5 });
    expect(preset).not.toHaveProperty('rmDashArgs');
  });

  it('drops invalid enum, format, and playlist values', () => {
    const presets = sanitizeDownloadPresets([
      {
        name: 'Sketchy',
        profile: 'not-a-profile',
        audioFormat: 'exe',
        convertFormat: 'mkv',
        gpuType: 'quantum',
        subtitleLangs: 'en;rm -rf',
        videoFormat: 'bad id!',
        playlist: { mode: 'range', start: 9, end: 2 },
      },
    ]);

    const preset = presets[0]!;
    expect(preset.profile).toBe('best-video');
    expect(preset.audioFormat).toBeUndefined();
    expect(preset.convertFormat).toBeUndefined();
    expect(preset.gpuType).toBeUndefined();
    expect(preset.subtitleLangs).toBeUndefined();
    expect(preset.videoFormat).toBeUndefined();
    expect(preset.playlist).toBeUndefined();
  });

  it('deduplicates names and ids, and caps the preset count', () => {
    const presets = sanitizeDownloadPresets([
      { id: 'dup', name: 'Same', profile: 'audio' },
      { id: 'dup', name: 'Same', profile: 'audio' },
    ]);
    expect(presets).toHaveLength(2);
    expect(presets[0]!.id).not.toBe(presets[1]!.id);
    expect(presets[0]!.name).not.toBe(presets[1]!.name);

    const many = sanitizeDownloadPresets(
      Array.from({ length: MAX_DOWNLOAD_PRESETS + 5 }, (_, index) => ({
        name: `Preset ${index}`,
        profile: 'best-video',
      }))
    );
    expect(many).toHaveLength(MAX_DOWNLOAD_PRESETS);
  });

  it('truncates overly long names', () => {
    const presets = sanitizeDownloadPresets([{ name: 'x'.repeat(200), profile: 'custom' }]);
    expect(presets[0]!.name.length).toBeLessThanOrEqual(MAX_PRESET_NAME_LENGTH);
  });

  it('migrates presets through the settings schema', () => {
    const migrated = migrateSettings({
      downloadPresets: [{ name: 'Audio only', profile: 'audio', audioFormat: 'flac' }],
    });
    expect(migrated.downloadPresets).toHaveLength(1);
    expect(migrated.downloadPresets[0]!.audioFormat).toBe('flac');
  });

  it('maps a preset onto safe request options', () => {
    const options = downloadPresetToRequestOptions({
      id: 'p1',
      name: 'Audio',
      profile: 'audio',
      audioFormat: 'mp3',
      writeSubtitles: true,
      subtitleLangs: 'en',
      playlist: { mode: 'all' },
    });

    expect(options).toMatchObject({
      profileEnabled: true,
      profile: 'audio',
      presetId: 'p1',
      presetName: 'Audio',
      audioOnly: true,
      audioOutputFormat: 'mp3',
      writeSubtitles: true,
      playlist: { mode: 'all' },
    });
    expect(Object.values(options).every((value) => value !== undefined)).toBe(true);
  });
});

describe('playlist selection validation', () => {
  it('accepts current and all without bounds', () => {
    expect(validatePlaylistSelectionPayload({ mode: 'current' })).toEqual({
      ok: true,
      data: { mode: 'current' },
    });
    expect(validatePlaylistSelectionPayload({ mode: 'all' })).toEqual({
      ok: true,
      data: { mode: 'all' },
    });
  });

  it('accepts a valid 1-based range', () => {
    expect(validatePlaylistSelectionPayload({ mode: 'range', start: 3, end: 7 })).toEqual({
      ok: true,
      data: { mode: 'range', start: 3, end: 7 },
    });
  });

  it('rejects malformed payloads and bad bounds', () => {
    for (const payload of [
      null,
      'range',
      { mode: 'nope' },
      { mode: 'all', start: 1 },
      { mode: 'range' },
      { mode: 'range', start: 0, end: 4 },
      { mode: 'range', start: 5, end: 2 },
      { mode: 'range', start: 1.5, end: 4 },
      { mode: 'range', start: 1, end: 99_999 },
    ]) {
      expect(validatePlaylistSelectionPayload(payload).ok).toBe(false);
    }
  });
});

describe('settings patch validation for presets', () => {
  it('accepts a well-formed preset list', () => {
    const result = validateSettingsPatchPayload({
      downloadPresets: [{ id: 'p1', name: 'Best', profile: 'best-video', convertFormat: 'mp4' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.downloadPresets).toHaveLength(1);
  });

  it('rejects invalid preset payloads', () => {
    for (const presets of [
      'nope',
      [null],
      [{ id: 'bad id', name: 'A', profile: 'best-video' }],
      [{ id: 'p1', name: '', profile: 'best-video' }],
      [{ id: 'p1', name: 'A', profile: 'invalid' }],
      [{ id: 'p1', name: 'A', profile: 'audio', audioFormat: 'exe' }],
      [{ id: 'p1', name: 'A', profile: 'audio', convertFormat: 'mkv' }],
      [{ id: 'p1', name: 'A', profile: 'audio', gpuType: 'quantum' }],
      [{ id: 'p1', name: 'A', profile: 'audio', subtitleLangs: 'en;bad' }],
      [{ id: 'p1', name: 'A', profile: 'audio', videoFormat: 'no spaces!' }],
      [{ id: 'p1', name: 'A', profile: 'audio', convertEnabled: 'yes' }],
      [{ id: 'p1', name: 'A', profile: 'audio', playlist: { mode: 'range', start: 4, end: 1 } }],
      [
        { id: 'p1', name: 'Same', profile: 'audio' },
        { id: 'p2', name: 'same', profile: 'audio' },
      ],
      [
        { id: 'p1', name: 'One', profile: 'audio' },
        { id: 'p1', name: 'Two', profile: 'audio' },
      ],
      Array.from({ length: MAX_DOWNLOAD_PRESETS + 1 }, (_, i) => ({
        id: `p${i}`,
        name: `P${i}`,
        profile: 'audio',
      })),
    ]) {
      expect(validateSettingsPatchPayload({ downloadPresets: presets }).ok).toBe(false);
    }
  });
});
