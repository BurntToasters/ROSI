import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/rosi-tests',
  },
  dialog: {
    showErrorBox: vi.fn(),
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
      audioOnly: true,
      convertFormat: 'mp3',
      updateChannel: 'beta',
      gpuType: 'nvidia',
      settingsVersion: 0,
    });

    expect(migrated.showConsoleOutput).toBe(true);
    expect(migrated.audioOnly).toBe(true);
    expect(migrated.convertFormat).toBe('mp3');
    expect(migrated.updateChannel).toBe('beta');
    expect(migrated.gpuType).toBe('nvidia');
    expect(migrated.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
  });

  it('falls back on invalid enum fields', () => {
    const defaults = getDefaultSettings();
    const migrated = migrateSettings({
      updateChannel: 'nightly',
      gpuType: 'unknown',
    });

    expect(migrated.updateChannel).toBe(defaults.updateChannel);
    expect(migrated.gpuType).toBe(defaults.gpuType);
  });
});
