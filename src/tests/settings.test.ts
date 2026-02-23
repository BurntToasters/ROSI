import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  existsSyncMock,
  readFileSyncMock,
  writeFileSyncMock,
  mkdirSyncMock,
  showErrorBoxMock,
  logErrorMock,
} = vi.hoisted(() => {
  return {
    existsSyncMock: vi.fn(),
    readFileSyncMock: vi.fn(),
    writeFileSyncMock: vi.fn(),
    mkdirSyncMock: vi.fn(),
    showErrorBoxMock: vi.fn(),
    logErrorMock: vi.fn(),
  };
});

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
  mkdirSync: mkdirSyncMock,
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/rosi-tests'),
  },
  dialog: {
    showErrorBox: showErrorBoxMock,
  },
}));

vi.mock('electron-log/main', () => ({
  default: {
    error: logErrorMock,
  },
}));

import {
  CURRENT_SETTINGS_VERSION,
  getDefaultSettings,
  loadSettings,
  saveSettings,
} from '../main/settings';

describe('settings persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockImplementation(() => true);
    readFileSyncMock.mockReturnValue(JSON.stringify(getDefaultSettings()));
  });

  it('returns default settings when settings file is missing', () => {
    existsSyncMock.mockImplementation((target: string) => !target.endsWith('settings.json'));
    const loaded = loadSettings();
    expect(loaded).toEqual(getDefaultSettings());
  });

  it('returns default settings when settings JSON is invalid', () => {
    readFileSyncMock.mockReturnValue('{');
    const loaded = loadSettings();
    expect(loaded).toEqual(getDefaultSettings());
  });

  it('normalizes loaded settings version to current version', () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        ...getDefaultSettings(),
        settingsVersion: 0,
        updateChannel: 'beta',
      })
    );

    const loaded = loadSettings();
    expect(loaded.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    expect(loaded.updateChannel).toBe('beta');
  });

  it('saves merged settings payload with normalized schema', () => {
    const result = saveSettings(
      {
        audioOnly: true,
        updateChannel: 'stable',
      },
      null
    );

    expect(result).toBe(true);
    expect(writeFileSyncMock).toHaveBeenCalledOnce();

    const [, writtenPayload] = writeFileSyncMock.mock.calls[0];
    const parsed = JSON.parse(writtenPayload);
    expect(parsed.audioOnly).toBe(true);
    expect(parsed.updateChannel).toBe('stable');
    expect(parsed.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
  });

  it('creates settings directory when missing before save', () => {
    existsSyncMock.mockImplementation((target: string) => target.endsWith('settings.json'));
    const result = saveSettings({ audioOnly: true }, null);

    expect(result).toBe(true);
    expect(mkdirSyncMock).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });

  it('returns false and shows error when write fails', () => {
    writeFileSyncMock.mockImplementation(() => {
      throw new Error('disk full');
    });
    const mainWindow = { isDestroyed: () => false } as any;
    const result = saveSettings({ audioOnly: true }, mainWindow);

    expect(result).toBe(false);
    expect(logErrorMock).toHaveBeenCalled();
    expect(showErrorBoxMock).toHaveBeenCalledWith(
      'Settings Save Error',
      expect.stringContaining('disk full')
    );
  });
});
