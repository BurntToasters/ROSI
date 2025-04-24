// --- begin preload.js ---
const { contextBridge, ipcRenderer } = require('electron');

console.log("✅ PRELOAD IS RUNNING!");

contextBridge.exposeInMainWorld('api', {
  // send toggle mp4 convert (not always used)
  convertToMp4: (value) => ipcRenderer.send('toggle-convert-mp4'),

  // get available formats for a url
  getFormats: (url) => ipcRenderer.invoke('getFormats', url),

  // open folder dialog for download location
  selectDownloadLocation: () => ipcRenderer.invoke('select-download-location'),

  // get settings from main process
  getSettings: () => ipcRenderer.invoke('get-settings'),

  // save settings to main process
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),

  // reset settings and restart app
  resetSettings: () => ipcRenderer.send('reset-settings'),

  // toggle console output (not always used)
  toggleConsoleOutput: () => ipcRenderer.send('toggle-console'),

  // toggle advanced options (not always used)
  toggleAdvancedOptions: () => ipcRenderer.send('toggle-advanced'),

  // open external url in browser
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // start download with options
  downloadVideo: (options) => ipcRenderer.send('download-video', options),

  // cancel current download/conversion
  cancelDownload: () => ipcRenderer.send('cancel-download'),

  // get application version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // listen for progress messages from main
  onProgress: (callback) => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on('progress', listener);
  },

  // listen for completion messages from main
  onComplete: (callback) => {
    const listener = (_, message) => callback(message);
    ipcRenderer.on('complete', listener);
  }
});
// --- end preload.js ---