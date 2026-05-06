import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  existsSyncMock,
  readFileSyncMock,
  writeFileSyncMock,
  mkdirSyncMock,
  renameSyncMock,
  statSyncMock,
  showSaveDialogMock,
  showOpenDialogMock,
  showErrorBoxMock,
  logErrorMock,
  logWarnMock,
} = vi.hoisted(() => {
  return {
    existsSyncMock: vi.fn(),
    readFileSyncMock: vi.fn(),
    writeFileSyncMock: vi.fn(),
    mkdirSyncMock: vi.fn(),
    renameSyncMock: vi.fn(),
    statSyncMock: vi.fn(),
    showSaveDialogMock: vi.fn(),
    showOpenDialogMock: vi.fn(),
    showErrorBoxMock: vi.fn(),
    logErrorMock: vi.fn(),
    logWarnMock: vi.fn(),
  };
});

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
  mkdirSync: mkdirSyncMock,
  renameSync: renameSyncMock,
  statSync: statSyncMock,
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/rosi-settings-ext-test'),
  },
  dialog: {
    showSaveDialog: showSaveDialogMock,
    showOpenDialog: showOpenDialogMock,
    showErrorBox: showErrorBoxMock,
  },
}));

vi.mock('electron-log/main.js', () => ({
  default: {
    error: logErrorMock,
    warn: logWarnMock,
  },
}));

import {
  getDefaultSettings,
  loadSettings,
  saveSettings,
  loadStats,
  resetStats,
  recordDownload,
  exportSettingsToFile,
  importSettingsFromFile,
  migrateSettings,
} from '../main/settings';

describe('settings extended coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify(getDefaultSettings()));
  });

  describe('loadSettings edge cases', () => {
    it('returns defaults when JSON contains array', () => {
      readFileSyncMock.mockReturnValue('[]');
      const settings = loadSettings();
      expect(settings).toEqual(getDefaultSettings());
    });

    it('returns defaults when readFileSync throws', () => {
      readFileSyncMock.mockImplementation(() => {
        throw new Error('EACCES');
      });
      const settings = loadSettings();
      expect(settings).toEqual(getDefaultSettings());
      expect(logWarnMock).toHaveBeenCalled();
    });

    it('returns defaults for empty string JSON', () => {
      readFileSyncMock.mockReturnValue('');
      const settings = loadSettings();
      expect(settings).toEqual(getDefaultSettings());
    });

    it('handles partial settings gracefully, filling defaults', () => {
      readFileSyncMock.mockReturnValue(JSON.stringify({ theme: 'dark' }));
      const settings = loadSettings();
      expect(settings.theme).toBe('dark');
      expect(settings.audioOnly).toBe(false);
      expect(settings.convertFormat).toBe('mp4');
    });
  });

  describe('saveSettings edge cases', () => {
    it('does not show error box when mainWindow is null', () => {
      writeFileSyncMock.mockImplementation(() => {
        throw new Error('write failed');
      });
      const result = saveSettings({ audioOnly: true }, null);
      expect(result).toBe(false);
      expect(showErrorBoxMock).not.toHaveBeenCalled();
    });

    it('does not show error box when window is destroyed', () => {
      writeFileSyncMock.mockImplementation(() => {
        throw new Error('write failed');
      });
      const result = saveSettings({ audioOnly: true }, { isDestroyed: () => true } as any);
      expect(result).toBe(false);
      expect(showErrorBoxMock).not.toHaveBeenCalled();
    });
  });

  describe('migrateSettings edge cases', () => {
    it('handles null field values gracefully', () => {
      const migrated = migrateSettings({
        theme: null,
        audioOnly: null,
        convertFormat: null,
        gpuType: null,
        updateChannel: null,
        audioFormat: null,
      });
      const defaults = getDefaultSettings();
      expect(migrated.theme).toBe(defaults.theme);
      expect(migrated.audioOnly).toBe(defaults.audioOnly);
      expect(migrated.convertFormat).toBe(defaults.convertFormat);
      expect(migrated.gpuType).toBe(defaults.gpuType);
      expect(migrated.updateChannel).toBe(defaults.updateChannel);
      expect(migrated.audioFormat).toBe(defaults.audioFormat);
    });

    it('handles numeric and boolean field type mismatches', () => {
      const defaults = getDefaultSettings();
      const migrated = migrateSettings({
        theme: 42,
        audioOnly: 'yes',
        browserChoice: true,
        ffmpegPath: 123,
      });
      expect(migrated.theme).toBe(defaults.theme);
      expect(migrated.audioOnly).toBe(defaults.audioOnly);
      expect(migrated.browserChoice).toBe(defaults.browserChoice);
      expect(migrated.ffmpegPath).toBe(defaults.ffmpegPath);
    });

    it('preserves all valid convert format values', () => {
      for (const fmt of ['mp4', 'mov', 'mp3', 'm4a']) {
        const migrated = migrateSettings({ convertFormat: fmt });
        expect(migrated.convertFormat).toBe(fmt);
      }
    });

    it('preserves all valid audio format values', () => {
      for (const fmt of ['mp3', 'flac', 'ogg', 'wav', 'm4a', 'opus']) {
        const migrated = migrateSettings({ audioFormat: fmt });
        expect(migrated.audioFormat).toBe(fmt);
      }
    });

    it('preserves all valid theme values', () => {
      for (const theme of ['system', 'light', 'dark', 'purple']) {
        const migrated = migrateSettings({ theme });
        expect(migrated.theme).toBe(theme);
      }
    });

    it('preserves all valid gpuType values', () => {
      for (const gpu of ['auto', 'nvidia', 'amd', 'intel']) {
        const migrated = migrateSettings({ gpuType: gpu });
        expect(migrated.gpuType).toBe(gpu);
      }
    });
  });

  describe('loadStats', () => {
    it('returns defaults when stats file is missing', () => {
      existsSyncMock.mockImplementation((p: string) => !p.includes('stats'));
      const stats = loadStats();
      expect(stats.totalDownloads).toBe(0);
      expect(stats.formatCounts).toEqual({});
    });

    it('returns defaults for invalid stats JSON', () => {
      readFileSyncMock.mockReturnValue('{bad json}');
      const stats = loadStats();
      expect(stats.totalDownloads).toBe(0);
    });

    it('returns defaults for non-object stats', () => {
      readFileSyncMock.mockReturnValue('"just a string"');
      const stats = loadStats();
      expect(stats.totalDownloads).toBe(0);
    });

    it('loads valid partial stats with defaults for missing fields', () => {
      readFileSyncMock.mockReturnValue(
        JSON.stringify({
          totalDownloads: 42,
          successfulDownloads: 30,
        })
      );
      const stats = loadStats();
      expect(stats.totalDownloads).toBe(42);
      expect(stats.successfulDownloads).toBe(30);
      expect(stats.failedDownloads).toBe(0);
      expect(stats.cancelledDownloads).toBe(0);
    });

    it('ignores non-numeric stat fields', () => {
      readFileSyncMock.mockReturnValue(
        JSON.stringify({
          totalDownloads: 'not a number',
          successfulDownloads: true,
        })
      );
      const stats = loadStats();
      expect(stats.totalDownloads).toBe(0);
      expect(stats.successfulDownloads).toBe(0);
    });
  });

  describe('recordDownload', () => {
    it('increments success counter', () => {
      readFileSyncMock.mockReturnValue(
        JSON.stringify({
          totalDownloads: 5,
          successfulDownloads: 3,
          failedDownloads: 1,
          cancelledDownloads: 1,
          totalBytesDownloaded: 0,
          formatCounts: {},
          firstDownloadAt: 1000,
          lastDownloadAt: 2000,
        })
      );
      recordDownload('success');
      expect(writeFileSyncMock).toHaveBeenCalled();
      const written = JSON.parse(writeFileSyncMock.mock.calls[0]![1]);
      expect(written.totalDownloads).toBe(6);
      expect(written.successfulDownloads).toBe(4);
    });

    it('increments failed counter', () => {
      readFileSyncMock.mockReturnValue(
        JSON.stringify({
          totalDownloads: 0,
          successfulDownloads: 0,
          failedDownloads: 0,
          cancelledDownloads: 0,
          totalBytesDownloaded: 0,
          formatCounts: {},
          firstDownloadAt: null,
          lastDownloadAt: null,
        })
      );
      recordDownload('failed');
      const written = JSON.parse(writeFileSyncMock.mock.calls[0]![1]);
      expect(written.failedDownloads).toBe(1);
    });

    it('increments cancelled counter', () => {
      readFileSyncMock.mockReturnValue(
        JSON.stringify({
          totalDownloads: 0,
          successfulDownloads: 0,
          failedDownloads: 0,
          cancelledDownloads: 0,
          totalBytesDownloaded: 0,
          formatCounts: {},
          firstDownloadAt: null,
          lastDownloadAt: null,
        })
      );
      recordDownload('cancelled');
      const written = JSON.parse(writeFileSyncMock.mock.calls[0]![1]);
      expect(written.cancelledDownloads).toBe(1);
    });

    it('sets firstDownloadAt on first download', () => {
      readFileSyncMock.mockReturnValue(
        JSON.stringify({
          totalDownloads: 0,
          successfulDownloads: 0,
          failedDownloads: 0,
          cancelledDownloads: 0,
          totalBytesDownloaded: 0,
          formatCounts: {},
          firstDownloadAt: null,
          lastDownloadAt: null,
        })
      );
      recordDownload('success');
      const written = JSON.parse(writeFileSyncMock.mock.calls[0]![1]);
      expect(written.firstDownloadAt).toBeGreaterThan(0);
    });

    it('tracks format counts on success with format argument', () => {
      readFileSyncMock.mockReturnValue(
        JSON.stringify({
          totalDownloads: 0,
          successfulDownloads: 0,
          failedDownloads: 0,
          cancelledDownloads: 0,
          totalBytesDownloaded: 0,
          formatCounts: {},
          firstDownloadAt: null,
          lastDownloadAt: null,
        })
      );
      recordDownload('success', 'mp4', 1024);
      const written = JSON.parse(writeFileSyncMock.mock.calls[0]![1]);
      expect(written.formatCounts.mp4).toBe(1);
      expect(written.totalBytesDownloaded).toBe(1024);
    });
  });

  describe('resetStats', () => {
    it('writes default stats to disk', () => {
      resetStats();
      expect(writeFileSyncMock).toHaveBeenCalled();
      const written = JSON.parse(writeFileSyncMock.mock.calls[0]![1]);
      expect(written.totalDownloads).toBe(0);
    });
  });

  describe('exportSettingsToFile', () => {
    it('returns false when window is null', async () => {
      const result = await exportSettingsToFile(null);
      expect(result).toBe(false);
    });

    it('returns false when window is destroyed', async () => {
      const result = await exportSettingsToFile({ isDestroyed: () => true } as any);
      expect(result).toBe(false);
    });

    it('returns false when dialog is cancelled', async () => {
      showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: '' });
      const result = await exportSettingsToFile({ isDestroyed: () => false } as any);
      expect(result).toBe(false);
    });

    it('writes settings to selected file path', async () => {
      showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/tmp/export.json' });
      existsSyncMock.mockReturnValue(true);
      readFileSyncMock.mockReturnValue(JSON.stringify(getDefaultSettings()));
      writeFileSyncMock.mockImplementation(() => {});
      const result = await exportSettingsToFile({ isDestroyed: () => false } as any);
      expect(result).toBe(true);
      expect(writeFileSyncMock).toHaveBeenCalledWith('/tmp/export.json', expect.any(String));
    });

    it('returns false on write error', async () => {
      showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/tmp/export.json' });
      writeFileSyncMock.mockImplementation((p: string) => {
        if (p === '/tmp/export.json') throw new Error('disk full');
      });
      const result = await exportSettingsToFile({ isDestroyed: () => false } as any);
      expect(result).toBe(false);
      expect(logErrorMock).toHaveBeenCalled();
    });
  });

  describe('importSettingsFromFile', () => {
    it('returns false when window is null', async () => {
      const result = await importSettingsFromFile(null);
      expect(result).toBe(false);
    });

    it('returns false when dialog is cancelled', async () => {
      showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });
      const result = await importSettingsFromFile({ isDestroyed: () => false } as any);
      expect(result).toBe(false);
    });

    it('returns false when file is too large', async () => {
      showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/tmp/big.json'] });
      statSyncMock.mockReturnValue({ size: 2_000_000 });
      const result = await importSettingsFromFile({ isDestroyed: () => false } as any);
      expect(result).toBe(false);
      expect(logWarnMock).toHaveBeenCalledWith(expect.stringContaining('too large'));
    });

    it('returns false for invalid JSON structure', async () => {
      showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/tmp/bad.json'] });
      statSyncMock.mockReturnValue({ size: 100 });
      readFileSyncMock.mockReturnValue('"just a string"');
      const result = await importSettingsFromFile({ isDestroyed: () => false } as any);
      expect(result).toBe(false);
    });

    it('returns false for array JSON', async () => {
      showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/tmp/arr.json'] });
      statSyncMock.mockReturnValue({ size: 100 });
      readFileSyncMock.mockReturnValue('[]');
      const result = await importSettingsFromFile({ isDestroyed: () => false } as any);
      expect(result).toBe(false);
    });

    it('successfully imports valid settings file', async () => {
      showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/tmp/good.json'] });
      statSyncMock.mockReturnValue({ size: 500 });
      readFileSyncMock.mockReturnValue(JSON.stringify({ theme: 'dark', audioOnly: true }));
      const result = await importSettingsFromFile({ isDestroyed: () => false } as any);
      expect(result).toBe(true);
      expect(writeFileSyncMock).toHaveBeenCalled();
      expect(renameSyncMock).toHaveBeenCalled();
    });

    it('returns false on parse error', async () => {
      showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/tmp/broken.json'] });
      statSyncMock.mockReturnValue({ size: 100 });
      readFileSyncMock.mockReturnValue('{broken json');
      const result = await importSettingsFromFile({ isDestroyed: () => false } as any);
      expect(result).toBe(false);
      expect(logErrorMock).toHaveBeenCalled();
    });
  });
});
