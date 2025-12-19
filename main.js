const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const sanitize = require('sanitize-filename');
const { autoUpdater } = require('electron-updater');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const isArm64 = process.arch === 'arm64';
const isPackaged = app.isPackaged;

// Select the appropriate arch yt-dlp
function getYtdlpBinaryName() {
  if (isWindows) {
    return isArm64 ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe';
  } else if (isMac) {
    return 'yt-dlp_macos';
  } else if (isLinux) {
    return isArm64 ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  }
  return 'yt-dlp_linux';
}

const ytdlpBinary = getYtdlpBinaryName();

let ytdlpPath;
if (isPackaged) {
  const possiblePaths = [
    path.join(process.resourcesPath, 'app.asar.unpacked', ytdlpBinary),
    path.join(process.resourcesPath, ytdlpBinary),
    path.join(__dirname, '..', ytdlpBinary),
    path.join(__dirname, ytdlpBinary)
  ];
  
  for (const tryPath of possiblePaths) {
    console.log(`Trying yt-dlp path: ${tryPath}`);
    if (fs.existsSync(tryPath)) {
      ytdlpPath = tryPath;
      console.log(`Found yt-dlp at: ${ytdlpPath}`);
      break;
    }
  }
  
  if (!ytdlpPath) {
    console.error(`Could not find ${ytdlpBinary} in any expected location`);
    ytdlpPath = path.join(process.resourcesPath, 'app.asar.unpacked', ytdlpBinary); // Default for error reporting
  }
} else {
  // DEV
  ytdlpPath = path.join(__dirname, ytdlpBinary);
}

// yt-dlp binary executable on macOS/Linux
if (!isWindows && fs.existsSync(ytdlpPath)) {
  try {
    fs.chmodSync(ytdlpPath, 0o755);
  } catch (err) {
    dialog.showErrorBox('Permission Error', `Failed to set executable permissions on yt-dlp binary at ${ytdlpPath}.\nError: ${err.message}`);
    app.quit();
  }
}

if (!fs.existsSync(ytdlpPath)) {
    dialog.showErrorBox('Missing Dependency', `yt-dlp binary not found at ${ytdlpPath}.\nPlease ensure ${ytdlpBinary} is in the application's directory.`);
    app.quit();
}


ipcMain.handle('get-app-version', () => app.getVersion());

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const defaultSettings = {
  showConsoleOutput: false,
  advancedOptions: false,
  audioOnly: false,
  convertEnabled: false,
  convertFormat: "mp4",
  keepOriginalAfterConvert: true,
  firstLaunch: true,
  hookBrowser: false,
  browserChoice: "Chrome",
  animateBackground: true,
  notifications: true,
  denoReminderDismissed: false,
  gpuAcceleration: false,
  gpuType: "auto",
  hideSupportModal: false,
  checkUpdatesOnStartup: true
};

// load settings from file or use defaults
function loadSettings() {
  try {
    if (!fs.existsSync(settingsPath)) {
        return { ...defaultSettings };
    }
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const loaded = JSON.parse(raw);
    return { ...defaultSettings, ...loaded };
  } catch (error) {
    return { ...defaultSettings };
  }
}

// save settings to file
function saveSettings(newSettings) {
  try {
      const dir = path.dirname(settingsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const completeSettings = { ...defaultSettings, ...newSettings };
      fs.writeFileSync(settingsPath, JSON.stringify(completeSettings, null, 2));
  } catch (error) {
      if (mainWindow && !mainWindow.isDestroyed()){
         dialog.showErrorBox('Settings Save Error', `Failed to save settings: ${error.message}`);
      }
  }
}

let mainWindow = null;
let splashWindow = null;

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 360,
    height: 360,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    icon: path.join(__dirname, 'app.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    },
    roundedCorners: true
  });
  splashWindow.loadFile('splash.html');
  splashWindow.center();
}

// create main window, set icon, menu bar, devtools
function createWindow() {
  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 900,
    minHeight: 700,
    maxWidth: 1800,
    maxHeight: 1400,
    icon: path.join(__dirname, 'app.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: isDev,
    },
    autoHideMenuBar: !isDev,
    menuBarVisible: isDev,
    show: false // Don't show window until ready
  });
  mainWindow.loadFile('index.html');
  
  mainWindow.setMenuBarVisibility(isDev);
  mainWindow.setAutoHideMenuBar(!isDev);

  if (!isDev) {
    mainWindow.removeMenu();
  }
  
  // When main window is ready, close splash and show main window
  mainWindow.once('ready-to-show', () => {
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    }, 800); // Small delay for smoother transition
  });
}

// First show splash, then create main window
app.whenReady().then(() => {
  createSplashWindow();
  setTimeout(() => {
    createWindow();
  }, 300); // Small delay to ensure splash shows first
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

app.on('before-quit', () => {
  if (ytdlpProcess) {
    try { ytdlpProcess.kill(); } catch (e) { }
    ytdlpProcess = null;
  }
  if (ffmpegProcess) {
    try { ffmpegProcess.kill(); } catch (e) {  }
    ffmpegProcess = null;
  }
});

// Auto Updater Setup
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('checking-for-update', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-status', { status: 'checking' });
  }
});

autoUpdater.on('update-available', (info) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-status', { 
      status: 'available', 
      version: info.version,
      releaseNotes: info.releaseNotes 
    });
  }
});

autoUpdater.on('update-not-available', (info) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-status', { 
      status: 'not-available',
      version: info.version 
    });
  }
});

autoUpdater.on('error', (err) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-status', { 
      status: 'error', 
      message: err.message 
    });
  }
});

autoUpdater.on('download-progress', (progressObj) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-progress', {
      percent: progressObj.percent,
      bytesPerSecond: progressObj.bytesPerSecond,
      transferred: progressObj.transferred,
      total: progressObj.total
    });
  }
});

autoUpdater.on('update-downloaded', (info) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-status', { 
      status: 'downloaded',
      version: info.version 
    });
  }
});

ipcMain.handle('is-packaged', () => isPackaged);

ipcMain.handle('check-for-updates', async () => {
  if (!isPackaged) {
    return { error: 'dev-mode', message: 'Update checking is not available in development mode.' };
  }
  
  try {
    return await autoUpdater.checkForUpdates();
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('download-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

// --- IPC Handlers ---


ipcMain.handle('check-deno-installed', async () => {
  return new Promise((resolve) => {
    const commonPaths = [];
    
    if (isWindows) {
      const userProfile = process.env.USERPROFILE || '';
      const localAppData = process.env.LOCALAPPDATA || '';
      commonPaths.push(
        path.join(userProfile, '.deno', 'bin', 'deno.exe'),
        path.join(localAppData, 'deno', 'bin', 'deno.exe'),
        'C:\\Program Files\\deno\\deno.exe',
        'C:\\deno\\deno.exe'
      );
    } else {
      const homeDir = process.env.HOME || '';
      commonPaths.push(
        path.join(homeDir, '.deno', 'bin', 'deno'),
        '/usr/local/bin/deno',
        '/opt/homebrew/bin/deno',
        '/usr/bin/deno',
        '/home/linuxbrew/.linuxbrew/bin/deno',
        path.join(homeDir, '.local', 'bin', 'deno')
      );
    }

    for (const denoPath of commonPaths) {
      if (fs.existsSync(denoPath)) {
        resolve(true);
        return;
      }
    }

    const checkCmd = isWindows ? 'where' : 'which';
    const spawnOptions = {};
    
    if (isWindows) {
      const userProfile = process.env.USERPROFILE || '';
      const localAppData = process.env.LOCALAPPDATA || '';
      const enhancedPath = [
        path.join(userProfile, '.deno', 'bin'),
        path.join(localAppData, 'deno', 'bin'),
        'C:\\Program Files\\deno',
        'C:\\deno',
        process.env.PATH || ''
      ].join(';');
      
      spawnOptions.env = { ...process.env, PATH: enhancedPath };
    } else {
      const homeDir = process.env.HOME || '';
      const enhancedPath = [
        path.join(homeDir, '.deno', 'bin'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
        '/home/linuxbrew/.linuxbrew/bin',
        path.join(homeDir, '.local', 'bin'),
        process.env.PATH || ''
      ].join(':');
      
      spawnOptions.env = { ...process.env, PATH: enhancedPath };
    }
    
    const proc = spawn(checkCmd, ['deno'], spawnOptions);
    
    // Add timeout to prevent hanging
    const timeout = setTimeout(() => {
      try { proc.kill(); } catch (e) { /* ignore */ }
      resolve(false);
    }, 10000); // 10 second timeout
    
    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
    
    proc.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
});

ipcMain.handle('install-deno', async () => {
  return new Promise((resolve, reject) => {
    let installCmd, installArgs, spawnOptions;
    
    if (isWindows) {
      // Windows: irm https://deno.land/install.ps1 | iex
      installCmd = 'powershell.exe';
      installArgs = ['-ExecutionPolicy', 'Bypass', '-Command', 'irm https://deno.land/install.ps1 | iex'];
      spawnOptions = {};
    } else {
      // Mac/Linux: curl -fsSL https://deno.land/install.sh | sh
      installCmd = 'sh';
      installArgs = ['-c', 'curl -fsSL https://deno.land/install.sh | sh'];
      spawnOptions = {};
    }
    
    const proc = spawn(installCmd, installArgs, spawnOptions);
    let output = '';
    let error = '';
    
    // timeout install process
    const timeout = setTimeout(() => {
      try { proc.kill(); } catch (e) { }
      reject({ success: false, error: 'Installation timed out after 2 minutes' });
    }, 120000);
    
    proc.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      error += data.toString();
    });
    
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ success: true, output });
      } else {
        reject({ success: false, error: error || output });
      }
    });
    
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject({ success: false, error: err.message });
    });
  });
});

// get settings from file
ipcMain.handle('get-settings', () => loadSettings());

// save settings from renderer
ipcMain.on('save-settings', (_, data) => {
    saveSettings(data);
});

// detect available GPU encoders
ipcMain.handle('detect-gpu', async () => {
  const result = { nvidia: false, amd: false, intel: false };
  
  try {
    // NVIDIA NVENC
    const nvencTest = spawn('ffmpeg', ['-hide_banner', '-encoders'], { shell: isWindows });
    const nvencOutput = await new Promise((resolve) => {
      let output = '';
      const timeout = setTimeout(() => {
        try { nvencTest.kill(); } catch (e) { /* ignore */ }
        resolve('');
      }, 10000);
      
      nvencTest.stdout.on('data', (data) => {
        if (output.length < 100000) output += data.toString();
      });
      nvencTest.stderr.on('data', (data) => {
        if (output.length < 100000) output += data.toString();
      });
      nvencTest.on('close', () => {
        clearTimeout(timeout);
        resolve(output);
      });
      nvencTest.on('error', () => {
        clearTimeout(timeout);
        resolve('');
      });
    });
    
    result.nvidia = nvencOutput.includes('h264_nvenc');
    result.amd = nvencOutput.includes('h264_amf');
    result.intel = nvencOutput.includes('h264_qsv');
  } catch (err) {
    console.error('GPU detection error:', err);
  }
  
  return result;
});

// reset settings and restart app
ipcMain.on('reset-settings', (event) => {
  try {
    saveSettings(defaultSettings);
    app.relaunch();
    app.exit();
  } catch (error) {
    console.error('Error resetting settings:', error);
    app.relaunch();
    app.exit();
  }
});

// open external links in browser
ipcMain.on('open-external', (_, url) => {
    try {
      if (url && typeof url === 'string' && (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('ms-windows-store:'))) {
          shell.openExternal(url).catch(err => {
            console.error('Failed to open external URL:', err);
          });
      }
    } catch (error) {
      console.error('Error in open-external handler:', error);
    }
});

// open folder dialog for download location
ipcMain.handle('select-download-location', async () => {
  try {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (!focusedWindow) {
      // Fallback to main
      if (mainWindow && !mainWindow.isDestroyed()) {
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
          title: 'Select Download Folder',
          properties: ['openDirectory', 'createDirectory']
        });
        return canceled ? null : filePaths[0];
      }
      return null;
    }
    const { canceled, filePaths } = await dialog.showOpenDialog(focusedWindow, {
      title: 'Select Download Folder',
      properties: ['openDirectory', 'createDirectory']
    });
    return canceled ? null : filePaths[0];
  } catch (error) {
    console.error('Error in select-download-location:', error);
    return null;
  }
});

// get available formats from yt-dlp
ipcMain.handle('getFormats', async (_, url) => {
    if (!url || typeof url !== 'string') {
        return Promise.reject('Invalid URL provided');
    }
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(ytdlpPath)) {
          return reject(`yt-dlp binary not found at ${ytdlpPath}`);
      }
      const proc = spawn(ytdlpPath, ['-F', url]);
      let outputData = '';
      let errorData = '';

      const timeout = setTimeout(() => {
        try { proc.kill(); } catch (e) {  }
        reject('Format fetch timed out after 60 seconds. The server may be slow or unresponsive.');
      }, 60000);
      
      proc.stdout.on('data', data => {
        if (outputData.length < 500000) outputData += data;
      });
      proc.stderr.on('data', data => {
        if (errorData.length < 100000) errorData += data;
      });
      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
            resolve(outputData);
        } else {
            const combinedError = `yt-dlp exited with code ${code}.\nOutput:\n${outputData}\nError:\n${errorData}`;
            reject(combinedError);
        }
      });
      proc.on('error', (err) => {
          clearTimeout(timeout);
          reject(`Failed to start yt-dlp: ${err.message}`);
      });
    });
});

// --- Download Video ---
let ytdlpProcess = null;
let ffmpegProcess = null;

// handle download-video, spawn yt-dlp
ipcMain.on('download-video', async (event, options) => {
  if (ytdlpProcess) {
    try { ytdlpProcess.kill(); } catch (e) { /* Process may have already exited */ }
    ytdlpProcess = null;
  }
  if (ffmpegProcess) {
    try { ffmpegProcess.kill(); } catch (e) { /* Process may have already exited */ }
    ffmpegProcess = null;
  }

  const sender = event.sender;
  const settings = loadSettings();
  const url = options?.url;
  const downloadDir = options?.outputPath;

  const safeSend = (channel, ...args) => {
      if (!sender.isDestroyed()) {
          sender.send(channel, ...args);
      }
  };

  if (!url || typeof url !== 'string' || url.trim() === "") {
    safeSend('progress', '⚠️ Invalid or missing URL.');
    safeSend('complete', '❌ Failed (Invalid URL).');
    return;
  }
  if (!downloadDir || typeof downloadDir !== 'string' || downloadDir.trim() === "") {
    safeSend('progress', '⚠️ Invalid or missing download folder.');
    safeSend('complete', '❌ Failed (Invalid Folder).');
    return;
  }
  if (!fs.existsSync(ytdlpPath)) {
    safeSend('progress', `❌ Error: yt-dlp binary not found at ${ytdlpPath}`);
    safeSend('complete', '❌ Failed (Missing Dependency).');
    return;
  }

  try {
    if (!fs.existsSync(downloadDir)) {
        safeSend('progress', `📂 Creating directory: ${downloadDir}`);
        fs.mkdirSync(downloadDir, { recursive: true });
    }

    const ytdlpArgs = [
        '-P', downloadDir,
        '--no-playlist',
        '--print', 'after_move:filepath',
        '--newline',
        url
    ];

    // Advanced format selection
    const videoFormat = options?.videoFormat;
    const audioFormat = options?.audioFormat;
    if (videoFormat && audioFormat) {
      ytdlpArgs.splice(-1, 0, '-f', `${videoFormat}+${audioFormat}`);
      safeSend('progress', `📹 Using formats: video=${videoFormat}, audio=${audioFormat}`);
    } else if (videoFormat) {
      ytdlpArgs.splice(-1, 0, '-f', videoFormat);
      safeSend('progress', `📹 Using video format: ${videoFormat}`);
    } else if (audioFormat) {
      ytdlpArgs.splice(-1, 0, '-f', audioFormat);
      safeSend('progress', `🎵 Using audio format: ${audioFormat}`);
    }

    // Audio-only mode (only applies when not using advanced format selection)
    if (settings.audioOnly && !videoFormat && !audioFormat) {
      ytdlpArgs.splice(-1, 0, '-x', '--audio-format', 'mp3', '--audio-quality', '0');
      safeSend('progress', '🎵 Audio-only mode enabled');
    }

    if (settings.hookBrowser && settings.browserChoice) {
      ytdlpArgs.splice(-1, 0, '--cookies-from-browser', settings.browserChoice);
    }

    safeSend('progress', `🚀 Starting download: ${url}`);
    safeSend('progress', `   Command: ${ytdlpBinary} ${ytdlpArgs.join(' ')}`);
    ytdlpProcess = spawn(ytdlpPath, ytdlpArgs);

    let downloadOutputData = '';
    let downloadErrorData = '';
    const MAX_BUFFER_SIZE = 500000;

    ytdlpProcess.stdout.on('data', (data) => {
        const message = data.toString();
        if (downloadOutputData.length > MAX_BUFFER_SIZE) {
            downloadOutputData = downloadOutputData.slice(-MAX_BUFFER_SIZE / 2);
        }
        downloadOutputData += message;
        safeSend('progress', message.trim());
    });
    ytdlpProcess.stderr.on('data', (data) => {
        const message = data.toString();
        if (downloadErrorData.length < MAX_BUFFER_SIZE) {
            downloadErrorData += message;
        }
        safeSend('progress', `[yt-dlp stderr] ${message.trim()}`);
    });

    ytdlpProcess.on('close', async (code) => {
      ytdlpProcess = null;
      const currentSettings = settings;
      if (code !== 0) {
          safeSend('progress', `❌ Download failed: yt-dlp process exited with code ${code}`);
          safeSend('progress', `   Check console and stderr output above for details.`);
          safeSend('complete', '❌ Download failed.');
          return;
      }

      // get downloaded file path from yt-dlp output
      let downloadedFilePath = null;
      try {
          const outputLines = downloadOutputData.trim().split('\n');
          downloadedFilePath = outputLines.filter(line => line.trim() !== '').pop();

          if (!downloadedFilePath) {
              throw new Error("Could not find a valid filepath in yt-dlp's output.");
          }
          safeSend('progress', `✅ Download finished. Identified file: ${downloadedFilePath}`);
      } catch (extractError) {
          safeSend('progress', `❌ Error determining downloaded file path after download.`);
          safeSend('progress', `   Error: ${extractError.message}`);
          safeSend('complete', '❌ Failed (File Path Error).');
          return;
      }

      // if convert enabled, run ffmpeg
      if (currentSettings.convertEnabled) {
        safeSend('progress', '⏳ Checking if conversion is needed...');
        try {
          const originalInputPath = downloadedFilePath;
          const originalFileName = path.basename(originalInputPath);
          let sanitizedFileName = sanitize(originalFileName);
          
          // edge case
          if (!sanitizedFileName || sanitizedFileName.trim() === '') {
            const ext = path.extname(originalFileName) || '.mp4';
            sanitizedFileName = `download_${Date.now()}${ext}`;
            safeSend('progress', `⚠️ Original filename contained only invalid characters. Using: ${sanitizedFileName}`);
          }
          
          const sanitizedInputPath = path.join(path.dirname(originalInputPath), sanitizedFileName);

          // Rename downloaded file -> sanitized version
          if (originalInputPath !== sanitizedInputPath) {
            fs.renameSync(originalInputPath, sanitizedInputPath);
            safeSend('progress', `Renamed to sanitized filename: ${sanitizedFileName}`);
          }
        
          const inputPath = sanitizedInputPath;
          const inputFileExt = path.extname(inputPath);
          const inputFilename = path.basename(inputPath);
          const targetFormat = currentSettings.convertFormat || "mp4";
          const outputPath = inputPath.replace(/\.[^/.]+$/, `.${targetFormat}`);
          const outputFilename = path.basename(outputPath);

          // Only convert if not already in target format
          if (inputFileExt.toLowerCase() === `.${targetFormat}`) {
            safeSend('progress', `ℹ️ Downloaded file is already ${targetFormat.toUpperCase()} (${inputFilename}). Skipping conversion.`);
            safeSend('complete', `✅ Done (Already ${targetFormat.toUpperCase()}).`);
            return;
          }

          if (fs.existsSync(outputPath)) {
            safeSend('progress', `⚠️ Output file ${outputFilename} already exists. Overwriting.`);
          }

          safeSend('progress', `🎬 Converting ${inputFilename} to ${targetFormat.toUpperCase()}...`);

          const getVideoEncoder = () => {
            if (!currentSettings.gpuAcceleration) return 'copy';
            
            const gpuType = currentSettings.gpuType || 'auto';
            if (gpuType === 'nvidia') return 'h264_nvenc';
            if (gpuType === 'amd') return 'h264_amf';
            if (gpuType === 'intel') return 'h264_qsv';
            return 'copy';
          };

          const videoEncoder = getVideoEncoder();
          const useGpu = currentSettings.gpuAcceleration && videoEncoder !== 'copy';
          
          if (useGpu) {
            safeSend('progress', `🖥️ Using GPU acceleration (${videoEncoder})`);
          }

          if (isWindows) {
              let ffmpegCommand;
              if (targetFormat === "mp3" || targetFormat === "m4a") {
                ffmpegCommand = `ffmpeg -i "${inputPath}" -vn -c:a ${targetFormat === "mp3" ? 'libmp3lame' : 'aac'} -y "${outputPath}"`;
              } else {
                ffmpegCommand = `ffmpeg -i "${inputPath}" -c:v ${videoEncoder} -c:a aac -movflags +faststart -y "${outputPath}"`;
              }
              ffmpegProcess = spawn(ffmpegCommand, { shell: true });
          } else {
              let ffmpegArgs;
              if (targetFormat === "mp3" || targetFormat === "m4a") {
                ffmpegArgs = ['-i', inputPath, '-vn', '-c:a', targetFormat === "mp3" ? 'libmp3lame' : 'aac', '-y', outputPath];
              } else {
                ffmpegArgs = ['-i', inputPath, '-c:v', videoEncoder, '-c:a', 'aac', '-movflags', '+faststart', '-y', outputPath];
              }
              ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
          }

          let ffmpegOutput = '';
          ffmpegProcess.stdout.on('data', (data) => {
              const msg = data.toString().trim();
              ffmpegOutput += msg + '\n';
              safeSend('progress', `[ffmpeg] ${msg}`);
          });
          ffmpegProcess.stderr.on('data', (data) => {
              const msg = data.toString().trim();
              ffmpegOutput += msg + '\n';
              safeSend('progress', `[ffmpeg] ${msg}`);
          });

          ffmpegProcess.on('close', (ffmpegCode) => {
            ffmpegProcess = null;
            if (ffmpegCode === 0) {
              safeSend('progress', `🎉 Successfully converted to ${outputPath}`);
              const shouldDelete = !currentSettings.keepOriginalAfterConvert;
              const pathsDiffer = inputPath.toLowerCase() !== outputPath.toLowerCase();
              if (shouldDelete && pathsDiffer) {
                safeSend('progress', `Attempting to delete original file: ${inputFilename}`);
                try {
                  fs.unlinkSync(inputPath);
                  safeSend('progress', `🗑️ Deleted original file: ${inputFilename}`);
                } catch (unlinkErr) {
                  safeSend('progress', `⚠️ Could not delete original file: ${inputFilename} (${unlinkErr.message})`);
                }
              } else if (currentSettings.keepOriginalAfterConvert) {
                safeSend('progress', `ℹ️ Keeping original file (${inputFilename}) as per settings.`);
              } else if (!pathsDiffer) {
                safeSend('progress', `ℹ️ Input and output paths resolved to the same file (${inputPath}), cannot delete original.`);
              }
              safeSend('complete', '🎬 Conversion complete.');
            } else {
              safeSend('progress', `❌ Conversion failed: FFmpeg process exited with code ${ffmpegCode}`);
              safeSend('progress', `   Check FFmpeg output above for details.`);
              safeSend('complete', '❌ Conversion failed.');
            }
          });

          ffmpegProcess.on('error', (err) => {
              ffmpegProcess = null;
              if (err.code === 'ENOENT') {
                 safeSend('progress', `❌ Failed to start conversion: 'ffmpeg' command not found. Ensure FFMPEG is installed and in your system's PATH.`);
                 safeSend('complete', '❌ Conversion failed (FFMPEG not found).');
                 if (mainWindow && !mainWindow.isDestroyed()){
                     dialog.showMessageBox(mainWindow, {
                         type: 'error',
                         title: 'FFMPEG Error',
                         message: "Failed to start conversion: 'ffmpeg' command not found.",
                         detail: "Please ensure FFMPEG is installed and accessible in your system's PATH environment variable. See Help for more details."
                     });
                 }
              } else {
                 safeSend('progress', `❌ Failed to start conversion process: ${err.message}`);
                 safeSend('complete', '❌ Conversion failed (ffmpeg spawn error).');
              }
          });

        } catch (err) {
          safeSend('progress', `❌ Error setting up conversion: ${err.message}`);
          safeSend('complete', '❌ Conversion failed (setup error).');
        }
      } else {
        safeSend('progress', 'ℹ️ Conversion not enabled for this download.');
        safeSend('complete', '✅ Download complete (no conversion).');
      }
    });

    ytdlpProcess.on('error', (err) => {
        ytdlpProcess = null;
        safeSend('progress', `❌ Failed to start download process: ${err.message}`);
        safeSend('complete', '❌ Download failed (process spawn error).');
    });

  } catch (error) {
      safeSend('progress', `❌ Error before starting download: ${error.message}`);
      safeSend('complete', '❌ Failed (Initial Setup Error).');
  }
});

// handle cancel-download, kill yt-dlp and ffmpeg if running
ipcMain.on('cancel-download', () => {
  try {
    let wasCancelled = false;
    if (ffmpegProcess) {
      try {
        ffmpegProcess.kill();
      } catch (killErr) {
        console.error('Error killing ffmpeg process:', killErr);
      }
      ffmpegProcess = null;
      wasCancelled = true;
    }
    if (ytdlpProcess) {
      try {
        ytdlpProcess.kill();
      } catch (killErr) {
        console.error('Error killing yt-dlp process:', killErr);
      }
      ytdlpProcess = null;
      wasCancelled = true;
    }
    if (wasCancelled && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('progress', '⏹️ Download/Conversion cancelled by user.');
        mainWindow.webContents.send('complete', '⏹️ Cancelled.');
    }
  } catch (error) {
    console.error('Error in cancel-download handler:', error);
  }
});

ipcMain.handle('restart-app', () => {
  app.relaunch();
  app.exit(0);
});

// file location via system file mgr
ipcMain.on('open-file-location', (_, filePath) => {
  try {
    if (filePath && typeof filePath === 'string' && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
    } else if (filePath && typeof filePath === 'string') {
      const dir = path.dirname(filePath);
      if (fs.existsSync(dir)) {
        shell.openPath(dir).catch(err => {
          console.error('Error opening directory:', err);
        });
      }
    }
  } catch (error) {
    console.error('Error in open-file-location handler:', error);
  }
});

ipcMain.on('show-notification', (_, options) => {
  try {
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: options?.title || 'ROSI',
        body: options?.body || '',
        icon: path.join(__dirname, 'app.png'),
        silent: false
      });
      
      notification.on('click', () => {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
          }
          if (options?.filePath) {
            shell.showItemInFolder(options.filePath);
          }
        } catch (clickErr) {
          console.error('Error handling notification click:', clickErr);
        }
      });
      
      notification.show();
    }
  } catch (error) {
    console.error('Error showing notification:', error);
  }
});