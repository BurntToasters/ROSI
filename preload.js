const { contextBridge, ipcRenderer } = require('electron');

console.log("✅ PRELOAD IS RUNNING!");

contextBridge.exposeInMainWorld('api', {
  restartApp: () => ipcRenderer.invoke('restart-app'),
  // get active distribution channel
  getChannel: () => (process.env.CHANNEL === 'msstore' || process.windowsStore ? 'msstore' : 'github'),
  getFormats: (url) => ipcRenderer.invoke('getFormats', url),
  selectDownloadLocation: () => ipcRenderer.invoke('select-download-location'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),
  resetSettings: () => ipcRenderer.send('reset-settings'),
  toggleConsoleOutput: () => ipcRenderer.send('toggle-console'),
  toggleAdvancedOptions: () => ipcRenderer.send('toggle-advanced'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  downloadVideo: (options) => ipcRenderer.send('download-video', options),
  cancelDownload: () => ipcRenderer.send('cancel-download'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkDenoInstalled: () => ipcRenderer.invoke('check-deno-installed'),
  installDeno: () => ipcRenderer.invoke('install-deno'),
  
  // Auto-updater APIs
  isPackaged: () => ipcRenderer.invoke('is-packaged'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.send('install-update'),
  onUpdaterStatus: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('updater-status', listener);
    return () => ipcRenderer.removeListener('updater-status', listener);
  },
  onUpdaterProgress: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('updater-progress', listener);
    return () => ipcRenderer.removeListener('updater-progress', listener);
  },
  
  // dl progress
  onDownloadProgress: (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
  
  onProgress: (callback) => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on('progress', listener);
    return () => ipcRenderer.removeListener('progress', listener);
  },
  onComplete: (callback) => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on('complete', listener);
    return () => ipcRenderer.removeListener('complete', listener);
  },
  openFileLocation: (filePath) => ipcRenderer.send('open-file-location', filePath),
  showNotification: (options) => ipcRenderer.send('show-notification', options),
});