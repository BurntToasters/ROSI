import fs from 'fs';
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
  openExternalMock,
  openPathMock,
  showItemInFolderMock,
  notificationIsSupportedMock,
  notificationShowMock,
  notificationOnMock,
  checkForUpdatesMock,
  downloadUpdateMock,
  cancelUpdateDownloadMock,
  installUpdateMock,
  checkDenoInstalledMock,
  installDenoMock,
  detectGpuMock,
  fetchFormatsMock,
  cancelFormatsMock,
} = vi.hoisted(() => {
  const handleMap: Record<string, (...args: unknown[]) => unknown> = {};
  const onMap: Record<string, (...args: unknown[]) => unknown> = {};
  const appOnMap: Record<string, (...args: unknown[]) => unknown> = {};
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

  const userDataDir = `${process.cwd()}/.tmp-main-ipc-test`;
  const downloadsDir = `${userDataDir}/downloads`;

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
        onComplete?: (status: string) => void
      ) => {
        if (typeof onComplete === 'function') {
          onComplete('✅ Done');
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
    importSettingsFromFileMock: vi.fn(async () => true),
    showOpenDialogMock: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    openExternalMock: vi.fn(async () => {}),
    openPathMock: vi.fn(async () => ''),
    showItemInFolderMock: vi.fn(),
    notificationIsSupportedMock: vi.fn(() => true),
    notificationShowMock: vi.fn(),
    notificationOnMock: vi.fn(),
    checkForUpdatesMock: vi.fn(async () => ({ ok: true })),
    downloadUpdateMock: vi.fn(async () => ({ success: true })),
    cancelUpdateDownloadMock: vi.fn(),
    installUpdateMock: vi.fn(),
    checkDenoInstalledMock: vi.fn(async () => true),
    installDenoMock: vi.fn(async () => ({ success: true })),
    detectGpuMock: vi.fn(async () => ({ nvidia: false, amd: false, intel: false })),
    fetchFormatsMock: vi.fn(async () => 'ok'),
    cancelFormatsMock: vi.fn(),
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
    show = notificationShowMock;
  },
}));

vi.mock('../main/platform', () => ({
  isPackaged: true,
  resolveYtdlpPath: vi.fn(() => 'C:/tools/yt-dlp.exe'),
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
}));

vi.mock('../main/constants', () => ({
  SPLASH_SHOW_DELAY_MS: 0,
  SPLASH_FADE_DELAY_MS: 0,
  MAX_QUEUE_SIZE: 500,
  CURRENT_SETTINGS_VERSION: 2,
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
  importSettingsFromFileMock.mockResolvedValue(true);
  showOpenDialogMock.mockClear();
  showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });
  openExternalMock.mockClear();
  openExternalMock.mockResolvedValue(undefined);
  openPathMock.mockClear();
  openPathMock.mockResolvedValue('');
  showItemInFolderMock.mockClear();
  notificationIsSupportedMock.mockClear();
  notificationIsSupportedMock.mockReturnValue(true);
  notificationShowMock.mockClear();
  notificationOnMock.mockClear();
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

    const addResult = await addToQueue({}, ['https://example.com/a', 'invalid-url']);
    expect(addResult).toEqual({ ok: true, data: { added: 1 } });

    let queue = await getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].status).toBe('pending');

    const removeMissingResult = await removeFromQueue({}, 'missing-id');
    expect(removeMissingResult).toEqual({
      ok: false,
      error: { code: 'NOT_AVAILABLE', message: 'Queue item not found.' },
    });

    const startResult = await startQueue();
    expect(startResult).toEqual({ ok: true, data: { started: true } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(startDownloadMock).toHaveBeenCalled();

    queue = await getQueue();
    expect(queue[0].status).toBe('completed');

    const secondAdd = await addToQueue({}, ['https://example.com/b', 'https://example.com/c']);
    expect(secondAdd).toEqual({ ok: true, data: { added: 2 } });

    const cancelResult = await cancelQueue();
    expect(cancelResult).toEqual({ ok: true, data: undefined });
    queue = await getQueue();
    const cancelledItems = queue.filter((item: { status: string }) => item.status === 'cancelled');
    expect(cancelledItems.length).toBeGreaterThanOrEqual(2);

    const clearResult = await clearQueue();
    expect(clearResult).toEqual({ ok: true, data: undefined });
    queue = await getQueue();
    expect(queue).toEqual([]);

    expect(await startQueue()).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'NOT_AVAILABLE' }),
      })
    );
  });

  it('rejects malformed queue input and ignores duplicate completion callbacks', async () => {
    expect(await handleHandlers['add-to-queue']!({}, 'not-array')).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      })
    );
    expect(await handleHandlers['add-to-queue']!({}, ['bad-url'])).toEqual(
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
        onComplete?: (status: string) => void
      ) => {
        onComplete?.('✅ Done');
        onComplete?.('❌ Too late');
      }
    );

    await handleHandlers['add-to-queue']!({}, ['https://example.com/settled']);
    expect(await handleHandlers['start-queue']!()).toEqual({ ok: true, data: { started: true } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const queue = (await handleHandlers['get-queue']!()) as Array<{ status: string }>;
    expect(queue[0]?.status).toBe('completed');
  });

  it('covers queue limits, removal success, and active removal rejection', async () => {
    const addToQueue = handleHandlers['add-to-queue'];
    const getQueue = handleHandlers['get-queue'];
    const removeFromQueue = handleHandlers['remove-from-queue'];
    const startQueue = handleHandlers['start-queue'];

    const tooMany = Array.from({ length: 501 }, (_, index) => `https://example.com/${index}`);
    const limitResult = await addToQueue({}, tooMany);
    expect(limitResult).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'Queue limit reached (max 500 items).' }),
      })
    );

    await addToQueue({}, ['https://example.com/remove-me']);
    let queue = (await getQueue()) as Array<{ id: string; status: string }>;
    const removeResult = await removeFromQueue({}, queue[0]!.id);
    expect(removeResult).toEqual({ ok: true, data: undefined });
    expect(await getQueue()).toEqual([]);

    startDownloadMock.mockImplementationOnce(() => {});
    await addToQueue({}, ['https://example.com/active']);
    await startQueue();
    await new Promise((resolve) => setTimeout(resolve, 10));

    queue = (await getQueue()) as Array<{ id: string; status: string }>;
    expect(queue[0]!.status).toBe('downloading');
    const activeRemove = await removeFromQueue({}, queue[0]!.id);
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
    mainWindow.webContents.id = 1;

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

    await addToQueue({}, ['https://example.com/cancel-error']);
    await startQueue();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await cancelQueue();
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

    const invalid = await downloadVideo({}, { url: 'bad', outputPath: '' });
    expect(invalid).toEqual({
      ok: false,
      error: {
        code: 'INVALID_URL',
        message: 'Download URL must be a valid http/https URL.',
      },
    });

    const valid = await downloadVideo(
      {},
      { url: 'https://example.com/video', outputPath: 'C:/tmp' }
    );
    expect(valid).toEqual({ ok: true, data: { started: true } });
    expect(startDownloadMock).toHaveBeenCalled();

    const mainWindow = getPrimaryWindow();
    mainWindow.webContents.id = 3;
    const unauthorized = await downloadVideo(
      { sender: { id: 4 } },
      { url: 'https://example.com/video', outputPath: 'C:/tmp' }
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

    const result = await handleHandlers['download-video']!(
      {},
      { url: 'https://example.com/video', outputPath: 'C:/tmp' }
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );
  });

  it('rejects unsafe external links through validation', async () => {
    const openExternal = handleHandlers['open-external'];
    const invalid = await openExternal({}, 'javascript:alert(1)');
    expect(invalid).toEqual({
      ok: false,
      error: { code: 'INVALID_URL', message: 'Invalid external URL payload.' },
    });
  });

  it('handles settings and utility IPC requests', async () => {
    expect(await handleHandlers['get-app-version']!()).toBe('4.0.0-beta.2');
    expect(await handleHandlers['is-packaged']!()).toBe(true);
    expect(await handleHandlers['get-settings']!()).toEqual(
      expect.objectContaining({ convertFormat: 'mp4' })
    );
    expect(await handleHandlers['check-deno-installed']!()).toBe(true);
    expect(await handleHandlers['install-deno']!()).toEqual({ success: true });
    expect(await handleHandlers['detect-gpu']!()).toEqual({
      nvidia: false,
      amd: false,
      intel: false,
    });
    expect(await handleHandlers['get-stats']!()).toEqual({ totalDownloads: 0 });
    expect(await handleHandlers['reset-stats']!()).toEqual({ ok: true, data: undefined });
    expect(await handleHandlers['check-for-updates']!()).toEqual({ ok: true });
    expect(await handleHandlers['download-update']!()).toEqual({ success: true });

    const saveResult = await handleHandlers['save-settings']!({}, { theme: 'dark' });
    expect(saveResult).toEqual(
      expect.objectContaining({
        ok: true,
      })
    );
    expect(saveSettingsMock).toHaveBeenCalledWith({ theme: 'dark' }, expect.anything());

    saveSettingsMock.mockReturnValueOnce(false);
    const saveFailure = await handleHandlers['save-settings']!({}, { theme: 'dark' });
    expect(saveFailure).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );

    const invalidSave = await handleHandlers['save-settings']!({}, { theme: 'neon' });
    expect(invalidSave).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      })
    );
  });

  it('handles update and cancellation fire-and-forget IPC events', () => {
    onHandlers['cancel-update-download']!({});
    onHandlers['install-update']!({});
    onHandlers['cancel-formats']!({ sender: {} });
    onHandlers['cancel-download']!({ sender: {} });

    expect(cancelUpdateDownloadMock).toHaveBeenCalled();
    expect(installUpdateMock).toHaveBeenCalled();
    expect(cancelFormatsMock).toHaveBeenCalled();
    expect(cancelActiveSessionMock).toHaveBeenCalledWith(true);
  });

  it('ignores unauthorized cancellation events and catches cancel errors', () => {
    const mainWindow = getPrimaryWindow();
    mainWindow.webContents.id = 10;

    onHandlers['cancel-formats']!({ sender: { id: 11 } });
    onHandlers['cancel-download']!({ sender: { id: 11 } });

    expect(cancelFormatsMock).not.toHaveBeenCalled();
    expect(cancelActiveSessionMock).not.toHaveBeenCalled();

    cancelActiveSessionMock.mockImplementationOnce(() => {
      throw new Error('cancel failed');
    });

    expect(() => onHandlers['cancel-download']!({ sender: { id: 10 } })).not.toThrow();
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
    mainWindow.destroy();

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
    const openResult = await handleHandlers['open-external']!({}, 'https://example.com');
    expect(openResult).toEqual({ ok: true, data: { opened: true } });
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com');

    openExternalMock.mockRejectedValueOnce(new Error('blocked'));
    const openFailure = await handleHandlers['open-external']!({}, 'https://example.com');
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
    expect(await handleHandlers['select-download-location']!()).toBe('C:/Downloads');

    showOpenDialogMock.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });
    expect(await handleHandlers['select-download-location']!()).toBeNull();

    showOpenDialogMock.mockRejectedValueOnce(new Error('dialog failed'));
    expect(await handleHandlers['select-download-location']!()).toBeNull();

    for (const windowRef of BrowserWindowMock.getAllWindows() as unknown as MockWindow[]) {
      windowRef.destroy();
    }
    expect(await handleHandlers['select-download-location']!()).toBeNull();

    expect(await handleHandlers['getFormats']!({}, 'https://example.com/video')).toEqual({
      ok: true,
      data: 'ok',
    });

    const invalidFormats = await handleHandlers['getFormats']!({}, 'not-a-url');
    expect(invalidFormats).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INVALID_URL' }),
      })
    );

    fetchFormatsMock.mockRejectedValueOnce('Format fetch cancelled.');
    const cancelledFormats = await handleHandlers['getFormats']!({}, 'https://example.com/video');
    expect(cancelledFormats).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'NOT_AVAILABLE' }),
      })
    );

    fetchFormatsMock.mockRejectedValueOnce(new Error('yt-dlp failed'));
    const failedFormats = await handleHandlers['getFormats']!({}, 'https://example.com/video');
    expect(failedFormats).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );

    fetchFormatsMock.mockRejectedValueOnce({});
    const unknownFailure = await handleHandlers['getFormats']!({}, 'https://example.com/video');
    expect(unknownFailure).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch formats.',
        }),
      })
    );
  });

  it('handles file location IPC branches', async () => {
    const userDataDir = appMock.getPath('userData');
    const filePath = path.join(userDataDir, 'downloads', 'video.mp4');
    fs.writeFileSync(filePath, '');

    const fileResult = await handleHandlers['open-file-location']!({}, filePath);
    expect(fileResult).toEqual({ ok: true, data: { opened: true } });
    expect(showItemInFolderMock).toHaveBeenCalledWith(filePath);

    const missingFilePath = path.join(userDataDir, 'downloads', 'missing.mp4');
    const dirResult = await handleHandlers['open-file-location']!({}, missingFilePath);
    expect(dirResult).toEqual({ ok: true, data: { opened: true } });
    expect(openPathMock).toHaveBeenCalledWith(path.dirname(missingFilePath));

    openPathMock.mockResolvedValueOnce('blocked');
    const dirFailure = await handleHandlers['open-file-location']!({}, missingFilePath);
    expect(dirFailure).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );

    const invalid = await handleHandlers['open-file-location']!({}, 'relative/path');
    expect(invalid).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INVALID_PATH' }),
      })
    );

    const missingDir = await handleHandlers['open-file-location']!(
      {},
      path.join(userDataDir, 'absent', 'file.mp4')
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
    const shellFailure = await handleHandlers['open-file-location']!({}, filePath);
    expect(shellFailure).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );
  });

  it('handles notification IPC branches and click behavior', async () => {
    const mainWindow = getPrimaryWindow();
    const result = await handleHandlers['show-notification']!(
      {},
      {
        title: 'Done',
        body: 'Saved',
        filePath: 'C:/tmp/video.mp4',
      }
    );
    expect(result).toEqual({ ok: true, data: { shown: true } });
    expect(notificationShowMock).toHaveBeenCalled();

    const clickHandler = notificationOnMock.mock.calls.find((call) => call[0] === 'click')?.[1] as
      | (() => void)
      | undefined;
    expect(clickHandler).toBeTypeOf('function');
    mainWindow.minimized = true;
    clickHandler?.();
    expect(mainWindow.restore).toHaveBeenCalled();
    expect(mainWindow.focus).toHaveBeenCalled();
    expect(showItemInFolderMock).toHaveBeenCalledWith('C:/tmp/video.mp4');

    expect(await handleHandlers['show-notification']!({}, {})).toEqual({
      ok: true,
      data: { shown: true },
    });

    showItemInFolderMock.mockImplementationOnce(() => {
      throw new Error('click failed');
    });
    await handleHandlers['show-notification']!({}, { title: 'Click', filePath: 'C:/tmp/fail.mp4' });
    const lastClickHandler = notificationOnMock.mock.calls
      .filter((call) => call[0] === 'click')
      .at(-1)?.[1] as (() => void) | undefined;
    expect(() => lastClickHandler?.()).not.toThrow();

    notificationIsSupportedMock.mockReturnValueOnce(false);
    const unsupported = await handleHandlers['show-notification']!({}, { title: 'Nope' });
    expect(unsupported).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'NOT_SUPPORTED' }),
      })
    );

    const invalid = await handleHandlers['show-notification']!({}, { title: 123 });
    expect(invalid).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      })
    );

    notificationShowMock.mockImplementationOnce(() => {
      throw new Error('notify failed');
    });
    const showFailure = await handleHandlers['show-notification']!({}, { title: 'Fail' });
    expect(showFailure).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );
  });

  it('handles settings import/export and restart/reset events', async () => {
    expect(await handleHandlers['export-settings']!()).toEqual({
      ok: true,
      data: { exported: true },
    });
    expect(await handleHandlers['import-settings']!()).toEqual({
      ok: true,
      data: { imported: true },
    });

    exportSettingsToFileMock.mockResolvedValueOnce(false);
    importSettingsFromFileMock.mockResolvedValueOnce(false);

    expect(await handleHandlers['export-settings']!()).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );
    expect(await handleHandlers['import-settings']!()).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );

    exportSettingsToFileMock.mockRejectedValueOnce(new Error('export failed'));
    importSettingsFromFileMock.mockRejectedValueOnce(new Error('import failed'));

    expect(await handleHandlers['export-settings']!()).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );
    expect(await handleHandlers['import-settings']!()).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      })
    );

    await handleHandlers['restart-app']!();
    expect(appMock.relaunch).toHaveBeenCalled();
    expect(appMock.exit).toHaveBeenCalledWith(0);

    appMock.relaunch.mockClear();
    appMock.exit.mockClear();
    const mainWindow = getPrimaryWindow();
    mainWindow.webContents.id = 20;
    onHandlers['reset-settings']!({ sender: { id: 21 } });
    expect(appMock.relaunch).not.toHaveBeenCalled();

    saveSettingsMock.mockReturnValueOnce(false);
    onHandlers['reset-settings']!({ sender: { id: 20 } });
    expect(appMock.relaunch).toHaveBeenCalled();
    expect(appMock.exit).toHaveBeenCalled();

    saveSettingsMock.mockImplementationOnce(() => {
      throw new Error('reset failed');
    });
    onHandlers['reset-settings']!({ sender: { id: 20 } });
    expect(appMock.relaunch).toHaveBeenCalledTimes(2);

    resetStatsMock.mockReturnValueOnce(false);
    expect(await handleHandlers['reset-stats']!()).toEqual(
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

    mainWindow.destroy();
    const countBeforeSecondInstance = BrowserWindowMock.getAllWindows().length;
    appOnHandlers['second-instance']!();
    expect(BrowserWindowMock.getAllWindows().length).toBeGreaterThan(countBeforeSecondInstance);

    appOnHandlers['window-all-closed']!();
    expect(appMock.quit).toHaveBeenCalled();

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
      windowRef.destroy();
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

    expect(await handleHandlers['get-queue']!()).toEqual([]);
  });

  it('recreates queue directory when persisting queue', async () => {
    const userDataDir = appMock.getPath('userData');
    fs.rmSync(userDataDir, { recursive: true, force: true });

    await handleHandlers['add-to-queue']!({}, ['https://example.com/recreate-dir']);

    expect(fs.existsSync(path.join(userDataDir, 'download-queue.json'))).toBe(true);
  });

  it('cleans up temp queue file when queue persist fails', async () => {
    const userDataDir = appMock.getPath('userData');
    const tempQueuePath = path.join(userDataDir, 'download-queue.json.tmp');
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed');
    });

    try {
      await handleHandlers['add-to-queue']!({}, ['https://example.com/persist-fail']);
      expect(fs.existsSync(tempQueuePath)).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('marks queued item failed when processing without a live window', async () => {
    await handleHandlers['add-to-queue']!({}, ['https://example.com/window-closed']);
    const mainWindow = getPrimaryWindow();
    mainWindow.destroy();

    expect(await handleHandlers['start-queue']!()).toEqual({ ok: true, data: { started: true } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const queue = (await handleHandlers['get-queue']!()) as Array<{
      status: string;
      error?: string;
    }>;
    expect(queue[0]).toEqual(expect.objectContaining({ status: 'failed', error: 'Window closed' }));
  });
});
