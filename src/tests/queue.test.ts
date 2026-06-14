import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  handleHandlers,
  sendMock,
  appMock,
  BrowserWindowMock,
  startDownloadMock,
  cancelActiveSessionMock,
  loadSettingsMock,
  getCurrentYtdlpFixturePath,
  resetTestPaths,
} = vi.hoisted(() => {
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  const { randomBytes } = require('crypto') as typeof import('crypto');
  const handleMap: Record<string, (...args: unknown[]) => unknown> = {};
  const send = vi.fn();
  const windows: Array<{
    destroyed: boolean;
    webContents: {
      send: (...args: unknown[]) => void;
      setWindowOpenHandler: (...args: unknown[]) => void;
      on: (...args: unknown[]) => void;
      id: number;
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
    webContents = {
      send,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
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
      if (event === 'ready-to-show') setTimeout(callback, 0);
    });
    isMinimized = () => false;
    restore = vi.fn();

    static getAllWindows() {
      return windows.filter((w) => !w.destroyed);
    }

    static getFocusedWindow() {
      const available = windows.filter((w) => !w.destroyed);
      return available.length > 0 ? available[available.length - 1] : null;
    }
  }

  function createTestPaths() {
    const userDataDir = nodePath.join(
      nodeOs.tmpdir(),
      `rosi-queue-test-${randomBytes(8).toString('hex')}`
    );
    return {
      userDataDir,
      downloadsDir: nodePath.join(userDataDir, 'downloads'),
      ytdlpFixturePath: nodePath.join(userDataDir, 'yt-dlp.exe'),
    };
  }

  let currentPaths = createTestPaths();

  const app = {
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    quit: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
    getPath: vi.fn((name: string) => {
      if (name === 'downloads') return currentPaths.downloadsDir;
      return currentPaths.userDataDir;
    }),
    getVersion: vi.fn(() => '4.0.0'),
    getAppPath: vi.fn(() => process.cwd()),
  };

  return {
    handleHandlers: handleMap,
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
    loadSettingsMock: vi.fn(() => ({
      convertEnabled: false,
      convertFormat: 'mp4',
      keepOriginalAfterConvert: true,
      ffmpegPath: '',
    })),
    getCurrentYtdlpFixturePath: () => currentPaths.ytdlpFixturePath,
    resetTestPaths: () => {
      currentPaths = createTestPaths();
      return currentPaths;
    },
  };
});

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: BrowserWindowMock,
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleHandlers[channel] = handler;
    }),
    on: vi.fn(),
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
  resolveYtdlpPath: vi.fn(() => getCurrentYtdlpFixturePath()),
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
  canStartDownload: vi.fn(() => true),
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
  for (const key of Object.keys(handleHandlers)) delete handleHandlers[key];
}

function destroyAllBrowserWindows() {
  for (const window of BrowserWindowMock.getAllWindows()) {
    window.destroy();
  }
}

function resetDownloadMocks() {
  startDownloadMock.mockReset();
  startDownloadMock.mockImplementation(
    (
      _ytdlpPath: string,
      _sender: unknown,
      _options: unknown,
      _mainWindow: unknown,
      onComplete?: (status: string, outcome: string) => void
    ) => {
      if (typeof onComplete === 'function') onComplete('✅ Done', 'success');
    }
  );
  cancelActiveSessionMock.mockReset();
}

async function waitForAuthorizedHandlers() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const getQueue = handleHandlers['get-queue'];
    if (getQueue) {
      const result = await getQueue(queueEvent);
      if (Array.isArray(result)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('IPC handlers were not ready after module init');
}

async function initializeMainModule() {
  resetTestPaths();
  const userDataDir = appMock.getPath('userData');
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(userDataDir, 'downloads'), { recursive: true });
  destroyAllBrowserWindows();
  clearHandlerMaps();
  sendMock.mockClear();
  resetDownloadMocks();
  const ytdlpFixturePath = getCurrentYtdlpFixturePath();
  fs.mkdirSync(path.dirname(ytdlpFixturePath), { recursive: true });
  fs.writeFileSync(ytdlpFixturePath, '');
  vi.resetModules();
  await import('../main/main');
  await appMock.whenReady.mock.results.at(-1)?.value;
  await waitForAuthorizedHandlers();
}

async function reloadMainModulePreservingUserData() {
  destroyAllBrowserWindows();
  clearHandlerMaps();
  sendMock.mockClear();
  const ytdlpFixturePath = getCurrentYtdlpFixturePath();
  fs.mkdirSync(path.dirname(ytdlpFixturePath), { recursive: true });
  fs.writeFileSync(ytdlpFixturePath, '');
  vi.resetModules();
  await import('../main/main');
  await appMock.whenReady.mock.results.at(-1)?.value;
  await waitForAuthorizedHandlers();
}

async function getAuthorizedQueue(options?: { minLength?: number }) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await handleHandlers['get-queue']!(queueEvent);
    if (Array.isArray(result)) {
      if (options?.minLength !== undefined && result.length < options.minLength) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('get-queue never returned an authorized queue array');
}

async function flushScheduledQueuePersist() {
  await vi.advanceTimersByTimeAsync(300);
  await vi.runOnlyPendingTimersAsync();
}

function readPersistedQueueFile() {
  const queuePath = path.join(appMock.getPath('userData'), 'download-queue.json');
  expect(fs.existsSync(queuePath)).toBe(true);
  return JSON.parse(fs.readFileSync(queuePath, 'utf8')) as Array<{ url: string }>;
}

const queueEvent = { sender: { id: 1 } };

describe('queue edge cases and error handling', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    await initializeMainModule();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects adding non-array urls', async () => {
    const addToQueue = handleHandlers['add-to-queue']!;
    const result = await addToQueue({ sender: { id: 1 } }, 'not-an-array');
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      })
    );
  });

  it('rejects adding when all URLs are invalid', async () => {
    const addToQueue = handleHandlers['add-to-queue']!;
    const result = await addToQueue({ sender: { id: 1 } }, ['not-a-url', 'ftp://bad', '']);
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'No valid URLs provided.' }),
      })
    );
  });

  it('filters valid URLs from a mixed batch', async () => {
    const addToQueue = handleHandlers['add-to-queue']!;
    const result = await addToQueue({ sender: { id: 1 } }, [
      'https://example.com/a',
      'invalid',
      'https://example.com/b',
    ]);
    expect(result).toEqual({ ok: true, data: { added: 2 } });
  });

  it('rejects start-queue when no pending items', async () => {
    const startQueue = handleHandlers['start-queue']!;
    const result = await startQueue(queueEvent);
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'NOT_AVAILABLE' }),
      })
    );
  });

  it('rejects start-queue when already running', async () => {
    const addToQueue = handleHandlers['add-to-queue']!;
    const startQueue = handleHandlers['start-queue']!;

    startDownloadMock.mockImplementationOnce(() => {});

    await addToQueue({ sender: { id: 1 } }, ['https://example.com/a']);
    await startQueue(queueEvent);

    await addToQueue({ sender: { id: 1 } }, ['https://example.com/b']);
    const result = await startQueue(queueEvent);
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      })
    );
  });

  it('rejects removing a non-existent queue item', async () => {
    const removeFromQueue = handleHandlers['remove-from-queue']!;
    const result = await removeFromQueue({ sender: { id: 1 } }, 'nonexistent-id');
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'NOT_AVAILABLE' }),
      })
    );
  });

  it('rejects removing non-string id', async () => {
    const removeFromQueue = handleHandlers['remove-from-queue']!;
    const result = await removeFromQueue({ sender: { id: 1 } }, 42);
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      })
    );
  });

  it('clears queue and cancels active session when running', async () => {
    const addToQueue = handleHandlers['add-to-queue']!;
    const startQueue = handleHandlers['start-queue']!;
    const clearQueue = handleHandlers['clear-queue']!;

    startDownloadMock.mockImplementationOnce(() => {});

    await addToQueue({ sender: { id: 1 } }, ['https://example.com/a']);
    await startQueue(queueEvent);

    const result = await clearQueue(queueEvent);
    expect(result).toEqual({ ok: true, data: undefined });

    const queue = await handleHandlers['get-queue']!(queueEvent);
    expect(queue).toEqual([]);
  });

  it('processes multiple queue items sequentially to completion', async () => {
    const addToQueue = handleHandlers['add-to-queue']!;
    const startQueue = handleHandlers['start-queue']!;
    const getQueue = handleHandlers['get-queue']!;

    await addToQueue({ sender: { id: 1 } }, [
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
    ]);

    await startQueue(queueEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const queue = (await getQueue(queueEvent)) as Array<{ status: string }>;
    const completed = queue.filter((item) => item.status === 'completed');
    expect(completed.length).toBe(3);
    expect(startDownloadMock).toHaveBeenCalledTimes(3);
  });

  it('marks queue item as failed when startDownload throws', async () => {
    const addToQueue = handleHandlers['add-to-queue']!;
    const startQueue = handleHandlers['start-queue']!;
    const getQueue = handleHandlers['get-queue']!;

    startDownloadMock.mockImplementationOnce(() => {
      throw new Error('spawn error');
    });

    await addToQueue({ sender: { id: 1 } }, ['https://example.com/will-fail']);

    await startQueue(queueEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const queue = (await getQueue(queueEvent)) as Array<{ status: string; error?: string }>;
    expect(queue[0]!.status).toBe('failed');
    expect(queue[0]!.error).toContain('spawn error');
  });

  it('marks queue item as failed on non-success completion message', async () => {
    const addToQueue = handleHandlers['add-to-queue']!;
    const startQueue = handleHandlers['start-queue']!;
    const getQueue = handleHandlers['get-queue']!;

    startDownloadMock.mockImplementationOnce(
      (
        _ytdlpPath: string,
        _sender: unknown,
        _options: unknown,
        _mainWindow: unknown,
        onComplete?: (status: string, outcome: string) => void
      ) => {
        if (typeof onComplete === 'function') onComplete('❌ Download failed.', 'failed');
      }
    );

    await addToQueue({ sender: { id: 1 } }, ['https://example.com/fail']);
    await startQueue(queueEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const queue = (await getQueue(queueEvent)) as Array<{ status: string; error?: string }>;
    expect(queue[0]!.status).toBe('failed');
    expect(queue[0]!.error).toContain('failed');
  });

  it('marks queue item as cancelled on cancel completion message', async () => {
    const addToQueue = handleHandlers['add-to-queue']!;
    const startQueue = handleHandlers['start-queue']!;
    const getQueue = handleHandlers['get-queue']!;

    startDownloadMock.mockImplementationOnce(
      (
        _ytdlpPath: string,
        _sender: unknown,
        _options: unknown,
        _mainWindow: unknown,
        onComplete?: (status: string, outcome: string) => void
      ) => {
        if (typeof onComplete === 'function') onComplete('⏹️ Cancelled.', 'cancelled');
      }
    );

    await addToQueue({ sender: { id: 1 } }, ['https://example.com/cancel']);
    await startQueue(queueEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const queue = (await getQueue(queueEvent)) as Array<{ status: string }>;
    expect(queue[0]!.status).toBe('cancelled');
  });

  it('cancel-queue marks pending and downloading items as cancelled', async () => {
    const addToQueue = handleHandlers['add-to-queue']!;
    const startQueue = handleHandlers['start-queue']!;
    const cancelQueue = handleHandlers['cancel-queue']!;
    const getQueue = handleHandlers['get-queue']!;

    startDownloadMock.mockImplementation(() => {});

    await addToQueue({ sender: { id: 1 } }, ['https://example.com/a', 'https://example.com/b']);
    await startQueue(queueEvent);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await cancelQueue(queueEvent);

    const queue = (await getQueue(queueEvent)) as Array<{ status: string }>;
    const allCancelledOrDownloading = queue.every(
      (item) => item.status === 'cancelled' || item.status === 'downloading'
    );
    expect(allCancelledOrDownloading).toBe(true);
    expect(cancelActiveSessionMock).toHaveBeenCalled();
  });

  it('persists queue to disk and restores on re-init', async () => {
    vi.useFakeTimers();
    const addToQueue = handleHandlers['add-to-queue']!;
    await addToQueue({ sender: { id: 1 } }, ['https://example.com/persisted']);
    await flushScheduledQueuePersist();

    const persisted = readPersistedQueueFile();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.url).toBe('https://example.com/persisted');

    vi.clearAllTimers();
    vi.useRealTimers();

    const queue1 = (await handleHandlers['get-queue']!(queueEvent)) as Array<{ url: string }>;
    expect(queue1).toHaveLength(1);
    expect(queue1[0]!.url).toBe('https://example.com/persisted');

    await reloadMainModulePreservingUserData();

    const queue2 = (await getAuthorizedQueue({ minLength: 1 })) as Array<{ url: string }>;
    expect(queue2).toHaveLength(1);
    expect(queue2[0]!.url).toBe('https://example.com/persisted');
  });

  it('restores queue from backup when primary is corrupted', async () => {
    vi.useFakeTimers();
    await handleHandlers['clear-queue']!({ sender: { id: 1 } });
    await flushScheduledQueuePersist();
    const addToQueue = handleHandlers['add-to-queue']!;
    await addToQueue({ sender: { id: 1 } }, ['https://example.com/backup-test']);
    await flushScheduledQueuePersist();
    vi.useRealTimers();

    const queuePath = path.join(appMock.getPath('userData'), 'download-queue.json');
    fs.writeFileSync(queuePath, '{invalid json}');

    await reloadMainModulePreservingUserData();

    const queue = (await getAuthorizedQueue({ minLength: 1 })) as Array<{ url: string }>;
    expect(queue).toHaveLength(1);
    expect(queue[0]!.url).toBe('https://example.com/backup-test');
  });

  it('returns empty queue when both primary and backup are corrupted', async () => {
    const userDataDir = appMock.getPath('userData');
    const queuePath = path.join(userDataDir, 'download-queue.json');
    const backupPath = path.join(userDataDir, 'download-queue.backup.json');

    fs.writeFileSync(queuePath, '{bad}');
    fs.writeFileSync(backupPath, '{also bad}');

    await reloadMainModulePreservingUserData();

    const queue = await getAuthorizedQueue();
    expect(queue).toEqual([]);
  });

  it('resets downloading status to pending on queue restore', async () => {
    const userDataDir = appMock.getPath('userData');
    const queuePath = path.join(userDataDir, 'download-queue.json');

    const staleQueue = [
      { id: 'q_1', url: 'https://example.com/stale', status: 'downloading', addedAt: Date.now() },
    ];
    fs.writeFileSync(queuePath, JSON.stringify(staleQueue));

    await reloadMainModulePreservingUserData();

    const queue = (await getAuthorizedQueue({ minLength: 1 })) as Array<{ status: string }>;
    expect(queue[0]!.status).toBe('pending');
  });
});
