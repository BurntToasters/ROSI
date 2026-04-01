import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  handleHandlers,
  onHandlers,
  sendMock,
  appMock,
  BrowserWindowMock,
  startDownloadMock,
  cancelActiveSessionMock,
  loadSettingsMock,
} = vi.hoisted(() => {
  const handleMap: Record<string, (...args: unknown[]) => unknown> = {};
  const onMap: Record<string, (...args: unknown[]) => unknown> = {};
  const send = vi.fn();
  const windows: Array<{
    destroyed: boolean;
    minimized: boolean;
    webContents: {
      send: (...args: unknown[]) => void;
      setWindowOpenHandler: (...args: unknown[]) => void;
      on: (...args: unknown[]) => void;
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
  }> = [];

  class BrowserWindowClass {
    destroyed = false;
    minimized = false;
    webContents = {
      send,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
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
    on: vi.fn(),
    quit: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
    getPath: vi.fn((name: string) => {
      if (name === 'downloads') return downloadsDir;
      return userDataDir;
    }),
    getVersion: vi.fn(() => '4.0.0-beta.2'),
  };

  return {
    handleHandlers: handleMap,
    onHandlers: onMap,
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
    loadSettingsMock: vi.fn(() => ({
      convertEnabled: false,
      convertFormat: 'mp4',
      keepOriginalAfterConvert: true,
      ffmpegPath: '',
    })),
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
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showErrorBox: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(async () => {}),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
  },
  Notification: class {
    constructor() {}
    static isSupported() {
      return true;
    }
    on = vi.fn();
    show = vi.fn();
  },
}));

vi.mock('../main/platform', () => ({
  isPackaged: true,
  resolveYtdlpPath: vi.fn(() => 'C:/tools/yt-dlp.exe'),
  verifyBundledFfmpeg: vi.fn(),
}));

vi.mock('../main/settings', () => ({
  loadSettings: loadSettingsMock,
  saveSettings: vi.fn(() => true),
  getDefaultSettings: vi.fn(() => ({})),
  loadStats: vi.fn(() => ({ totalDownloads: 0 })),
  resetStats: vi.fn(() => true),
  exportSettingsToFile: vi.fn(async () => true),
  importSettingsFromFile: vi.fn(async () => true),
}));

vi.mock('../main/updater', () => ({
  setupAutoUpdater: vi.fn(),
  checkForUpdates: vi.fn(async () => ({ ok: true })),
  downloadUpdate: vi.fn(async () => ({ success: true })),
  cancelUpdateDownload: vi.fn(),
  installUpdate: vi.fn(),
}));

vi.mock('../main/deno', () => ({
  checkDenoInstalled: vi.fn(async () => true),
  installDeno: vi.fn(async () => ({ success: true })),
}));

vi.mock('../main/gpu', () => ({
  detectGpu: vi.fn(async () => ({ nvidia: false, amd: false, intel: false })),
}));

vi.mock('../main/downloader', () => ({
  startDownload: startDownloadMock,
  cancelActiveSession: cancelActiveSessionMock,
  killAllProcesses: vi.fn(),
  fetchFormats: vi.fn(async () => 'ok'),
  cancelFormats: vi.fn(),
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
}

async function initializeMainModule() {
  const userDataDir = appMock.getPath('userData');
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(userDataDir, 'downloads'), { recursive: true });
  clearHandlerMaps();
  sendMock.mockClear();
  startDownloadMock.mockClear();
  cancelActiveSessionMock.mockClear();
  vi.resetModules();
  await import('../main/main');
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('main process IPC wiring and queue behavior', () => {
  beforeEach(async () => {
    await initializeMainModule();
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
  });

  it('rejects unsafe external links through validation', async () => {
    const openExternal = handleHandlers['open-external'];
    const invalid = await openExternal({}, 'javascript:alert(1)');
    expect(invalid).toEqual({
      ok: false,
      error: { code: 'INVALID_URL', message: 'Invalid external URL payload.' },
    });
  });
});
