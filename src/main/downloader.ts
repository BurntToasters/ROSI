import * as path from 'path';
import * as fs from 'fs';
import sanitize from 'sanitize-filename';
import { dialog } from 'electron';
import log from 'electron-log/main';
import { spawnWithEnv, resolveFfmpegPath, ytdlpBinary, isWindows } from './platform';
import { loadSettings } from './settings';
import { buildFfmpegArgs, buildYtdlpArgs, resolveVideoEncoder } from './download/commandBuilders';
import { isSafeHttpUrl } from '../utils/validation';
import {
  createDownloadLifecycleState,
  markDownloadCancelled,
  shouldEmitTerminalEvent,
  markTerminalEventEmitted,
  classifyDownloadExit,
} from '../utils/downloadLifecycle';
import { MAX_OUTPUT_BUFFER, MAX_ERROR_BUFFER, FORMAT_FETCH_TIMEOUT_MS } from './constants';
import type { ChildProcess } from 'child_process';
import type { DownloadSession, DownloadRequestOptions, FormatsProcess, Settings } from '../types';

let ytdlpProcess: ChildProcess | null = null;
let ffmpegProcess: ChildProcess | null = null;
let activeDownloadSession: DownloadSession | null = null;
let downloadSessionCounter = 0;
let formatsProcess: FormatsProcess | null = null;

function isActiveSession(session: DownloadSession | null) {
  return Boolean(session && activeDownloadSession && activeDownloadSession.id === session.id);
}

function safeSend(sender: Electron.WebContents, channel: string, message: unknown) {
  if (sender && !sender.isDestroyed()) {
    sender.send(channel, message);
  }
}

function sendProgress(session: DownloadSession | null, message: string) {
  if (!session || !shouldEmitTerminalEvent(session.lifecycle)) return;
  if (!isActiveSession(session)) return;
  safeSend(session.sender, 'progress', message);
}

function completeSession(
  session: DownloadSession | null,
  statusMessage: string,
  progressMessage: string | null = null
) {
  if (!session || !isActiveSession(session)) return;
  if (!shouldEmitTerminalEvent(session.lifecycle)) return;
  session.lifecycle = markTerminalEventEmitted(session.lifecycle);
  if (progressMessage) {
    safeSend(session.sender, 'progress', progressMessage);
  }
  safeSend(session.sender, 'complete', statusMessage);
  activeDownloadSession = null;
  ytdlpProcess = null;
  ffmpegProcess = null;
}

function killProcess(proc: ChildProcess | null, label: string) {
  if (!proc) return;
  try {
    proc.kill();
  } catch (error) {
    log.error(`Error killing ${label} process:`, error);
  }
}

export function cancelActiveSession(notify = true) {
  if (!activeDownloadSession) return;
  const session = activeDownloadSession;
  session.lifecycle = markDownloadCancelled(session.lifecycle);
  killProcess(session.ffmpegProcess, 'ffmpeg');
  killProcess(session.ytdlpProcess, 'yt-dlp');
  session.ffmpegProcess = null;
  session.ytdlpProcess = null;

  if (!isActiveSession(session)) return;

  if (notify) {
    completeSession(session, '⏹️ Cancelled.', '⏹️ Download/Conversion cancelled by user.');
    return;
  }

  session.lifecycle = markTerminalEventEmitted(session.lifecycle);
  activeDownloadSession = null;
  ytdlpProcess = null;
  ffmpegProcess = null;
}

export function killAllProcesses() {
  if (ytdlpProcess) {
    try {
      ytdlpProcess.kill();
    } catch {}
    ytdlpProcess = null;
  }
  if (ffmpegProcess) {
    try {
      ffmpegProcess.kill();
    } catch {}
    ffmpegProcess = null;
  }
}

export function fetchFormats(ytdlpPath: string, url: string): Promise<string> {
  if (!isSafeHttpUrl(url)) {
    return Promise.reject('Invalid URL provided');
  }
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(ytdlpPath)) {
      return reject(`yt-dlp binary not found at ${ytdlpPath}`);
    }
    if (formatsProcess?.proc && !formatsProcess.proc.killed) {
      try {
        formatsProcess.cancelled = true;
        formatsProcess.proc.kill();
      } catch {}
    }
    const proc = spawnWithEnv(ytdlpPath, ['-F', url]);
    formatsProcess = { proc, cancelled: false };
    let outputData = '';
    let errorData = '';

    const timeout = setTimeout(() => {
      try {
        formatsProcess!.cancelled = true;
        proc.kill();
      } catch {}
      reject('Format fetch timed out after 60 seconds. The server may be slow or unresponsive.');
    }, FORMAT_FETCH_TIMEOUT_MS);

    proc.stdout?.on('data', (data) => {
      if (outputData.length < MAX_OUTPUT_BUFFER) outputData += data;
    });
    proc.stderr?.on('data', (data) => {
      if (errorData.length < MAX_ERROR_BUFFER) errorData += data;
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      const wasCancelled = formatsProcess?.proc === proc && formatsProcess.cancelled;
      if (formatsProcess?.proc === proc) {
        formatsProcess = null;
      }
      if (wasCancelled) {
        reject('Format fetch cancelled.');
        return;
      }
      if (code === 0) {
        resolve(outputData);
      } else {
        reject(`yt-dlp exited with code ${code}.\nOutput:\n${outputData}\nError:\n${errorData}`);
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      if (formatsProcess?.proc === proc) {
        formatsProcess = null;
      }
      reject(`Failed to start yt-dlp: ${err.message}`);
    });
  });
}

export function cancelFormats() {
  if (formatsProcess?.proc && !formatsProcess.proc.killed) {
    formatsProcess.cancelled = true;
    try {
      formatsProcess.proc.kill();
    } catch {}
  }
}

async function runConversion(
  session: DownloadSession,
  downloadedFilePath: string,
  effectiveSettings: Settings,
  ffmpegCommand: string,
  mainWindow: Electron.BrowserWindow | null
) {
  sendProgress(session, '⏳ Checking if conversion is needed...');
  try {
    const originalInputPath = downloadedFilePath;
    const originalFileName = path.basename(originalInputPath);
    let sanitizedFileName = sanitize(originalFileName);

    if (!sanitizedFileName || sanitizedFileName.trim() === '') {
      const ext = path.extname(originalFileName) || '.mp4';
      sanitizedFileName = `download_${Date.now()}${ext}`;
      sendProgress(
        session,
        `⚠️ Original filename contained only invalid characters. Using: ${sanitizedFileName}`
      );
    }

    const sanitizedInputPath = path.join(path.dirname(originalInputPath), sanitizedFileName);

    if (originalInputPath !== sanitizedInputPath) {
      fs.renameSync(originalInputPath, sanitizedInputPath);
      sendProgress(session, `Renamed to sanitized filename: ${sanitizedFileName}`);
    }

    const inputPath = sanitizedInputPath;
    const inputFileExt = path.extname(inputPath);
    const inputFilename = path.basename(inputPath);
    const targetFormat = effectiveSettings.convertFormat || 'mp4';
    const outputPath = inputPath.replace(/\.[^/.]+$/, `.${targetFormat}`);
    const outputFilename = path.basename(outputPath);

    if (inputFileExt.toLowerCase() === `.${targetFormat}`) {
      sendProgress(
        session,
        `ℹ️ Downloaded file is already ${targetFormat.toUpperCase()} (${inputFilename}). Skipping conversion.`
      );
      completeSession(session, `✅ Done (Already ${targetFormat.toUpperCase()}).`);
      return;
    }

    if (fs.existsSync(outputPath)) {
      sendProgress(session, `⚠️ Output file ${outputFilename} already exists. Overwriting.`);
    }

    sendProgress(session, `🎬 Converting ${inputFilename} to ${targetFormat.toUpperCase()}...`);

    const videoEncoder = await resolveVideoEncoder(effectiveSettings);
    const useGpu = effectiveSettings.gpuAcceleration && videoEncoder !== 'copy';

    if (useGpu) {
      sendProgress(session, `🖥️ Using GPU acceleration (${videoEncoder})`);
    }

    const ffmpegArgs = buildFfmpegArgs(inputPath, outputPath, targetFormat, videoEncoder);

    ffmpegProcess = spawnWithEnv(ffmpegCommand, ffmpegArgs);
    session.ffmpegProcess = ffmpegProcess;

    ffmpegProcess.stdout?.on('data', (data) => {
      if (!isActiveSession(session)) return;
      sendProgress(session, `[ffmpeg] ${data.toString().trim()}`);
    });
    ffmpegProcess.stderr?.on('data', (data) => {
      if (!isActiveSession(session)) return;
      sendProgress(session, `[ffmpeg] ${data.toString().trim()}`);
    });

    ffmpegProcess.on('close', (ffmpegCode) => {
      if (!isActiveSession(session)) return;
      session.ffmpegProcess = null;
      ffmpegProcess = null;
      const ffExitType = classifyDownloadExit(session.lifecycle, ffmpegCode ?? 1);

      if (ffExitType === 'cancelled') {
        completeSession(session, '⏹️ Cancelled.', '⏹️ Download/Conversion cancelled by user.');
        return;
      }

      if (ffExitType === 'success') {
        sendProgress(session, `🎉 Successfully converted to ${outputPath}`);
        const shouldDelete = !effectiveSettings.keepOriginalAfterConvert;
        const pathsDiffer = isWindows
          ? inputPath.toLowerCase() !== outputPath.toLowerCase()
          : inputPath !== outputPath;
        if (shouldDelete && pathsDiffer) {
          sendProgress(session, `Attempting to delete original file: ${inputFilename}`);
          try {
            fs.unlinkSync(inputPath);
            sendProgress(session, `🗑️ Deleted original file: ${inputFilename}`);
          } catch (unlinkErr) {
            sendProgress(
              session,
              `⚠️ Could not delete original file: ${inputFilename} (${(unlinkErr as Error).message})`
            );
          }
        } else if (effectiveSettings.keepOriginalAfterConvert) {
          sendProgress(session, `ℹ️ Keeping original file (${inputFilename}) as per settings.`);
        } else if (!pathsDiffer) {
          sendProgress(
            session,
            `ℹ️ Input and output paths resolved to the same file (${inputPath}), cannot delete original.`
          );
        }
        completeSession(session, '🎬 Conversion complete.');
      } else {
        sendProgress(
          session,
          `❌ Conversion failed: FFmpeg process exited with code ${ffmpegCode}`
        );
        sendProgress(session, `   Check FFmpeg output above for details.`);
        completeSession(session, '❌ Conversion failed.');
      }
    });

    ffmpegProcess.on('error', (err) => {
      if (!isActiveSession(session)) return;
      session.ffmpegProcess = null;
      ffmpegProcess = null;
      if (classifyDownloadExit(session.lifecycle, 1) === 'cancelled') {
        completeSession(session, '⏹️ Cancelled.', '⏹️ Download/Conversion cancelled by user.');
        return;
      }
      if (err.message.includes('ENOENT')) {
        sendProgress(
          session,
          `❌ Failed to start conversion: FFmpeg not found at ${ffmpegCommand}. Ensure FFMPEG is installed and accessible.`
        );
        completeSession(session, '❌ Conversion failed (FFMPEG not found).');
        if (mainWindow && !mainWindow.isDestroyed()) {
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'FFMPEG Error',
            message: `Failed to start conversion: FFmpeg not found at ${ffmpegCommand}.`,
            detail:
              'Please ensure FFMPEG is installed and accessible, or set a custom FFmpeg path in Settings. See Help for more details.',
          });
        }
      } else {
        sendProgress(session, `❌ Failed to start conversion process: ${err.message}`);
        completeSession(session, '❌ Conversion failed (ffmpeg spawn error).');
      }
    });
  } catch (err) {
    sendProgress(session, `❌ Error setting up conversion: ${(err as Error).message}`);
    completeSession(session, '❌ Conversion failed (setup error).');
  }
}

export function startDownload(
  ytdlpPath: string,
  sender: Electron.WebContents,
  options: DownloadRequestOptions,
  mainWindow: Electron.BrowserWindow | null
) {
  if (activeDownloadSession) {
    cancelActiveSession(false);
  }

  downloadSessionCounter += 1;
  const session: DownloadSession = {
    id: downloadSessionCounter,
    sender,
    lifecycle: createDownloadLifecycleState(),
    ytdlpProcess: null,
    ffmpegProcess: null,
  };
  activeDownloadSession = session;

  const settings = loadSettings();
  const effectiveSettings: Settings = { ...settings };
  const ffmpegLocation = resolveFfmpegPath(options.ffmpegPath || settings.ffmpegPath);
  const ffmpegCommand = ffmpegLocation || 'ffmpeg';

  if (options.convertFormat !== undefined) {
    if (typeof options.convertFormat === 'string' && options.convertFormat.trim() !== '') {
      effectiveSettings.convertFormat = options.convertFormat;
      effectiveSettings.convertEnabled = true;
    } else {
      effectiveSettings.convertEnabled = false;
    }
  }
  if (typeof options.keepOriginal === 'boolean') {
    effectiveSettings.keepOriginalAfterConvert = options.keepOriginal;
  }

  const url = options.url;
  const downloadDir = options.outputPath;

  if (!isSafeHttpUrl(url)) {
    sendProgress(session, '⚠️ Invalid or missing URL.');
    completeSession(session, '❌ Failed (Invalid URL).');
    return;
  }
  if (!downloadDir || typeof downloadDir !== 'string' || downloadDir.trim() === '') {
    sendProgress(session, '⚠️ Invalid or missing download folder.');
    completeSession(session, '❌ Failed (Invalid Folder).');
    return;
  }
  if (!fs.existsSync(ytdlpPath)) {
    sendProgress(session, `❌ Error: yt-dlp binary not found at ${ytdlpPath}`);
    completeSession(session, '❌ Failed (Missing Dependency).');
    return;
  }

  try {
    const normalizedDownloadDir = path.resolve(downloadDir);
    if (!fs.existsSync(normalizedDownloadDir)) {
      sendProgress(session, `📂 Creating directory: ${normalizedDownloadDir}`);
      fs.mkdirSync(normalizedDownloadDir, { recursive: true });
    } else {
      const stats = fs.statSync(normalizedDownloadDir);
      if (!stats.isDirectory()) {
        sendProgress(session, `❌ Download path is not a directory: ${normalizedDownloadDir}`);
        completeSession(session, '❌ Failed (Invalid Folder).');
        return;
      }
    }

    const { args: ytdlpArgs, statusMessages } = buildYtdlpArgs({
      normalizedDownloadDir,
      url,
      settings: effectiveSettings,
      options,
      ffmpegLocation,
    });
    statusMessages.forEach((message) => sendProgress(session, message));

    sendProgress(session, `🚀 Starting download: ${url}`);
    sendProgress(session, `   Command: ${ytdlpBinary} ${ytdlpArgs.join(' ')}`);
    ytdlpProcess = spawnWithEnv(ytdlpPath, ytdlpArgs, {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    session.ytdlpProcess = ytdlpProcess;

    let downloadOutputData = '';
    let downloadErrorData = '';

    ytdlpProcess.stdout?.on('data', (data) => {
      if (!isActiveSession(session)) return;
      const message = data.toString();
      if (downloadOutputData.length > MAX_OUTPUT_BUFFER) {
        downloadOutputData = downloadOutputData.slice(-MAX_OUTPUT_BUFFER / 2);
      }
      downloadOutputData += message;
      sendProgress(session, message.trim());
    });

    ytdlpProcess.stderr?.on('data', (data) => {
      if (!isActiveSession(session)) return;
      const message = data.toString();
      if (downloadErrorData.length < MAX_ERROR_BUFFER) {
        downloadErrorData += message;
      }
      sendProgress(session, `[yt-dlp stderr] ${message.trim()}`);
    });

    ytdlpProcess.on('close', (code) => {
      if (!isActiveSession(session)) return;
      session.ytdlpProcess = null;
      ytdlpProcess = null;

      const exitType = classifyDownloadExit(session.lifecycle, code ?? 1);
      if (exitType === 'cancelled') {
        completeSession(session, '⏹️ Cancelled.', '⏹️ Download/Conversion cancelled by user.');
        return;
      }

      if (exitType === 'failed') {
        sendProgress(session, `❌ Download failed: yt-dlp process exited with code ${code}`);
        sendProgress(session, `   Check console and stderr output above for details.`);
        completeSession(session, '❌ Download failed.');
        return;
      }

      let downloadedFilePath: string | null = null;
      try {
        const outputLines = downloadOutputData.trim().split('\n');
        downloadedFilePath = outputLines.filter((line) => line.trim() !== '').pop() ?? null;
        if (!downloadedFilePath) {
          throw new Error("Could not find a valid filepath in yt-dlp's output.");
        }
        sendProgress(session, `✅ Download finished. Identified file: ${downloadedFilePath}`);
      } catch (extractError) {
        sendProgress(session, `❌ Error determining downloaded file path after download.`);
        sendProgress(session, `   Error: ${(extractError as Error).message}`);
        completeSession(session, '❌ Failed (File Path Error).');
        return;
      }

      if (effectiveSettings.convertEnabled) {
        void runConversion(
          session,
          downloadedFilePath,
          effectiveSettings,
          ffmpegCommand,
          mainWindow
        );
      } else {
        sendProgress(session, 'ℹ️ Conversion not enabled for this download.');
        completeSession(session, '✅ Download complete (no conversion).');
      }
    });

    ytdlpProcess.on('error', (err) => {
      if (!isActiveSession(session)) return;
      session.ytdlpProcess = null;
      ytdlpProcess = null;
      if (classifyDownloadExit(session.lifecycle, 1) === 'cancelled') {
        completeSession(session, '⏹️ Cancelled.', '⏹️ Download/Conversion cancelled by user.');
        return;
      }
      sendProgress(session, `❌ Failed to start download process: ${err.message}`);
      completeSession(session, '❌ Download failed (process spawn error).');
    });
  } catch (error) {
    sendProgress(session, `❌ Error before starting download: ${(error as Error).message}`);
    completeSession(session, '❌ Failed (Initial Setup Error).');
  }
}
