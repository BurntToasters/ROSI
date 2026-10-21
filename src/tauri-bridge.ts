// Tauri implementation of the renderer API contract (`window.api`) that the
// ROSI v4 Electron preload exposed. rosiEngine.ts and the renderer modules
// keep calling the same methods; each maps to a Rust command or event.
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
import { call, fire } from './commands';

const CHANNEL: 'github' | 'msstore' =
  import.meta.env.VITE_ROSI_CHANNEL === 'msstore' ? 'msstore' : 'github';

let prepareForCloseRegistration: Promise<void> = Promise.resolve();

function reportBridgeError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[rosi] ${context}: ${message}`);
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
  restartApp: () => call('restart_app'),
  getChannel: () => CHANNEL,
  getFormats: (url) => call('get_formats', { url }),
  getVideoInfo: (url, playlistMode) =>
    call('get_video_info', { url, playlistMode: playlistMode ?? null }),
  cancelVideoInfo: () => fire('cancel_video_info'),
  selectDownloadLocation: () => call('select_download_location'),
  getSettings: () => call('get_settings'),
  getDefaultSettings: () => call('get_default_settings'),
  saveSettings: (settings) => call('save_settings', { settings }),
  resetSettings: () => call('reset_settings'),
  openExternal: (url) => call('open_external', { url }),
  downloadVideo: (options) => call('download_video', { options }),
  cancelDownload: () => fire('cancel_download'),
  cancelFormats: () => fire('cancel_formats'),
  getAppVersion: () => getVersion(),
  getAppPlatform: () => call('get_app_platform'),
  checkDenoInstalled: () => call('check_deno_installed'),
  installDeno: () => call('install_deno'),
  detectGpu: () => call('detect_gpu'),
  isPackaged: () => call('is_packaged'),
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
  openFileLocation: (filePath) => call('open_file_location', { filePath }),
  showNotification: (options) => call('show_notification', { options }),
  exportSettings: () => call('export_settings'),
  importSettings: () => call('import_settings'),
  getStats: () => call('get_stats'),
  resetStats: () => call('reset_stats'),
  getDownloadActivity: () => call('get_download_activity'),
  clearDownloadActivity: () => call('clear_download_activity'),
  onDownloadActivityUpdate: (callback) => subscribe('download-activity-update', callback),
  logError: (message) => fire('log_error', { message }),
  setWindowTheme: (theme) => {
    getCurrentWindow()
      .setTheme(theme)
      .catch((error: unknown) => reportBridgeError('setTheme', error));
  },
  notifySettingsFlushed: (generation) => call('notify_settings_flushed', { generation }),
  addToQueue: (urls, options) => call('add_to_queue', { urls, options: options ?? null }),
  removeFromQueue: (id) => call('remove_from_queue', { id }),
  retryQueueItem: (id) => call('retry_queue_item', { id }),
  reorderQueueItem: (request) => call('reorder_queue_item', { request }),
  clearQueue: () => call('clear_queue'),
  clearFinishedQueue: () => call('clear_finished_queue'),
  isFlatpak: () => call('is_flatpak'),
  getQueue: () => call('get_queue'),
  startQueue: () => call('start_queue'),
  cancelQueue: () => call('cancel_queue'),
  onPrepareForClose: (callback) =>
    subscribe<number>('prepare-for-close', (generation) => {
      void callback(generation);
    }),
  onQueueUpdate: (callback) => subscribe('queue-update', callback),
  onSettingsImported: (callback) => subscribe('settings-imported', callback),
};

window.api = api;
