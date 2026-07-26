import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/rosi-upgrade-tests' },
  dialog: { showErrorBox: vi.fn() },
}));

vi.mock('electron-log/main.js', () => ({
  default: { initialize: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CURRENT_SETTINGS_VERSION, migrateSettings } from '../main/settings';

// A realistic schema v6 (4.3.0-beta.1) settings payload, to prove that an
// in-place upgrade keeps every existing preference.
const v6Settings = {
  settingsVersion: 6,
  theme: 'purple',
  downloadProfilesEnabled: true,
  downloadMode: 'audio',
  audioFormat: 'flac',
  convertEnabled: true,
  convertFormat: 'mp3',
  queueCollapsed: true,
  consoleCollapsed: true,
  askDownloadLocation: true,
  showTaskbarProgress: false,
  subtitleLangs: 'en,es',
  writeSubtitles: true,
  embedMetadata: true,
  embedThumbnail: true,
  sponsorblockRemove: true,
  updateChannel: 'beta',
  firstLaunch: false,
  hideSupportModal: true,
  hookBrowser: true,
  browserChoice: 'firefox',
  gpuAcceleration: true,
  gpuType: 'nvidia',
  flatUi: true,
};

describe('settings upgrade from 4.3.0-beta.1 (schema v6)', () => {
  it('preserves every stored preference and adds an empty preset list', () => {
    const migrated = migrateSettings(v6Settings);

    // migrateSettings keeps a valid stored version as-is; loadSettings/saveSettings
    // are what normalize it up to the current schema.
    expect(migrated.settingsVersion).toBe(6);
    expect(migrated.theme).toBe('purple');
    expect(migrated.downloadProfilesEnabled).toBe(true);
    expect(migrated.downloadMode).toBe('audio');
    expect(migrated.audioOnly).toBe(true);
    expect(migrated.audioFormat).toBe('flac');
    expect(migrated.convertEnabled).toBe(true);
    expect(migrated.convertFormat).toBe('mp3');
    expect(migrated.queueCollapsed).toBe(true);
    expect(migrated.consoleCollapsed).toBe(true);
    expect(migrated.askDownloadLocation).toBe(true);
    expect(migrated.showTaskbarProgress).toBe(false);
    expect(migrated.subtitleLangs).toBe('en,es');
    expect(migrated.writeSubtitles).toBe(true);
    expect(migrated.embedMetadata).toBe(true);
    expect(migrated.embedThumbnail).toBe(true);
    expect(migrated.sponsorblockRemove).toBe(true);
    expect(migrated.updateChannel).toBe('beta');
    expect(migrated.firstLaunch).toBe(false);
    expect(migrated.hideSupportModal).toBe(true);
    expect(migrated.hookBrowser).toBe(true);
    expect(migrated.browserChoice).toBe('firefox');
    expect(migrated.gpuAcceleration).toBe(true);
    expect(migrated.gpuType).toBe('nvidia');
    expect(migrated.flatUi).toBe(true);

    // The only new key in schema v7.
    expect(migrated.downloadPresets).toEqual([]);
  });

  it('does not trust a schema version newer than this build', () => {
    const migrated = migrateSettings({ ...v6Settings, settingsVersion: 99 });
    expect(migrated.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
  });

  it('drops unknown keys rather than persisting them', () => {
    const migrated = migrateSettings({ ...v6Settings, somethingInjected: 'rm -rf /' });
    expect(migrated).not.toHaveProperty('somethingInjected');
  });
});
