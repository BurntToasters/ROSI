// Tauri implementation of the renderer API contract (`window.api`) that the
// ROSI v4 Electron preload exposed. rosiEngine.ts and the renderer modules
// keep calling the same methods; each maps to a Rust command or event.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  cancelUpdateDownload,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  notifyUpdaterChannelChanged,
  onUpdaterProgress,
  onUpdaterStatus,
} from './updater';

const CHANNEL: 'github' | 'msstore' =
  import.meta.env.VITE_ROSI_CHANNEL === 'msstore' ? 'msstore' : 'github';

let prepareForCloseRegistration: Promise<void> = Promise.resolve();

function reportBridgeError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[rosi] ${context}: ${message}`);
}

function fire(command: string, args?: Record<string, unknown>): void {
  invoke(command, args).catch((error: unknown) => reportBridgeError(command, error));
}

function subscribe<T>(event: string, callback: (payload: T) => void): () => void {
  let disposed = false;
  let unlisten: UnlistenFn | null = null;
  const registration = listen<T>(event, (message) => {
    if (!disposed) callback(message.payload);
  })
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch((error: unknown) => {
      reportBridgeError(`listen ${event}`, error);
      throw error;
    });
  if (event === 'prepare-for-close') {
    prepareForCloseRegistration = registration.then(() => undefined);
    void prepareForCloseRegistration.catch(() => {});
  } else {
    void registration.catch(() => {});
  }
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

export function waitForPrepareForCloseListener(): Promise<void> {
  return prepareForCloseRegistration;
}

const api: RosiRendererApi = {
  restartApp: () => invoke('restart_app'),
  getChannel: () => CHANNEL,
  getFormats: (url) => invoke('get_formats', { url }),
  getVideoInfo: (url, playlistMode) =>
    invoke('get_video_info', { url, playlistMode: playlistMode ?? null }),
  cancelVideoInfo: () => fire('cancel_video_info'),
  selectDownloadLocation: () => invoke('select_download_location'),
  getSettings: () => invoke('get_settings'),
  getDefaultSettings: () => invoke('get_default_settings'),
  saveSettings: (settings) => invoke('save_settings', { settings }),
  resetSettings: () => invoke('reset_settings'),
  openExternal: (url) => invoke('open_external', { url }),
  downloadVideo: (options) => invoke('download_video', { options }),
  cancelDownload: () => fire('cancel_download'),
  cancelFormats: () => fire('cancel_formats'),
  getAppVersion: () => getVersion(),
  getAppPlatform: () => invoke('get_app_platform'),
  checkDenoInstalled: () => invoke('check_deno_installed'),
  installDeno: () => invoke('install_deno'),
  detectGpu: () => invoke('detect_gpu'),
  isPackaged: () => invoke('is_packaged'),
  checkForUpdates: () => checkForUpdates(),
  notifyUpdaterChannelChanged: (channel, save, previousChannel) =>
    notifyUpdaterChannelChanged(channel, save, previousChannel),
  downloadUpdate: (candidateId) => downloadUpdate(candidateId),
  cancelUpdateDownload: () => cancelUpdateDownload(),
  installUpdate: (candidateId) => installUpdate(candidateId),
  onUpdaterStatus: (callback) => onUpdaterStatus(callback),
  onUpdaterProgress: (callback) => onUpdaterProgress(callback),
  onProgress: (callback) => subscribe('progress', callback),
  onJobProgress: (callback) => subscribe('job-progress', callback),
  onMenuAction: (callback) => subscribe('menu-action', callback),
  onComplete: (callback) => subscribe('complete', callback),
  onDownloadComplete: (callback) => subscribe('download-complete', callback),
  openFileLocation: (filePath) => invoke('open_file_location', { filePath }),
  showNotification: (options) => invoke('show_notification', { options }),
  exportSettings: () => invoke('export_settings'),
  importSettings: () => invoke('import_settings'),
  getStats: () => invoke('get_stats'),
  resetStats: () => invoke('reset_stats'),
  getDownloadActivity: () => invoke('get_download_activity'),
  clearDownloadActivity: () => invoke('clear_download_activity'),
  onDownloadActivityUpdate: (callback) => subscribe('download-activity-update', callback),
  logError: (message) => fire('log_error', { message }),
  setWindowTheme: (theme) => {
    getCurrentWindow()
      .setTheme(theme)
      .catch((error: unknown) => reportBridgeError('setTheme', error));
  },
  notifySettingsFlushed: (generation) => invoke('notify_settings_flushed', { generation }),
  addToQueue: (urls, options) => invoke('add_to_queue', { urls, options: options ?? null }),
  removeFromQueue: (id) => invoke('remove_from_queue', { id }),
  retryQueueItem: (id) => invoke('retry_queue_item', { id }),
  reorderQueueItem: (request) => invoke('reorder_queue_item', { request }),
  clearQueue: () => invoke('clear_queue'),
  getQueue: () => invoke('get_queue'),
  startQueue: () => invoke('start_queue'),
  cancelQueue: () => invoke('cancel_queue'),
  onPrepareForClose: (callback) =>
    subscribe<number>('prepare-for-close', (generation) => {
      void callback(generation);
    }),
  onQueueUpdate: (callback) => subscribe('queue-update', callback),
  onSettingsImported: (callback) => subscribe('settings-imported', callback),
};

window.api = api;
