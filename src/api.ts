// The renderer API object. Callers import `api` and call `api.method(...)` at
// call time, so a replaced method is seen everywhere. Each method maps to a
// Rust command or a Tauri event. The E2E hook exposes this same object.
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { call, fire } from './commands';

export interface RosiRendererApi {
  restartApp: () => Promise<void>;
  getChannel: () => 'github' | 'msstore';
  getFormats: (url: string) => Promise<RosiIpcResult<import('./generated/ipc-types').FormatList>>;
  getVideoInfo: (
    url: string,
    playlistMode?: 'current' | 'all'
  ) => Promise<RosiIpcResult<import('./generated/ipc-types').VideoInfo>>;
  cancelVideoInfo: () => void;
  selectDownloadLocation: () => Promise<string | null>;
  getSettings: () => Promise<RosiSettings>;
  getDefaultSettings: () => Promise<RosiIpcResult<RosiSettings>>;
  saveSettings: (settings: Partial<RosiSettings>) => Promise<RosiIpcResult<RosiSettings>>;
  resetSettings: () => Promise<void>;
  openExternal: (url: string) => Promise<RosiIpcResult<{ opened: boolean }>>;
  downloadVideo: (
    options: Partial<RosiDownloadRequestOptions>
  ) => Promise<RosiIpcResult<import('./generated/ipc-types').DownloadStarted>>;
  resolveDownloadOptions: (
    options: Partial<RosiDownloadRequestOptions>
  ) => Promise<RosiIpcResult<RosiDownloadRequestOptions>>;
  resolvePresetOptions: (presetId: string) => Promise<RosiIpcResult<RosiDownloadRequestOptions>>;
  extractQueueUrls: (text: string) => Promise<RosiIpcResult<RosiExtractedQueueUrls>>;
  cancelDownload: () => void;
  cancelFormats: () => void;
  getAppVersion: () => Promise<string>;
  getAppPlatform: () => Promise<NodeJS.Platform>;
  checkDenoInstalled: () => Promise<boolean>;
  installDeno: () => Promise<import('./generated/ipc-types').InstallResult>;
  detectGpu: () => Promise<{ nvidia: boolean; amd: boolean; intel: boolean }>;
  isPackaged: () => Promise<boolean>;
  onProgress: (callback: (message: string) => void) => () => void;
  onJobProgress: (callback: (data: RosiJobProgressEvent) => void) => () => void;
  onMenuAction: (
    callback: (
      action: 'check-for-updates' | 'open-settings' | 'show-licenses' | 'toggle-sidebar'
    ) => void
  ) => () => void;
  onComplete: (callback: (message: string) => void) => () => void;
  onDownloadComplete: (callback: (completion: RosiDownloadCompletion) => void) => () => void;
  openFileLocation: (filePath: string) => Promise<RosiIpcResult<{ opened: boolean }>>;
  showNotification: (options: {
    title?: string;
    body?: string;
    filePath?: string;
  }) => Promise<RosiIpcResult<{ shown: boolean }>>;
  exportSettings: () => Promise<RosiIpcResult<{ exported: boolean }>>;
  importSettings: () => Promise<RosiIpcResult<{ imported: boolean }>>;
  getStats: () => Promise<RosiDownloadStats>;
  resetStats: () => Promise<RosiIpcResult<void>>;
  getDownloadActivity: () => Promise<RosiIpcResult<RosiDownloadActivity[]>>;
  clearDownloadActivity: () => Promise<RosiIpcResult<void>>;
  onDownloadActivityUpdate: (callback: (activity: RosiDownloadActivity[]) => void) => () => void;
  logError: (message: string) => void;
  setWindowTheme: (theme: 'light' | 'dark') => void;
  notifySettingsFlushed: (generation: number) => Promise<void>;
  addToQueue: (
    urls: string[],
    options?: Partial<RosiDownloadRequestOptions>
  ) => Promise<RosiIpcResult<import('./generated/ipc-types').AddResult>>;
  removeFromQueue: (id: string) => Promise<RosiIpcResult<void>>;
  retryQueueItem: (id: string) => Promise<RosiIpcResult<void>>;
  reorderQueueItem: (request: {
    id: string;
    direction: 'up' | 'down';
  }) => Promise<RosiIpcResult<void>>;
  clearQueue: () => Promise<RosiIpcResult<void>>;
  clearFinishedQueue: () => Promise<RosiIpcResult<{ removed: number }>>;
  isFlatpak: () => Promise<boolean>;
  getQueue: () => Promise<RosiQueueItem[]>;
  startQueue: () => Promise<RosiIpcResult<{ started: boolean }>>;
  cancelQueue: () => Promise<RosiIpcResult<void>>;
  onPrepareForClose: (callback: (generation: number) => void | Promise<void>) => () => void;
  onQueueUpdate: (callback: (snapshot: RosiQueueSnapshot | RosiQueueItem[]) => void) => () => void;
  onSettingsImported: (callback: (settings: RosiSettings) => void) => () => void;
}

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

export const api: RosiRendererApi = {
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
  resolveDownloadOptions: (options) => call('resolve_download_options', { options }),
  resolvePresetOptions: (presetId) => call('resolve_preset_options', { options: { presetId } }),
  extractQueueUrls: (text) => call('extract_queue_urls', { input: { text } }),
  cancelDownload: () => fire('cancel_download'),
  cancelFormats: () => fire('cancel_formats'),
  getAppVersion: () => getVersion(),
  getAppPlatform: () => call('get_app_platform'),
  checkDenoInstalled: () => call('check_deno_installed'),
  installDeno: () => call('install_deno'),
  detectGpu: () => call('detect_gpu'),
  isPackaged: () => call('is_packaged'),
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
