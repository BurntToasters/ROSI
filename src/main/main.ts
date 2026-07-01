import { app, BrowserWindow, ipcMain, dialog, shell, Notification } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import log from 'electron-log/main.js';
import { isPackaged, initializeYtdlpPath, verifyBundledFfmpeg } from './platform';
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
  applyChannelFromSettings,
} from './updater';
import { checkDenoInstalled, installDeno } from './deno';
import { detectGpu } from './gpu';
import {
  startDownload,
  cancelActiveSession,
  killAllProcesses,
  fetchFormats,
  cancelFormats,
  canStartDownload,
  isDownloadBusy,
} from './downloader';
import { fetchVideoInfo, cancelVideoInfo } from './download/videoInfo';
import { isSafeExternalUrl, isSafeHttpUrl, isAllowedNavigationUrl } from '../utils/validation';
import {
  errorResult,
  okResult,
  validateDownloadRequestPayload,
  validateExternalUrlPayload,
  validateFileLocationPayload,
  validateNotificationPayload,
  validateSettingsPatchPayload,
  validateDownloadPath,
} from '../utils/ipcValidation';
import { SPLASH_SHOW_DELAY_MS, SPLASH_FADE_DELAY_MS, MAX_QUEUE_SIZE } from './constants';
import type { DownloadRequestOptions, DownloadOutcome, QueueItem } from '../types';

log.initialize();

process.setMaxListeners(48);

process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
  try {
    flushQueueOnShutdown();
  } catch {}
  try {
    killAllProcesses();
  } catch {}
  try {
    cancelFormats();
  } catch {}
  try {
    cancelVideoInfo();
  } catch {}
  try {
    dialog.showErrorBox(
      'Fatal Error',
      `ROSI encountered an unexpected error and must close.\n\n${error.message}`
    );
  } catch (dialogErr) {
    log.error('Failed to show error dialog:', dialogErr);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});

let ytdlpPath: string | null = null;
function getYtdlpPath(): string {
  if (!ytdlpPath) {
    throw new Error('yt-dlp path has not been initialized.');
  }
  return ytdlpPath;
}
const isSmokeRun = process.argv.includes('--smoke') || process.env.ROSI_SMOKE === '1';
const isPrimaryInstance =
  isSmokeRun || typeof app.requestSingleInstanceLock !== 'function'
    ? true
    : app.requestSingleInstanceLock();
const SETTINGS_FLUSH_TIMEOUT_MS = 1500;

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let mainWindowCloseInProgress = false;
let mainWindowCloseTimer: NodeJS.Timeout | null = null;
let appQuitting = false;
let isInstallingUpdate = false;
let renderProcessReloadCount = 0;

function getMainWindow() {
  return mainWindow;
}

function assertMainWindowSender(event?: { sender?: { id?: number } }): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  return event?.sender?.id === mainWindow.webContents.id;
}

function clearMainWindowCloseTimer() {
  if (mainWindowCloseTimer) {
    clearTimeout(mainWindowCloseTimer);
    mainWindowCloseTimer = null;
  }
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
      sandbox: true,
      webSecurity: true,
    },
    ...(process.platform === 'darwin' ? { roundedCorners: true } : {}),
  });
  void splashWindow.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'splash.html'));
  splashWindow.center();
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
  }, 30_000);
}

async function runRendererSmokeChecks(windowRef: BrowserWindow): Promise<string[]> {
  const script = `
    (async () => {
      const failures = [];
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const assert = (condition, message) => {
        if (!condition) failures.push(message);
      };

      try {
        assert(!!window.rosiModules, 'window.rosiModules is missing.');

        for (let i = 0; i < 5; i += 1) {
          const modalActive = document.getElementById('app-modal')?.classList.contains('active');
          const licensesActive = document
            .getElementById('licenses-overlay')
            ?.classList.contains('active');
          if (!modalActive && !licensesActive) break;
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await wait(120);
        }

        // Dismiss setup wizard if visible
        const wizardOverlay = document.getElementById('setup-wizard');
        if (wizardOverlay && wizardOverlay.classList.contains('active')) {
          const wizardNext = document.getElementById('wizard-next');
          for (let i = 0; i < 5 && wizardOverlay.classList.contains('active'); i++) {
            if (wizardNext) wizardNext.click();
            await wait(100);
          }
        }

        const sidebar = document.getElementById('sidebar');
        const settingsBtn = document.getElementById('settingsBtn');
        const closeSidebarBtn = document.getElementById('closeSidebar');
        const urlInput = document.getElementById('url');
        const downloadBtn = document.getElementById('downloadBtn');
        const queueSection = document.getElementById('queueSection');
        const queueCount = document.getElementById('queueCount');

        assert(!!sidebar, 'Missing #sidebar.');
        assert(!!settingsBtn, 'Missing #settingsBtn.');
        assert(!!closeSidebarBtn, 'Missing #closeSidebar.');
        assert(!!urlInput, 'Missing #url.');
        assert(!!downloadBtn, 'Missing #downloadBtn.');
        assert(!!queueSection, 'Missing #queueSection.');
        assert(!!queueCount, 'Missing #queueCount.');

        const urlLabel = document.querySelector('label[for="url"]');
        const queueLabel = document.querySelector('label[for="queueUrlInput"]');
        assert(!!urlLabel, 'Missing explicit label for #url.');
        assert(!!queueLabel, 'Missing explicit label for #queueUrlInput.');

        if (settingsBtn instanceof HTMLElement && sidebar instanceof HTMLElement) {
          settingsBtn.click();
          await wait(150);
          assert(sidebar.classList.contains('open'), 'Sidebar did not open from settings button.');
        }

        if (closeSidebarBtn instanceof HTMLElement && sidebar instanceof HTMLElement) {
          closeSidebarBtn.click();
          await wait(150);
          assert(!sidebar.classList.contains('open'), 'Sidebar did not close from close button.');
        }

        const isMac = navigator.platform.toLowerCase().includes('mac');
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: ',',
            bubbles: true,
            metaKey: isMac,
            ctrlKey: !isMac,
          })
        );
        await wait(150);
        if (sidebar instanceof HTMLElement) {
          assert(sidebar.classList.contains('open'), 'Sidebar did not open via keyboard shortcut.');
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(150);
        if (sidebar instanceof HTMLElement) {
          assert(!sidebar.classList.contains('open'), 'Sidebar did not close via Escape.');
        }

        if (urlInput instanceof HTMLInputElement && downloadBtn instanceof HTMLButtonElement) {
          urlInput.value = 'not-a-url';
          urlInput.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(180);
          assert(downloadBtn.disabled, 'Download button should be disabled for invalid URL.');

          urlInput.value = 'https://example.com/watch?v=smoke';
          urlInput.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(180);
          assert(!downloadBtn.disabled, 'Download button should be enabled for valid URL.');
        }

        if (window.api?.clearQueue && window.api?.addToQueue) {
          await window.api.clearQueue();
          const addResult = await window.api.addToQueue(['https://example.com/smoke']);
          assert(addResult && addResult.ok, 'addToQueue failed in smoke check.');
          await wait(220);
          const count = Number(queueCount?.textContent || '0');
          assert(count >= 1, 'Queue count did not update after addToQueue.');
          await window.api.clearQueue();
          await wait(180);
        } else {
          failures.push('window.api queue handlers are missing.');
        }
      } catch (error) {
        failures.push(
          'Smoke execution failed: ' +
            (error && typeof error === 'object' && 'message' in error
              ? String(error.message)
              : String(error))
        );
      }

      return failures;
    })();
  `;

  const result: unknown = await windowRef.webContents.executeJavaScript(script, true);
  if (!Array.isArray(result)) {
    return ['Smoke script returned an invalid response payload.'];
  }
  return result.filter((item): item is string => typeof item === 'string');
}

function createWindow() {
  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 900,
    minHeight: 700,
    icon: path.join(__dirname, '..', '..', 'src', 'renderer', 'app.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: isDev,
    },
    autoHideMenuBar: !isDev,
    show: false,
  });
  void mainWindow.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'));
  mainWindowCloseInProgress = false;
  clearMainWindowCloseTimer();

  mainWindow.on('close', (event) => {
    if (isSmokeRun || mainWindowCloseInProgress || isInstallingUpdate) {
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    // Warn the user if a download or queue is in progress.
    if (isDownloadBusy() || isQueueRunning) {
      event.preventDefault();
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Cancel', 'Close Anyway'],
        defaultId: 0,
        cancelId: 0,
        title: 'Download in Progress',
        message: 'A download is currently in progress.',
        detail: 'Closing ROSI now will cancel the active download. Are you sure?',
      });
      if (choice === 0) {
        return; // User chose Cancel — stay open.
      }
      // User chose to close — fall through to the flush logic.
    }

    event.preventDefault();
    mainWindowCloseInProgress = true;

    if (mainWindow.webContents.isDestroyed()) {
      mainWindow.destroy();
      return;
    }

    mainWindowCloseTimer = setTimeout(() => {
      log.warn('Timed out waiting for renderer settings flush. Closing window.');
      mainWindowCloseInProgress = false;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
      }
    }, SETTINGS_FLUSH_TIMEOUT_MS);

    mainWindow.webContents.send('prepare-for-close');
  });

  mainWindow.on('closed', () => {
    clearMainWindowCloseTimer();
    mainWindowCloseInProgress = false;
    isInstallingUpdate = false;
    if (process.platform === 'darwin' && !appQuitting) {
      stopActiveDownloadsAndQueue();
    }
    mainWindow = null;
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log.error(`Main window failed to load: ${errorCode} ${errorDescription}`);
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    dialog.showErrorBox(
      'Load Error',
      `ROSI failed to load the application window.\n\n${errorDescription}`
    );
    app.quit();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch((err) => {
        log.error('Failed to open external URL:', err);
      });
    }
    return { action: 'deny' as const };
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error(`Renderer process gone: ${details.reason} (exit code: ${details.exitCode})`);
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
      if (renderProcessReloadCount < 3) {
        renderProcessReloadCount += 1;
        mainWindow.reload();
        return;
      }
      dialog.showErrorBox(
        'Renderer Error',
        'The application window failed to recover after multiple reload attempts. Please restart ROSI.'
      );
    }
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigationUrl(url, app.getAppPath())) {
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
        if (!isSmokeRun) {
          mainWindow.focus();
          return;
        }
        void runRendererSmokeChecks(mainWindow)
          .then((failures) => {
            if (failures.length > 0) {
              log.error('Runtime smoke checks failed:', failures);
              app.exit(1);
              return;
            }
            log.info('Runtime smoke checks passed.');
            app.exit(0);
          })
          .catch((error) => {
            log.error('Runtime smoke checks encountered an error:', error);
            app.exit(1);
          });
      }
    }, SPLASH_FADE_DELAY_MS);
  });
}

if (isPrimaryInstance && !isSmokeRun) {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return;
    }

    if (app.isReady()) {
      createWindow();
    }
  });
}

void app.whenReady().then(async () => {
  if (!isPrimaryInstance) {
    app.quit();
    return;
  }

  ytdlpPath = await initializeYtdlpPath();
  const resolvedYtdlpPath = ytdlpPath;
  if (!fs.existsSync(resolvedYtdlpPath)) {
    dialog.showErrorBox(
      'Missing Dependency',
      `yt-dlp binary not found at ${resolvedYtdlpPath}.\nPlease ensure the yt-dlp binary is in the application's directory.`
    );
    app.quit();
    return;
  }

  if (!isSmokeRun) {
    createSplashWindow();
  }
  verifyBundledFfmpeg();
  setTimeout(
    () => {
      createWindow();
    },
    isSmokeRun ? 0 : SPLASH_SHOW_DELAY_MS
  );
});

app.on('window-all-closed', () => {
  const shouldQuit = process.platform !== 'darwin' || appQuitting;
  if (shouldQuit) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  appQuitting = true;
  flushQueueOnShutdown();
  try {
    killAllProcesses();
  } catch (error) {
    log.error('Error killing processes on quit:', error);
  }
  try {
    cancelFormats();
  } catch (error) {
    log.error('Error cancelling formats on quit:', error);
  }
  try {
    cancelVideoInfo();
  } catch (error) {
    log.error('Error cancelling video info on quit:', error);
  }
});

if (!process.windowsStore) {
  setupAutoUpdater(getMainWindow, loadSettings);
}

ipcMain.on('log-error', (_, message) => {
  if (typeof message === 'string') {
    const truncated = message.length > 2000 ? message.slice(0, 2000) + '...(truncated)' : message;
    log.error(`[renderer] ${truncated}`);
  }
});

ipcMain.on('settings-flush-complete', (event) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (!mainWindowCloseInProgress) {
    return;
  }
  if (event.sender.id !== mainWindow.webContents.id) {
    return;
  }

  clearMainWindowCloseTimer();
  mainWindow.destroy();
});

ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('is-packaged', () => isPackaged);
if (!process.windowsStore) {
  ipcMain.handle('check-for-updates', () => checkForUpdates(isPackaged, loadSettings));
  ipcMain.handle('download-update', () => downloadUpdate());
  ipcMain.on('cancel-update-download', () => cancelUpdateDownload(getMainWindow));
  ipcMain.on('install-update', (event) => {
    if (!assertMainWindowSender(event)) {
      return;
    }
    isInstallingUpdate = true;
    clearMainWindowCloseTimer();
    try {
      installUpdate();
      setTimeout(() => {
        if (isInstallingUpdate && mainWindow && !mainWindow.isDestroyed()) {
          isInstallingUpdate = false;
        }
      }, 8000);
    } catch (error) {
      isInstallingUpdate = false;
      log.error('Failed to install update:', error);
    }
  });
}

ipcMain.handle('check-deno-installed', (event) => {
  if (!assertMainWindowSender(event)) {
    return false;
  }
  return checkDenoInstalled();
});
ipcMain.handle('install-deno', (event) => {
  if (!assertMainWindowSender(event)) {
    return { error: 'Unauthorized sender.' };
  }
  return installDeno(mainWindow);
});

ipcMain.handle('get-settings', (event) => {
  if (!assertMainWindowSender(event)) {
    return getDefaultSettings();
  }
  return loadSettings();
});
ipcMain.handle('save-settings', (event, data) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
  const validation = validateSettingsPatchPayload(data);
  if (!validation.ok) {
    return errorResult(validation.error.code, validation.error.message, validation.error.details);
  }

  const saved = saveSettings(validation.data, mainWindow);
  if (!saved) {
    return errorResult('INTERNAL_ERROR', 'Failed to persist settings.');
  }
  const updated = loadSettings();
  if (!process.windowsStore && validation.data.updateChannel !== undefined) {
    applyChannelFromSettings(updated);
  }
  return okResult(updated);
});

ipcMain.handle('detect-gpu', (event) => {
  if (!assertMainWindowSender(event)) {
    return { nvidia: false, amd: false, intel: false };
  }
  return detectGpu();
});

ipcMain.on('reset-settings', (event) => {
  if (!assertMainWindowSender(event)) {
    return;
  }
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

ipcMain.handle('open-external', async (event, url) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
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

ipcMain.handle('select-download-location', async (event) => {
  if (!assertMainWindowSender(event)) {
    return null;
  }
  try {
    // Prefer the user's last-chosen folder over the generic Downloads dir.
    const settings = loadSettings();
    const savedFolder = settings.downloadFolder?.trim();
    const defaultPath =
      savedFolder && fs.existsSync(savedFolder) ? savedFolder : app.getPath('downloads');
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

ipcMain.handle('getFormats', async (event, url) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
  if (typeof url !== 'string' || !isSafeHttpUrl(url)) {
    return errorResult('INVALID_URL', 'Invalid URL provided.');
  }

  try {
    const formats = await fetchFormats(getYtdlpPath(), url);
    return okResult(formats);
  } catch (error) {
    const message =
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : 'Failed to fetch formats.';
    if (message.toLowerCase().includes('cancel')) {
      return errorResult('NOT_AVAILABLE', message);
    }
    return errorResult('INTERNAL_ERROR', message);
  }
});
ipcMain.on('cancel-formats', (event) => {
  if (!assertMainWindowSender(event)) {
    return;
  }
  cancelFormats();
});

ipcMain.handle('get-video-info', async (event, url) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
  if (typeof url !== 'string' || !isSafeHttpUrl(url)) {
    return errorResult('INVALID_URL', 'Invalid URL provided.');
  }

  try {
    const info = await fetchVideoInfo(getYtdlpPath(), url);
    return okResult(info);
  } catch (error) {
    const message =
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : 'Failed to fetch video info.';
    if (message.toLowerCase().includes('cancel')) {
      return errorResult('NOT_AVAILABLE', message);
    }
    return errorResult('INTERNAL_ERROR', message);
  }
});

ipcMain.on('cancel-video-info', (event) => {
  if (!assertMainWindowSender(event)) {
    return;
  }
  cancelVideoInfo();
});

ipcMain.handle('download-video', (event, options) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
  const validation = validateDownloadRequestPayload(options);
  if (!validation.ok) {
    return errorResult(validation.error.code, validation.error.message, validation.error.details);
  }
  if (!canStartDownload('manual')) {
    return errorResult('NOT_AVAILABLE', 'A queue download is already in progress.');
  }

  try {
    startDownload(
      getYtdlpPath(),
      event.sender,
      validation.data as DownloadRequestOptions,
      mainWindow,
      undefined,
      'manual'
    );
    return okResult({ started: true });
  } catch (error) {
    log.error('Error in download-video handler:', error);
    return errorResult('INTERNAL_ERROR', 'Failed to start download.');
  }
});

ipcMain.on('cancel-download', (event) => {
  if (!assertMainWindowSender(event)) {
    return;
  }
  try {
    cancelActiveSession(true);
  } catch (error) {
    log.error('Error in cancel-download handler:', error);
  }
});

ipcMain.handle('restart-app', (event) => {
  if (!assertMainWindowSender(event)) {
    return;
  }
  appQuitting = true;
  try {
    cancelActiveSession(false);
    killAllProcesses();
    cancelFormats();
    cancelVideoInfo();
  } catch (error) {
    log.error('Error cleaning up before restart:', error);
  }
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('open-file-location', async (event, filePath) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
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
      const openResult = await shell.openPath(dir);
      if (typeof openResult === 'string' && openResult.trim() !== '') {
        return errorResult('INTERNAL_ERROR', `Failed to open directory: ${openResult}`);
      }
      return okResult({ opened: true });
    }

    return errorResult('INVALID_PATH', 'Path and containing directory do not exist.');
  } catch (error) {
    log.error('Error in open-file-location handler:', error);
    return errorResult('INTERNAL_ERROR', 'Failed to open file location.');
  }
});

ipcMain.handle('show-notification', (event, options) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
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

    notification.once('click', () => {
      try {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.focus();
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

ipcMain.handle('export-settings', async (event) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
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

ipcMain.handle('import-settings', async (event) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
  try {
    const parentWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const importedSettings = await importSettingsFromFile(parentWindow);
    if (!importedSettings) return errorResult('INTERNAL_ERROR', 'Import cancelled or failed.');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings-imported', importedSettings);
    }
    return okResult({ imported: true });
  } catch (error) {
    log.error('Error importing settings:', error);
    return errorResult('INTERNAL_ERROR', 'Failed to import settings.');
  }
});

ipcMain.handle('get-stats', (event) => {
  if (!assertMainWindowSender(event)) {
    return loadStats();
  }
  return loadStats();
});

ipcMain.handle('reset-stats', (event) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
  const success = resetStats();
  if (!success) return errorResult('INTERNAL_ERROR', 'Failed to reset stats.');
  return okResult(undefined);
});

let downloadQueue: QueueItem[] = [];
let isQueueRunning = false;
let queueCancelled = false;
let queueActiveItemId: string | null = null;
let queueProcessingLock = false;

const queuePath = path.join(app.getPath('userData'), 'download-queue.json');
const queueBackupPath = path.join(app.getPath('userData'), 'download-queue.backup.json');

function readQueueFromDisk(filePath: string): QueueItem[] | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter(
        (item: unknown): item is QueueItem =>
          item !== null &&
          typeof item === 'object' &&
          typeof (item as QueueItem).id === 'string' &&
          typeof (item as QueueItem).url === 'string'
      )
      .map((item: QueueItem) => ({
        ...item,
        status: item.status === 'downloading' ? ('pending' as const) : item.status,
      }));
  } catch {
    return null;
  }
}

function loadPersistedQueue(): QueueItem[] {
  const queueFromPrimary = readQueueFromDisk(queuePath);
  if (queueFromPrimary) {
    return queueFromPrimary;
  }
  const queueFromBackup = readQueueFromDisk(queueBackupPath);
  if (queueFromBackup) {
    log.warn('Primary queue file could not be read. Restoring queue from backup.');
    return queueFromBackup;
  }
  return [];
}

let persistQueueTimer: NodeJS.Timeout | null = null;

function persistQueue(): void {
  const tempPath = `${queuePath}.tmp`;
  try {
    const dir = path.dirname(queuePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const serialized = JSON.stringify(downloadQueue, null, 2);
    fs.writeFileSync(tempPath, serialized, 'utf-8');
    if (fs.existsSync(queuePath)) {
      fs.copyFileSync(queuePath, queueBackupPath);
      fs.rmSync(queuePath, { force: true });
    }
    fs.renameSync(tempPath, queuePath);
    fs.copyFileSync(queuePath, queueBackupPath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    } catch {}
    log.error('Failed to persist queue:', error);
  }
}

downloadQueue = loadPersistedQueue();

function generateQueueId(): string {
  return `q_${randomUUID()}`;
}

function schedulePersistQueue(): void {
  if (persistQueueTimer) {
    clearTimeout(persistQueueTimer);
  }
  persistQueueTimer = setTimeout(() => {
    persistQueueTimer = null;
    persistQueue();
  }, 300);
}

function flushQueueOnShutdown() {
  if (persistQueueTimer) {
    clearTimeout(persistQueueTimer);
    persistQueueTimer = null;
  }
  persistQueue();
}

function stopActiveDownloadsAndQueue() {
  queueCancelled = true;
  isQueueRunning = false;
  queueActiveItemId = null;
  try {
    cancelActiveSession(false);
  } catch {}
  try {
    killAllProcesses();
  } catch {}
  try {
    cancelFormats();
  } catch {}
  try {
    cancelVideoInfo();
  } catch {}
}

function broadcastQueue() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('queue-update', downloadQueue);
  }
  schedulePersistQueue();
}

async function processQueue() {
  if (!isQueueRunning || queueProcessingLock) return;
  queueProcessingLock = true;

  try {
    const nextItem = downloadQueue.find((item) => item.status === 'pending');
    if (!nextItem || queueCancelled) {
      isQueueRunning = false;
      queueCancelled = false;
      queueActiveItemId = null;
      broadcastQueue();
      return;
    }

    nextItem.status = 'downloading';
    queueActiveItemId = nextItem.id;
    broadcastQueue();

    await new Promise<void>((resolve) => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        nextItem.status = 'failed';
        nextItem.error = 'Window closed';
        queueActiveItemId = null;
        broadcastQueue();
        resolve();
        return;
      }

      const settings = loadSettings();
      let outputPath = app.getPath('downloads');
      const rawFolder = settings.downloadFolder?.trim();
      if (rawFolder) {
        const folderValidation = validateDownloadPath(rawFolder);
        if (folderValidation.ok && folderValidation.data) {
          outputPath = folderValidation.data;
        }
      }
      const options: DownloadRequestOptions = {
        url: nextItem.url,
        outputPath,
        ffmpegPath: settings.ffmpegPath || undefined,
        convertFormat: settings.convertEnabled ? settings.convertFormat : undefined,
        keepOriginal: settings.convertEnabled ? settings.keepOriginalAfterConvert : undefined,
      };

      let settled = false;
      const completeListener = (statusMessage: string, outcome?: DownloadOutcome) => {
        if (settled) return;
        settled = true;

        if (outcome === 'cancelled') {
          nextItem.status = 'cancelled';
          nextItem.error = undefined;
        } else if (outcome === 'success') {
          nextItem.status = 'completed';
          nextItem.error = undefined;
        } else {
          nextItem.status = 'failed';
          nextItem.error = statusMessage;
        }

        queueActiveItemId = null;
        broadcastQueue();
        resolve();
      };

      try {
        startDownload(
          getYtdlpPath(),
          mainWindow.webContents,
          options,
          mainWindow,
          completeListener,
          'queue'
        );
      } catch (error) {
        nextItem.status = 'failed';
        nextItem.error = (error as Error).message;
        queueActiveItemId = null;
        broadcastQueue();
        resolve();
      }
    });
  } finally {
    queueProcessingLock = false;
    if (isQueueRunning && !queueCancelled) {
      void processQueue();
    }
  }
}

ipcMain.handle('add-to-queue', (event, urls) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
  if (!Array.isArray(urls)) {
    return errorResult('VALIDATION_ERROR', 'URLs must be an array.');
  }
  const validUrls = urls.filter((u): u is string => typeof u === 'string' && isSafeHttpUrl(u));
  if (validUrls.length === 0) {
    return errorResult('VALIDATION_ERROR', 'No valid URLs provided.');
  }
  if (downloadQueue.length + validUrls.length > MAX_QUEUE_SIZE) {
    return errorResult('VALIDATION_ERROR', `Queue limit reached (max ${MAX_QUEUE_SIZE} items).`);
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

ipcMain.handle('remove-from-queue', (event, id) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
  if (typeof id !== 'string') {
    return errorResult('VALIDATION_ERROR', 'Queue item ID must be a string.');
  }
  const idx = downloadQueue.findIndex((item) => item.id === id);
  if (idx === -1) return errorResult('NOT_AVAILABLE', 'Queue item not found.');
  const item = downloadQueue[idx];
  if (!item) return errorResult('NOT_AVAILABLE', 'Queue item not found.');
  if (item.status === 'downloading') {
    return errorResult('VALIDATION_ERROR', 'Cannot remove an actively downloading item.');
  }
  downloadQueue.splice(idx, 1);
  broadcastQueue();
  return okResult(undefined);
});

ipcMain.handle('clear-queue', (event) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
  if (isQueueRunning) {
    queueCancelled = true;
    cancelActiveSession(true);
    isQueueRunning = false;
    queueActiveItemId = null;
  }
  downloadQueue = [];
  broadcastQueue();
  return okResult(undefined);
});

ipcMain.handle('get-queue', (event) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
  return downloadQueue;
});

ipcMain.handle('start-queue', (event) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
  const pending = downloadQueue.filter((item) => item.status === 'pending');
  if (pending.length === 0) {
    return errorResult('NOT_AVAILABLE', 'No pending items in queue.');
  }
  if (isQueueRunning) {
    return errorResult('VALIDATION_ERROR', 'Queue is already running.');
  }
  if (!canStartDownload('queue')) {
    return errorResult('NOT_AVAILABLE', 'A manual download is already in progress.');
  }
  isQueueRunning = true;
  queueCancelled = false;
  void processQueue();
  return okResult({ started: true });
});

ipcMain.handle('cancel-queue', (event) => {
  if (!assertMainWindowSender(event)) {
    return errorResult('VALIDATION_ERROR', 'Unauthorized sender.');
  }
  try {
    queueCancelled = true;
    isQueueRunning = false;
    if (queueActiveItemId) {
      cancelActiveSession(true);
      queueActiveItemId = null;
    }
    downloadQueue.forEach((item) => {
      if (item.status === 'pending' || item.status === 'downloading') {
        item.status = 'cancelled';
      }
    });
    broadcastQueue();
    return okResult(undefined);
  } catch (error) {
    log.error('Error in cancel-queue handler:', error);
    return errorResult('INTERNAL_ERROR', 'Failed to cancel queue.');
  }
});
