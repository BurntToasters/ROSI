import type { BrowserWindow } from 'electron';
import { autoUpdater, CancellationToken } from 'electron-updater';
import log from 'electron-log/main';

let updateDownloadCancellationToken: CancellationToken | null = null;

export function setupAutoUpdater(getMainWindow: () => BrowserWindow | null) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  const sendToWindow = (channel: string, data: unknown) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  };

  autoUpdater.on('checking-for-update', () => {
    sendToWindow('updater-status', { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    sendToWindow('updater-status', {
      status: 'available',
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    sendToWindow('updater-status', {
      status: 'not-available',
      version: info.version,
    });
  });

  autoUpdater.on('error', (err) => {
    log.error('Auto-updater error:', err);
    sendToWindow('updater-status', {
      status: 'error',
      message: err.message,
    });
  });

  autoUpdater.on('download-progress', (progressObj) => {
    sendToWindow('updater-progress', {
      percent: progressObj.percent,
      bytesPerSecond: progressObj.bytesPerSecond,
      transferred: progressObj.transferred,
      total: progressObj.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendToWindow('updater-status', {
      status: 'downloaded',
      version: info.version,
    });
  });
}

export async function checkForUpdates(isPackaged: boolean) {
  if (!isPackaged) {
    return { error: 'dev-mode', message: 'Update checking is not available in development mode.' };
  }
  try {
    return await autoUpdater.checkForUpdates();
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export async function downloadUpdate() {
  try {
    updateDownloadCancellationToken = new CancellationToken();
    await autoUpdater.downloadUpdate(updateDownloadCancellationToken);
    updateDownloadCancellationToken = null;
    return { success: true };
  } catch (error) {
    updateDownloadCancellationToken = null;
    if ((error as Error).message?.includes('cancelled')) {
      return { cancelled: true };
    }
    return { error: (error as Error).message };
  }
}

export function cancelUpdateDownload(getMainWindow: () => BrowserWindow | null) {
  if (updateDownloadCancellationToken) {
    updateDownloadCancellationToken.cancel();
    updateDownloadCancellationToken = null;
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater-status', { status: 'cancelled' });
    }
  }
}

export function installUpdate() {
  autoUpdater.quitAndInstall(false, true);
}
