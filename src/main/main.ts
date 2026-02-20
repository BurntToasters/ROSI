import { app, BrowserWindow, ipcMain, dialog, shell, Notification } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import log from 'electron-log/main';
import { isPackaged, resolveYtdlpPath } from './platform';
import { loadSettings, saveSettings, getDefaultSettings } from './settings';
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
import { isSafeExternalUrl, isAllowedNavigationUrl } from '../utils/validation';
import { SPLASH_SHOW_DELAY_MS, SPLASH_FADE_DELAY_MS } from './constants';
import type { DownloadRequestOptions } from '../types';

log.initialize();

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

setupAutoUpdater(getMainWindow);

ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('is-packaged', () => isPackaged);
ipcMain.handle('check-for-updates', () => checkForUpdates(isPackaged));
ipcMain.handle('download-update', () => downloadUpdate());
ipcMain.on('cancel-update-download', () => cancelUpdateDownload(getMainWindow));
ipcMain.on('install-update', () => installUpdate());

ipcMain.handle('check-deno-installed', () => checkDenoInstalled());
ipcMain.handle('install-deno', () => installDeno(mainWindow));

ipcMain.handle('get-settings', () => loadSettings());
ipcMain.on('save-settings', (_, data) => saveSettings(data, mainWindow));

ipcMain.handle('detect-gpu', () => detectGpu());

ipcMain.on('reset-settings', () => {
  try {
    saveSettings(getDefaultSettings(), mainWindow);
    app.relaunch();
    app.exit();
  } catch (error) {
    log.error('Error resetting settings:', error);
    app.relaunch();
    app.exit();
  }
});

ipcMain.on('open-external', (_, url) => {
  try {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch((err) => {
        log.error('Failed to open external URL:', err);
      });
    }
  } catch (error) {
    log.error('Error in open-external handler:', error);
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

ipcMain.handle('getFormats', (_, url) => fetchFormats(ytdlpPath, url));
ipcMain.on('cancel-formats', () => cancelFormats());

ipcMain.on('download-video', (event, options) => {
  startDownload(ytdlpPath, event.sender, options as DownloadRequestOptions, mainWindow);
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

ipcMain.on('open-file-location', (_, filePath) => {
  try {
    if (filePath && typeof filePath === 'string') {
      if (fs.existsSync(filePath)) {
        shell.showItemInFolder(filePath);
      } else {
        const dir = path.dirname(filePath);
        if (fs.existsSync(dir)) {
          shell.openPath(dir).catch((err: Error) => {
            log.error('Error opening directory:', err);
          });
        }
      }
    }
  } catch (error) {
    log.error('Error in open-file-location handler:', error);
  }
});

ipcMain.on('show-notification', (_, options) => {
  try {
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: options?.title || 'ROSI',
        body: options?.body || '',
        icon: path.join(__dirname, '..', '..', 'src', 'renderer', 'app.png'),
        silent: false,
      });

      notification.on('click', () => {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
          }
          if (options?.filePath) {
            shell.showItemInFolder(options.filePath);
          }
        } catch (clickErr) {
          log.error('Error handling notification click:', clickErr);
        }
      });

      notification.show();
    }
  } catch (error) {
    log.error('Error showing notification:', error);
  }
});
