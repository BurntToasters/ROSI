const { contextBridge, ipcRenderer } = require('electron');

console.log("✅ PRELOAD IS RUNNING!");

contextBridge.exposeInMainWorld('api', {
  convertToMp4: (value) => ipcRenderer.send('toggle-convert-mp4'),
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
  onProgress: (callback) => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on('progress', listener);
  },
  onComplete: (callback) => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on('complete', listener);
  },
});