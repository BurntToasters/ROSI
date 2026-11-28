// Update banner, update dialogs, and updater event wiring. The Rust updater
// (src-tauri/src/updater.rs) decides every transition; this module draws them
// and calls the updater commands. Failure modes: e2e/v5-fixes/updater-engine/failure-modes.md.
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { call, fire } from '../commands';
import type { UpdaterProgressEvent, UpdaterStatusEvent } from '../generated/ipc-types';
import { logError } from './core';
import { formatUpdateProgressInfo } from '../modules/updates';
import { currentModalData, modalQueue, retireModal, showModal } from './overlays';
import { formatBytes } from './progress';
import { openExternalLink, setButtonLoading, showToast } from './ui-helpers';
import { api } from '../api';

// The public ROSI website, the same host as the website and support links.
const ROSI_WEBSITE_URL = 'https://rosie.run';

export let isManualUpdateCheck = false;
export let updateCheckTimeout: ReturnType<typeof setTimeout> | null = null;
export let updateCheckBtnRef: HTMLButtonElement | null = null;

export function finishManualUpdateCheck() {
  isManualUpdateCheck = false;
  if (updateCheckTimeout) {
    clearTimeout(updateCheckTimeout);
    updateCheckTimeout = null;
  }
  if (updateCheckBtnRef) {
    setButtonLoading(updateCheckBtnRef, false);
    updateCheckBtnRef = null;
  }
}

export async function checkForUpdates() {
  const channel = api.getChannel();

  if (channel === 'msstore') {
    showModal({
      title: 'Microsoft Store Version',
      message:
        'Updates for the Microsoft Store version are managed through the Microsoft Store app.',
      buttons: [
        {
          label: 'Open Store',
          primary: true,
          action: () => {
            void openExternalLink(
              'ms-windows-store://pdp/?ProductId=9P4Q134B2JW3',
              'the Microsoft Store'
            );
          },
        },
        { label: 'OK' },
      ],
    });
    return;
  }

  // The updater refuses a check during a download with no status event, so the
  // user is told here instead of waiting for the timeout below.
  if (isUpdateDownloadActive()) {
    showToast('An update is already downloading.', { type: 'info' });
    return;
  }

  if (isManualUpdateCheck) return;

  isManualUpdateCheck = true;
  const checkBtn = document.getElementById('checkUpdateBtn') as HTMLButtonElement | null;
  updateCheckBtnRef = checkBtn;
  if (checkBtn) {
    setButtonLoading(checkBtn, true);
  }

  updateCheckTimeout = setTimeout(() => {
    if (!isManualUpdateCheck) return;
    finishManualUpdateCheck();
    showModal({
      title: 'Update Check Timed Out',
      message: 'Checking for updates took too long. Please try again later.',
      buttons: [{ label: 'OK', primary: true }],
      priority: true,
    });
  }, 30000);

  try {
    // Null means the check started (its result arrives as updater-status events)
    // or the Rust updater was busy with another operation and sent no event.
    // The transfer case is refused above; the timeout covers any other busy case.
    const refusal = await call('check_for_updates');

    if (refusal?.reason === 'dev-mode') {
      finishManualUpdateCheck();
      showModal({
        title: 'Development Mode',
        message:
          'Update checking is not available when running in development mode.\n\nBuild and package the app to test auto-updates.',
        buttons: [{ label: 'OK', primary: true }],
        priority: true,
      });
      return;
    }

    if (refusal) {
      finishManualUpdateCheck();
      showModal({
        title: 'Update Check Failed',
        message: `Could not check for updates.\n\nError: ${refusal.message}`,
        buttons: [{ label: 'OK', primary: true }],
        priority: true,
      });
    }
  } catch {
    finishManualUpdateCheck();
    showModal({
      title: 'Update Check Failed',
      message: 'Could not check for updates. Please try again later.',
      buttons: [{ label: 'OK', primary: true }],
      priority: true,
    });
  }
}

/** Startup check: the result arrives as events, so nothing is shown for a refusal. */
export async function checkForUpdatesOnStartup(): Promise<void> {
  await call('check_for_updates');
}

/** The channel changed; Rust saves it and revalidates the update identity. */
export function notifyUpdateChannelChanged(channel: 'auto' | 'stable' | 'beta'): void {
  fire('set_update_channel', { channel });
}

export let updaterCleanupFunctions: Array<() => void> = [];
export let updaterCandidateId: number | null = null;

/** A hidden banner is off screen, so its controls must leave the Tab order too. */
function setBannerInert(banner: HTMLElement, isInert: boolean) {
  if ('inert' in banner) {
    (banner as HTMLElement & { inert: boolean }).inert = isInert;
  }
}

// True from the Download & Install click until the banner hides, the same window
// the banner shows. The Rust updater is busy for this span.
let updateDownloadActive = false;

/** Whether an update download is running, so checks and restarts must wait or ask. */
export function isUpdateDownloadActive(): boolean {
  return updateDownloadActive;
}

export function showUpdateBanner() {
  const banner = document.getElementById('update-banner');
  const bar = document.getElementById('update-banner-bar') as HTMLElement | null;
  const progressWrapper = document.getElementById('update-banner-progress');
  const info = document.getElementById('update-banner-info');
  const text = document.getElementById('update-banner-text');
  updateDownloadActive = true;
  if (bar) bar.style.width = '0%';
  if (progressWrapper) {
    progressWrapper.setAttribute('aria-valuenow', '0');
    progressWrapper.removeAttribute('aria-valuetext');
  }
  if (info) info.textContent = '';
  if (text) text.textContent = 'Downloading update…';
  if (banner) {
    setBannerInert(banner, false);
    banner.classList.add('active');
    banner.setAttribute('aria-busy', 'true');
  }
}

export function hideUpdateBanner() {
  updateDownloadActive = false;
  const banner = document.getElementById('update-banner');
  if (banner) {
    banner.classList.remove('active');
    banner.setAttribute('aria-busy', 'false');
    setBannerInert(banner, true);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Shows the "Update Error" prompt. A failed download arrives twice, as an error
 * status event and as the command result, so an identical prompt that is
 * already shown or queued is not repeated.
 */
function showUpdateError(message: string) {
  const text = `An error occurred while checking or installing the update:\n${message}\n\nYou can download the latest version from ${ROSI_WEBSITE_URL}.`;
  const alreadyShown = [currentModalData, ...modalQueue].some(
    (data) => data?.title === 'Update Error' && data.message === text
  );
  if (alreadyShown) return;
  showModal({
    title: 'Update Error',
    message: text,
    // OK stays first: the dismiss helpers in the tests click the first button.
    buttons: [
      { label: 'OK', primary: true },
      {
        label: 'Get Latest Version',
        action: () => {
          void openExternalLink(ROSI_WEBSITE_URL, 'the ROSI website');
        },
      },
    ],
    priority: true,
  });
}

export function showRestartFailure(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  showModal({
    title: 'Could Not Restart ROSI',
    message: `ROSI could not complete the restart safely, so the app remains open.\n\n${detail}`,
    buttons: [{ label: 'OK', primary: true }],
    priority: true,
  });
}

// Flatpak builds open the release page instead of downloading. The version
// comes from the update feed, so it is encoded before it enters the URL.
export function releasePageUrl(version: string): string {
  return `https://github.com/BurntToasters/ROSI/releases/tag/v${encodeURIComponent(version)}`;
}

/** Subscribes to one updater event; the returned function stops it. */
function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
  let disposed = false;
  let stop: UnlistenFn | null = null;
  listen<T>(event, (message) => {
    if (!disposed) handler(message.payload);
  })
    .then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    })
    .catch((error: unknown) => logError(`Could not listen for ${event}`, error));
  return () => {
    disposed = true;
    stop?.();
    stop = null;
  };
}

export function setupAutoUpdater(flushSettingsBeforeRestart: () => Promise<boolean>) {
  const cancelBtn = document.getElementById('update-banner-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      fire('cancel_update_download');
    });
  }

  // Built in one place so a failed restart flush can offer the same prompt again.
  function showUpdateReadyPrompt(candidateId: number, version: string) {
    showModal({
      title: 'Update Ready!',
      key: 'updater-downloaded',
      message: `Version ${version} has been downloaded.\n\nSelect Restart Now to install it. If you quit instead, ROSI downloads it again next time.`,
      buttons: [
        {
          label: 'Restart Now',
          primary: true,
          action: async () => {
            if (updaterCandidateId !== candidateId) return;
            try {
              if (await flushSettingsBeforeRestart()) {
                await call('install_update', { candidateId });
              } else if (updaterCandidateId === candidateId) {
                // Keep Downloading or a failed save closed the prompt. Offer it
                // again, unless a newer status replaced this candidate meanwhile.
                showUpdateReadyPrompt(candidateId, version);
              }
            } catch (error) {
              hideUpdateBanner();
              showUpdateError(errorMessage(error));
            }
          },
        },
        { label: 'Later' },
      ],
      priority: true,
    });
  }

  updaterCleanupFunctions.push(
    subscribe<UpdaterStatusEvent>('updater-status', (data) => {
      const wasManualCheck = isManualUpdateCheck;
      if (isManualUpdateCheck && data.status !== 'checking') {
        finishManualUpdateCheck();
      }

      switch (data.status) {
        case 'checking':
          updaterCandidateId = null;
          retireModal('updater-candidate');
          retireModal('updater-downloaded');
          break;

        case 'available': {
          const candidateId = data.candidateId;
          updaterCandidateId = candidateId;
          retireModal('updater-candidate');
          retireModal('updater-downloaded');
          hideUpdateBanner();
          const version = data.version;
          const isBetaUpdate = data.isBeta;
          if (data.manualInstall) {
            showModal({
              title: isBetaUpdate ? 'Beta Update Available!' : 'Update Available!',
              key: 'updater-candidate',
              message: `${isBetaUpdate ? 'A new beta version' : 'A new version'} (v${version}) of ROSI is available!\n\nFlatpak builds cannot be updated inside the app. Open the release page to download and reinstall it.`,
              priority: wasManualCheck,
              buttons: [
                {
                  label: 'Open Release Page',
                  primary: true,
                  action: () => {
                    if (updaterCandidateId !== candidateId) return;
                    void openExternalLink(releasePageUrl(version), 'the release page');
                  },
                },
                { label: 'Later' },
              ],
            });
            break;
          }
          showModal({
            title: isBetaUpdate ? 'Beta Update Available!' : 'Update Available!',
            key: 'updater-candidate',
            message: isBetaUpdate
              ? `A new beta version (v${version}) of ROSI is available!\n\nWould you like to download and install it?`
              : `A new version (v${version}) of ROSI is available!\n\nWould you like to download and install it?`,
            priority: wasManualCheck,
            buttons: [
              {
                label: 'Download & Install',
                primary: true,
                action: async () => {
                  if (updaterCandidateId !== candidateId) return;
                  showUpdateBanner();
                  try {
                    const result = await call('download_update', { candidateId });
                    if (result.cancelled) {
                      // The cancelled status event owns the message.
                      hideUpdateBanner();
                    } else if (!result.success) {
                      // Covers a refusal while a cancelled download is still stopping,
                      // which arrives without a status event.
                      hideUpdateBanner();
                      showUpdateError(result.error ?? 'The update could not be downloaded.');
                    }
                  } catch (error) {
                    hideUpdateBanner();
                    showUpdateError(errorMessage(error));
                  }
                },
              },
              { label: 'Later' },
            ],
          });
          break;
        }

        case 'not-available':
          updaterCandidateId = null;
          retireModal('updater-candidate');
          retireModal('updater-downloaded');
          hideUpdateBanner();
          if (wasManualCheck) {
            showModal({
              title: 'ROSI Is Up to Date!',
              message: `You are running the latest version (v${data.version}).`,
              buttons: [{ label: 'OK', primary: true }],
              priority: true,
            });
          }
          break;

        case 'error':
          updaterCandidateId = null;
          retireModal('updater-candidate');
          retireModal('updater-downloaded');
          hideUpdateBanner();
          if (data.kind === 'feed' && !wasManualCheck) break;
          showUpdateError(data.message);
          break;

        case 'cancelled':
          updaterCandidateId = null;
          retireModal('updater-candidate');
          retireModal('updater-downloaded');
          hideUpdateBanner();
          showToast('The update download was cancelled.', { type: 'info' });
          break;

        case 'downloaded': {
          const candidateId = data.candidateId;
          updaterCandidateId = candidateId;
          retireModal('updater-candidate');
          retireModal('updater-downloaded');
          hideUpdateBanner();
          showUpdateReadyPrompt(candidateId, data.version);
          break;
        }
      }
    })
  );

  updaterCleanupFunctions.push(
    subscribe<UpdaterProgressEvent>('updater-progress', (data) => {
      const progressBar = document.getElementById('update-banner-bar') as HTMLElement | null;
      const progressWrapper = document.getElementById('update-banner-progress');
      const progressInfo = document.getElementById('update-banner-info');

      if (progressBar) {
        progressBar.style.width = `${data.percent}%`;
      }
      if (progressWrapper) {
        progressWrapper.setAttribute('aria-valuenow', String(Math.round(data.percent)));
      }

      if (progressInfo) {
        progressInfo.textContent = formatUpdateProgressInfo(data, formatBytes);
      }
    })
  );
}

export function cleanupUpdaterListeners() {
  updaterCleanupFunctions.forEach((cleanup) => {
    if (typeof cleanup === 'function') {
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    }
  });
  updaterCleanupFunctions = [];
}
