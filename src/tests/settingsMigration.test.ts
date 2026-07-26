import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/rosi-tests',
  },
  dialog: {
    showErrorBox: vi.fn(),
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

import { CURRENT_SETTINGS_VERSION, getDefaultSettings, migrateSettings } from '../main/settings';

describe('settings migration', () => {
  it('returns defaults for invalid payloads', () => {
    expect(migrateSettings(null)).toEqual(getDefaultSettings());
    expect(migrateSettings('invalid')).toEqual(getDefaultSettings());
    expect(migrateSettings([])).toEqual(getDefaultSettings());
  });

  it('migrates legacy settings and enforces schema defaults', () => {
    const migrated = migrateSettings({
      showConsoleOutput: true,
      theme: 'purple',
      audioOnly: true,
      convertFormat: 'mp3',
      updateChannel: 'beta',
      gpuType: 'nvidia',
      flatUi: true,
      settingsVersion: 0,
    });

    expect(migrated.showConsoleOutput).toBe(true);
    expect(migrated.theme).toBe('purple');
    expect(migrated.downloadProfilesEnabled).toBe(false);
    expect(migrated.downloadMode).toBe('audio');
    expect(migrated.audioOnly).toBe(false);
    expect(migrated.convertFormat).toBe('mp3');
    expect(migrated.updateChannel).toBe('beta');
    expect(migrated.gpuType).toBe('nvidia');
    expect(migrated.flatUi).toBe(true);
    expect(migrated.showTaskbarProgress).toBe(true);
    expect(migrated.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
  });

  it('adds flat UI with a default value during migration', () => {
    const migrated = migrateSettings({ settingsVersion: 2 });

    expect(migrated.flatUi).toBe(false);
    expect(migrated.queueCollapsed).toBe(false);
  });

  it('falls back on invalid enum fields', () => {
    const defaults = getDefaultSettings();
    const migrated = migrateSettings({
      theme: 'sunset',
      updateChannel: 'nightly',
      gpuType: 'unknown',
    });

    expect(migrated.theme).toBe(defaults.theme);
    expect(migrated.updateChannel).toBe(defaults.updateChannel);
    expect(migrated.gpuType).toBe(defaults.gpuType);
  });

  it('adds audioFormat with default value during migration', () => {
    const migrated = migrateSettings({
      settingsVersion: 1,
      audioOnly: true,
    });

    expect(migrated.audioFormat).toBe('mp3');
    expect(migrated.settingsVersion).toBe(1);
  });

  it('adds enhancement settings with defaults during migration', () => {
    const migrated = migrateSettings({ settingsVersion: 2 });

    expect(migrated.writeSubtitles).toBe(false);
    expect(migrated.subtitleLangs).toBe('en');
    expect(migrated.embedThumbnail).toBe(false);
    expect(migrated.embedMetadata).toBe(false);
    expect(migrated.sponsorblockRemove).toBe(false);
  });

  it('keeps profiles opt-in and activates their mapped flags only when enabled', () => {
    const disabled = migrateSettings({ audioOnly: true });
    expect(disabled.downloadProfilesEnabled).toBe(false);
    expect(disabled.downloadMode).toBe('audio');
    expect(disabled.audioOnly).toBe(false);

    const enabled = migrateSettings({
      downloadProfilesEnabled: true,
      downloadMode: 'custom',
    });
    expect(enabled.advancedOptions).toBe(true);
    expect(enabled.audioOnly).toBe(false);
    expect(enabled.bestQuality).toBe(false);
  });

  it('preserves valid enhancement settings and rejects malformed subtitle langs', () => {
    const migrated = migrateSettings({
      writeSubtitles: true,
      subtitleLangs: 'en,es',
      embedThumbnail: true,
    });
    expect(migrated.writeSubtitles).toBe(true);
    expect(migrated.subtitleLangs).toBe('en,es');
    expect(migrated.embedThumbnail).toBe(true);

    const bad = migrateSettings({ subtitleLangs: 'en; rm -rf /' });
    expect(bad.subtitleLangs).toBe('en');
  });
});
