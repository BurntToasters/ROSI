// main.js

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const sanitize = require('sanitize-filename');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const isArm64 = process.arch === 'arm64';

const isPackaged = app.isPackaged;
const ytdlpBinary = isWindows
  ? (isArm64 ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe')
  : isMac
    ? 'yt-dlp_macos'
    : 'yt-dlp_linux';

let ytdlpPath;
if (isPackaged) {
  // Use asarUnpack location
  ytdlpPath = path.join(process.resourcesPath, 'app.asar.unpacked', ytdlpBinary);
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

// ipcMain.handle('get-app-version', () => app.getVersion());

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const defaultSettings = {
  showConsoleOutput: false,
  advancedOptions: false,
  convertEnabled: false,
  convertFormat: "mp4",
  keepOriginalAfterConvert: true,
  firstLaunch: true,
  hookBrowser: false,
  browserChoice: "Chrome"
};

// [!] The console debugger uses emojis to easily identify messages. If you see any issues with emojis, please ensure your terminal supports them or disable the console output in settings.

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

// create main window, set icon, menu bar, devtools
function createWindow() {
  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: path.join(__dirname, 'app.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: isDev,
    }
  });
  mainWindow.loadFile('index.html');
  const showMenu = process.argv.includes('--show-menu');
  mainWindow.setMenuBarVisibility(showMenu);
  mainWindow.setAutoHideMenuBar(!showMenu);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// --- IPC Handlers ---

// get settings from file
ipcMain.handle('get-settings', () => loadSettings());

// save settings from renderer
ipcMain.on('save-settings', (_, data) => {
    saveSettings(data);
});

// reset settings and restart app
ipcMain.on('reset-settings', (event) => {
  saveSettings(defaultSettings);
  app.relaunch();
  app.exit();
});

// ⚠️ THIS CODE IS TEMPORARY AND WILL BE REMOVED IN THE FUTURE
ipcMain.on('open-beta-window', () => {
  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
  const betaWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: path.join(__dirname, 'app.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: isDev,
    }
  });
  betaWindow.loadFile('beta-redesign.html');
  const showMenu = process.argv.includes('--show-menu');
  betaWindow.setMenuBarVisibility(showMenu);
  betaWindow.setAutoHideMenuBar(!showMenu);
  
  
  if (mainWindow) {
    mainWindow.close();
  }
});
//END TEMPORARY CODE

// open external links in browser
ipcMain.on('open-external', (_, url) => {
    if (url && typeof url === 'string' && (url.startsWith('http:') || url.startsWith('https:'))) {
        shell.openExternal(url);
    }
});

// open folder dialog for download location
ipcMain.handle('select-download-location', async () => {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(focusedWindow, {
    title: 'Select Download Folder',
    properties: ['openDirectory', 'createDirectory']
  });
  return canceled ? null : filePaths[0];
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
      proc.stdout.on('data', data => outputData += data);
      proc.stderr.on('data', data => errorData += data);
      proc.on('close', (code) => {
        if (code === 0) {
            resolve(outputData);
        } else {
            const combinedError = `yt-dlp exited with code ${code}.\nOutput:\n${outputData}\nError:\n${errorData}`;
            reject(combinedError);
        }
      });
      proc.on('error', (err) => {
          reject(`Failed to start yt-dlp: ${err.message}`);
      });
    });
});

// --- Download Video ---
let ytdlpProcess = null;
let ffmpegProcess = null;

// handle download-video, spawn yt-dlp, handle conversion, send progress
ipcMain.on('download-video', async (event, options) => {
  if (ytdlpProcess) {
    ytdlpProcess.kill();
    ytdlpProcess = null;
  }
  if (ffmpegProcess) {
    ffmpegProcess.kill();
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

    if (settings.hookBrowser && settings.browserChoice) {
      ytdlpArgs.splice(-1, 0, '--cookies-from-browser', settings.browserChoice);
    }

    safeSend('progress', `🚀 Starting download: ${url}`);
    safeSend('progress', `   Command: ${ytdlpBinary} ${ytdlpArgs.join(' ')}`);
    ytdlpProcess = spawn(ytdlpPath, ytdlpArgs);

    let downloadOutputData = '';
    let downloadErrorData = '';

    ytdlpProcess.stdout.on('data', (data) => {
        const message = data.toString();
        downloadOutputData += message;
        safeSend('progress', message.trim());
    });
    ytdlpProcess.stderr.on('data', (data) => {
        const message = data.toString();
        downloadErrorData += message;
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
          safeSend('progress', `✅ Download finished. Identified file: ${path.basename(downloadedFilePath)}`);
      } catch (extractError) {
          safeSend('progress', `❌ Error determining downloaded file path after download.`);
          safeSend('progress', `   Error: ${extractError.message}`);
          safeSend('complete', '❌ Failed (File Path Error).');
          return;
      }

      // if convert is enabled, run ffmpeg
      if (currentSettings.convertEnabled) {
        safeSend('progress', '⏳ Checking if conversion is needed...');
        try {
          const originalInputPath = downloadedFilePath;
          const sanitizedFileName = sanitize(path.basename(originalInputPath));
          const sanitizedInputPath = path.join(path.dirname(originalInputPath), sanitizedFileName);

          // Rename the downloaded file to the sanitized version
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

          if (isWindows) {
              let ffmpegCommand;
              if (targetFormat === "mp3" || targetFormat === "m4a") {
                ffmpegCommand = `ffmpeg -i "${inputPath}" -vn -c:a ${targetFormat === "mp3" ? 'libmp3lame' : 'aac'} -y "${outputPath}"`;
              } else {
                ffmpegCommand = `ffmpeg -i "${inputPath}" -c:v copy -c:a aac -movflags +faststart -y "${outputPath}"`;
              }
              ffmpegProcess = spawn(ffmpegCommand, { shell: true });
          } else {
              let ffmpegArgs;
              if (targetFormat === "mp3" || targetFormat === "m4a") {
                ffmpegArgs = ['-i', inputPath, '-vn', '-c:a', targetFormat === "mp3" ? 'libmp3lame' : 'aac', '-y', outputPath];
              } else {
                ffmpegArgs = ['-i', inputPath, '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', '-y', outputPath];
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
              safeSend('progress', `🎉 Successfully converted to ${outputFilename}`);
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
  let wasCancelled = false;
  if (ffmpegProcess) {
    ffmpegProcess.kill();
    ffmpegProcess = null;
    wasCancelled = true;
  }
  if (ytdlpProcess) {
    ytdlpProcess.kill();
    ytdlpProcess = null;
    wasCancelled = true;
  }
  if (wasCancelled && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('progress', '⏹️ Download/Conversion cancelled by user.');
      mainWindow.webContents.send('complete', '⏹️ Cancelled.');
  }
});

ipcMain.handle('restart-app', () => {
  app.relaunch();
  app.exit(0);
});

// --- End main.js ---