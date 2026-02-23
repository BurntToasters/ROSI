import { contextBridge, ipcRenderer } from 'electron';
import type {
  DownloadRequestOptions,
  NotificationRequest,
  RendererApi,
  Settings,
  UpdateDownloadResult,
  UpdaterProgressEvent,
  UpdaterStatusEvent,
} from '../types';

const api: RendererApi = {
  restartApp: () => ipcRenderer.invoke('restart-app'),
  getChannel: () =>
    process.env.CHANNEL === 'msstore' || process.windowsStore ? 'msstore' : 'github',
  getFormats: (url: string) => ipcRenderer.invoke('getFormats', url),
  selectDownloadLocation: () => ipcRenderer.invoke('select-download-location'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: Partial<Settings>) => ipcRenderer.invoke('save-settings', settings),
  resetSettings: () => ipcRenderer.send('reset-settings'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  downloadVideo: (options: DownloadRequestOptions) => ipcRenderer.invoke('download-video', options),
  cancelDownload: () => ipcRenderer.send('cancel-download'),
  cancelFormats: () => ipcRenderer.send('cancel-formats'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkDenoInstalled: () => ipcRenderer.invoke('check-deno-installed'),
  installDeno: () => ipcRenderer.invoke('install-deno'),
  detectGpu: () => ipcRenderer.invoke('detect-gpu'),
  isPackaged: () => ipcRenderer.invoke('is-packaged'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update') as Promise<UpdateDownloadResult>,
  cancelUpdateDownload: () => ipcRenderer.send('cancel-update-download'),
  installUpdate: () => ipcRenderer.send('install-update'),
  onUpdaterStatus: (callback: (data: UpdaterStatusEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: UpdaterStatusEvent) => callback(data);
    ipcRenderer.on('updater-status', listener);
    return () => ipcRenderer.removeListener('updater-status', listener);
  },
  onUpdaterProgress: (callback: (data: UpdaterProgressEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: UpdaterProgressEvent) => callback(data);
    ipcRenderer.on('updater-progress', listener);
    return () => ipcRenderer.removeListener('updater-progress', listener);
  },
  onDownloadProgress: (callback: (data: Record<string, unknown>) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: Record<string, unknown>) =>
      callback(data);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
  onProgress: (callback: (message: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('progress', listener);
    return () => ipcRenderer.removeListener('progress', listener);
  },
  onComplete: (callback: (message: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('complete', listener);
    return () => ipcRenderer.removeListener('complete', listener);
  },
  openFileLocation: (filePath: string) => ipcRenderer.invoke('open-file-location', filePath),
  showNotification: (options: NotificationRequest) =>
    ipcRenderer.invoke('show-notification', options),
};

contextBridge.exposeInMainWorld('api', api);
