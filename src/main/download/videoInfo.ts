import * as fs from 'fs';
import log from 'electron-log/main.js';
import { spawnWithEnv } from '../platform';
import { killChildProcess } from '../processKill';
import { isSafeHttpUrl } from '../../utils/validation';
import { MAX_OUTPUT_BUFFER, MAX_ERROR_BUFFER, FORMAT_FETCH_TIMEOUT_MS } from '../constants';
import type { FormatsProcess, VideoInfo } from '../../types';

let infoProcess: FormatsProcess | null = null;

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function pickNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pickThumbnail(value: unknown): string | null {
  return typeof value === 'string' && isSafeHttpUrl(value) ? value : null;
}

/**
 * How many flat playlist entries a preview will pull. Entries are small, but
 * the listing still has to finish quickly, so it stays bounded.
 */
export const PLAYLIST_PREVIEW_ENTRY_LIMIT = 500;

export function parseVideoInfo(
  jsonString: string,
  entryLimit = PLAYLIST_PREVIEW_ENTRY_LIMIT
): VideoInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const data = parsed as Record<string, unknown>;
  const isPlaylist = data._type === 'playlist' || Array.isArray(data.entries);
  const entries: unknown[] | null = Array.isArray(data.entries)
    ? (data.entries as unknown[])
    : null;

  let thumbnail = pickThumbnail(data.thumbnail);
  if (!thumbnail && Array.isArray(data.thumbnails) && data.thumbnails.length > 0) {
    const last: unknown = (data.thumbnails as unknown[])[data.thumbnails.length - 1];
    if (last && typeof last === 'object') {
      thumbnail = pickThumbnail((last as Record<string, unknown>).url);
    }
  }
  if (!thumbnail && entries && entries.length > 0) {
    const first: unknown = entries[0];
    if (first && typeof first === 'object') {
      thumbnail = pickThumbnail((first as Record<string, unknown>).thumbnail);
    }
  }

  const title =
    pickString(data.title) ?? pickString(data.fulltitle) ?? (isPlaylist ? 'Playlist' : 'Untitled');

  // Prefer the extractor's own total. Only fall back to counting entries when
  // the listing was not truncated, otherwise the limit would be reported as if
  // it were the real playlist length.
  const reportedCount = pickNumber(data.playlist_count);
  const entriesWereTruncated = entries !== null && entries.length >= entryLimit;
  const playlistCount = reportedCount ?? (entries && !entriesWereTruncated ? entries.length : null);

  return {
    title,
    uploader: pickString(data.uploader) ?? pickString(data.channel) ?? pickString(data.creator),
    durationSeconds: pickNumber(data.duration),
    thumbnail,
    ext: pickString(data.ext),
    viewCount: pickNumber(data.view_count),
    isPlaylist,
    playlistCount,
    webpageUrl: pickThumbnail(data.webpage_url),
  };
}

export function cancelVideoInfo(): void {
  if (infoProcess?.proc && !infoProcess.proc.killed) {
    infoProcess.cancelled = true;
    killChildProcess(infoProcess.proc, 'video-info');
  }
}

function resolveVideoInfoPlaylistMode(
  url: string,
  requestedMode?: 'current' | 'all'
): 'current' | 'all' {
  if (requestedMode) return requestedMode;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.has('list') || /\/playlist(?:\/|$)/i.test(parsed.pathname)
      ? 'all'
      : 'current';
  } catch {
    return 'current';
  }
}

export function fetchVideoInfo(
  ytdlpPath: string,
  url: string,
  playlistMode?: 'current' | 'all'
): Promise<VideoInfo> {
  if (!isSafeHttpUrl(url)) {
    return Promise.reject('Invalid URL provided');
  }
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(ytdlpPath)) {
      return reject(`yt-dlp binary not found at ${ytdlpPath}`);
    }
    if (infoProcess?.proc && !infoProcess.proc.killed) {
      try {
        infoProcess.cancelled = true;
        killChildProcess(infoProcess.proc, 'video-info');
      } catch (error) {
        log.warn('Error killing previous video info process:', error);
      }
    }

    const resolvedPlaylistMode = resolveVideoInfoPlaylistMode(url, playlistMode);
    const playlistArgs =
      resolvedPlaylistMode === 'all'
        ? [
            '--yes-playlist',
            '--flat-playlist',
            '--playlist-end',
            String(PLAYLIST_PREVIEW_ENTRY_LIMIT),
          ]
        : ['--no-playlist'];
    const proc = spawnWithEnv(ytdlpPath, [
      '--dump-single-json',
      ...playlistArgs,
      '--no-warnings',
      '--skip-download',
      '--',
      url,
    ]);
    infoProcess = { proc, cancelled: false };
    let outputData = '';
    let errorData = '';

    const timeout = setTimeout(() => {
      try {
        infoProcess!.cancelled = true;
        killChildProcess(proc, 'video-info-timeout');
      } catch (error) {
        log.warn('Error killing video info process on timeout:', error);
      }
      reject('Video info request timed out. The server may be slow or unresponsive.');
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
      const wasCancelled = infoProcess?.proc === proc && infoProcess.cancelled;
      if (infoProcess?.proc === proc) {
        infoProcess = null;
      }
      if (wasCancelled) {
        reject('Video info request cancelled.');
        return;
      }
      if (code !== 0) {
        reject(`yt-dlp exited with code ${code}.\n${errorData}`);
        return;
      }
      const info = parseVideoInfo(outputData);
      if (!info) {
        reject('Could not parse video information.');
        return;
      }
      resolve(info);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      proc.removeAllListeners();
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      if (infoProcess?.proc === proc) {
        infoProcess = null;
      }
      reject(`Failed to start yt-dlp: ${err.message}`);
    });
  });
}
