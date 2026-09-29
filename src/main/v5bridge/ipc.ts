/** IPC for the ROSI 5 bridge. Every channel accepts only the main window. */
import {
  app,
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import log from 'electron-log/main.js';
import { bridgeConfig } from './config';
import {
  cancelV5Download,
  checkForV5,
  downloadV5,
  startV5Install,
  takeFailedResult,
  type BridgeOffer,
} from './index';

export interface BridgeIpcDeps {
  getMainWindow: () => BrowserWindow | null;
  isAuthorized: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
  isPackaged: boolean;
  /** Whether a download or the queue is running. */
  isBusy: () => boolean;
  /** 'beta' or 'stable', resolved like the ROSI 4 updater channel. */
  channel: () => 'beta' | 'stable';
}

export type BridgeActionResult =
  { ok: true; version?: string } | { ok: false; cancelled?: boolean; message: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerV5BridgeIpc(deps: BridgeIpcDeps): void {
  ipcMain.handle('v5-bridge-check', async (event): Promise<BridgeOffer | null> => {
    if (!deps.isAuthorized(event) || !deps.isPackaged) return null;
    try {
      return await checkForV5(deps.channel());
    } catch (error) {
      log.warn('[v5-bridge] check failed:', error);
      return null;
    }
  });

  ipcMain.handle('v5-bridge-download', async (event): Promise<BridgeActionResult> => {
    if (!deps.isAuthorized(event)) return { ok: false, message: 'Unauthorized sender.' };
    try {
      const version = await downloadV5((progress) => {
        const win = deps.getMainWindow();
        if (win && !win.isDestroyed()) win.webContents.send('updater-progress', progress);
      });
      return { ok: true, version };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      if (!aborted) log.error('[v5-bridge] download failed:', error);
      return aborted
        ? { ok: false, cancelled: true, message: 'The ROSI 5 download was cancelled.' }
        : { ok: false, message: message(error) };
    }
  });

  ipcMain.on('v5-bridge-cancel', (event) => {
    if (deps.isAuthorized(event)) cancelV5Download();
  });

  ipcMain.handle('v5-bridge-install', async (event): Promise<BridgeActionResult> => {
    if (!deps.isAuthorized(event)) return { ok: false, message: 'Unauthorized sender.' };
    if (deps.isBusy()) {
      return { ok: false, message: 'Finish or cancel the current download and queue first.' };
    }
    try {
      await startV5Install();
    } catch (error) {
      log.error('[v5-bridge] install handoff failed:', error);
      return { ok: false, message: message(error) };
    }
    // Quit through the normal path so settings and the queue are flushed.
    setTimeout(() => app.quit(), 300);
    return { ok: true };
  });

  ipcMain.handle('v5-bridge-last-failure', (event) => {
    if (!deps.isAuthorized(event)) return null;
    try {
      const failure = takeFailedResult();
      return failure ? { ...failure, downloadPage: bridgeConfig().downloadPage } : null;
    } catch (error) {
      log.warn('[v5-bridge] could not read the last result:', error);
      return null;
    }
  });
}
