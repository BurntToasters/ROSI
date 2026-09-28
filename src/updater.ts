// In-app updater built on @tauri-apps/plugin-updater. Mirrors Zinnia's
// stable/beta channel selection: stable checks use the default
// latest-{target}-{arch}.json endpoints; beta checks pass a custom
// `{os}-beta-{arch}-{installer}` target so they read the beta manifests
// published (and synced onto the latest stable release) by scripts/gpg-sign.js.
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';

export type UpdaterStatusEvent =
  | { status: 'checking' }
  | { status: 'available'; version: string; releaseNotes: string | null; isBeta: boolean }
  | { status: 'not-available'; version: string; isBeta: boolean }
  | { status: 'error'; message: string }
  | { status: 'cancelled' }
  | { status: 'downloaded'; version: string };

export interface UpdaterProgressEvent {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

const UPDATE_CHECK_TIMEOUT_MS = 30_000;
// Bundles carry yt-dlp and FFmpeg, so allow slow connections to finish.
const UPDATE_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const PROGRESS_EMIT_INTERVAL_MS = 100;

const statusListeners = new Set<(event: UpdaterStatusEvent) => void>();
const progressListeners = new Set<(event: UpdaterProgressEvent) => void>();

let pendingUpdate: Update | null = null;
let pendingTarget: string | undefined;
let downloaded = false;
let downloading = false;
let generation = 0;

function emitStatus(event: UpdaterStatusEvent): void {
  for (const listener of statusListeners) listener(event);
}

function emitProgress(event: UpdaterProgressEvent): void {
  for (const listener of progressListeners) listener(event);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isBetaVersion(version: string): boolean {
  return /-(beta|alpha|rc)/i.test(version);
}

function releasePending(): void {
  const update = pendingUpdate;
  pendingUpdate = null;
  pendingTarget = undefined;
  downloaded = false;
  if (update) void update.close().catch(() => {});
}

async function updateCheckTarget(): Promise<string | undefined> {
  const settings = await invoke<{ updateChannel?: string }>('get_settings');
  const channel = settings.updateChannel ?? 'auto';
  if (channel === 'stable') return undefined;
  if (channel === 'beta') return invoke<string>('get_beta_updater_target');
  // auto: follow the installed version.
  return isBetaVersion(await getVersion()) ? invoke<string>('get_beta_updater_target') : undefined;
}

async function checkFeed(target: string | undefined): Promise<Update | null> {
  const options = { ...(target ? { target } : {}), timeout: UPDATE_CHECK_TIMEOUT_MS };
  try {
    const update = await check(options);
    // Beta manifests are swapped onto the stable release through two adjacent
    // asset renames. A second lookup masks that short window.
    if (!update && target) return await check(options);
    return update;
  } catch (error) {
    if (!target) throw error;
    return check(options);
  }
}

export function onUpdaterStatus(listener: (event: UpdaterStatusEvent) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function onUpdaterProgress(listener: (event: UpdaterProgressEvent) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

export async function checkForUpdates(): Promise<{ error: string; message?: string } | null> {
  if (!(await invoke<boolean>('is_packaged'))) {
    return { error: 'dev-mode', message: 'Update checking is not available in development mode.' };
  }
  if (await invoke<boolean>('is_flatpak')) {
    return {
      error: 'Flatpak builds update through a reinstalled bundle, not the in-app updater.',
    };
  }
  if (downloading) return null;
  emitStatus({ status: 'checking' });
  try {
    const target = await updateCheckTarget();
    if (pendingUpdate && pendingTarget !== target) releasePending();
    const currentVersion = await getVersion();
    const update = await checkFeed(target);
    if (!update) {
      emitStatus({
        status: 'not-available',
        version: currentVersion,
        isBeta: isBetaVersion(currentVersion),
      });
      return null;
    }
    if (pendingUpdate && pendingUpdate.version === update.version && downloaded) {
      void update.close().catch(() => {});
      emitStatus({ status: 'downloaded', version: pendingUpdate.version });
      return null;
    }
    releasePending();
    pendingUpdate = update;
    pendingTarget = target;
    emitStatus({
      status: 'available',
      version: update.version,
      releaseNotes: update.body ?? null,
      isBeta: isBetaVersion(update.version),
    });
    return null;
  } catch (error) {
    emitStatus({ status: 'error', message: errorMessage(error) });
    return null;
  }
}

export async function downloadUpdate(): Promise<{
  success?: boolean;
  cancelled?: boolean;
  error?: string;
}> {
  const update = pendingUpdate;
  if (!update) return { error: 'No update is ready to download.' };
  if (downloading) return { error: 'A download is already in progress.' };
  downloading = true;
  const current = ++generation;
  const startedAt = Date.now();
  let total = 0;
  let transferred = 0;
  let lastEmit = 0;
  try {
    await update.download(
      (event: DownloadEvent) => {
        if (current !== generation) return;
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
          return;
        }
        if (event.event === 'Progress') transferred += event.data.chunkLength;
        const now = Date.now();
        if (event.event === 'Progress' && now - lastEmit < PROGRESS_EMIT_INTERVAL_MS) return;
        lastEmit = now;
        const elapsed = Math.max((now - startedAt) / 1000, 0.001);
        emitProgress({
          percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0,
          bytesPerSecond: transferred / elapsed,
          transferred,
          total: total || transferred,
        });
      },
      { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS }
    );
    if (current !== generation) return { cancelled: true };
    downloaded = true;
    emitStatus({ status: 'downloaded', version: update.version });
    return { success: true };
  } catch (error) {
    if (current !== generation) return { cancelled: true };
    const message = errorMessage(error);
    emitStatus({ status: 'error', message });
    return { error: message };
  } finally {
    if (current === generation) downloading = false;
  }
}

export function cancelUpdateDownload(): void {
  if (!downloading) return;
  // The plugin cannot abort an in-flight download; discard its result.
  generation += 1;
  downloading = false;
  releasePending();
  emitStatus({ status: 'cancelled' });
}

export async function installUpdate(): Promise<void> {
  const update = pendingUpdate;
  if (!update || !downloaded) {
    emitStatus({ status: 'error', message: 'No downloaded update is ready to install.' });
    return;
  }
  try {
    await update.install();
    pendingUpdate = null;
    // Windows installers exit the app themselves; elsewhere restart through
    // the backend so downloads stop and the queue is flushed first.
    await invoke('restart_app');
  } catch (error) {
    emitStatus({ status: 'error', message: errorMessage(error) });
  }
}
