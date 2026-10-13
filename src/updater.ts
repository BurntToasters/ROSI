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
  | {
      status: 'available';
      candidateId: number;
      version: string;
      releaseNotes: string | null;
      isBeta: boolean;
    }
  | { status: 'not-available'; version: string; isBeta: boolean }
  | { status: 'error'; message: string; kind: 'feed' | 'download' | 'install' }
  | { status: 'cancelled' }
  | { status: 'downloaded'; candidateId: number; version: string };

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

interface UpdateIdentity {
  readonly update: Update;
  readonly version: string;
  readonly target: string | undefined;
  readonly sequence: number;
}

interface ActiveDownload {
  readonly identity: UpdateIdentity;
  readonly generation: number;
  cancelled: boolean;
  recheckTarget: boolean;
}

interface E2eUpdaterAdapter {
  invoke?: (command: string, args?: Record<string, unknown>) => unknown | Promise<unknown>;
  check?: (target: string | undefined) => Update | null | Promise<Update | null>;
}

function e2eUpdaterAdapter(): E2eUpdaterAdapter | undefined {
  if (import.meta.env.VITE_ROSI_E2E !== '1') return undefined;
  return (window as Window & { __ROSI_E2E__?: { updaterAdapter?: E2eUpdaterAdapter } }).__ROSI_E2E__
    ?.updaterAdapter;
}

async function updaterInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const testInvoke = e2eUpdaterAdapter()?.invoke;
  if (testInvoke) return (await testInvoke(command, args)) as T;
  return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
}

let pendingUpdate: UpdateIdentity | null = null;
let downloadedUpdate: UpdateIdentity | null = null;
let installedUpdate: UpdateIdentity | null = null;
let downloading = false;
let installing = false;
let checkGeneration = 0;
let downloadGeneration = 0;
let identitySequence = 0;
let activeDownload: ActiveDownload | null = null;
let updateChannelOverride: 'stable' | 'beta' | null = null;
let pendingChannelSave: Promise<boolean> | null = null;
let recheckAfterInstall = false;
let installStarted = false;

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
  const update = pendingUpdate?.update;
  pendingUpdate = null;
  downloadedUpdate = null;
  installedUpdate = null;
  if (update) closeUpdate(update);
}

function closeUpdate(update: Update): void {
  void update.close().catch(() => {});
}

async function updateCheckTarget(): Promise<string | undefined> {
  const channelSave = pendingChannelSave;
  if (channelSave) {
    const saved = await channelSave;
    if (pendingChannelSave === channelSave) pendingChannelSave = null;
    if (!saved) {
      throw new Error('The selected update channel could not be saved before revalidation.');
    }
  }
  const channel =
    updateChannelOverride ??
    (await updaterInvoke<{ updateChannel?: string }>('get_settings')).updateChannel ??
    'auto';
  if (channel === 'stable') return undefined;
  if (channel === 'beta') return updaterInvoke<string>('get_beta_updater_target');
  // auto: follow the installed version.
  return isBetaVersion(await getVersion())
    ? updaterInvoke<string>('get_beta_updater_target')
    : undefined;
}

export function notifyUpdaterChannelChanged(
  channel: 'auto' | 'stable' | 'beta',
  save?: Promise<boolean>,
  previousChannel?: 'auto' | 'stable' | 'beta'
): void {
  const nextOverride = channel === 'auto' ? null : channel;
  const changed =
    previousChannel === undefined
      ? nextOverride !== updateChannelOverride
      : channel !== previousChannel;
  updateChannelOverride = nextOverride;
  if (save) pendingChannelSave = save.catch(() => false);
  if (!changed) return;

  checkGeneration += 1;
  if (installing) {
    recheckAfterInstall = true;
    if (!installStarted) {
      if (pendingUpdate) releasePending();
    }
    return;
  }

  if (downloading && activeDownload) {
    activeDownload.recheckTarget = true;
    const newlyCancelled = !activeDownload.cancelled;
    if (newlyCancelled) {
      activeDownload.cancelled = true;
      downloadGeneration += 1;
    }
    // Keep the updater resource alive while its native transfer still uses
    // it. The completion path retires this identity after the transfer settles.
    if (newlyCancelled) emitStatus({ status: 'cancelled' });
    return;
  }

  if (pendingUpdate) releasePending();
  void checkForUpdates();
}

async function retiredLinuxPackageMessage(): Promise<string | null> {
  const installedTarget = await updaterInvoke<string>('get_beta_updater_target');
  if (!/^linux-beta-[a-z0-9_]+-(?:deb|rpm)$/i.test(installedTarget)) return null;
  return 'DEB and RPM packages are no longer published for ROSI 5. Install the AppImage or Flatpak manually from the latest release to continue receiving updates.';
}

async function checkFeed(
  target: string | undefined,
  isCurrent: () => boolean
): Promise<Update | null> {
  const testCheck = e2eUpdaterAdapter()?.check;
  if (testCheck) {
    const update = await testCheck(target);
    if (!isCurrent()) {
      if (update) closeUpdate(update);
      return null;
    }
    return update;
  }
  const options = { ...(target ? { target } : {}), timeout: UPDATE_CHECK_TIMEOUT_MS };
  let update: Update | null;
  try {
    update = await check(options);
  } catch (error) {
    if (!isCurrent()) return null;
    if (!target) throw error;
    return check(options);
  }
  if (!isCurrent()) {
    if (update) closeUpdate(update);
    return null;
  }
  // Beta manifests are swapped onto the stable release through two adjacent
  // asset renames. A second lookup masks that short window.
  if (!update && target) return check(options);
  return update;
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
  const current = ++checkGeneration;
  const isCurrent = () => current === checkGeneration;
  if (downloading || installing) return null;
  emitStatus({ status: 'checking' });
  let candidate: Update | null = null;
  let checkedTarget: string | undefined;
  let hasCheckedTarget = false;
  try {
    const packaged = await updaterInvoke<boolean>('is_packaged');
    if (!isCurrent()) return null;
    if (!packaged) {
      return {
        error: 'dev-mode',
        message: 'Update checking is not available in development mode.',
      };
    }
    const flatpak = await updaterInvoke<boolean>('is_flatpak');
    if (!isCurrent()) return null;
    if (flatpak) {
      return {
        error: 'Flatpak builds update through a reinstalled bundle, not the in-app updater.',
      };
    }
    const retiredPackageMessage = await retiredLinuxPackageMessage();
    if (!isCurrent()) return null;
    if (retiredPackageMessage) return { error: retiredPackageMessage };

    const target = await updateCheckTarget();
    checkedTarget = target;
    hasCheckedTarget = true;
    if (!isCurrent() || downloading || installing) return null;
    if (installedUpdate && pendingUpdate === installedUpdate) {
      emitStatus({
        status: 'downloaded',
        candidateId: installedUpdate.sequence,
        version: installedUpdate.version,
      });
      return null;
    }
    if (pendingUpdate && pendingUpdate.target !== target) releasePending();

    const currentVersion = await getVersion();
    if (!isCurrent() || downloading || installing) return null;
    candidate = await checkFeed(target, isCurrent);
    if (!isCurrent() || downloading || installing) {
      if (candidate) closeUpdate(candidate);
      return null;
    }

    // Settings can change while the feed request is in flight. Do not commit
    // a result obtained from the former channel or release resources owned by
    // a download that has since taken over.
    const confirmedTarget = await updateCheckTarget();
    if (!isCurrent() || downloading || installing) {
      if (candidate) closeUpdate(candidate);
      return null;
    }
    if (confirmedTarget !== target) {
      if (candidate) closeUpdate(candidate);
      candidate = null;
      if (pendingUpdate && pendingUpdate.target !== confirmedTarget) releasePending();
      void checkForUpdates();
      return null;
    }

    const update = candidate;
    candidate = null;
    if (!update) {
      const sameTargetIdentity = pendingUpdate;
      if (sameTargetIdentity && sameTargetIdentity.target === target) {
        if (downloadedUpdate === sameTargetIdentity) {
          emitStatus({
            status: 'downloaded',
            candidateId: sameTargetIdentity.sequence,
            version: sameTargetIdentity.version,
          });
          return null;
        }
        releasePending();
      }
      emitStatus({
        status: 'not-available',
        version: currentVersion,
        isBeta: isBetaVersion(currentVersion),
      });
      return null;
    }
    if (
      pendingUpdate &&
      pendingUpdate.version === update.version &&
      pendingUpdate.target === target &&
      downloadedUpdate === pendingUpdate
    ) {
      closeUpdate(update);
      emitStatus({
        status: 'downloaded',
        candidateId: pendingUpdate.sequence,
        version: pendingUpdate.version,
      });
      return null;
    }
    releasePending();
    const identity: UpdateIdentity = Object.freeze({
      update,
      version: update.version,
      target,
      sequence: ++identitySequence,
    });
    pendingUpdate = identity;
    emitStatus({
      status: 'available',
      candidateId: identity.sequence,
      version: identity.version,
      releaseNotes: update.body ?? null,
      isBeta: isBetaVersion(identity.version),
    });
    return null;
  } catch (error) {
    if (candidate) closeUpdate(candidate);
    if (isCurrent() && hasCheckedTarget) {
      try {
        const confirmedTarget = await updateCheckTarget();
        if (!isCurrent()) return null;
        if (confirmedTarget !== checkedTarget) {
          if (pendingUpdate && pendingUpdate.target !== confirmedTarget) releasePending();
          void checkForUpdates();
          return null;
        }
      } catch {
        return null;
      }
    }
    if (isCurrent()) {
      emitStatus({ status: 'error', message: errorMessage(error), kind: 'feed' });
    }
    return null;
  }
}

export async function downloadUpdate(candidateId?: number): Promise<{
  success?: boolean;
  cancelled?: boolean;
  error?: string;
}> {
  const identity = pendingUpdate;
  if (candidateId !== undefined && (!identity || candidateId !== identity.sequence)) {
    return { cancelled: true };
  }
  if (!identity) return { error: 'No update is ready to download.' };
  if (downloading) return { error: 'A download is already in progress.' };
  if (installing || installedUpdate === identity) {
    return { error: 'This update is already being installed.' };
  }
  checkGeneration += 1;
  downloading = true;
  const operation: ActiveDownload = {
    identity,
    generation: ++downloadGeneration,
    cancelled: false,
    recheckTarget: false,
  };
  activeDownload = operation;
  const startedAt = Date.now();
  let total = 0;
  let transferred = 0;
  let lastEmit = 0;
  let recheckTarget = false;
  let downloadCompleted = false;
  const isCurrent = () =>
    activeDownload === operation &&
    operation.generation === downloadGeneration &&
    pendingUpdate === identity;
  try {
    await identity.update.download(
      (event: DownloadEvent) => {
        if (!isCurrent()) return;
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
    downloadCompleted = true;
    if (!isCurrent()) {
      return { cancelled: true };
    }
    const effectiveTarget = await updateCheckTarget();
    if (!isCurrent()) {
      return { cancelled: true };
    }
    if (effectiveTarget !== identity.target) {
      releasePending();
      recheckTarget = true;
      return { cancelled: true };
    }
    downloadedUpdate = identity;
    emitStatus({
      status: 'downloaded',
      candidateId: identity.sequence,
      version: identity.version,
    });
    return { success: true };
  } catch (error) {
    if (!isCurrent()) return { cancelled: true };
    const message = errorMessage(error);
    if (downloadCompleted) releasePending();
    emitStatus({ status: 'error', message, kind: 'download' });
    return { error: message };
  } finally {
    if (activeDownload === operation) {
      if (
        pendingUpdate === identity &&
        (operation.cancelled || operation.recheckTarget || recheckTarget)
      ) {
        releasePending();
      }
      activeDownload = null;
      downloading = false;
    }
    if ((recheckTarget || operation.recheckTarget) && !downloading && !installing) {
      void checkForUpdates();
    }
  }
}

export function cancelUpdateDownload(): void {
  const operation = activeDownload;
  if (!downloading || !operation || operation.cancelled) return;
  // The plugin cannot abort an in-flight download; discard its result.
  operation.cancelled = true;
  downloadGeneration += 1;
  checkGeneration += 1;
  // Keep both the single-flight lock and updater resource alive until the
  // transfer settles; finally retires it after any late bytes are attached.
  emitStatus({ status: 'cancelled' });
}

export async function installUpdate(candidateId?: number): Promise<void> {
  const identity = pendingUpdate;
  if (candidateId !== undefined && (!identity || candidateId !== identity.sequence)) return;
  if (!identity || downloadedUpdate !== identity) {
    emitStatus({
      status: 'error',
      message: 'No downloaded update is ready to install.',
      kind: 'install',
    });
    return;
  }
  if (installing || downloading) return;
  checkGeneration += 1;
  installing = true;
  installStarted = installedUpdate === identity;
  let recheckTarget = false;
  try {
    if (installedUpdate !== identity) {
      const effectiveTarget = await updateCheckTarget();
      if (pendingUpdate !== identity || downloadedUpdate !== identity) return;
      if (effectiveTarget !== identity.target) {
        releasePending();
        recheckTarget = true;
        return;
      }
      installStarted = true;
      await identity.update.install();
      if (pendingUpdate !== identity || downloadedUpdate !== identity) return;
      installedUpdate = identity;
    }
    // Windows installers exit the app themselves; elsewhere restart through
    // the backend so queue state is acknowledged before restart. Keep this
    // identity if restart is refused so the user can retry safely.
    await updaterInvoke('restart_app');
    if (pendingUpdate === identity) releasePending();
  } catch (error) {
    if (pendingUpdate === identity) {
      emitStatus({ status: 'error', message: errorMessage(error), kind: 'install' });
    }
  } finally {
    installing = false;
    installStarted = false;
    if ((recheckTarget || recheckAfterInstall) && !downloading) {
      recheckAfterInstall = false;
      void checkForUpdates();
    }
  }
}
