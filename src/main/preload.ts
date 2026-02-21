import { contextBridge, ipcRenderer } from 'electron';

const api = {
  restartApp: () => ipcRenderer.invoke('restart-app'),
  // get active distribution channel
  getChannel: () =>
    process.env.CHANNEL === 'msstore' || process.windowsStore ? 'msstore' : 'github',
  getFormats: (url: string) => ipcRenderer.invoke('getFormats', url),
  selectDownloadLocation: () => ipcRenderer.invoke('select-download-location'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: Record<string, unknown>) => ipcRenderer.send('save-settings', settings),
  resetSettings: () => ipcRenderer.send('reset-settings'),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  downloadVideo: (options: Record<string, unknown>) => ipcRenderer.send('download-video', options),
  cancelDownload: () => ipcRenderer.send('cancel-download'),
  cancelFormats: () => ipcRenderer.send('cancel-formats'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkDenoInstalled: () => ipcRenderer.invoke('check-deno-installed'),
  installDeno: () => ipcRenderer.invoke('install-deno'),
  detectGpu: () => ipcRenderer.invoke('detect-gpu'),

  // Auto-updater APIs
  isPackaged: () => ipcRenderer.invoke('is-packaged'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  cancelUpdateDownload: () => ipcRenderer.send('cancel-update-download'),
  installUpdate: () => ipcRenderer.send('install-update'),
  onUpdaterStatus: (callback: (data: Record<string, unknown>) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: Record<string, unknown>) =>
      callback(data);
    ipcRenderer.on('updater-status', listener);
    return () => ipcRenderer.removeListener('updater-status', listener);
  },
  onUpdaterProgress: (callback: (data: Record<string, unknown>) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: Record<string, unknown>) =>
      callback(data);
    ipcRenderer.on('updater-progress', listener);
    return () => ipcRenderer.removeListener('updater-progress', listener);
  },

  // dl progress
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
  openFileLocation: (filePath: string) => ipcRenderer.send('open-file-location', filePath),
  showNotification: (options: Record<string, unknown>) =>
    ipcRenderer.send('show-notification', options),
};

contextBridge.exposeInMainWorld('api', api);
