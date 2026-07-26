import * as path from 'path';
import * as fs from 'fs';
import sanitize from 'sanitize-filename';
import { dialog } from 'electron';
import log from 'electron-log/main.js';
import {
  spawnWithEnv,
  getEffectiveFfmpegPath,
  resolveFfmpegLocationForYtdlp,
  ytdlpBinary,
  isWindows,
} from './platform';
import { killChildProcess } from './processKill';
import { loadSettings, recordDownload } from './settings';
import {
  buildFfmpegArgs,
  buildYtdlpArgs,
  resolveVideoEncoder,
  probeMediaCodecs,
} from './download/commandBuilders';
import { JobProgressReporter, summarizeYtdlpJsonForConsole } from './download/jobProgressReporter';
import {
  createFfmpegProgressParseState,
  parseFfmpegProgressChunk,
  resolveJobProgressPlanFromSettings,
} from '../utils/downloadJobProgress';
import { isSafeHttpUrl } from '../utils/validation';
import { isMac } from './platform';
import {
  createDownloadLifecycleState,
  markDownloadCancelled,
  shouldEmitTerminalEvent,
  markTerminalEventEmitted,
  classifyDownloadExit,
} from '../utils/downloadLifecycle';
import {
  MAX_OUTPUT_BUFFER,
  MAX_ERROR_BUFFER,
  FORMAT_FETCH_TIMEOUT_MS,
  FFMPEG_CONVERT_TIMEOUT_MS,
} from './constants';
import type { ChildProcess } from 'child_process';
import type {
  DownloadSession,
  DownloadSessionOwner,
  DownloadRequestOptions,
  DownloadOutcome,
  FormatsProcess,
  Settings,
  QueueDownloadProgress,
} from '../types';

let activeDownloadSession: DownloadSession | null = null;
let downloadSessionOwner: DownloadSessionOwner | null = null;
let downloadSessionCounter = 0;
let formatsProcess: FormatsProcess | null = null;
let activeProgressReporter: JobProgressReporter | null = null;

export function getDownloadSessionOwner(): DownloadSessionOwner | null {
  return downloadSessionOwner;
}

export function isDownloadBusy(): boolean {
  return activeDownloadSession !== null;
}

export function canStartDownload(owner: DownloadSessionOwner): boolean {
  if (!activeDownloadSession) return true;
  return downloadSessionOwner === owner;
}

function isActiveSession(session: DownloadSession | null) {
  return Boolean(session && activeDownloadSession && activeDownloadSession.id === session.id);
}

function safeSend(sender: Electron.WebContents, channel: string, message: unknown) {
  if (!sender || sender.isDestroyed()) return;
  try {
    sender.send(channel, message);
  } catch (error) {
    log.warn(`Failed to send IPC '${channel}':`, error);
  }
}

function sendProgress(session: DownloadSession | null, message: string) {
  if (!session || !shouldEmitTerminalEvent(session.lifecycle)) return;
  if (!isActiveSession(session)) return;
  safeSend(session.sender, 'progress', message);
}

function handleYtdlpOutputLines(
  session: DownloadSession,
  reporter: JobProgressReporter,
  chunk: string,
  isStderr: boolean
) {
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('{')) {
      reporter.handleYtdlpOutputLine(session, trimmed);
      try {
        const parsed = JSON.parse(trimmed) as Parameters<typeof summarizeYtdlpJsonForConsole>[0];
        const summary = summarizeYtdlpJsonForConsole(parsed);
        if (summary) sendProgress(session, summary);
      } catch {
        // ignore invalid json
      }
      continue;
    }

    const handled = reporter.handleYtdlpOutputLine(session, trimmed);
    if (handled) continue;

    if (isStderr) {
      sendProgress(session, `[yt-dlp stderr] ${trimmed}`);
    } else {
      sendProgress(session, trimmed);
    }
  }
}

interface CompletionMeta {
  format?: string;
  bytes?: number;
  progressMessage?: string | null;
}

function statFileSize(filePath: string): number | undefined {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0 ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

function completeSession(
  session: DownloadSession | null,
  statusMessage: string,
  outcome: DownloadOutcome,
  meta: CompletionMeta = {}
) {
  if (!session || !isActiveSession(session)) return;
  if (!shouldEmitTerminalEvent(session.lifecycle)) return;
  session.lifecycle = markTerminalEventEmitted(session.lifecycle);
  if (meta.progressMessage) {
    safeSend(session.sender, 'progress', meta.progressMessage);
  }
  safeSend(session.sender, 'complete', statusMessage);

  if (typeof session.onComplete === 'function') {
    try {
      session.onComplete(statusMessage, outcome);
    } catch (error) {
      log.error('Error in download completion callback:', error);
    }
  }

  if (outcome === 'success') {
    recordDownload('success', meta.format, meta.bytes);
  } else {
    recordDownload(outcome);
  }

  activeDownloadSession = null;
  downloadSessionOwner = null;
  if (activeProgressReporter) {
    activeProgressReporter.emitIdle(session);
    activeProgressReporter.clearTaskbar();
    activeProgressReporter = null;
  }
}

function killProcess(proc: ChildProcess | null, label: string) {
  killChildProcess(proc, label);
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

  if (notify || session.owner === 'manual') {
    completeSession(session, '⏹️ Cancelled.', 'cancelled', {
      progressMessage: '⏹️ Download/Conversion cancelled by user.',
    });
    return;
  }

  if (typeof session.onComplete === 'function') {
    try {
      session.onComplete('⏹️ Cancelled.', 'cancelled');
    } catch (error) {
      log.error('Error in download cancellation callback:', error);
    }
  }

  recordDownload('cancelled');
  session.lifecycle = markTerminalEventEmitted(session.lifecycle);
  activeDownloadSession = null;
  downloadSessionOwner = null;
  if (activeProgressReporter) {
    activeProgressReporter.clearTaskbar();
    activeProgressReporter = null;
  }
}

export function killAllProcesses() {
  if (!activeDownloadSession) return;
  const session = activeDownloadSession;
  session.lifecycle = markDownloadCancelled(session.lifecycle);
  killProcess(session.ytdlpProcess, 'yt-dlp');
  killProcess(session.ffmpegProcess, 'ffmpeg');
  session.ytdlpProcess = null;
  session.ffmpegProcess = null;

  if (typeof session.onComplete === 'function') {
    try {
      session.onComplete('⏹️ Cancelled.', 'cancelled');
    } catch (error) {
      log.error('Error in download cancellation callback:', error);
    }
  }

  recordDownload('cancelled');
  session.lifecycle = markTerminalEventEmitted(session.lifecycle);
  activeDownloadSession = null;
  downloadSessionOwner = null;
  if (activeProgressReporter) {
    activeProgressReporter.clearTaskbar();
    activeProgressReporter = null;
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
        killChildProcess(formatsProcess.proc, 'formats');
      } catch (error) {
        log.warn('Error killing previous formats process:', error);
      }
    }
    const proc = spawnWithEnv(ytdlpPath, ['-F', '--', url]);
    formatsProcess = { proc, cancelled: false };
    let outputData = '';
    let errorData = '';

    const timeout = setTimeout(() => {
      try {
        formatsProcess!.cancelled = true;
        killChildProcess(proc, 'formats-timeout');
      } catch (error) {
        log.warn('Error killing formats process on timeout:', error);
      }
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
      proc.removeAllListeners();
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
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
      proc.removeAllListeners();
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
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
    } catch (error) {
      log.warn('Error killing formats process:', error);
    }
  }
}

async function runConversion(
  session: DownloadSession,
  downloadedFilePath: string,
  effectiveSettings: Settings,
  ffmpegCommand: string,
  mainWindow: Electron.BrowserWindow | null,
  progressReporter: JobProgressReporter | null
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
    const targetFormat = (effectiveSettings.convertFormat || 'mp4').toLowerCase();
    const outputPath = inputPath.replace(/\.[^/.]+$/, `.${targetFormat}`);
    const outputFilename = path.basename(outputPath);

    if (inputFileExt.toLowerCase() === `.${targetFormat}`) {
      sendProgress(
        session,
        `ℹ️ Downloaded file is already ${targetFormat.toUpperCase()} (${inputFilename}). Skipping conversion.`
      );
      completeSession(session, `✅ Done (Already ${targetFormat.toUpperCase()}).`, 'success', {
        format: targetFormat,
        bytes: statFileSize(inputPath),
      });
      return;
    }

    if (fs.existsSync(outputPath)) {
      sendProgress(session, `⚠️ Output file ${outputFilename} already exists. Overwriting.`);
    }

    sendProgress(session, `🎬 Converting ${inputFilename} to ${targetFormat.toUpperCase()}...`);

    const srcCodecs = await probeMediaCodecs(ffmpegCommand, inputPath);
    const videoEncoder = await resolveVideoEncoder(effectiveSettings);

    progressReporter?.emitConvertProgress(session, 0, 'Converting...');

    const ffmpegArgs = buildFfmpegArgs(
      inputPath,
      outputPath,
      targetFormat,
      videoEncoder,
      srcCodecs
    );

    const reencodesVideo = ffmpegArgs.includes('-c:v') && !ffmpegArgs.includes('copy');
    if (effectiveSettings.gpuAcceleration && videoEncoder !== 'copy' && reencodesVideo) {
      sendProgress(session, `🖥️ Using GPU acceleration (${videoEncoder})`);
    }

    const ffProc = spawnWithEnv(ffmpegCommand, ffmpegArgs, {
      // New process group so kill(-pid) reaches any ffmpeg sub-processes too.
      detached: !isWindows,
    });
    session.ffmpegProcess = ffProc;

    const ffmpegProgressState = createFfmpegProgressParseState(srcCodecs.durationSeconds ?? null);

    const conversionTimeout = setTimeout(() => {
      if (!isActiveSession(session) || !ffProc || ffProc.killed) return;
      sendProgress(session, '❌ Conversion timed out after 10 minutes.');
      killProcess(ffProc, 'ffmpeg-timeout');
      completeSession(session, '❌ Conversion failed (timeout).', 'failed');
    }, FFMPEG_CONVERT_TIMEOUT_MS);

    ffProc.stdout?.on('data', (data: Buffer) => {
      if (!isActiveSession(session)) return;
      const percent = parseFfmpegProgressChunk(ffmpegProgressState, data.toString());
      if (percent !== null) {
        progressReporter?.emitConvertProgress(session, percent, 'Converting...');
      }
    });
    ffProc.stderr?.on('data', (data: Buffer) => {
      if (!isActiveSession(session)) return;
      const text = data.toString().trim();
      if (text) sendProgress(session, `[ffmpeg] ${text}`);
    });

    ffProc.on('close', (ffmpegCode) => {
      clearTimeout(conversionTimeout);
      if (!isActiveSession(session)) return;
      session.ffmpegProcess = null;
      const ffExitType = classifyDownloadExit(session.lifecycle, ffmpegCode ?? 1);

      if (ffExitType === 'cancelled') {
        completeSession(session, '⏹️ Cancelled.', 'cancelled', {
          progressMessage: '⏹️ Download/Conversion cancelled by user.',
        });
        return;
      }

      if (ffExitType === 'success') {
        progressReporter?.emitConvertProgress(session, 100, 'Conversion complete');
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
        completeSession(session, '🎬 Conversion complete.', 'success', {
          format: targetFormat,
          bytes: statFileSize(outputPath),
        });
      } else {
        sendProgress(
          session,
          `❌ Conversion failed: FFmpeg process exited with code ${ffmpegCode}`
        );
        sendProgress(session, `   Check FFmpeg output above for details.`);
        try {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch {}
        completeSession(session, '❌ Conversion failed.', 'failed');
      }
    });

    ffProc.on('error', (err) => {
      clearTimeout(conversionTimeout);
      if (!isActiveSession(session)) return;
      session.ffmpegProcess = null;
      if (classifyDownloadExit(session.lifecycle, 1) === 'cancelled') {
        completeSession(session, '⏹️ Cancelled.', 'cancelled', {
          progressMessage: '⏹️ Download/Conversion cancelled by user.',
        });
        return;
      }
      if (err.message.includes('ENOENT')) {
        sendProgress(
          session,
          `❌ Failed to start conversion: FFmpeg was not found at ${ffmpegCommand}.`
        );
        completeSession(session, '❌ Conversion failed (FFmpeg not found).', 'failed');
        if (mainWindow && !mainWindow.isDestroyed()) {
          void dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'FFmpeg Error',
            message: `Failed to start conversion: FFmpeg not found at ${ffmpegCommand}.`,
            detail:
              'ROSI uses bundled FFmpeg by default. If you set a custom FFmpeg path, make sure it points to a valid FFmpeg binary.',
          });
        }
      } else {
        sendProgress(session, `❌ Failed to start conversion process: ${err.message}`);
        completeSession(session, '❌ Conversion failed (ffmpeg spawn error).', 'failed');
      }
    });
  } catch (err) {
    sendProgress(session, `❌ Error setting up conversion: ${(err as Error).message}`);
    completeSession(session, '❌ Conversion failed (setup error).', 'failed');
  }
}

export function startDownload(
  ytdlpPath: string,
  sender: Electron.WebContents,
  options: DownloadRequestOptions,
  mainWindow: Electron.BrowserWindow | null,
  onComplete?: (statusMessage: string, outcome?: DownloadOutcome) => void,
  owner: DownloadSessionOwner = 'manual',
  queueProgress: QueueDownloadProgress | null = null
) {
  if (activeDownloadSession && downloadSessionOwner !== owner) {
    throw new Error('Download session already active with a different owner.');
  }
  if (activeDownloadSession) {
    cancelActiveSession(false);
  }

  downloadSessionCounter += 1;
  const session: DownloadSession = {
    id: downloadSessionCounter,
    sender,
    owner,
    lifecycle: createDownloadLifecycleState(),
    ytdlpProcess: null,
    ffmpegProcess: null,
    onComplete,
    queueProgress,
    jobPhase: 'download',
    ytdlpPostprocess: false,
    ytdlpDownloadFinished: false,
  };
  activeDownloadSession = session;
  downloadSessionOwner = owner;

  const settings = loadSettings();
  const effectiveSettings: Settings = { ...settings };
  const ffmpegCommand = getEffectiveFfmpegPath(options.ffmpegPath || settings.ffmpegPath);
  const ffmpegLocation = resolveFfmpegLocationForYtdlp(options.ffmpegPath || settings.ffmpegPath);

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
    completeSession(session, '❌ Failed (Invalid URL).', 'failed');
    return;
  }
  if (!downloadDir || typeof downloadDir !== 'string' || downloadDir.trim() === '') {
    sendProgress(session, '⚠️ Invalid or missing download folder.');
    completeSession(session, '❌ Failed (Invalid Folder).', 'failed');
    return;
  }
  if (!fs.existsSync(ytdlpPath)) {
    sendProgress(session, `❌ Error: yt-dlp binary not found at ${ytdlpPath}`);
    completeSession(session, '❌ Failed (Missing Dependency).', 'failed');
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
        completeSession(session, '❌ Failed (Invalid Folder).', 'failed');
        return;
      }
    }

    const pathOutputFile = path.join(
      normalizedDownloadDir,
      `.rosi-path-${session.id}-${Date.now()}.txt`
    );
    const cleanupPathFile = () => {
      try {
        if (fs.existsSync(pathOutputFile)) fs.rmSync(pathOutputFile, { force: true });
      } catch {}
    };

    const { args: ytdlpArgs, statusMessages } = buildYtdlpArgs({
      normalizedDownloadDir,
      url,
      settings: effectiveSettings,
      options,
      ffmpegLocation,
      pathOutputFile,
    });
    statusMessages.forEach((message) => sendProgress(session, message));

    const progressPlan = resolveJobProgressPlanFromSettings({
      downloadProfilesEnabled: effectiveSettings.downloadProfilesEnabled,
      downloadMode: effectiveSettings.downloadMode,
      bestQuality: effectiveSettings.bestQuality,
      audioOnly: effectiveSettings.audioOnly,
      advancedOptions: effectiveSettings.advancedOptions,
      convertEnabled: effectiveSettings.convertEnabled,
    });
    const progressReporter = new JobProgressReporter(
      mainWindow,
      progressPlan,
      queueProgress,
      effectiveSettings.showTaskbarProgress
    );
    activeProgressReporter = progressReporter;
    progressReporter.emitPhaseIndeterminate(session, 'download', 'Starting download...');

    sendProgress(session, `🚀 Starting download: ${url}`);
    sendProgress(session, `   Command: ${ytdlpBinary} ${ytdlpArgs.join(' ')}`);
    const ytProc = spawnWithEnv(ytdlpPath, ytdlpArgs, {
      env: { PYTHONUNBUFFERED: '1' },
      // On Unix, spawn as a new process-group leader so kill(-pid) delivers
      // signals to yt-dlp AND any ffmpeg it spawns internally for merging.
      detached: !isWindows,
    });
    session.ytdlpProcess = ytProc;

    let downloadOutputData = '';
    let downloadErrorData = '';

    ytProc.stdout?.on('data', (data: Buffer) => {
      if (!isActiveSession(session)) return;
      const message = data.toString();
      if (downloadOutputData.length + message.length > MAX_OUTPUT_BUFFER) {
        downloadOutputData = downloadOutputData.slice(-MAX_OUTPUT_BUFFER / 2);
      }
      downloadOutputData += message;
      handleYtdlpOutputLines(session, progressReporter, message, false);
    });

    ytProc.stderr?.on('data', (data: Buffer) => {
      if (!isActiveSession(session)) return;
      const message = data.toString();
      if (downloadErrorData.length < MAX_ERROR_BUFFER) {
        downloadErrorData += message;
      }
      handleYtdlpOutputLines(session, progressReporter, message, true);
    });

    ytProc.on('close', (code) => {
      if (!isActiveSession(session)) return;
      session.ytdlpProcess = null;

      const exitType = classifyDownloadExit(session.lifecycle, code ?? 1);
      if (exitType === 'cancelled') {
        cleanupPathFile();
        completeSession(session, '⏹️ Cancelled.', 'cancelled', {
          progressMessage: '⏹️ Download/Conversion cancelled by user.',
        });
        return;
      }

      if (exitType === 'failed') {
        cleanupPathFile();
        sendProgress(session, `❌ Download failed: yt-dlp process exited with code ${code}`);
        if (
          downloadErrorData.includes('different Team IDs') ||
          downloadErrorData.includes('[PYI-') ||
          downloadErrorData.includes('Failed to load Python shared library')
        ) {
          sendProgress(
            session,
            '   macOS blocked the bundled yt-dlp runtime (code signing). Install yt-dlp via Homebrew as a workaround, or use a rebuilt ROSI release with signed helpers.'
          );
        }
        sendProgress(session, `   Check console and stderr output above for details.`);
        completeSession(session, '❌ Download failed.', 'failed');
        return;
      }

      let downloadedFilePath: string;
      try {
        let rawPath: string | null = null;
        try {
          if (fs.existsSync(pathOutputFile)) {
            const fileLines = fs
              .readFileSync(pathOutputFile, 'utf-8')
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l.length > 0);
            if (fileLines.length > 0) {
              rawPath = fileLines[fileLines.length - 1] ?? null;
            }
          }
        } catch (readErr) {
          log.warn('Failed to read yt-dlp path output file:', readErr);
        }

        if (!rawPath) {
          const outputLines = downloadOutputData.trim().split('\n');
          const pathLines = outputLines
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith('[') && !l.startsWith('WARNING'));
          rawPath = pathLines.length > 0 ? (pathLines[pathLines.length - 1] ?? null) : null;
        }

        if (!rawPath || rawPath.trim() === '') {
          throw new Error("Could not find a valid filepath in yt-dlp's output.");
        }
        const resolvedFilePath = path.resolve(rawPath);
        const resolvedDownloadDir = path.resolve(normalizedDownloadDir);
        const caseInsensitive = isWindows || isMac;
        const compareFilePath = caseInsensitive ? resolvedFilePath.toLowerCase() : resolvedFilePath;
        const compareDownloadDir = caseInsensitive
          ? resolvedDownloadDir.toLowerCase()
          : resolvedDownloadDir;
        const relativePath = path.relative(compareDownloadDir, compareFilePath);
        if (
          path.isAbsolute(relativePath) ||
          relativePath === '..' ||
          relativePath.startsWith(`..${path.sep}`) ||
          relativePath.startsWith('../')
        ) {
          throw new Error(
            `Downloaded file path "${resolvedFilePath}" is outside the expected directory "${resolvedDownloadDir}".`
          );
        }
        downloadedFilePath = resolvedFilePath;
        cleanupPathFile();
        sendProgress(session, `✅ Download finished. Identified file: ${downloadedFilePath}`);
      } catch (extractError) {
        cleanupPathFile();
        sendProgress(session, `❌ Error determining downloaded file path after download.`);
        sendProgress(session, `   Error: ${(extractError as Error).message}`);
        completeSession(session, '❌ Failed (File Path Error).', 'failed');
        return;
      }

      if (effectiveSettings.convertEnabled) {
        void runConversion(
          session,
          downloadedFilePath,
          effectiveSettings,
          ffmpegCommand,
          mainWindow,
          progressReporter
        );
      } else {
        sendProgress(session, 'ℹ️ Conversion not enabled for this download.');
        progressReporter.emitDownloadComplete(session);
        const ext = path.extname(downloadedFilePath).replace('.', '').toLowerCase() || undefined;
        completeSession(session, '✅ Download complete (no conversion).', 'success', {
          format: ext,
          bytes: statFileSize(downloadedFilePath),
        });
      }
    });

    ytProc.on('error', (err) => {
      if (!isActiveSession(session)) return;
      session.ytdlpProcess = null;
      cleanupPathFile();
      if (classifyDownloadExit(session.lifecycle, 1) === 'cancelled') {
        completeSession(session, '⏹️ Cancelled.', 'cancelled', {
          progressMessage: '⏹️ Download/Conversion cancelled by user.',
        });
        return;
      }
      sendProgress(session, `❌ Failed to start download process: ${err.message}`);
      completeSession(session, '❌ Download failed (process spawn error).', 'failed');
    });
  } catch (error) {
    sendProgress(session, `❌ Error before starting download: ${(error as Error).message}`);
    completeSession(session, '❌ Failed (Initial Setup Error).', 'failed');
  }
}
