// Update checks, the update banner, and updater event wiring.
import { logError, updatesModule } from './core';
import { retireModal, showModal } from './overlays';
import { formatBytes } from './progress';
import { setButtonLoading } from './ui-helpers';

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
  const channel = window.api.getChannel();

  if (channel === 'msstore') {
    showModal({
      title: 'Microsoft Store Version',
      message:
        'Updates for the Microsoft Store version are managed through the Microsoft Store app.',
      buttons: [
        {
          label: 'Open Store',
          primary: true,
          action: () => window.api.openExternal('ms-windows-store://pdp/?ProductId=9P4Q134B2JW3'),
        },
        { label: 'OK' },
      ],
    });
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
    const result = await window.api.checkForUpdates();

    if (result && result.error === 'dev-mode') {
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

    if (result && result.error && result.error !== 'dev-mode') {
      finishManualUpdateCheck();
      showModal({
        title: 'Update Check Failed',
        message: `Could not check for updates.\n\nError: ${result.error}`,
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

export let updaterCleanupFunctions: Array<() => void> = [];
export let updaterCandidateId: number | null = null;

export function showUpdateBanner() {
  const banner = document.getElementById('update-banner');
  const bar = document.getElementById('update-banner-bar') as HTMLElement | null;
  const progressWrapper = document.getElementById('update-banner-progress');
  const info = document.getElementById('update-banner-info');
  const text = document.getElementById('update-banner-text');
  if (bar) bar.style.width = '0%';
  if (progressWrapper) {
    progressWrapper.setAttribute('aria-valuenow', '0');
    progressWrapper.removeAttribute('aria-valuetext');
  }
  if (info) info.textContent = '';
  if (text) text.textContent = 'Downloading update…';
  if (banner) {
    banner.classList.add('active');
    banner.setAttribute('aria-busy', 'true');
  }
}

export function hideUpdateBanner() {
  const banner = document.getElementById('update-banner');
  if (banner) {
    banner.classList.remove('active');
    banner.setAttribute('aria-busy', 'false');
  }
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

export function setupAutoUpdater(flushSettingsBeforeRestart: () => Promise<boolean>) {
  const cancelBtn = document.getElementById('update-banner-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      window.api.cancelUpdateDownload();
    });
  }

  updaterCleanupFunctions.push(
    window.api.onUpdaterStatus((data) => {
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
          if (typeof candidateId !== 'number') break;
          updaterCandidateId = candidateId;
          retireModal('updater-candidate');
          retireModal('updater-downloaded');
          hideUpdateBanner();
          const version = data.version ?? '';
          const isBetaUpdate =
            data.isBeta ||
            (updatesModule && typeof updatesModule.isPrereleaseVersion === 'function'
              ? updatesModule.isPrereleaseVersion(version)
              : /-(beta|alpha|rc)/i.test(version));
          if (data.manualInstall === true) {
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
                    void window.api
                      .openExternal(releasePageUrl(version))
                      .catch((error: unknown) =>
                        logError('Could not open the release page', error)
                      );
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
              ? `A new beta version (v${data.version}) of ROSI is available!\n\nWould you like to download and install it?`
              : `A new version (v${data.version}) of ROSI is available!\n\nWould you like to download and install it?`,
            priority: wasManualCheck,
            buttons: [
              {
                label: 'Download & Install',
                primary: true,
                action: async () => {
                  if (updaterCandidateId !== candidateId) return;
                  showUpdateBanner();
                  const result = await window.api.downloadUpdate(candidateId);
                  if (result?.cancelled || result?.error) hideUpdateBanner();
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
              title: 'ROSI is up to date!',
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
          showModal({
            title: 'Update Error',
            message: `An error occurred while checking or installing the update:\n${data.message}`,
            buttons: [{ label: 'OK', primary: true }],
            priority: true,
          });
          break;

        case 'cancelled':
          updaterCandidateId = null;
          retireModal('updater-candidate');
          retireModal('updater-downloaded');
          hideUpdateBanner();
          showModal({
            title: 'Download Cancelled',
            message: 'The update download was cancelled.',
            buttons: [{ label: 'OK', primary: true }],
            priority: true,
          });
          break;

        case 'downloaded':
          if (typeof data.candidateId !== 'number') break;
          updaterCandidateId = data.candidateId;
          retireModal('updater-candidate');
          retireModal('updater-downloaded');
          hideUpdateBanner();
          showModal({
            title: 'Update Ready!',
            key: 'updater-downloaded',
            message: `Version ${data.version} has been downloaded.\n\nThe update will be installed when you restart ROSI.`,
            buttons: [
              {
                label: 'Restart Now',
                primary: true,
                action: async () => {
                  if (updaterCandidateId !== data.candidateId) return;
                  if (await flushSettingsBeforeRestart()) {
                    await window.api.installUpdate(data.candidateId);
                  }
                },
              },
              { label: 'Later' },
            ],
            priority: true,
          });
          break;
      }
    })
  );

  updaterCleanupFunctions.push(
    window.api.onUpdaterProgress((data) => {
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
        if (updatesModule && typeof updatesModule.formatUpdateProgressInfo === 'function') {
          progressInfo.textContent = updatesModule.formatUpdateProgressInfo(data, formatBytes);
        } else {
          const speed = formatBytes(data.bytesPerSecond) + '/s';
          const downloaded = formatBytes(data.transferred);
          const total = formatBytes(data.total);
          progressInfo.textContent = `${downloaded} / ${total} (${speed}) - ${Math.round(data.percent)}%`;
        }
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
