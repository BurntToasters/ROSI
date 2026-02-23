import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  autoUpdaterMock,
  listeners,
  appGetVersionMock,
  cancellationCancelMock,
  logInfoMock,
  logErrorMock,
} = vi.hoisted(() => {
  const eventListeners: Record<string, Array<(payload?: any) => void>> = {};
  const cancellationCancel = vi.fn();
  const autoUpdater = {
    channel: 'latest',
    allowPrerelease: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: vi.fn((event: string, callback: (payload?: any) => void) => {
      eventListeners[event] ??= [];
      eventListeners[event].push(callback);
    }),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  };

  return {
    autoUpdaterMock: autoUpdater,
    listeners: eventListeners,
    appGetVersionMock: vi.fn(() => '3.4.3'),
    cancellationCancelMock: cancellationCancel,
    logInfoMock: vi.fn(),
    logErrorMock: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: {
    getVersion: appGetVersionMock,
  },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterMock,
  CancellationToken: class {
    cancel() {
      cancellationCancelMock();
    }
  },
}));

vi.mock('electron-log/main', () => ({
  default: {
    info: logInfoMock,
    error: logErrorMock,
  },
}));

import {
  cancelUpdateDownload,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  setupAutoUpdater,
} from '../main/updater';
import type { Settings } from '../types';

function createSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    settingsVersion: 1,
    showConsoleOutput: false,
    consoleCollapsed: false,
    advancedOptions: false,
    audioOnly: false,
    convertEnabled: false,
    convertFormat: 'mp4',
    keepOriginalAfterConvert: true,
    firstLaunch: false,
    hookBrowser: false,
    browserChoice: 'Chrome',
    animateBackground: true,
    notifications: true,
    denoReminderDismissed: false,
    gpuAcceleration: false,
    gpuType: 'auto',
    bestQuality: false,
    ffmpegPath: '',
    hideSupportModal: false,
    checkUpdatesOnStartup: true,
    updateChannel: 'auto',
    ...overrides,
  };
}

function emit(event: string, payload?: any) {
  for (const listener of listeners[event] ?? []) {
    listener(payload);
  }
}

describe('updater event wiring and control flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(listeners).forEach((key) => {
      listeners[key] = [];
    });
    appGetVersionMock.mockReturnValue('3.4.3');
  });

  it('wires updater events to renderer channels', () => {
    const sendMock = vi.fn();
    setupAutoUpdater(
      () =>
        ({
          isDestroyed: () => false,
          webContents: { send: sendMock },
        }) as any,
      () => createSettings({ updateChannel: 'stable' })
    );

    emit('checking-for-update');
    emit('update-not-available', { version: '3.4.3' });
    emit('download-progress', {
      percent: 50,
      bytesPerSecond: 1000,
      transferred: 100,
      total: 200,
    });
    emit('update-downloaded', { version: '3.5.0' });
    emit('error', new Error('network'));

    expect(sendMock).toHaveBeenCalledWith('updater-status', { status: 'checking' });
    expect(sendMock).toHaveBeenCalledWith('updater-status', {
      status: 'not-available',
      version: '3.4.3',
      isBeta: false,
    });
    expect(sendMock).toHaveBeenCalledWith('updater-progress', {
      percent: 50,
      bytesPerSecond: 1000,
      transferred: 100,
      total: 200,
    });
    expect(sendMock).toHaveBeenCalledWith('updater-status', {
      status: 'downloaded',
      version: '3.5.0',
    });
    expect(sendMock).toHaveBeenCalledWith('updater-status', {
      status: 'error',
      message: 'network',
    });
  });

  it('filters beta updates on stable channel', () => {
    const sendMock = vi.fn();
    setupAutoUpdater(
      () =>
        ({
          isDestroyed: () => false,
          webContents: { send: sendMock },
        }) as any,
      () => createSettings({ updateChannel: 'stable' })
    );

    emit('update-available', { version: '3.5.0-beta.1', releaseNotes: null });
    expect(sendMock).toHaveBeenCalledWith('updater-status', {
      status: 'not-available',
      version: '3.4.3',
      isBeta: false,
    });
  });

  it('emits available status for valid newer updates', () => {
    const sendMock = vi.fn();
    setupAutoUpdater(
      () =>
        ({
          isDestroyed: () => false,
          webContents: { send: sendMock },
        }) as any,
      () => createSettings({ updateChannel: 'stable' })
    );

    emit('update-available', { version: '3.5.0', releaseNotes: 'notes' });
    expect(sendMock).toHaveBeenCalledWith('updater-status', {
      status: 'available',
      version: '3.5.0',
      releaseNotes: 'notes',
      isBeta: false,
    });
  });

  it('ignores updates that are not newer than current version', () => {
    const sendMock = vi.fn();
    setupAutoUpdater(
      () =>
        ({
          isDestroyed: () => false,
          webContents: { send: sendMock },
        }) as any,
      () => createSettings({ updateChannel: 'stable' })
    );

    emit('update-available', { version: '3.4.3', releaseNotes: null });
    expect(logInfoMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledWith('updater-status', {
      status: 'not-available',
      version: '3.4.3',
      isBeta: false,
    });
  });

  it('handles checkForUpdates in dev and packaged modes', async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({ updateInfo: { version: '3.5.0' } });

    await expect(checkForUpdates(false, () => createSettings())).resolves.toEqual({
      error: 'dev-mode',
      message: 'Update checking is not available in development mode.',
    });

    await expect(checkForUpdates(true, () => createSettings())).resolves.toEqual({
      updateInfo: { version: '3.5.0' },
    });
  });

  it('handles successful and error update download responses', async () => {
    autoUpdaterMock.downloadUpdate.mockResolvedValueOnce(undefined);
    await expect(downloadUpdate()).resolves.toEqual({ success: true });

    autoUpdaterMock.downloadUpdate.mockRejectedValueOnce(new Error('cancelled by user'));
    await expect(downloadUpdate()).resolves.toEqual({ cancelled: true });

    autoUpdaterMock.downloadUpdate.mockRejectedValueOnce(new Error('network'));
    await expect(downloadUpdate()).resolves.toEqual({ error: 'network' });
  });

  it('can cancel active update download and emit cancelled status', async () => {
    const sendMock = vi.fn();
    setupAutoUpdater(
      () =>
        ({
          isDestroyed: () => false,
          webContents: { send: sendMock },
        }) as any,
      () => createSettings({ updateChannel: 'stable' })
    );

    autoUpdaterMock.downloadUpdate.mockImplementationOnce(() => new Promise(() => {}));
    void downloadUpdate();

    cancelUpdateDownload(
      () =>
        ({
          isDestroyed: () => false,
          webContents: { send: sendMock },
        }) as any
    );

    expect(cancellationCancelMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledWith('updater-status', { status: 'cancelled' });
  });

  it('invokes installUpdate quitAndInstall', () => {
    installUpdate();
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(false, true);
  });
});
