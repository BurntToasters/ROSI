import fs from 'fs';
import * as os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  handleHandlers,
  onHandlers,
  appOnHandlers,
  sendMock,
  appMock,
  BrowserWindowMock,
  startDownloadMock,
  cancelActiveSessionMock,
  killAllProcessesMock,
  loadSettingsMock,
  saveSettingsMock,
  resetStatsMock,
  exportSettingsToFileMock,
  importSettingsFromFileMock,
  showOpenDialogMock,
  showMessageBoxSyncMock,
  openExternalMock,
  openPathMock,
  showItemInFolderMock,
  notificationIsSupportedMock,
  notificationShowMock,
  notificationOnMock,
  notificationOnceMock,
  checkForUpdatesMock,
  downloadUpdateMock,
  cancelUpdateDownloadMock,
  installUpdateMock,
  checkDenoInstalledMock,
  installDenoMock,
  detectGpuMock,
  fetchFormatsMock,
  cancelFormatsMock,
  isDownloadBusyMock,
  fetchVideoInfoMock,
  cancelVideoInfoMock,
  ytdlpFixturePath,
} = vi.hoisted(() => {
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  const { randomBytes } = require('crypto') as typeof import('crypto');
  const handleMap: Record<string, any> = {};
  const onMap: Record<string, any> = {};
  const appOnMap: Record<string, any> = {};
  const send = vi.fn();
  const windows: Array<{
    destroyed: boolean;
    minimized: boolean;
    webContents: {
      send: (...args: unknown[]) => void;
      setWindowOpenHandler: (...args: unknown[]) => void;
      on: (...args: unknown[]) => void;
      isDestroyed: () => boolean;
      id?: number;
    };
    once: (event: string, cb: () => void) => void;
    loadFile: (...args: unknown[]) => void;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    isDestroyed: () => boolean;
    show: () => void;
    focus: () => void;
    close: () => void;
    destroy: () => void;
    center: () => void;
    removeMenu: () => void;
    setMenuBarVisibility: (...args: unknown[]) => void;
    setAutoHideMenuBar: (...args: unknown[]) => void;
    isMinimized: () => boolean;
    restore: () => void;
    reload: () => void;
  }> = [];

  class BrowserWindowClass {
    destroyed = false;
    minimized = false;
    webContents = {
      send,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      id: 1,
    };

    constructor() {
      windows.push(this);
    }

    loadFile = vi.fn();
    on = vi.fn();
    setMenuBarVisibility = vi.fn();
    setAutoHideMenuBar = vi.fn();
    removeMenu = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    close = vi.fn(() => {
      this.destroyed = true;
    });
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    center = vi.fn();
    isDestroyed = () => this.destroyed;
    once = vi.fn((event: string, callback: () => void) => {
      if (event === 'ready-to-show') {
        setTimeout(callback, 0);
      }
    });
    isMinimized = () => this.minimized;
    restore = vi.fn(() => {
      this.minimized = false;
    });
    reload = vi.fn();

    static getAllWindows() {
      return windows.filter((windowRef) => !windowRef.destroyed);
    }

    static getFocusedWindow() {
      const available = windows.filter((windowRef) => !windowRef.destroyed);
      return available.length > 0 ? available[available.length - 1] : null;
    }
  }

  const userDataDir = nodePath.join(
    nodeOs.tmpdir(),
    `rosi-main-ipc-test-${randomBytes(8).toString('hex')}`
  );
  const downloadsDir = nodePath.join(userDataDir, 'downloads');
  const ytdlpFixturePath = nodePath.join(userDataDir, 'yt-dlp.exe');

  const app = {
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      appOnMap[channel] = handler;
    }),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
    getPath: vi.fn((name: string) => {
      if (name === 'downloads') return downloadsDir;
      return userDataDir;
    }),
    getVersion: vi.fn(() => '4.0.0-beta.2'),
    getAppPath: vi.fn(() => process.cwd()),
    isReady: vi.fn(() => true),
  };

  return {
    handleHandlers: handleMap,
    onHandlers: onMap,
    appOnHandlers: appOnMap,
    sendMock: send,
    appMock: app,
    BrowserWindowMock: BrowserWindowClass,
    startDownloadMock: vi.fn(
      (
        _ytdlpPath: string,
        _sender: unknown,
        _options: unknown,
        _mainWindow: unknown,
        onComplete?: (status: string, outcome: string) => void
      ) => {
        if (typeof onComplete === 'function') {
          onComplete('✅ Done', 'success');
        }
      }
    ),
    cancelActiveSessionMock: vi.fn(),
    killAllProcessesMock: vi.fn(),
    loadSettingsMock: vi.fn(() => ({
      convertEnabled: false,
      convertFormat: 'mp4',
      keepOriginalAfterConvert: true,
      ffmpegPath: '',
    })),
    saveSettingsMock: vi.fn(() => true),
    resetStatsMock: vi.fn(() => true),
    exportSettingsToFileMock: vi.fn(async () => true),
    importSettingsFromFileMock: vi.fn(async () => ({
      convertEnabled: false,
      convertFormat: 'mp4',
    })),
    showOpenDialogMock: vi.fn(async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
      canceled: true,
      filePaths: [],
    })),
    showMessageBoxSyncMock: vi.fn(() => 0),
    openExternalMock: vi.fn(async () => {}),
    openPathMock: vi.fn(async () => ''),
    showItemInFolderMock: vi.fn(),
    notificationIsSupportedMock: vi.fn(() => true),
    notificationShowMock: vi.fn(),
    notificationOnMock: vi.fn(),
    notificationOnceMock: vi.fn(),
    checkForUpdatesMock: vi.fn(async () => ({ ok: true })),
    downloadUpdateMock: vi.fn(async () => ({ success: true })),
    cancelUpdateDownloadMock: vi.fn(),
    installUpdateMock: vi.fn(),
    checkDenoInstalledMock: vi.fn(async () => true),
    installDenoMock: vi.fn(async () => ({ success: true })),
    detectGpuMock: vi.fn(async () => ({ nvidia: false, amd: false, intel: false })),
    fetchFormatsMock: vi.fn(async () => 'ok'),
    cancelFormatsMock: vi.fn(),
    isDownloadBusyMock: vi.fn(() => false),
    fetchVideoInfoMock: vi.fn(async () => ({
      title: 'Example Video',
      duration: 120,
      thumbnail: 'https://example.com/thumb.jpg',
    })),
    cancelVideoInfoMock: vi.fn(),
    ytdlpFixturePath,
  };
});

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: BrowserWindowMock,
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleHandlers[channel] = handler;
    }),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      onHandlers[channel] = handler;
    }),
  },
  dialog: {
    showOpenDialog: showOpenDialogMock,
    showMessageBoxSync: showMessageBoxSyncMock,
    showErrorBox: vi.fn(),
  },
  shell: {
    openExternal: openExternalMock,
    openPath: openPathMock,
    showItemInFolder: showItemInFolderMock,
  },
  Notification: class {
    constructor() {}
    static isSupported() {
      return notificationIsSupportedMock();
    }
    on = notificationOnMock;
    once = notificationOnceMock;
    show = notificationShowMock;
  },
}));

vi.mock('../main/platform', () => ({
  isPackaged: true,
  initializeYtdlpPath: vi.fn(async () => ytdlpFixturePath),
  verifyBundledFfmpeg: vi.fn(),
}));

vi.mock('../main/settings', () => ({
  loadSettings: loadSettingsMock,
  saveSettings: saveSettingsMock,
  getDefaultSettings: vi.fn(() => ({})),
  loadStats: vi.fn(() => ({ totalDownloads: 0 })),
  resetStats: resetStatsMock,
  exportSettingsToFile: exportSettingsToFileMock,
  importSettingsFromFile: importSettingsFromFileMock,
}));

vi.mock('../main/updater', () => ({
  setupAutoUpdater: vi.fn(),
  checkForUpdates: checkForUpdatesMock,
  downloadUpdate: downloadUpdateMock,
  cancelUpdateDownload: cancelUpdateDownloadMock,
  installUpdate: installUpdateMock,
}));

vi.mock('../main/deno', () => ({
  checkDenoInstalled: checkDenoInstalledMock,
  installDeno: installDenoMock,
}));

vi.mock('../main/gpu', () => ({
  detectGpu: detectGpuMock,
}));

vi.mock('../main/downloader', () => ({
  startDownload: startDownloadMock,
  cancelActiveSession: cancelActiveSessionMock,
  killAllProcesses: killAllProcessesMock,
  fetchFormats: fetchFormatsMock,
  cancelFormats: cancelFormatsMock,
  canStartDownload: vi.fn(() => true),
  isDownloadBusy: isDownloadBusyMock,
}));

vi.mock('../main/download/videoInfo', () => ({
  fetchVideoInfo: fetchVideoInfoMock,
  cancelVideoInfo: cancelVideoInfoMock,
}));

vi.mock('../main/constants', () => ({
  SPLASH_SHOW_DELAY_MS: 0,
  SPLASH_FADE_DELAY_MS: 0,
  MAX_QUEUE_SIZE: 500,
  CURRENT_SETTINGS_VERSION: 2,
}));

vi.mock('electron-log/main.js', () => ({
  default: {
    initialize: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function clearHandlerMaps() {
  for (const key of Object.keys(handleHandlers)) {
    delete handleHandlers[key];
  }
  for (const key of Object.keys(onHandlers)) {
    delete onHandlers[key];
  }
  for (const key of Object.keys(appOnHandlers)) {
    delete appOnHandlers[key];
  }
}

async function initializeMainModule(options?: { beforeImport?: (userDataDir: string) => void }) {
  const userDataDir = appMock.getPath('userData');
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(userDataDir, 'downloads'), { recursive: true });
  clearHandlerMaps();
  sendMock.mockClear();
  startDownloadMock.mockClear();
  cancelActiveSessionMock.mockClear();
  saveSettingsMock.mockClear();
  saveSettingsMock.mockReturnValue(true);
  resetStatsMock.mockClear();
  resetStatsMock.mockReturnValue(true);
  exportSettingsToFileMock.mockClear();
  exportSettingsToFileMock.mockResolvedValue(true);
  importSettingsFromFileMock.mockClear();
  importSettingsFromFileMock.mockResolvedValue({
    convertEnabled: false,
    convertFormat: 'mp4',
  });
  showOpenDialogMock.mockClear();
  showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });
  showMessageBoxSyncMock.mockClear();
  showMessageBoxSyncMock.mockReturnValue(0);
  openExternalMock.mockClear();
  openExternalMock.mockResolvedValue(undefined);
  openPathMock.mockClear();
  openPathMock.mockResolvedValue('');
  showItemInFolderMock.mockClear();
  notificationIsSupportedMock.mockClear();
  notificationIsSupportedMock.mockReturnValue(true);
  notificationShowMock.mockClear();
  notificationOnMock.mockClear();
  notificationOnceMock.mockClear();
  checkForUpdatesMock.mockClear();
  checkForUpdatesMock.mockResolvedValue({ ok: true });
  downloadUpdateMock.mockClear();
  downloadUpdateMock.mockResolvedValue({ success: true });
  cancelUpdateDownloadMock.mockClear();
  installUpdateMock.mockClear();
  checkDenoInstalledMock.mockClear();
  checkDenoInstalledMock.mockResolvedValue(true);
  installDenoMock.mockClear();
  installDenoMock.mockResolvedValue({ success: true });
  detectGpuMock.mockClear();
  detectGpuMock.mockResolvedValue({ nvidia: false, amd: false, intel: false });
  fetchFormatsMock.mockClear();
  fetchFormatsMock.mockResolvedValue('ok');
  cancelFormatsMock.mockClear();
  isDownloadBusyMock.mockClear();
  isDownloadBusyMock.mockReturnValue(false);
  fetchVideoInfoMock.mockClear();
  fetchVideoInfoMock.mockResolvedValue({
    title: 'Example Video',
    duration: 120,
    thumbnail: 'https://example.com/thumb.jpg',
  });
  cancelVideoInfoMock.mockClear();
  killAllProcessesMock.mockClear();
  appMock.on.mockClear();
  appMock.quit.mockClear();
  appMock.relaunch.mockClear();
  appMock.exit.mockClear();
  appMock.whenReady.mockClear();
  appMock.whenReady.mockResolvedValue(undefined);
  appMock.requestSingleInstanceLock.mockReset();
  appMock.requestSingleInstanceLock.mockReturnValue(true);
  options?.beforeImport?.(userDataDir);
  fs.mkdirSync(path.dirname(ytdlpFixturePath), { recursive: true });
  fs.writeFileSync(ytdlpFixturePath, '');
  vi.resetModules();
  await import('../main/main');
  await new Promise((resolve) => setTimeout(resolve, 10));
}

type MockFn = ReturnType<typeof vi.fn>;
type MockWindow = {
  minimized: boolean;
  webContents: {
    id?: number;
    send: MockFn;
    setWindowOpenHandler: MockFn;
    on: MockFn;
    isDestroyed: MockFn;
  };
  on: MockFn;
  show: MockFn;
  focus: MockFn;
  destroy: MockFn;
  reload: MockFn;
  restore: MockFn;
};

const authorizedEvent = { sender: { id: 1 } };

function getPrimaryWindow(): MockWindow {
  const windows = BrowserWindowMock.getAllWindows() as unknown as MockWindow[];
  const primary = [...windows]
    .reverse()
    .find((windowRef) => windowRef.webContents.setWindowOpenHandler.mock.calls.length > 0);
  if (!primary) {
    throw new Error('Primary window not found');
  }
  return primary;
}

function getWindowHandler(
  windowRef: MockWindow,
  eventName: string
): (...args: unknown[]) => unknown {
  const call = windowRef.on.mock.calls.find((args) => args[0] === eventName);
  if (!call) throw new Error(`Window handler not found: ${eventName}`);
  return call[1] as (...args: unknown[]) => unknown;
}

function getWebContentsHandler(
  windowRef: MockWindow,
  eventName: string
): (...args: unknown[]) => unknown {
  const call = windowRef.webContents.on.mock.calls.find((args) => args[0] === eventName);
  if (!call) throw new Error(`WebContents handler not found: ${eventName}`);
  return call[1] as (...args: unknown[]) => unknown;
}

describe('main process IPC wiring and queue behavior', () => {
  beforeEach(async () => {
    await initializeMainModule();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers critical IPC handlers for queue/download/settings flow', () => {
    const expectedChannels = [
      'get-settings',
      'save-settings',
      'download-video',
      'add-to-queue',
      'remove-from-queue',
      'clear-queue',
      'get-queue',
      'start-queue',
      'cancel-queue',
      'open-external',
    ];
    expectedChannels.forEach((channel) => {
      expect(typeof handleHandlers[channel]).toBe('function');
    });
  });

  it('processes queue add/start/remove/cancel/clear flow', async () => {
    const addToQueue = handleHandlers['add-to-queue'];
    const getQueue = handleHandlers['get-queue'];
    const removeFromQueue = handleHandlers['remove-from-queue'];
    const startQueue = handleHandlers['start-queue'];
    const clearQueue = handleHandlers['clear-queue'];
    const cancelQueue = handleHandlers['cancel-queue'];

    const addResult = await addToQueue(authorizedEvent, ['https://example.com/a', 'invalid-url']);
    expect(addResult).toEqual({ ok: true, data: { added: 1 } });

    let queue = await getQueue(authorizedEvent);
    expect(queue).toHaveLength(1);
    expect(queue[0].status).toBe('pending');

    const removeMissingResult = await removeFromQueue(authorizedEvent, 'missing-id');
    expect(removeMissingResult).toEqual({
      ok: false,
      error: { code: 'NOT_AVAILABLE', message: 'Queue item not found.' },
    });

    const startResult = await startQueue(authorizedEvent);
    expect(startResult).toEqual({ ok: true, data: { started: true } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(startDownloadMock).toHaveBeenCalled();

    queue = await getQueue(authorizedEvent);
    expect(queue[0].status).toBe('completed');

    const secondAdd = await addToQueue(authorizedEvent, [
      'https://example.com/b',
      'https://example.com/c',
    ]);
    expect(secondAdd).toEqual({ ok: true, data: { added: 2 } });

    const cancelResult = await cancelQueue(authorizedEvent);
    expect(cancelResult).toEqual({ ok: true, data: undefined });
    queue = await getQueue(authorizedEvent);
    const cancelledItems = queue.filter((item: { status: string }) => item.status === 'cancelled');
    expect(cancelledItems.length).toBeGreaterThanOrEqual(2);

    const clearResult = await clearQueue(authorizedEvent);
    expect(clearResult).toEqual({ ok: true, data: undefined });
    queue = await getQueue(authorizedEvent);
    expect(queue).toEqual([]);

    expect(await startQueue(authorizedEvent)).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'NOT_AVAILABLE' }),
      })
    );
  });

  it('rejects malformed queue input and ignores duplicate completion callbacks', async () => {
    expect(await handleHandlers['add-to-queue']!(authorizedEvent, 'not-array')).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      })
    );
    expect(await handleHandlers['add-to-queue']!(authorizedEvent, ['bad-url'])).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'No valid URLs provided.' }),
      })
    );

    startDownloadMock.mockImplementationOnce(
      (
        _ytdlpPath: string,
        _sender: unknown,
        _options: unknown,
        _mainWindow: unknown,
        onComplete?: (status: string, outcome: string) => void
      ) => {
        onComplete?.('✅ Done', 'success');
        onComplete?.('❌ Too late', 'failed');
      }
    );

    await handleHandlers['add-to-queue']!(authorizedEvent, ['https://example.com/settled']);
    expect(await handleHandlers['start-queue']!(authorizedEvent)).toEqual({
      ok: true,
      data: { started: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const queue = (await handleHandlers['get-queue']!(authorizedEvent)) as Array<{
      status: string;
    }>;
    expect(queue[0]?.status).toBe('completed');
  });

  it('covers queue limits, removal success, and active removal rejection', async () => {
    const addToQueue = handleHandlers['add-to-queue'];
    const getQueue = handleHandlers['get-queue'];
    const removeFromQueue = handleHandlers['remove-from-queue'];
    const startQueue = handleHandlers['start-queue'];

    const tooMany = Array.from({ length: 501 }, (_, index) => `https://example.com/${index}`);
    const limitResult = await addToQueue(authorizedEvent, tooMany);
    expect(limitResult).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'Queue limit reached (max 500 items).' }),
      })
    );

    await addToQueue(authorizedEvent, ['https://example.com/remove-me']);
    let queue = (await getQueue(authorizedEvent)) as Array<{ id: string; status: string }>;
    const removeResult = await removeFromQueue(authorizedEvent, queue[0]!.id);
    expect(removeResult).toEqual({ ok: true, data: undefined });
    expect(await getQueue(authorizedEvent)).toEqual([]);

    startDownloadMock.mockImplementationOnce(() => {});
    await addToQueue(authorizedEvent, ['https://example.com/active']);
    await startQueue(authorizedEvent);
    await new Promise((resolve) => setTimeout(resolve, 10));

    queue = (await getQueue(authorizedEvent)) as Array<{ id: string; status: string }>;
    expect(queue[0]!.status).toBe('downloading');
    const activeRemove = await removeFromQueue(authorizedEvent, queue[0]!.id);
    expect(activeRemove).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: 'Cannot remove an actively downloading item.',
        }),
      })
    );
  });

  it('rejects queue mutations from unauthorized sender', async () => {
    const mainWindow = getPrimaryWindow();
    const addResult = await handleHandlers['add-to-queue']!({ sender: { id: 2 } }, [
      'https://example.com/a',
    ]);
    expect(addResult).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'Unauthorized sender.' }),
      })
    );

    const removeResult = await handleHandlers['remove-from-queue']!({ sender: { id: 2 } }, 'q_1');
    expect(removeResult).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'Unauthorized sender.' }),
      })
    );
  });

  it('returns internal error when cancel-queue throws', async () => {
    const addToQueue = handleHandlers['add-to-queue'];
    const startQueue = handleHandlers['start-queue'];
    const cancelQueue = handleHandlers['cancel-queue'];

    startDownloadMock.mockImplementationOnce(() => {});
    cancelActiveSessionMock.mockImplementationOnce(() => {
      throw new Error('cancel failed');
    });

    await addToQueue(authorizedEvent, ['https://example.com/cancel-error']);
    await startQueue(authorizedEvent);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await cancelQueue(authorizedEvent);
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'INTERNAL_ERROR',
          message: 'Failed to cancel queue.',
        }),
      })
    );
  });

  it('validates and starts direct download requests through ipc', async () => {
    const downloadVideo = handleHandlers['download-video'];

    const invalid = await downloadVideo(authorizedEvent, { url: 'bad', outputPath: '' });
    expect(invalid).toEqual({
      ok: false,
      error: {
        code: 'INVALID_URL',
        message: 'Download URL must be a valid http/https URL.',
      },
    });

    const valid = await downloadVideo(authorizedEvent, {
      url: 'https://example.com/video',
      outputPath: path.join(os.homedir(), 'Downloads'),
    });
    expect(valid).toEqual({ ok: true, data: { started: true } });
    expect(startDownloadMock).toHaveBeenCalled();

    const unauthorized = await downloadVideo(
      { sender: { id: 4 } },
      { url: 'https://example.com/video', outputPath: path.join(os.homedir(), 'Downloads') }
    );
    expect(unauthorized).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'Unauthorized sender.' }),
      })
    );
  });

  it('returns internal error when direct download start throws', async () => {
    startDownloadMock.mockImplementationOnce(() => {
      throw new Error('start failed');
    });

    const result = await handleHandlers['download-video']!(authorizedEvent, {
      url: 'https://example.com/video',
      outputPath: path.join(os.homedir(), 'Downloads'),
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );
  });

  it('rejects unsafe external links through validation', async () => {
    const openExternal = handleHandlers['open-external'];
    const invalid = await openExternal(authorizedEvent, 'javascript:alert(1)');
    expect(invalid).toEqual({
      ok: false,
      error: { code: 'INVALID_URL', message: 'Invalid external URL payload.' },
    });
  });

  it('handles settings and utility IPC requests', async () => {
    expect(await handleHandlers['get-app-version']!()).toBe('4.0.0-beta.2');
    expect(await handleHandlers['is-packaged']!()).toBe(true);
    expect(await handleHandlers['get-settings']!(authorizedEvent)).toEqual(
      expect.objectContaining({ convertFormat: 'mp4' })
    );
    expect(await handleHandlers['check-deno-installed']!(authorizedEvent)).toBe(true);
    expect(await handleHandlers['install-deno']!(authorizedEvent)).toEqual({ success: true });
    expect(await handleHandlers['detect-gpu']!(authorizedEvent)).toEqual({
      nvidia: false,
      amd: false,
      intel: false,
    });
    expect(await handleHandlers['get-stats']!()).toEqual({ totalDownloads: 0 });
    expect(await handleHandlers['reset-stats']!(authorizedEvent)).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await handleHandlers['check-for-updates']!()).toEqual({ ok: true });
    expect(await handleHandlers['download-update']!()).toEqual({ success: true });

    const saveResult = await handleHandlers['save-settings']!(authorizedEvent, { theme: 'dark' });
    expect(saveResult).toEqual(
      expect.objectContaining({
        ok: true,
      })
    );
    expect(saveSettingsMock).toHaveBeenCalledWith({ theme: 'dark' }, expect.anything());

    saveSettingsMock.mockReturnValueOnce(false);
    const saveFailure = await handleHandlers['save-settings']!(authorizedEvent, { theme: 'dark' });
    expect(saveFailure).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );

    const invalidSave = await handleHandlers['save-settings']!(authorizedEvent, { theme: 'neon' });
    expect(invalidSave).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      })
    );
  });

  it('handles update and cancellation fire-and-forget IPC events', () => {
    onHandlers['cancel-update-download']!({});
    onHandlers['install-update']!(authorizedEvent);
    onHandlers['cancel-formats']!(authorizedEvent);
    onHandlers['cancel-download']!(authorizedEvent);

    expect(cancelUpdateDownloadMock).toHaveBeenCalled();
    expect(installUpdateMock).toHaveBeenCalled();
    expect(cancelFormatsMock).toHaveBeenCalled();
    expect(cancelActiveSessionMock).toHaveBeenCalledWith(true);
  });

  it('ignores unauthorized cancellation events and catches cancel errors', () => {
    onHandlers['cancel-formats']!({ sender: { id: 11 } });
    onHandlers['cancel-download']!({ sender: { id: 11 } });

    expect(cancelFormatsMock).not.toHaveBeenCalled();
    expect(cancelActiveSessionMock).not.toHaveBeenCalled();

    cancelActiveSessionMock.mockImplementationOnce(() => {
      throw new Error('cancel failed');
    });

    expect(() => onHandlers['cancel-download']!(authorizedEvent)).not.toThrow();
    expect(cancelActiveSessionMock).toHaveBeenCalledWith(true);
  });

  it('handles renderer logs and main window navigation events', async () => {
    const mainWindow = getPrimaryWindow();

    onHandlers['log-error']!({}, 'x'.repeat(2105));
    onHandlers['log-error']!({}, 'short');
    onHandlers['log-error']!({}, 123);

    const openHandler = mainWindow.webContents.setWindowOpenHandler.mock.calls[0]![0] as (input: {
      url: string;
    }) => { action: 'deny' };
    expect(openHandler({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com');

    openExternalMock.mockRejectedValueOnce(new Error('blocked'));
    expect(openHandler({ url: 'https://example.com/rejected' })).toEqual({ action: 'deny' });
    await Promise.resolve();

    const renderGoneHandler = getWebContentsHandler(mainWindow, 'render-process-gone');
    renderGoneHandler({}, { reason: 'crashed', exitCode: 9 });
    expect(mainWindow.reload).toHaveBeenCalled();
    mainWindow.reload.mockClear();
    renderGoneHandler({}, { reason: 'clean-exit', exitCode: 0 });
    expect(mainWindow.reload).not.toHaveBeenCalled();

    const willNavigateHandler = getWebContentsHandler(mainWindow, 'will-navigate');
    const preventDefault = vi.fn();
    willNavigateHandler({ preventDefault }, 'https://example.com/external');

    expect(preventDefault).toHaveBeenCalled();
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/external');

    openExternalMock.mockRejectedValueOnce(new Error('navigate blocked'));
    willNavigateHandler({ preventDefault: vi.fn() }, 'https://example.com/fail');
    await Promise.resolve();
  });

  it('allows immediate close when installing an update', () => {
    const mainWindow = getPrimaryWindow();
    const closeHandler = getWindowHandler(mainWindow, 'close');
    const preventDefault = vi.fn();

    onHandlers['install-update']!(authorizedEvent);
    closeHandler({ preventDefault });

    expect(installUpdateMock).toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalledWith('prepare-for-close');
  });

  it('keeps the window open when the user cancels close during an active download', () => {
    const mainWindow = getPrimaryWindow();
    const closeHandler = getWindowHandler(mainWindow, 'close');
    const preventDefault = vi.fn();
    isDownloadBusyMock.mockReturnValueOnce(true);
    showMessageBoxSyncMock.mockReturnValueOnce(0);

    closeHandler({ preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    expect(showMessageBoxSyncMock).toHaveBeenCalledWith(
      mainWindow,
      expect.objectContaining({
        buttons: ['Cancel', 'Close Anyway'],
        defaultId: 0,
        cancelId: 0,
      })
    );
    expect(sendMock).not.toHaveBeenCalledWith('prepare-for-close');
    expect(mainWindow.destroy).not.toHaveBeenCalled();
  });

  it('continues the close flow when the user confirms close during an active download', () => {
    const mainWindow = getPrimaryWindow();
    const closeHandler = getWindowHandler(mainWindow, 'close');
    const preventDefault = vi.fn();
    isDownloadBusyMock.mockReturnValueOnce(true);
    showMessageBoxSyncMock.mockReturnValueOnce(1);

    closeHandler({ preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    expect(showMessageBoxSyncMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledWith('prepare-for-close');
  });

  it('waits for renderer settings flush before closing main window', () => {
    const mainWindow = getPrimaryWindow();
    mainWindow.webContents.id = 99;
    const closeHandler = getWindowHandler(mainWindow, 'close');
    const preventDefault = vi.fn();

    onHandlers['settings-flush-complete']!({ sender: { id: 99 } });
    expect(mainWindow.destroy).not.toHaveBeenCalled();

    closeHandler({ preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledWith('prepare-for-close');

    const secondPreventDefault = vi.fn();
    closeHandler({ preventDefault: secondPreventDefault });
    expect(secondPreventDefault).not.toHaveBeenCalled();

    onHandlers['settings-flush-complete']!({ sender: { id: 100 } });
    expect(mainWindow.destroy).not.toHaveBeenCalled();

    onHandlers['settings-flush-complete']!({ sender: { id: mainWindow.webContents.id } });
    expect(mainWindow.destroy).toHaveBeenCalled();

    const closedHandler = getWindowHandler(mainWindow, 'closed');
    closedHandler();
    onHandlers['settings-flush-complete']!({ sender: { id: mainWindow.webContents.id } });
  });

  it('destroys immediately when closing with destroyed webContents', () => {
    const mainWindow = getPrimaryWindow();
    const closeHandler = getWindowHandler(mainWindow, 'close');
    const preventDefault = vi.fn();
    mainWindow.webContents.isDestroyed.mockReturnValueOnce(true);

    closeHandler({ preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    expect(mainWindow.destroy).toHaveBeenCalled();
  });

  it('ignores close handler when main window is already destroyed', () => {
    const mainWindow = getPrimaryWindow();
    const closeHandler = getWindowHandler(mainWindow, 'close');
    const preventDefault = vi.fn();
    (mainWindow.destroy as unknown as () => void)();

    closeHandler({ preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('destroys main window when settings flush times out', async () => {
    vi.useFakeTimers();
    const mainWindow = getPrimaryWindow();
    const closeHandler = getWindowHandler(mainWindow, 'close');

    closeHandler({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(1500);

    expect(mainWindow.destroy).toHaveBeenCalled();
  });

  it('handles external links, folder selection, and formats IPC branches', async () => {
    const openResult = await handleHandlers['open-external']!(
      authorizedEvent,
      'https://example.com'
    );
    expect(openResult).toEqual({ ok: true, data: { opened: true } });
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com');

    openExternalMock.mockRejectedValueOnce(new Error('blocked'));
    const openFailure = await handleHandlers['open-external']!(
      authorizedEvent,
      'https://example.com'
    );
    expect(openFailure).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );

    showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['C:/Downloads'],
    });
    expect(await handleHandlers['select-download-location']!(authorizedEvent)).toBe('C:/Downloads');

    showOpenDialogMock.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });
    expect(await handleHandlers['select-download-location']!(authorizedEvent)).toBeNull();

    showOpenDialogMock.mockRejectedValueOnce(new Error('dialog failed'));
    expect(await handleHandlers['select-download-location']!(authorizedEvent)).toBeNull();

    expect(
      await handleHandlers['getFormats']!(authorizedEvent, 'https://example.com/video')
    ).toEqual({
      ok: true,
      data: 'ok',
    });

    const invalidFormats = await handleHandlers['getFormats']!(authorizedEvent, 'not-a-url');
    expect(invalidFormats).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INVALID_URL' }),
      })
    );

    fetchFormatsMock.mockRejectedValueOnce('Format fetch cancelled.');
    const cancelledFormats = await handleHandlers['getFormats']!(
      authorizedEvent,
      'https://example.com/video'
    );
    expect(cancelledFormats).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'NOT_AVAILABLE' }),
      })
    );

    fetchFormatsMock.mockRejectedValueOnce(new Error('yt-dlp failed'));
    const failedFormats = await handleHandlers['getFormats']!(
      authorizedEvent,
      'https://example.com/video'
    );
    expect(failedFormats).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );

    fetchFormatsMock.mockRejectedValueOnce({});
    const unknownFailure = await handleHandlers['getFormats']!(
      authorizedEvent,
      'https://example.com/video'
    );
    expect(unknownFailure).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch formats.',
        }),
      })
    );

    for (const windowRef of BrowserWindowMock.getAllWindows() as unknown as MockWindow[]) {
      (windowRef.destroy as unknown as () => void)();
    }
    expect(await handleHandlers['select-download-location']!(authorizedEvent)).toBeNull();
  });

  it('opens the download folder dialog at the last saved folder when it exists', async () => {
    const savedFolder = path.join(appMock.getPath('userData'), 'saved-downloads');
    fs.mkdirSync(savedFolder, { recursive: true });
    loadSettingsMock.mockReturnValueOnce({
      convertEnabled: false,
      convertFormat: 'mp4',
      keepOriginalAfterConvert: true,
      ffmpegPath: '',
      downloadFolder: savedFolder,
    });
    showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: [savedFolder],
    });

    await handleHandlers['select-download-location']!(authorizedEvent);

    expect(showOpenDialogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        defaultPath: savedFolder,
        properties: ['openDirectory', 'createDirectory'],
      })
    );
  });

  it('handles file location IPC branches', async () => {
    const downloadDir = path.join(os.homedir(), 'Downloads', `rosi-ipc-fileloc-${Date.now()}`);
    const filePath = path.join(downloadDir, 'rosi-ipc-test-video.mp4');
    fs.mkdirSync(downloadDir, { recursive: true });
    fs.writeFileSync(filePath, '');

    const fileResult = await handleHandlers['open-file-location']!(authorizedEvent, filePath);
    expect(fileResult).toEqual({ ok: true, data: { opened: true } });
    expect(showItemInFolderMock).toHaveBeenCalledWith(filePath);

    const missingFilePath = path.join(downloadDir, 'rosi-ipc-test-missing.mp4');
    const dirResult = await handleHandlers['open-file-location']!(authorizedEvent, missingFilePath);
    expect(dirResult).toEqual({ ok: true, data: { opened: true } });
    expect(openPathMock).toHaveBeenCalledWith(path.dirname(missingFilePath));

    openPathMock.mockResolvedValueOnce('blocked');
    const dirFailure = await handleHandlers['open-file-location']!(
      authorizedEvent,
      missingFilePath
    );
    expect(dirFailure).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );

    const invalid = await handleHandlers['open-file-location']!(authorizedEvent, 'relative/path');
    expect(invalid).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INVALID_PATH' }),
      })
    );

    const missingDir = await handleHandlers['open-file-location']!(
      authorizedEvent,
      path.join(os.homedir(), 'rosi-nonexistent-dir', 'file.mp4')
    );
    expect(missingDir).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INVALID_PATH' }),
      })
    );

    showItemInFolderMock.mockImplementationOnce(() => {
      throw new Error('shell failed');
    });
    const shellFailure = await handleHandlers['open-file-location']!(authorizedEvent, filePath);
    expect(shellFailure).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );
  });

  it('handles notification IPC branches and click behavior', async () => {
    const mainWindow = getPrimaryWindow();
    const notificationFile = path.join(
      os.homedir(),
      '.rosi-ipc-test',
      'rosi-notification-test.mp4'
    );
    const result = await handleHandlers['show-notification']!(authorizedEvent, {
      title: 'Done',
      body: 'Saved',
      filePath: notificationFile,
    });
    expect(result).toEqual({ ok: true, data: { shown: true } });
    expect(notificationShowMock).toHaveBeenCalled();

    const clickHandler = notificationOnceMock.mock.calls.find(
      (call) => call[0] === 'click'
    )?.[1] as (() => void) | undefined;
    expect(clickHandler).toBeTypeOf('function');
    mainWindow.minimized = true;
    clickHandler?.();
    expect(mainWindow.restore).toHaveBeenCalled();
    expect(mainWindow.focus).toHaveBeenCalled();
    expect(showItemInFolderMock).toHaveBeenCalledWith(path.resolve(notificationFile));

    expect(await handleHandlers['show-notification']!(authorizedEvent, {})).toEqual({
      ok: true,
      data: { shown: true },
    });

    showItemInFolderMock.mockImplementationOnce(() => {
      throw new Error('click failed');
    });
    await handleHandlers['show-notification']!(authorizedEvent, {
      title: 'Click',
      filePath: path.join(os.homedir(), '.rosi-ipc-test', 'rosi-notification-fail.mp4'),
    });
    const lastClickHandler = notificationOnceMock.mock.calls
      .filter((call) => call[0] === 'click')
      .at(-1)?.[1] as (() => void) | undefined;
    expect(() => lastClickHandler?.()).not.toThrow();

    notificationIsSupportedMock.mockReturnValueOnce(false);
    const unsupported = await handleHandlers['show-notification']!(authorizedEvent, {
      title: 'Nope',
    });
    expect(unsupported).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'NOT_SUPPORTED' }),
      })
    );

    const invalid = await handleHandlers['show-notification']!(authorizedEvent, { title: 123 });
    expect(invalid).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      })
    );

    notificationShowMock.mockImplementationOnce(() => {
      throw new Error('notify failed');
    });
    const showFailure = await handleHandlers['show-notification']!(authorizedEvent, {
      title: 'Fail',
    });
    expect(showFailure).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );
  });

  it('handles settings import/export and restart/reset events', async () => {
    expect(await handleHandlers['export-settings']!(authorizedEvent)).toEqual({
      ok: true,
      data: { exported: true },
    });
    const importResult = await handleHandlers['import-settings']!(authorizedEvent);
    expect(importResult).toEqual({
      ok: true,
      data: { imported: true },
    });
    expect(sendMock).toHaveBeenCalledWith('settings-imported', {
      convertEnabled: false,
      convertFormat: 'mp4',
    });

    exportSettingsToFileMock.mockResolvedValueOnce(false);
    importSettingsFromFileMock.mockResolvedValueOnce(false);

    expect(await handleHandlers['export-settings']!(authorizedEvent)).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );
    expect(await handleHandlers['import-settings']!(authorizedEvent)).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );

    exportSettingsToFileMock.mockRejectedValueOnce(new Error('export failed'));
    importSettingsFromFileMock.mockRejectedValueOnce(new Error('import failed'));

    expect(await handleHandlers['export-settings']!(authorizedEvent)).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );
    expect(await handleHandlers['import-settings']!(authorizedEvent)).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );

    await handleHandlers['restart-app']!(authorizedEvent);
    expect(cancelActiveSessionMock).toHaveBeenCalledWith(false);
    expect(killAllProcessesMock).toHaveBeenCalled();
    expect(appMock.relaunch).toHaveBeenCalled();
    expect(appMock.exit).toHaveBeenCalledWith(0);

    appMock.relaunch.mockClear();
    appMock.exit.mockClear();
    const mainWindow = getPrimaryWindow();
    onHandlers['reset-settings']!({ sender: { id: 21 } });
    expect(appMock.relaunch).not.toHaveBeenCalled();

    saveSettingsMock.mockReturnValueOnce(false);
    onHandlers['reset-settings']!(authorizedEvent);
    expect(appMock.relaunch).toHaveBeenCalled();
    expect(appMock.exit).toHaveBeenCalled();

    saveSettingsMock.mockImplementationOnce(() => {
      throw new Error('reset failed');
    });
    onHandlers['reset-settings']!(authorizedEvent);
    expect(appMock.relaunch).toHaveBeenCalledTimes(2);

    resetStatsMock.mockReturnValueOnce(false);
    expect(await handleHandlers['reset-stats']!(authorizedEvent)).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );
  });

  it('runs registered app lifecycle callbacks', async () => {
    expect(typeof appOnHandlers['window-all-closed']).toBe('function');
    expect(typeof appOnHandlers['activate']).toBe('function');
    expect(typeof appOnHandlers['before-quit']).toBe('function');
    expect(typeof appOnHandlers['second-instance']).toBe('function');

    const mainWindow = getPrimaryWindow();
    mainWindow.minimized = true;
    appOnHandlers['second-instance']!();
    expect(mainWindow.restore).toHaveBeenCalled();
    expect(mainWindow.show).toHaveBeenCalled();
    expect(mainWindow.focus).toHaveBeenCalled();

    (mainWindow.destroy as unknown as () => void)();
    const countBeforeSecondInstance = BrowserWindowMock.getAllWindows().length;
    appOnHandlers['second-instance']!();
    expect(BrowserWindowMock.getAllWindows().length).toBeGreaterThan(countBeforeSecondInstance);

    appOnHandlers['window-all-closed']!();
    if (process.platform === 'darwin') {
      expect(appMock.quit).not.toHaveBeenCalled();
    } else {
      expect(appMock.quit).toHaveBeenCalled();
    }

    appOnHandlers['before-quit']!();
    expect(killAllProcessesMock).toHaveBeenCalled();
    expect(cancelFormatsMock).toHaveBeenCalled();

    killAllProcessesMock.mockImplementationOnce(() => {
      throw new Error('kill failed');
    });
    cancelFormatsMock.mockImplementationOnce(() => {
      throw new Error('formats failed');
    });
    expect(() => appOnHandlers['before-quit']!()).not.toThrow();

    for (const windowRef of BrowserWindowMock.getAllWindows() as unknown as MockWindow[]) {
      (windowRef.destroy as unknown as () => void)();
    }
    appOnHandlers['activate']!();
    expect(BrowserWindowMock.getAllWindows().length).toBeGreaterThan(0);
  });

  it('quits startup flow when single-instance lock is unavailable', async () => {
    await initializeMainModule({
      beforeImport: () => {
        appMock.requestSingleInstanceLock.mockReturnValueOnce(false);
      },
    });

    expect(appMock.quit).toHaveBeenCalled();
    expect(appOnHandlers['second-instance']).toBeUndefined();
  });

  it('loads empty queue when persisted queue payload is not an array', async () => {
    await initializeMainModule({
      beforeImport: (userDataDir) => {
        fs.writeFileSync(
          path.join(userDataDir, 'download-queue.json'),
          JSON.stringify({ invalid: true }),
          'utf-8'
        );
      },
    });

    expect(await handleHandlers['get-queue']!(authorizedEvent)).toEqual([]);
  });

  it('recreates queue directory when persisting queue', async () => {
    vi.useFakeTimers();
    const userDataDir = appMock.getPath('userData');
    fs.rmSync(userDataDir, { recursive: true, force: true });

    await handleHandlers['add-to-queue']!(authorizedEvent, ['https://example.com/recreate-dir']);
    await vi.advanceTimersByTimeAsync(300);

    expect(fs.existsSync(path.join(userDataDir, 'download-queue.json'))).toBe(true);
  });

  it('cleans up temp queue file when queue persist fails', async () => {
    vi.useFakeTimers();
    const userDataDir = appMock.getPath('userData');
    const tempQueuePath = path.join(userDataDir, 'download-queue.json.tmp');
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed');
    });

    try {
      await handleHandlers['add-to-queue']!(authorizedEvent, ['https://example.com/persist-fail']);
      await vi.advanceTimersByTimeAsync(300);
      expect(fs.existsSync(tempQueuePath)).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('rejects start-queue when main window is already destroyed', async () => {
    await handleHandlers['add-to-queue']!(authorizedEvent, ['https://example.com/window-closed']);
    const mainWindow = getPrimaryWindow();
    (mainWindow.destroy as unknown as () => void)();

    expect(await handleHandlers['start-queue']!(authorizedEvent)).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'Unauthorized sender.' }),
      })
    );
  });

  it('returns video info for authorized get-video-info requests', async () => {
    const info = {
      title: 'Example Video',
      duration: 120,
      thumbnail: 'https://example.com/thumb.jpg',
    };
    fetchVideoInfoMock.mockResolvedValueOnce(info);

    const result = await handleHandlers['get-video-info']!(
      authorizedEvent,
      'https://example.com/video'
    );

    expect(result).toEqual({ ok: true, data: info });
    expect(fetchVideoInfoMock).toHaveBeenCalledWith(ytdlpFixturePath, 'https://example.com/video');
  });

  it('rejects invalid URLs for get-video-info', async () => {
    const result = await handleHandlers['get-video-info']!(authorizedEvent, 'not-a-url');
    expect(result).toEqual({
      ok: false,
      error: { code: 'INVALID_URL', message: 'Invalid URL provided.' },
    });
    expect(fetchVideoInfoMock).not.toHaveBeenCalled();
  });

  it('returns NOT_AVAILABLE when get-video-info fetch is cancelled', async () => {
    fetchVideoInfoMock.mockRejectedValueOnce('Video info fetch cancelled.');

    const result = await handleHandlers['get-video-info']!(
      authorizedEvent,
      'https://example.com/video'
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'NOT_AVAILABLE' }),
      })
    );
  });

  it('returns INTERNAL_ERROR when get-video-info fetch fails', async () => {
    fetchVideoInfoMock.mockRejectedValueOnce(new Error('yt-dlp failed'));

    const result = await handleHandlers['get-video-info']!(
      authorizedEvent,
      'https://example.com/video'
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'INTERNAL_ERROR',
          message: 'yt-dlp failed',
        }),
      })
    );
  });

  it('rejects unauthorized get-video-info sender', async () => {
    const result = await handleHandlers['get-video-info']!(
      { sender: { id: 2 } },
      'https://example.com/video'
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'Unauthorized sender.' }),
      })
    );
    expect(fetchVideoInfoMock).not.toHaveBeenCalled();
  });

  it('ignores cancel-video-info from unauthorized sender', () => {
    onHandlers['cancel-video-info']!({ sender: { id: 2 } });
    expect(cancelVideoInfoMock).not.toHaveBeenCalled();

    onHandlers['cancel-video-info']!(authorizedEvent);
    expect(cancelVideoInfoMock).toHaveBeenCalled();
  });

  it('rejects save-settings from unauthorized sender when main window exists', async () => {
    const result = await handleHandlers['save-settings']!({ sender: { id: 2 } }, { theme: 'dark' });
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'Unauthorized sender.' }),
      })
    );
    expect(saveSettingsMock).not.toHaveBeenCalled();
  });

  it('ignores install-update from unauthorized sender', () => {
    onHandlers['install-update']!({ sender: { id: 2 } });
    expect(installUpdateMock).not.toHaveBeenCalled();
  });
});
