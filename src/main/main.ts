import { app, BrowserWindow, ipcMain, dialog, shell, Notification } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import log from 'electron-log/main';
import { isPackaged, resolveYtdlpPath, verifyBundledFfmpeg } from './platform';
import {
  loadSettings,
  saveSettings,
  getDefaultSettings,
  loadStats,
  resetStats,
  exportSettingsToFile,
  importSettingsFromFile,
} from './settings';
import {
  setupAutoUpdater,
  checkForUpdates,
  downloadUpdate,
  cancelUpdateDownload,
  installUpdate,
} from './updater';
import { checkDenoInstalled, installDeno } from './deno';
import { detectGpu } from './gpu';
import {
  startDownload,
  cancelActiveSession,
  killAllProcesses,
  fetchFormats,
  cancelFormats,
} from './downloader';
import { isSafeExternalUrl, isSafeHttpUrl, isAllowedNavigationUrl } from '../utils/validation';
import {
  errorResult,
  okResult,
  validateDownloadRequestPayload,
  validateExternalUrlPayload,
  validateFileLocationPayload,
  validateNotificationPayload,
  validateSettingsPatchPayload,
} from '../utils/ipcValidation';
import { SPLASH_SHOW_DELAY_MS, SPLASH_FADE_DELAY_MS } from './constants';
import type { DownloadRequestOptions, QueueItem } from '../types';
import { isSafeHttpUrl as isSafeHttpUrlCheck } from '../utils/validation';

log.initialize();

process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});

const ytdlpPath = resolveYtdlpPath();

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;

function getMainWindow() {
  return mainWindow;
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 360,
    height: 360,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    icon: path.join(__dirname, '..', '..', 'src', 'renderer', 'app.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
    roundedCorners: true,
  });
  splashWindow.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'splash.html'));
  splashWindow.center();
}

function createWindow() {
  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 900,
    minHeight: 700,
    maxWidth: 1800,
    maxHeight: 1400,
    icon: path.join(__dirname, '..', '..', 'src', 'renderer', 'app.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: isDev,
    },
    autoHideMenuBar: !isDev,
    show: false,
  });
  mainWindow.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch((err) => {
        log.error('Failed to open external URL:', err);
      });
    }
    return { action: 'deny' as const };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigationUrl(url)) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) {
        shell.openExternal(url).catch((err) => {
          log.error('Failed to open external URL:', err);
        });
      }
    }
  });

  mainWindow.setMenuBarVisibility(isDev);
  mainWindow.setAutoHideMenuBar(!isDev);

  if (!isDev) {
    mainWindow.removeMenu();
  }

  mainWindow.once('ready-to-show', () => {
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    }, SPLASH_FADE_DELAY_MS);
  });
}

app.whenReady().then(() => {
  createSplashWindow();
  verifyBundledFfmpeg();
  setTimeout(() => {
    createWindow();
  }, SPLASH_SHOW_DELAY_MS);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  killAllProcesses();
});

setupAutoUpdater(getMainWindow, loadSettings);

ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('is-packaged', () => isPackaged);
ipcMain.handle('check-for-updates', () => checkForUpdates(isPackaged, loadSettings));
ipcMain.handle('download-update', () => downloadUpdate());
ipcMain.on('cancel-update-download', () => cancelUpdateDownload(getMainWindow));
ipcMain.on('install-update', () => installUpdate());

ipcMain.handle('check-deno-installed', () => checkDenoInstalled());
ipcMain.handle('install-deno', () => installDeno(mainWindow));

ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_, data) => {
  const validation = validateSettingsPatchPayload(data);
  if (!validation.ok) {
    return errorResult(validation.error.code, validation.error.message, validation.error.details);
  }

  const saved = saveSettings(validation.data, mainWindow);
  if (!saved) {
    return errorResult('INTERNAL_ERROR', 'Failed to persist settings.');
  }
  return okResult(loadSettings());
});

ipcMain.handle('detect-gpu', () => detectGpu());

ipcMain.on('reset-settings', () => {
  try {
    const saved = saveSettings(getDefaultSettings(), mainWindow);
    if (!saved) {
      log.error('Failed to save default settings during reset-settings.');
    }
    app.relaunch();
    app.exit();
  } catch (error) {
    log.error('Error resetting settings:', error);
    app.relaunch();
    app.exit();
  }
});

ipcMain.handle('open-external', async (_, url) => {
  const validation = validateExternalUrlPayload(url);
  if (!validation.ok) {
    return errorResult(validation.error.code, validation.error.message, validation.error.details);
  }

  try {
    await shell.openExternal(validation.data);
    return okResult({ opened: true });
  } catch (error) {
    log.error('Error in open-external handler:', error);
    return errorResult('INTERNAL_ERROR', 'Failed to open external URL.');
  }
});

ipcMain.handle('select-download-location', async () => {
  try {
    const defaultPath = app.getPath('downloads');
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const parentWindow =
      focusedWindow || (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
    if (!parentWindow) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog(parentWindow, {
      title: 'Select Download Folder',
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return canceled ? null : filePaths[0];
  } catch (error) {
    log.error('Error in select-download-location:', error);
    return null;
  }
});

ipcMain.handle('getFormats', (_, url) => {
  if (typeof url !== 'string' || !isSafeHttpUrl(url)) {
    return Promise.reject('Invalid URL provided');
  }
  return fetchFormats(ytdlpPath, url);
});
ipcMain.on('cancel-formats', () => cancelFormats());

ipcMain.handle('download-video', (event, options) => {
  const validation = validateDownloadRequestPayload(options);
  if (!validation.ok) {
    return errorResult(validation.error.code, validation.error.message, validation.error.details);
  }

  try {
    startDownload(ytdlpPath, event.sender, validation.data as DownloadRequestOptions, mainWindow);
    return okResult({ started: true });
  } catch (error) {
    log.error('Error in download-video handler:', error);
    return errorResult('INTERNAL_ERROR', 'Failed to start download.');
  }
});

ipcMain.on('cancel-download', () => {
  try {
    cancelActiveSession(true);
  } catch (error) {
    log.error('Error in cancel-download handler:', error);
  }
});

ipcMain.handle('restart-app', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('open-file-location', async (_, filePath) => {
  const validation = validateFileLocationPayload(filePath);
  if (!validation.ok) {
    return errorResult(validation.error.code, validation.error.message, validation.error.details);
  }

  try {
    if (fs.existsSync(validation.data)) {
      shell.showItemInFolder(validation.data);
      return okResult({ opened: true });
    }

    const dir = path.dirname(validation.data);
    if (fs.existsSync(dir)) {
      await shell.openPath(dir);
      return okResult({ opened: true });
    }

    return errorResult('INVALID_PATH', 'Path and containing directory do not exist.');
  } catch (error) {
    log.error('Error in open-file-location handler:', error);
    return errorResult('INTERNAL_ERROR', 'Failed to open file location.');
  }
});

ipcMain.handle('show-notification', (_, options) => {
  const validation = validateNotificationPayload(options);
  if (!validation.ok) {
    return errorResult(validation.error.code, validation.error.message, validation.error.details);
  }

  try {
    if (!Notification.isSupported()) {
      return errorResult('NOT_SUPPORTED', 'Notifications are not supported in this environment.');
    }

    const notification = new Notification({
      title: validation.data.title || 'ROSI',
      body: validation.data.body || '',
      icon: path.join(__dirname, '..', '..', 'src', 'renderer', 'app.png'),
      silent: false,
    });

    notification.on('click', () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
        if (validation.data.filePath) {
          shell.showItemInFolder(validation.data.filePath);
        }
      } catch (clickErr) {
        log.error('Error handling notification click:', clickErr);
      }
    });

    notification.show();
    return okResult({ shown: true });
  } catch (error) {
    log.error('Error showing notification:', error);
    return errorResult('INTERNAL_ERROR', 'Failed to show notification.');
  }
});

ipcMain.handle('export-settings', async () => {
  try {
    const parentWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const success = await exportSettingsToFile(parentWindow);
    if (!success) return errorResult('INTERNAL_ERROR', 'Export cancelled or failed.');
    return okResult({ exported: true });
  } catch (error) {
    log.error('Error exporting settings:', error);
    return errorResult('INTERNAL_ERROR', 'Failed to export settings.');
  }
});

ipcMain.handle('import-settings', async () => {
  try {
    const parentWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const success = await importSettingsFromFile(parentWindow);
    if (!success) return errorResult('INTERNAL_ERROR', 'Import cancelled or failed.');
    return okResult({ imported: true });
  } catch (error) {
    log.error('Error importing settings:', error);
    return errorResult('INTERNAL_ERROR', 'Failed to import settings.');
  }
});

ipcMain.handle('get-stats', () => loadStats());

ipcMain.handle('reset-stats', () => {
  const success = resetStats();
  if (!success) return errorResult('INTERNAL_ERROR', 'Failed to reset stats.');
  return okResult(undefined);
});

let downloadQueue: QueueItem[] = [];
let isQueueRunning = false;
let queueCancelled = false;

function generateQueueId(): string {
  return `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function broadcastQueue() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('queue-update', downloadQueue);
  }
}

async function processQueue() {
  if (!isQueueRunning) return;

  const nextItem = downloadQueue.find((item) => item.status === 'pending');
  if (!nextItem || queueCancelled) {
    isQueueRunning = false;
    queueCancelled = false;
    broadcastQueue();
    return;
  }

  nextItem.status = 'downloading';
  broadcastQueue();

  return new Promise<void>((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      nextItem.status = 'failed';
      nextItem.error = 'Window closed';
      broadcastQueue();
      resolve();
      return;
    }

    const settings = loadSettings();
    const options: DownloadRequestOptions = {
      url: nextItem.url,
      outputPath: app.getPath('downloads'),
      ffmpegPath: settings.ffmpegPath || undefined,
      convertFormat: settings.convertEnabled ? settings.convertFormat : undefined,
      keepOriginal: settings.convertEnabled ? settings.keepOriginalAfterConvert : undefined,
    };

    const completeListener = (
      _: Electron.IpcRendererEvent | Electron.Event,
      statusMessage: string
    ) => {
      mainWindow?.webContents.removeListener('ipc-message', ipcListener);
      const msg = String(statusMessage || '').toLowerCase();
      if (msg.includes('cancel')) {
        nextItem.status = 'cancelled';
      } else if (msg.includes('✅') || msg.includes('complete') || msg.includes('done')) {
        nextItem.status = 'completed';
      } else {
        nextItem.status = 'failed';
        nextItem.error = statusMessage;
      }
      broadcastQueue();
      if (isQueueRunning && !queueCancelled) {
        void processQueue().then(resolve);
      } else {
        resolve();
      }
    };

    const ipcListener = (_: Electron.Event, channel: string, ...args: unknown[]) => {
      if (channel === 'complete') {
        completeListener(_, args[0] as string);
      }
    };

    mainWindow.webContents.on('ipc-message', ipcListener);

    try {
      startDownload(ytdlpPath, mainWindow.webContents, options, mainWindow);
    } catch (error) {
      mainWindow?.webContents.removeListener('ipc-message', ipcListener);
      nextItem.status = 'failed';
      nextItem.error = (error as Error).message;
      broadcastQueue();
      if (isQueueRunning && !queueCancelled) {
        void processQueue().then(resolve);
      } else {
        resolve();
      }
    }
  });
}

ipcMain.handle('add-to-queue', (_, urls) => {
  if (!Array.isArray(urls)) {
    return errorResult('VALIDATION_ERROR', 'URLs must be an array.');
  }
  const validUrls = urls.filter((u): u is string => typeof u === 'string' && isSafeHttpUrlCheck(u));
  if (validUrls.length === 0) {
    return errorResult('VALIDATION_ERROR', 'No valid URLs provided.');
  }
  const newItems: QueueItem[] = validUrls.map((url) => ({
    id: generateQueueId(),
    url,
    status: 'pending' as const,
    addedAt: Date.now(),
  }));
  downloadQueue.push(...newItems);
  broadcastQueue();
  return okResult({ added: validUrls.length });
});

ipcMain.handle('remove-from-queue', (_, id) => {
  if (typeof id !== 'string') {
    return errorResult('VALIDATION_ERROR', 'Queue item ID must be a string.');
  }
  const idx = downloadQueue.findIndex((item) => item.id === id);
  if (idx === -1) return errorResult('NOT_AVAILABLE', 'Queue item not found.');
  if (downloadQueue[idx].status === 'downloading') {
    return errorResult('VALIDATION_ERROR', 'Cannot remove an actively downloading item.');
  }
  downloadQueue.splice(idx, 1);
  broadcastQueue();
  return okResult(undefined);
});

ipcMain.handle('clear-queue', () => {
  if (isQueueRunning) {
    queueCancelled = true;
    cancelActiveSession(true);
  }
  downloadQueue = downloadQueue.filter((item) => item.status === 'downloading');
  broadcastQueue();
  return okResult(undefined);
});

ipcMain.handle('get-queue', () => downloadQueue);

ipcMain.handle('start-queue', () => {
  const pending = downloadQueue.filter((item) => item.status === 'pending');
  if (pending.length === 0) {
    return errorResult('NOT_AVAILABLE', 'No pending items in queue.');
  }
  if (isQueueRunning) {
    return errorResult('VALIDATION_ERROR', 'Queue is already running.');
  }
  isQueueRunning = true;
  queueCancelled = false;
  void processQueue();
  return okResult({ started: true });
});

ipcMain.on('cancel-queue', () => {
  queueCancelled = true;
  isQueueRunning = false;
  cancelActiveSession(true);
  downloadQueue.forEach((item) => {
    if (item.status === 'pending' || item.status === 'downloading') {
      item.status = 'cancelled';
    }
  });
  broadcastQueue();
});
