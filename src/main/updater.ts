import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import { autoUpdater, CancellationToken } from 'electron-updater';
import log from 'electron-log/main';
import type {
  Settings,
  UpdateDownloadResult,
  UpdaterProgressEvent,
  UpdaterStatusEvent,
} from '../types';

let updateDownloadCancellationToken: CancellationToken | null = null;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function isBetaVersion(version: string): boolean {
  return /-(beta|alpha|rc)/i.test(version);
}

export function parseVersion(v: string): ParsedVersion {
  const cleaned = v.trim().replace(/^v/i, '').split('+')[0];
  const match = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return { major: 0, minor: 0, patch: 0, prerelease: [] as string[] };
  return {
    major: parseInt(match[1], 10) || 0,
    minor: match[2] ? parseInt(match[2], 10) : 0,
    patch: match[3] ? parseInt(match[3], 10) : 0,
    prerelease: match[4] ? match[4].split('.') : ([] as string[]),
  };
}

export function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const aNum = /^\d+$/.test(a[i]) ? parseInt(a[i], 10) : null;
    const bNum = /^\d+$/.test(b[i]) ? parseInt(b[i], 10) : null;
    if (aNum !== null && bNum !== null) {
      if (aNum !== bNum) return aNum > bNum ? 1 : -1;
    } else if (aNum !== null) {
      return -1;
    } else if (bNum !== null) {
      return 1;
    } else {
      const cmp = a[i].localeCompare(b[i]);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

export function compareVersions(a: string, b: string): number {
  const vA = parseVersion(a);
  const vB = parseVersion(b);
  if (vA.major !== vB.major) return vA.major > vB.major ? 1 : -1;
  if (vA.minor !== vB.minor) return vA.minor > vB.minor ? 1 : -1;
  if (vA.patch !== vB.patch) return vA.patch > vB.patch ? 1 : -1;
  return comparePrerelease(vA.prerelease, vB.prerelease);
}

export function resolveUseBeta(channel: Settings['updateChannel']): boolean {
  if (channel === 'beta') return true;
  if (channel === 'stable') return false;
  return isBetaVersion(app.getVersion());
}

export function applyChannel(useBeta: boolean) {
  if (useBeta) {
    autoUpdater.channel = 'beta';
    autoUpdater.allowPrerelease = true;
  } else {
    autoUpdater.channel = 'latest';
    autoUpdater.allowPrerelease = false;
  }
}

export function setupAutoUpdater(
  getMainWindow: () => BrowserWindow | null,
  loadSettings: () => Settings
) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  const settings = loadSettings();
  const useBeta = resolveUseBeta(settings.updateChannel);
  applyChannel(useBeta);

  const sendToWindow = (channel: 'updater-status' | 'updater-progress', data: unknown) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  };

  const sendStatus = (data: UpdaterStatusEvent) => {
    sendToWindow('updater-status', data);
  };

  const sendProgress = (data: UpdaterProgressEvent) => {
    sendToWindow('updater-progress', data);
  };

  autoUpdater.on('checking-for-update', () => {
    sendStatus({ status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    const currentUseBeta = resolveUseBeta(loadSettings().updateChannel);
    const updateIsBeta = isBetaVersion(info.version);

    if (currentUseBeta && !updateIsBeta) {
      sendStatus({
        status: 'not-available',
        version: app.getVersion(),
        isBeta: currentUseBeta,
      });
      return;
    }
    if (!currentUseBeta && updateIsBeta) {
      sendStatus({
        status: 'not-available',
        version: app.getVersion(),
        isBeta: currentUseBeta,
      });
      return;
    }

    const currentVersion = app.getVersion();
    if (compareVersions(info.version, currentVersion) <= 0) {
      log.info(
        `[AutoUpdater] Ignoring update ${info.version} — current ${currentVersion} is newer or equal`
      );
      sendStatus({
        status: 'not-available',
        version: currentVersion,
        isBeta: currentUseBeta,
      });
      return;
    }

    sendStatus({
      status: 'available',
      version: info.version,
      releaseNotes: info.releaseNotes ?? null,
      isBeta: updateIsBeta,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    sendStatus({
      status: 'not-available',
      version: info.version ?? app.getVersion(),
      isBeta: isBetaVersion(info.version ?? app.getVersion()),
    });
  });

  autoUpdater.on('error', (err) => {
    log.error('Auto-updater error:', err);
    sendStatus({
      status: 'error',
      message: err.message,
    });
  });

  autoUpdater.on('download-progress', (progressObj) => {
    sendProgress({
      percent: progressObj.percent,
      bytesPerSecond: progressObj.bytesPerSecond,
      transferred: progressObj.transferred,
      total: progressObj.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendStatus({
      status: 'downloaded',
      version: info.version,
    });
  });
}

export async function checkForUpdates(isPackaged: boolean, loadSettings: () => Settings) {
  if (!isPackaged) {
    return { error: 'dev-mode', message: 'Update checking is not available in development mode.' };
  }
  try {
    const settings = loadSettings();
    const useBeta = resolveUseBeta(settings.updateChannel);
    applyChannel(useBeta);
    return await autoUpdater.checkForUpdates();
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export async function downloadUpdate(): Promise<UpdateDownloadResult> {
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
      const cancelledEvent: UpdaterStatusEvent = { status: 'cancelled' };
      win.webContents.send('updater-status', cancelledEvent);
    }
  }
}

export function installUpdate() {
  autoUpdater.quitAndInstall(false, true);
}
