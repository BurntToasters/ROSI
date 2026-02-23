function isMac() {
  return navigator.platform.toLowerCase().includes('mac');
}

function getModifierKey() {
  return isMac() ? 'metaKey' : 'ctrlKey';
}

function getModifierKeyName() {
  return isMac() ? 'Cmd' : 'Ctrl';
}

function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// toggles console output visibility
function updateConsoleVisibility(show) {
  const consoleSection = document.getElementById('console-section');
  if (consoleSection) {
    if (show) {
      consoleSection.classList.add('visible');
    } else {
      consoleSection.classList.remove('visible');
    }
  }
}

const OUTPUT_MAX_CHARS = 200000;

function appendConsoleOutput(outputEl, text) {
  if (!outputEl) return;
  const nextText = outputEl.textContent + text + '\n';
  if (nextText.length <= OUTPUT_MAX_CHARS) {
    outputEl.textContent = nextText;
  } else {
    outputEl.textContent = nextText.slice(-OUTPUT_MAX_CHARS);
  }
  outputEl.scrollTop = outputEl.scrollHeight;
}

// Toggle console collapsed state
function toggleConsoleCollapse() {
  const consoleSection = document.getElementById('console-section');
  const consoleHeader = document.getElementById('consoleHeader');
  if (consoleSection) {
    consoleSection.classList.toggle('collapsed');
    const isCollapsed = consoleSection.classList.contains('collapsed');
    if (consoleHeader) consoleHeader.setAttribute('aria-expanded', String(!isCollapsed));
    return isCollapsed;
  }
  return false;
}

// handles loader in button, swaps text for spinner, click cancels
function setButtonLoading(button, isLoading, onCancel) {
  if (!button) return;
  if (!button.dataset.defaultHtml) {
    button.dataset.defaultHtml = button.innerHTML;
  }
  if (!button.dataset.defaultText) {
    button.dataset.defaultText = button.textContent.trim();
  }
  if (isLoading) {
    button.classList.add('loading');
    button.innerHTML = `<img src="loader.svg" class="loader-icon" alt="Loading...">`;
    button.disabled = false;
    button.setAttribute('aria-busy', 'true');
    button.onclick = typeof onCancel === 'function' ? onCancel : null;
  } else {
    button.classList.remove('loading');
    button.innerHTML = button.dataset.defaultHtml || button.dataset.defaultText || 'Action';
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.onclick = button._originalClick || null;
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (!sidebar) return;

  const isOpen = sidebar.classList.contains('open');
  if (isOpen) {
    sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) settingsBtn.focus();
  } else {
    sidebar.classList.add('open');
    if (overlay) overlay.classList.add('active');
    const closeBtn = document.getElementById('closeSidebar');
    if (closeBtn) closeBtn.focus();
  }
}

function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('active');
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) settingsBtn.focus();
}
function toggleAdvancedUI(show) {
  const formatSection = document.getElementById('formatOptions');
  if (formatSection) {
    if (show) {
      formatSection.classList.add('visible');
    } else {
      formatSection.classList.remove('visible');
    }
  }
}

// Modal queue system
const modalQueue = [];
let isModalActive = false;
let currentModalData = null;
let previousFocus = null;
let modalTrapHandler = null;

function showModal({ title, message, buttons = [], priority = false, extra = null }) {
  const modalData = { title, message, buttons, priority, extra };
  if (priority && isModalActive) {
    const modal = document.getElementById('app-modal');
    if (modal) {
      modal.classList.remove('active', 'showing', 'hiding');
    }
    isModalActive = false;
    currentModalData = null;
  }
  if (priority) {
    modalQueue.unshift(modalData);
  } else {
    modalQueue.push(modalData);
  }
  if (!isModalActive) {
    displayNextModal();
  }
}

function displayNextModal() {
  if (modalQueue.length === 0) {
    isModalActive = false;
    currentModalData = null;
    return;
  }

  isModalActive = true;
  currentModalData = modalQueue.shift();
  const { title, message, buttons, extra } = currentModalData;

  const modal = document.getElementById('app-modal');
  const titleEl = document.getElementById('modal-title');
  const msgEl = document.getElementById('modal-message');
  const btnContainer = document.getElementById('modal-buttons');
  const extraEl = document.getElementById('modal-extra');
  if (!modal || !titleEl || !msgEl || !btnContainer) {
    displayNextModal();
    return;
  }

  titleEl.textContent = title;
  const safeMessage =
    typeof message === 'string' ? message : message == null ? '' : String(message);
  msgEl.textContent = safeMessage;
  if (extraEl) {
    extraEl.textContent = '';
    if (extra) {
      const extraNode = typeof extra === 'function' ? extra() : extra;
      if (extraNode && extraNode.nodeType) {
        extraEl.appendChild(extraNode);
      }
    }
  }
  btnContainer.innerHTML = '';

  modal.classList.add('showing');
  modal.classList.add('active');

  void modal.offsetWidth;
  requestAnimationFrame(() => {
    modal.classList.remove('showing');
  });

  buttons.forEach(({ label, action }) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.onclick = () => {
      hideModal(modal, action);
    };
    btnContainer.appendChild(btn);
  });

  previousFocus = document.activeElement;

  if (modalTrapHandler) {
    modal.removeEventListener('keydown', modalTrapHandler);
  }
  modalTrapHandler = (e) => {
    if (e.key !== 'Tab') return;
    const focusable = modal.querySelectorAll('button');
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  modal.addEventListener('keydown', modalTrapHandler);

  requestAnimationFrame(() => {
    const firstBtn = btnContainer.querySelector('button');
    if (firstBtn) firstBtn.focus();
  });
}

function hideModal(modal, action) {
  modal.classList.add('hiding');
  currentModalData = null;
  if (modalTrapHandler) {
    modal.removeEventListener('keydown', modalTrapHandler);
    modalTrapHandler = null;
  }
  setTimeout(() => {
    modal.classList.remove('active', 'hiding');
    isModalActive = false;
    if (typeof action === 'function') action();
    if (!isModalActive) {
      displayNextModal();
    }
    if (!isModalActive && previousFocus && typeof previousFocus.focus === 'function') {
      previousFocus.focus();
      previousFocus = null;
    }
  }, 200);
}

function showKeyboardShortcuts() {
  const modKey = getModifierKeyName();
  showModal({
    title: 'Keyboard Shortcuts',
    message: `${modKey}+D - Restart application\n${modKey}+F - Focus URL input field\n${modKey}+, - Open settings`,
    buttons: [{ label: 'OK' }],
  });
}

let isFetchingFormats = false;
let fetchFormatsAbort = null;
async function fetchFormats() {
  const btn = document.getElementById('fetchFormatsBtn');
  const urlInput = document.getElementById('url');
  const videoUrl = urlInput ? urlInput.value : null;

  try {
    if (!btn || !videoUrl || videoUrl.trim() === '') {
      showModal({
        title: 'Input Error',
        message: 'Please enter a video URL first.',
        buttons: [{ label: 'OK' }],
      });
      return;
    }

    // Validate URL format
    if (!isValidUrl(videoUrl.trim())) {
      showModal({
        title: 'Invalid URL',
        message: 'Please enter a valid URL starting with http:// or https://',
        buttons: [{ label: 'OK' }],
      });
      return;
    }

    if (isFetchingFormats) return;
    isFetchingFormats = true;
    let wasCancelled = false;
    fetchFormatsAbort = () => {
      wasCancelled = true;
      isFetchingFormats = false;
      setButtonLoading(btn, false);
    };
    setButtonLoading(btn, true, () => {
      if (window.api.cancelFormats) {
        window.api.cancelFormats();
      }
      fetchFormatsAbort();
    });
    const videoSelect = document.getElementById('videoFormat');
    const audioSelect = document.getElementById('audioFormat');
    if (videoSelect) videoSelect.innerHTML = '<option value="">Loading...</option>';
    if (audioSelect) audioSelect.innerHTML = '<option value="">Loading...</option>';
    try {
      const output = await window.api.getFormats(videoUrl);
      if (wasCancelled) return;
      const lines = output.split('\n');
      if (videoSelect) videoSelect.innerHTML = '<option value="">Select Video Format</option>';
      if (audioSelect) audioSelect.innerHTML = '<option value="">Select Audio Format</option>';
      let videoFormatsFound = 0,
        audioFormatsFound = 0;
      lines.forEach((line) => {
        if (/^\s*\d+\s+[a-zA-Z0-9]+/.test(line.trim())) {
          const parts = line.trim().split(/\s+/);
          const formatId = parts[0];
          const option = document.createElement('option');
          option.value = formatId;
          let labelText = line.trim();
          const resolutionMatch = labelText.match(/(\d{3,4}x\d{3,4}|\d{3,4}p)/);
          const fpsMatch = labelText.match(/@\s*(\d+fps)/);
          const sizeMatch = labelText.match(/(\d+(\.\d+)?(MiB|GiB|KiB))/);
          const codecMatch = line.match(/(avc1|vp9|av01|h264|h265|opus|mp4a|aac|vorbis)/i);
          let cleanLabel = `ID: ${formatId}`;
          if (resolutionMatch) cleanLabel += ` ${resolutionMatch[0]}`;
          if (fpsMatch) cleanLabel += ` ${fpsMatch[1]}`;
          if (codecMatch) cleanLabel += ` (${codecMatch[0]})`;
          if (sizeMatch) cleanLabel += ` ~${sizeMatch[0]}`;
          option.text = cleanLabel;
          option.title = line.trim();
          const isVideo = /video/.test(line.toLowerCase()) && !/audio only/i.test(line);
          const isAudio = /audio/.test(line.toLowerCase()) && !/video only/i.test(line);
          const isVideoOnly = /video only/i.test(line);
          const isAudioOnly = /audio only/i.test(line);
          if (isVideoOnly || (isVideo && !isAudio)) {
            if (videoSelect) videoSelect.appendChild(option);
            videoFormatsFound++;
          } else if (isAudioOnly || (isAudio && !isVideo)) {
            if (audioSelect) audioSelect.appendChild(option);
            audioFormatsFound++;
          } else if (isVideo && isAudio) {
            if (videoSelect) videoSelect.appendChild(option);
            videoFormatsFound++;
          }
        }
      });
      if (videoFormatsFound === 0 && videoSelect)
        videoSelect.innerHTML = '<option value="">No video formats found</option>';
      if (audioFormatsFound === 0 && audioSelect)
        audioSelect.innerHTML = '<option value="">No audio formats found</option>';
    } catch (e) {
      const errorMessage = typeof e === 'string' ? e : e.message || 'Unknown error';
      const cancelled =
        wasCancelled ||
        (typeof errorMessage === 'string' && errorMessage.toLowerCase().includes('cancel'));
      if (cancelled) return;
      if (videoSelect) videoSelect.innerHTML = '<option value="">Error loading formats</option>';
      if (audioSelect) audioSelect.innerHTML = '<option value="">Error loading formats</option>';
      showModal({
        title: 'Format Fetch Failed',
        message: `Could not retrieve formats.\nError: ${errorMessage}`,
        buttons: [{ label: 'OK' }],
      });
    } finally {
      if (!wasCancelled) {
        isFetchingFormats = false;
        setButtonLoading(btn, false);
      }
    }
  } catch (outerError) {
    console.error('Unexpected error in fetchFormats:', outerError);
    isFetchingFormats = false;
    if (btn) setButtonLoading(btn, false);
    showModal({
      title: 'Unexpected Error',
      message: 'An unexpected error occurred while fetching formats. Please try again.',
      buttons: [{ label: 'OK' }],
    });
  }
}

// handles download button logic
let isDownloading = false;
let downloadAbort = null;
let lastDownloadedFilePath = null;

function showProgressBar(status = 'Downloading...') {
  const container = document.getElementById('progress-container');
  const statusEl = document.getElementById('progress-status');
  const percentEl = document.getElementById('progress-percent');
  const bar = document.getElementById('progress-bar');
  const details = document.getElementById('progress-details');

  if (container) {
    container.classList.add('visible');
  }
  if (statusEl) statusEl.textContent = status;
  if (percentEl) percentEl.textContent = '0%';
  if (bar) {
    bar.style.width = '0%';
    bar.classList.remove('indeterminate');
  }
  if (details) details.textContent = '';
}

function updateProgressBar(percent, statusText = null, detailsText = null) {
  const statusEl = document.getElementById('progress-status');
  const percentEl = document.getElementById('progress-percent');
  const bar = document.getElementById('progress-bar');
  const details = document.getElementById('progress-details');

  if (percentEl) percentEl.textContent = `${Math.round(percent)}%`;
  if (bar) {
    bar.style.width = `${percent}%`;
    bar.classList.remove('indeterminate');
  }
  if (statusText && statusEl) statusEl.textContent = statusText;
  if (detailsText && details) details.textContent = detailsText;
}

function setProgressIndeterminate(status = 'Processing...') {
  const statusEl = document.getElementById('progress-status');
  const percentEl = document.getElementById('progress-percent');
  const bar = document.getElementById('progress-bar');
  const details = document.getElementById('progress-details');

  if (statusEl) statusEl.textContent = status;
  if (percentEl) percentEl.textContent = '';
  if (bar) bar.classList.add('indeterminate');
  if (details) details.textContent = '';
}

function hideProgressBar() {
  const container = document.getElementById('progress-container');
  if (container) {
    container.classList.remove('visible');
  }
}

function parseYtdlpProgress(message) {
  const progressMatch = message.match(
    /\[download\]\s+(\d+\.?\d*)%\s+of\s+~?(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/
  );
  if (progressMatch) {
    return {
      percent: parseFloat(progressMatch[1]),
      totalSize: progressMatch[2],
      speed: progressMatch[3],
      eta: progressMatch[4],
    };
  }

  const simpleMatch = message.match(/\[download\]\s+(\d+\.?\d*)%\s+of\s+~?(\S+)/);
  if (simpleMatch) {
    return {
      percent: parseFloat(simpleMatch[1]),
      totalSize: simpleMatch[2],
      speed: null,
      eta: null,
    };
  }

  return null;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

let isManualUpdateCheck = false;

async function checkForUpdates() {
  const channel = window.api.getChannel();

  if (channel === 'msstore') {
    showModal({
      title: 'Microsoft Store Version',
      message:
        'Updates for the Microsoft Store version are managed through the Microsoft Store app.',
      buttons: [
        {
          label: 'Open Store',
          action: () => window.api.openExternal('ms-windows-store://pdp/?ProductId=9N0BQSTFL4SV'),
        },
        { label: 'OK' },
      ],
    });
    return;
  }

  isManualUpdateCheck = true;

  try {
    showModal({
      title: 'Checking for Updates',
      message: 'Please wait while we check for updates...',
      buttons: [
        {
          label: 'Cancel',
          action: () => {
            isManualUpdateCheck = false;
          },
        },
      ],
    });

    const result = await window.api.checkForUpdates();

    if (result && result.error === 'dev-mode') {
      showModal({
        title: 'Development Mode',
        message:
          'Update checking is not available when running in development mode.\n\nBuild and package the app to test auto-updates.',
        buttons: [{ label: 'OK' }],
        priority: isManualUpdateCheck,
      });
      isManualUpdateCheck = false;
      return;
    }

    if (result && result.error && result.error !== 'dev-mode') {
      showModal({
        title: 'Update Check Failed',
        message: `Could not check for updates.\n\nError: ${result.error}`,
        buttons: [{ label: 'OK' }],
        priority: isManualUpdateCheck,
      });
      isManualUpdateCheck = false;
      return;
    }
  } catch (e) {
    showModal({
      title: 'Update Check Failed',
      message: 'Could not check for updates. Please try again later.',
      buttons: [{ label: 'OK' }],
      priority: isManualUpdateCheck,
    });
    isManualUpdateCheck = false;
  }
}

let updaterCleanupFunctions = [];

function showUpdateBanner() {
  const banner = document.getElementById('update-banner');
  const bar = document.getElementById('update-banner-bar');
  const info = document.getElementById('update-banner-info');
  const text = document.getElementById('update-banner-text');
  if (bar) bar.style.width = '0%';
  if (info) info.textContent = '';
  if (text) text.textContent = 'Downloading update…';
  if (banner) {
    banner.classList.add('active');
  }
}

function hideUpdateBanner() {
  const banner = document.getElementById('update-banner');
  if (banner) {
    banner.classList.remove('active');
  }
}

function setupAutoUpdater() {
  let updateVersion = '';

  const cancelBtn = document.getElementById('update-banner-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      window.api.cancelUpdateDownload();
    });
  }

  updaterCleanupFunctions.push(
    window.api.onUpdaterStatus((data) => {
      switch (data.status) {
        case 'checking':
          break;

        case 'available': {
          updateVersion = data.version;
          const wasManualCheck = isManualUpdateCheck;
          isManualUpdateCheck = false;
          const isBetaUpdate = data.isBeta || /-(beta|alpha|rc)/i.test(data.version);
          showModal({
            title: isBetaUpdate ? 'Beta Update Available!' : 'Update Available!',
            message: isBetaUpdate
              ? `A new beta version (v${data.version}) of ROSI is available!\n\nWould you like to download and install it?`
              : `A new version (v${data.version}) of ROSI is available!\n\nWould you like to download and install it?`,
            priority: wasManualCheck,
            buttons: [
              {
                label: 'Download & Install',
                action: async () => {
                  showUpdateBanner();
                  await window.api.downloadUpdate();
                },
              },
              { label: 'Later' },
            ],
          });
          break;
        }

        case 'not-available':
          if (isManualUpdateCheck) {
            showModal({
              title: 'ROSI is up to date!',
              message: `You are running the latest version (v${data.version}).`,
              buttons: [{ label: 'OK' }],
              priority: true,
            });
          }
          isManualUpdateCheck = false;
          break;

        case 'error':
          hideUpdateBanner();
          if (isManualUpdateCheck) {
            showModal({
              title: 'Update Error',
              message: `An error occurred while checking for updates:\n${data.message}`,
              buttons: [{ label: 'OK' }],
              priority: true,
            });
          }
          isManualUpdateCheck = false;
          break;

        case 'cancelled':
          hideUpdateBanner();
          showModal({
            title: 'Download Cancelled',
            message: 'The update download was cancelled.',
            buttons: [{ label: 'OK' }],
            priority: true,
          });
          break;

        case 'downloaded':
          hideUpdateBanner();
          showModal({
            title: 'Update Ready!',
            message: `Version ${data.version} has been downloaded.\n\nThe update will be installed when you restart ROSI.`,
            buttons: [
              {
                label: 'Restart Now',
                action: () => window.api.installUpdate(),
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
      const progressBar = document.getElementById('update-banner-bar');
      const progressInfo = document.getElementById('update-banner-info');

      if (progressBar) {
        progressBar.style.width = `${data.percent}%`;
      }

      if (progressInfo) {
        const speed = formatBytes(data.bytesPerSecond) + '/s';
        const downloaded = formatBytes(data.transferred);
        const total = formatBytes(data.total);
        progressInfo.textContent = `${downloaded} / ${total} (${speed}) — ${Math.round(data.percent)}%`;
      }
    })
  );
}

function cleanupUpdaterListeners() {
  updaterCleanupFunctions.forEach((cleanup) => {
    if (typeof cleanup === 'function') {
      try {
        cleanup();
      } catch (e) {
        /* ignore */
      }
    }
  });
  updaterCleanupFunctions = [];
}

let licensesPreviousFocus = null;
let licensesTrapHandler = null;

function showLicenses() {
  const licensesOverlay = document.getElementById('licenses-overlay');
  if (licensesOverlay) {
    licensesPreviousFocus = document.activeElement;
    licensesOverlay.classList.add('active');
    document.body.style.overflow = 'hidden';

    const closeBtn = licensesOverlay.querySelector('#close-licenses');
    if (closeBtn) {
      requestAnimationFrame(() => closeBtn.focus());
    }

    licensesTrapHandler = (e) => {
      if (e.key !== 'Tab') return;
      const focusable = licensesOverlay.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    licensesOverlay.addEventListener('keydown', licensesTrapHandler);
  }
}

function hideLicenses() {
  const licensesOverlay = document.getElementById('licenses-overlay');
  if (licensesOverlay) {
    if (licensesTrapHandler) {
      licensesOverlay.removeEventListener('keydown', licensesTrapHandler);
      licensesTrapHandler = null;
    }
    licensesOverlay.classList.remove('active');
    setTimeout(() => {
      document.body.style.overflow = '';
    }, 300);
    if (licensesPreviousFocus) {
      licensesPreviousFocus.focus();
      licensesPreviousFocus = null;
    }
  }
}

function updateBackgroundAnimation(animate) {
  const body = document.body;
  if (animate) {
    body.classList.add('animate-bg');
  } else {
    body.classList.remove('animate-bg');
  }
}

// check for Deno
async function checkDenoInstallation(settings) {
  if (settings.denoReminderDismissed) {
    return;
  }

  try {
    const isInstalled = await window.api.checkDenoInstalled();

    if (!isInstalled) {
      showModal({
        title: 'Deno Required for Full YouTube Functionality',
        message:
          'Recent updates to yt-dlp require Deno for full YouTube functionality.\n\nWould you like to install Deno now?\n\nDeno is the default JS interpreter for yt-dlp and is recommended due to its lightweight nature.',
        buttons: [
          {
            label: 'Install',
            action: async () => {
              showModal({
                title: 'Installing Deno...',
                message: 'Please wait while Deno is being installed. This may take a moment.',
                buttons: [],
                priority: true,
              });

              try {
                const result = await window.api.installDeno();
                if (result && result.cancelled) {
                  showModal({
                    title: 'Installation Cancelled',
                    message: 'Deno installation was cancelled.',
                    buttons: [{ label: 'OK' }],
                    priority: true,
                  });
                  return;
                }
                showModal({
                  title: 'Installation Complete',
                  message:
                    'Deno has been successfully installed!\nRestarting the app can help pick up the updated environment.',
                  buttons: [
                    { label: 'Restart Now', action: () => window.api.restartApp() },
                    { label: 'Later' },
                  ],
                  priority: true,
                });
              } catch (error) {
                showModal({
                  title: 'Installation Failed',
                  message: `Failed to install Deno automatically.\n\nPlease install manually:\nMac/Linux: curl -fsSL https://deno.land/install.sh | sh\nWindows: irm https://deno.land/install.ps1 | iex\n\nError: ${error.error || 'Unknown error'}`,
                  buttons: [
                    {
                      label: 'Open Deno Website',
                      action: () => window.api.openExternal('https://deno.land'),
                    },
                    { label: 'OK' },
                  ],
                  priority: true,
                });
              }
            },
          },
          { label: 'Later' },
          {
            label: "No, don't remind me",
            action: () => {
              settings.denoReminderDismissed = true;
              void persistSettings();
            },
          },
        ],
      });
    }
  } catch (error) {
    console.error('Error checking Deno installation:', error);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  let settings;
  try {
    settings = await window.api.getSettings();
  } catch (error) {
    settings = {
      settingsVersion: 1,
      showConsoleOutput: false,
      advancedOptions: false,
      convertEnabled: false,
      convertFormat: 'mp4',
      keepOriginalAfterConvert: true,
      firstLaunch: true,
      hookBrowser: false,
      browserChoice: 'Chrome',
      animateBackground: true,
      notifications: true,
      denoReminderDismissed: false,
      gpuAcceleration: false,
      gpuType: 'auto',
      ffmpegPath: '',
      hideSupportModal: false,
      checkUpdatesOnStartup: true,
      updateChannel: 'auto',
      audioOnly: false,
      consoleCollapsed: false,
    };
    showModal({
      title: 'Settings Error',
      message: 'Could not load settings. Using defaults.',
      buttons: [{ label: 'OK' }],
    });
  }

  try {
    const version = await window.api.getAppVersion();
    const versionLink = document.getElementById('versionLink');
    const betaBadge = document.getElementById('betaBadge');
    if (versionLink && version) {
      versionLink.textContent = `v${version}`;
      versionLink.addEventListener('click', (event) => {
        event.preventDefault();
        window.api.openExternal(`https://github.com/BurntToasters/ROSI/releases/tag/v${version}`);
      });
      const isBeta = /-(beta|alpha|rc)/i.test(version);
      if (isBeta) {
        versionLink.classList.add('beta-version');
        if (betaBadge) betaBadge.classList.remove('hidden');
      }
    }
  } catch (e) {
    console.error('Could not get app version:', e);
  }

  try {
    setupAutoUpdater();
  } catch (e) {
    console.error('Failed to setup auto-updater:', e);
  }
  let settingsSaveErrorShownAt = 0;

  function showSettingsSaveError(message) {
    const now = Date.now();
    if (now - settingsSaveErrorShownAt < 5000) {
      return;
    }
    settingsSaveErrorShownAt = now;
    showModal({
      title: 'Settings Save Failed',
      message,
      buttons: [{ label: 'OK' }],
      priority: true,
    });
  }

  async function persistSettings(silent = false) {
    try {
      const result = await window.api.saveSettings(settings);
      if (!result || result.ok !== true) {
        if (!silent) {
          const message = result?.error?.message || 'Could not save settings.';
          showSettingsSaveError(`${message}\nChanges may not persist after restart.`);
        }
        return false;
      }
      settings = result.data;
      return true;
    } catch (_error) {
      if (!silent) {
        showSettingsSaveError('Could not save settings due to an unexpected error.');
      }
      return false;
    }
  }

  const consoleToggle = document.getElementById('consoleToggle');
  const advancedToggle = document.getElementById('advancedToggle');
  const keepOriginalToggle = document.getElementById('keepOriginalToggle');
  const hookBrowserToggle = document.getElementById('hookBrowserToggle');
  const browserChoiceContainer = document.getElementById('browserChoiceContainer');
  const browserChoiceSelect = document.getElementById('browserChoice');
  const convertToggle = document.getElementById('convertToggle');
  const convertFormatContainer = document.getElementById('convertFormatContainer');
  const convertFormatSelect = document.getElementById('convertFormat');
  const keepOriginalLabel = document.getElementById('keepOriginalLabel');
  const gpuAccelerationToggle = document.getElementById('gpuAccelerationToggle');
  const gpuAccelerationLabel = document.getElementById('gpuAccelerationLabel');
  const gpuTypeContainer = document.getElementById('gpuTypeContainer');
  const gpuTypeSelect = document.getElementById('gpuType');
  const ffmpegPathInput = document.getElementById('ffmpegPathInput');
  const outputEl = document.getElementById('output');
  const resetSettingsBtn = document.getElementById('resetSettings');
  const fetchFormatsBtn = document.getElementById('fetchFormatsBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const checkUpdateBtn = document.getElementById('checkUpdateBtn');
  const animateBackgroundToggle = document.getElementById('animateBackgroundToggle');
  const bestQualityToggle = document.getElementById('bestQualityToggle');
  const audioOnlyToggle = document.getElementById('audioOnlyToggle');
  const notificationsToggle = document.getElementById('notificationsToggle');
  const checkUpdatesOnStartupToggle = document.getElementById('checkUpdatesOnStartupToggle');
  const checkUpdatesOnStartupLabel = document.getElementById('checkUpdatesOnStartupLabel');
  const updateChannelSelect = document.getElementById('updateChannelSelect');
  const updateChannelContainer = document.getElementById('updateChannelContainer');
  const showUpdateChannelBtn = document.getElementById('showUpdateChannelBtn');

  const settingsBtn = document.getElementById('settingsBtn');
  const closeSidebarBtn = document.getElementById('closeSidebar');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const shortcutsBtn = document.getElementById('shortcutsBtn');
  const clearUrlBtn = document.getElementById('clearUrl');
  const clearConsoleBtn = document.getElementById('clearConsole');
  const urlInput = document.getElementById('url');
  const browserCookiesHelp = document.getElementById('browserCookiesHelp');
  const helpLink = document.getElementById('helpLink');
  const supportLink = document.getElementById('supportLink');
  const websiteLink = document.getElementById('websiteLink');
  const supportProjectLink = document.getElementById('supportProjectLink');
  const licensesLink = document.getElementById('licensesLink');

  if (fetchFormatsBtn) fetchFormatsBtn._originalClick = fetchFormats;
  if (downloadBtn) downloadBtn._originalClick = null;

  const isWindows = navigator.userAgent.includes('Windows');
  if (isWindows && browserChoiceSelect) {
    Array.from(browserChoiceSelect.options).forEach((opt) => {
      if (opt.value !== 'Firefox') {
        browserChoiceSelect.removeChild(opt);
      }
    });
    browserChoiceSelect.value = 'Firefox';
    if (settings.browserChoice !== 'Firefox') {
      settings.browserChoice = 'Firefox';
      void persistSettings();
    }
  }

  // update UI from settings
  const updateUIFromSettings = () => {
    if (
      !consoleToggle ||
      !advancedToggle ||
      !keepOriginalToggle ||
      !hookBrowserToggle ||
      !browserChoiceContainer ||
      !browserChoiceSelect ||
      !convertToggle ||
      !convertFormatContainer ||
      !convertFormatSelect ||
      !keepOriginalLabel
    )
      return;
    consoleToggle.checked = settings.showConsoleOutput ?? false;
    advancedToggle.checked = settings.advancedOptions ?? false;
    keepOriginalToggle.checked = settings.keepOriginalAfterConvert ?? true;
    hookBrowserToggle.checked = settings.hookBrowser ?? false;
    browserChoiceSelect.value = settings.browserChoice ?? 'Chrome';
    convertToggle.checked = settings.convertEnabled ?? false;
    convertFormatSelect.value = settings.convertFormat ?? 'mp4';
    keepOriginalToggle.checked = settings.keepOriginalAfterConvert ?? true;

    if (convertToggle.checked) {
      convertFormatContainer.classList.add('visible');
      keepOriginalLabel.classList.add('visible');
      if (gpuAccelerationLabel) gpuAccelerationLabel.classList.add('visible');
    } else {
      convertFormatContainer.classList.remove('visible');
      keepOriginalLabel.classList.remove('visible');
      if (gpuAccelerationLabel) gpuAccelerationLabel.classList.remove('visible');
    }

    // GPU acceleration settings
    if (gpuAccelerationToggle) {
      gpuAccelerationToggle.checked = settings.gpuAcceleration ?? false;
    }
    if (gpuTypeSelect) {
      gpuTypeSelect.value = settings.gpuType ?? 'auto';
    }
    if (gpuTypeContainer) {
      if (settings.gpuAcceleration) {
        gpuTypeContainer.classList.add('visible');
      } else {
        gpuTypeContainer.classList.remove('visible');
      }
    }

    if (ffmpegPathInput) {
      ffmpegPathInput.value = settings.ffmpegPath ?? '';
    }

    if (settings.hookBrowser) {
      browserChoiceContainer.classList.add('visible');
    } else {
      browserChoiceContainer.classList.remove('visible');
    }

    updateConsoleVisibility(settings.showConsoleOutput);

    // Restore console collapsed state
    if (settings.consoleCollapsed) {
      const consoleSection = document.getElementById('console-section');
      const consoleHeaderEl = document.getElementById('consoleHeader');
      if (consoleSection) consoleSection.classList.add('collapsed');
      if (consoleHeaderEl) consoleHeaderEl.setAttribute('aria-expanded', 'false');
    }

    toggleAdvancedUI(settings.advancedOptions);

    // Update additional options
    if (animateBackgroundToggle) {
      animateBackgroundToggle.checked = settings.animateBackground ?? true;
      updateBackgroundAnimation(settings.animateBackground ?? true);
    }
    if (bestQualityToggle) {
      bestQualityToggle.checked = settings.bestQuality ?? false;
      const bestQualityDisabled =
        (settings.advancedOptions ?? false) || (settings.audioOnly ?? false);
      bestQualityToggle.disabled = bestQualityDisabled;
      if (bestQualityDisabled) {
        bestQualityToggle.parentElement.classList.add('disabled');
        bestQualityToggle.parentElement.title = settings.audioOnly
          ? 'Disabled when Audio-only mode is enabled'
          : 'Disabled when Advanced format selection is enabled';
      } else {
        bestQualityToggle.parentElement.classList.remove('disabled');
        bestQualityToggle.parentElement.title = '';
      }
    }
    if (audioOnlyToggle) {
      audioOnlyToggle.checked = settings.audioOnly ?? false;
      audioOnlyToggle.disabled = settings.advancedOptions ?? false;
      if (audioOnlyToggle.disabled) {
        audioOnlyToggle.parentElement.classList.add('disabled');
        audioOnlyToggle.parentElement.title = 'Disabled when Advanced format selection is enabled';
      } else {
        audioOnlyToggle.parentElement.classList.remove('disabled');
        audioOnlyToggle.parentElement.title = '';
      }
    }
    // disable convert when audio-only is enabled
    if (convertToggle) {
      convertToggle.disabled = settings.audioOnly ?? false;
      if (settings.audioOnly) {
        convertToggle.parentElement.classList.add('disabled');
        convertToggle.parentElement.title =
          'Disabled when Audio-only mode is enabled (audio already extracted as MP3)';
      } else {
        convertToggle.parentElement.classList.remove('disabled');
        convertToggle.parentElement.title = '';
      }
    }
    if (notificationsToggle) {
      notificationsToggle.checked = settings.notifications ?? true;
    }

    const channel = window.api.getChannel();
    if (checkUpdatesOnStartupToggle) {
      checkUpdatesOnStartupToggle.checked = settings.checkUpdatesOnStartup ?? true;
      if (channel === 'msstore' && checkUpdatesOnStartupLabel) {
        checkUpdatesOnStartupLabel.classList.add('hidden');
      }
    }

    if (updateChannelSelect) {
      updateChannelSelect.value = settings.updateChannel ?? 'auto';
      if (channel === 'msstore') {
        if (updateChannelContainer) updateChannelContainer.classList.add('hidden');
        if (showUpdateChannelBtn) showUpdateChannelBtn.classList.add('hidden');
      }
    }
  };

  try {
    updateUIFromSettings();
  } catch (e) {
    console.error('Failed to update UI from settings:', e);
  }

  if (!settings.hideSupportModal) {
    showModal({
      title: 'Support This Project?',
      message:
        'Would you like to support the development of ROSI?\nYour help keeps this project alive!',
      buttons: [
        {
          label: '❤️ Yes Support!',
          action: () => {
            window.api.openExternal('https://rosie.run/support');
            settings.hideSupportModal = true;
            void persistSettings();
          },
        },
        {
          label: 'No thanks',
          action: () => {
            settings.hideSupportModal = true;
            void persistSettings();
          },
        },
      ],
    });
  }

  // Sidebar controls
  if (settingsBtn) settingsBtn.addEventListener('click', toggleSidebar);
  if (closeSidebarBtn) closeSidebarBtn.addEventListener('click', closeSidebar);
  if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);
  if (shortcutsBtn) shortcutsBtn.addEventListener('click', showKeyboardShortcuts);

  const bindExternalLink = (element, url) => {
    if (element) {
      element.addEventListener('click', (event) => {
        event.preventDefault();
        window.api.openExternal(url);
      });
    }
  };

  bindExternalLink(browserCookiesHelp, 'https://help.rosie.run/about-browser-cookies');
  bindExternalLink(helpLink, 'https://help.rosie.run/rosi/en-us/faq');
  bindExternalLink(supportLink, 'https://rosie.run/support');
  bindExternalLink(websiteLink, 'https://rosie.run');
  bindExternalLink(supportProjectLink, 'https://rosie.run/support');

  if (licensesLink) {
    licensesLink.addEventListener('click', (event) => {
      event.preventDefault();
      showLicenses();
    });
  }

  if (clearUrlBtn && urlInput) {
    clearUrlBtn.addEventListener('click', () => {
      urlInput.value = '';
      urlInput.focus();
      clearUrlBtn.classList.add('hidden');
    });
    urlInput.addEventListener('input', () => {
      clearUrlBtn.classList.toggle('hidden', urlInput.value.length === 0);
    });
    clearUrlBtn.classList.toggle('hidden', urlInput.value.length === 0);
  }

  if (clearConsoleBtn && outputEl) {
    clearConsoleBtn.addEventListener('click', () => {
      outputEl.textContent = '';
    });
  }

  if (consoleToggle)
    consoleToggle.addEventListener('change', (e) => {
      settings.showConsoleOutput = e.target.checked;
      void persistSettings();
      updateConsoleVisibility(settings.showConsoleOutput);
    });

  // Console collapse toggle
  const consoleHeader = document.getElementById('consoleHeader');
  if (consoleHeader) {
    consoleHeader.addEventListener('click', (e) => {
      if (e.target.closest('#clearConsole')) return;
      const isCollapsed = toggleConsoleCollapse();
      settings.consoleCollapsed = isCollapsed;
      void persistSettings();
    });
    consoleHeader.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (e.target.closest('#clearConsole')) return;
        const isCollapsed = toggleConsoleCollapse();
        settings.consoleCollapsed = isCollapsed;
        void persistSettings();
      }
    });
  }

  if (advancedToggle)
    advancedToggle.addEventListener('change', (e) => {
      settings.advancedOptions = e.target.checked;
      toggleAdvancedUI(e.target.checked);

      if (bestQualityToggle) {
        bestQualityToggle.disabled = e.target.checked;
        if (e.target.checked) {
          bestQualityToggle.checked = false;
          settings.bestQuality = false;
          bestQualityToggle.parentElement.classList.add('disabled');
          bestQualityToggle.parentElement.title =
            'Disabled when Advanced format selection is enabled';
        } else {
          bestQualityToggle.parentElement.classList.remove('disabled');
          bestQualityToggle.parentElement.title = '';
        }
      }

      if (audioOnlyToggle) {
        audioOnlyToggle.disabled = e.target.checked;
        if (e.target.checked) {
          audioOnlyToggle.checked = false;
          settings.audioOnly = false;
          audioOnlyToggle.parentElement.classList.add('disabled');
          audioOnlyToggle.parentElement.title =
            'Disabled when Advanced format selection is enabled';

          if (convertToggle) {
            convertToggle.disabled = false;
            convertToggle.parentElement.classList.remove('disabled');
            convertToggle.parentElement.title = '';
          }
        } else {
          audioOnlyToggle.parentElement.classList.remove('disabled');
          audioOnlyToggle.parentElement.title = '';
        }
      }

      void persistSettings();
    });
  if (keepOriginalToggle)
    keepOriginalToggle.addEventListener('change', (e) => {
      if (!e.target.disabled) {
        settings.keepOriginalAfterConvert = e.target.checked;
        void persistSettings();
      } else {
        e.preventDefault();
      }
    });
  if (hookBrowserToggle)
    hookBrowserToggle.addEventListener('change', (e) => {
      settings.hookBrowser = e.target.checked;
      if (browserChoiceContainer) {
        if (e.target.checked) {
          browserChoiceContainer.classList.add('visible');
        } else {
          browserChoiceContainer.classList.remove('visible');
        }
      }
      void persistSettings();
    });
  if (browserChoiceSelect)
    browserChoiceSelect.addEventListener('change', (e) => {
      settings.browserChoice = e.target.value;
      void persistSettings();
    });
  if (convertToggle)
    convertToggle.addEventListener('change', (e) => {
      settings.convertEnabled = e.target.checked;
      if (e.target.checked) {
        convertFormatContainer.classList.add('visible');
        keepOriginalLabel.classList.add('visible');
        if (gpuAccelerationLabel) gpuAccelerationLabel.classList.add('visible');
      } else {
        convertFormatContainer.classList.remove('visible');
        keepOriginalLabel.classList.remove('visible');
        if (gpuAccelerationLabel) gpuAccelerationLabel.classList.remove('visible');
        if (gpuTypeContainer) gpuTypeContainer.classList.remove('visible');
      }
      if (!e.target.checked) {
        settings.keepOriginalAfterConvert = true;
        if (keepOriginalToggle) keepOriginalToggle.checked = true;
      }
      void persistSettings();
    });
  if (convertFormatSelect)
    convertFormatSelect.addEventListener('change', (e) => {
      settings.convertFormat = e.target.value;
      void persistSettings();
    });
  if (ffmpegPathInput) {
    ffmpegPathInput.addEventListener('input', (e) => {
      settings.ffmpegPath = e.target.value;
    });
    ffmpegPathInput.addEventListener('change', (e) => {
      settings.ffmpegPath = e.target.value;
      void persistSettings();
    });
  }
  // GPU acceleration toggle
  if (gpuAccelerationToggle) {
    gpuAccelerationToggle.addEventListener('change', (e) => {
      settings.gpuAcceleration = e.target.checked;
      if (gpuTypeContainer) {
        if (e.target.checked) {
          gpuTypeContainer.classList.add('visible');
        } else {
          gpuTypeContainer.classList.remove('visible');
        }
      }
      void persistSettings();
    });
  }
  if (gpuTypeSelect) {
    gpuTypeSelect.addEventListener('change', (e) => {
      settings.gpuType = e.target.value;
      void persistSettings();
    });
  }
  // Animate Background toggle
  if (animateBackgroundToggle) {
    animateBackgroundToggle.addEventListener('change', (e) => {
      settings.animateBackground = e.target.checked;
      updateBackgroundAnimation(e.target.checked);
      void persistSettings();
    });
  }

  if (bestQualityToggle) {
    bestQualityToggle.addEventListener('change', (e) => {
      settings.bestQuality = e.target.checked;
      void persistSettings();
    });
  }

  // Audio-only toggle
  if (audioOnlyToggle) {
    audioOnlyToggle.addEventListener('change', (e) => {
      settings.audioOnly = e.target.checked;

      if (bestQualityToggle) {
        bestQualityToggle.disabled = e.target.checked;
        if (e.target.checked) {
          bestQualityToggle.checked = false;
          settings.bestQuality = false;
          bestQualityToggle.parentElement.classList.add('disabled');
          bestQualityToggle.parentElement.title = 'Disabled when Audio-only mode is enabled';
        } else {
          bestQualityToggle.parentElement.classList.remove('disabled');
          bestQualityToggle.parentElement.title = '';
        }
      }

      if (convertToggle) {
        convertToggle.disabled = e.target.checked;
        if (e.target.checked) {
          convertToggle.checked = false;
          settings.convertEnabled = false;
          convertToggle.parentElement.classList.add('disabled');
          convertToggle.parentElement.title =
            'Disabled when Audio-only mode is enabled (audio already extracted as MP3)';
          if (convertFormatContainer) convertFormatContainer.classList.remove('visible');
          if (keepOriginalLabel) keepOriginalLabel.classList.remove('visible');
        } else {
          convertToggle.parentElement.classList.remove('disabled');
          convertToggle.parentElement.title = '';
        }
      }

      void persistSettings();
    });
  }

  // Notifications toggle
  if (notificationsToggle) {
    notificationsToggle.addEventListener('change', (e) => {
      settings.notifications = e.target.checked;
      void persistSettings();
    });
  }

  // Check updates on startup
  if (checkUpdatesOnStartupToggle) {
    checkUpdatesOnStartupToggle.addEventListener('change', (e) => {
      settings.checkUpdatesOnStartup = e.target.checked;
      void persistSettings();
    });
  }

  if (showUpdateChannelBtn && updateChannelContainer) {
    showUpdateChannelBtn.addEventListener('click', () => {
      const isVisible = updateChannelContainer.classList.contains('visible');
      updateChannelContainer.classList.toggle('visible', !isVisible);
      showUpdateChannelBtn.textContent = isVisible
        ? '▸ Update channel settings'
        : '▾ Hide update channel';
    });
  }

  if (updateChannelSelect) {
    updateChannelSelect.addEventListener('change', (e) => {
      settings.updateChannel = e.target.value;
      void persistSettings();
    });
  }

  if (resetSettingsBtn)
    resetSettingsBtn.addEventListener('click', () => {
      showModal({
        title: 'Confirm Reset',
        message: 'Are you sure you want to reset all settings to default? Rosi will restart.',
        buttons: [
          { label: 'Cancel' },
          { label: '⟳ Reset & Restart', action: () => window.api.resetSettings() },
        ],
      });
    });

  if (fetchFormatsBtn) {
    fetchFormatsBtn.onclick = fetchFormats;
  }

  // download button
  if (downloadBtn) {
    downloadBtn._originalClick = async function () {
      try {
        if (isDownloading) return;

        isDownloading = true;

        const urlInput = document.getElementById('url');
        const url = urlInput ? urlInput.value : null;
        if (!url || url.trim() === '') {
          isDownloading = false;
          showModal({
            title: 'Input Error',
            message: 'Please enter a video URL.',
            buttons: [{ label: 'OK' }],
          });
          return;
        }

        // Validate URL format
        if (!isValidUrl(url.trim())) {
          isDownloading = false;
          showModal({
            title: 'Invalid URL',
            message: 'Please enter a valid URL starting with http:// or https://',
            buttons: [{ label: 'OK' }],
          });
          return;
        }

        const videoSelect = document.getElementById('videoFormat');
        const audioSelect = document.getElementById('audioFormat');
        if (
          settings.advancedOptions &&
          (!videoSelect || !audioSelect || !videoSelect.value || !audioSelect.value)
        ) {
          isDownloading = false;
          showModal({
            title: 'Format Selection Needed',
            message: 'Please check resolutions and select video/audio formats first.',
            buttons: [{ label: 'OK' }],
          });
          return;
        }

        let savePath;
        try {
          savePath = await window.api.selectDownloadLocation();
        } catch (dialogError) {
          console.error('Error opening save dialog:', dialogError);
          isDownloading = false;
          showModal({
            title: 'Error',
            message: 'Could not open the save location dialog. Please try again.',
            buttons: [{ label: 'OK' }],
          });
          return;
        }

        if (!savePath) {
          isDownloading = false;
          if (outputEl) outputEl.textContent = '⚠️ Download cancelled: No save location selected.';
          return;
        }
        if (outputEl) outputEl.textContent = '';
        downloadAbort = () => {
          isDownloading = false;
          setButtonLoading(downloadBtn, false);
        };
        setButtonLoading(downloadBtn, true, () => {
          window.api.cancelDownload();
          downloadAbort();
          hideProgressBar();
        });

        showProgressBar('Starting download...');

        const videoFormat = settings.advancedOptions ? videoSelect.value : null;
        const audioFormat = settings.advancedOptions ? audioSelect.value : null;
        const convertFormat = settings.convertEnabled ? convertFormatSelect.value : null;
        const keepOriginal = settings.convertEnabled ? keepOriginalToggle.checked : null;
        const startResult = await window.api.downloadVideo({
          url,
          videoFormat,
          audioFormat,
          outputPath: savePath,
          convertFormat,
          keepOriginal,
          ffmpegPath: settings.ffmpegPath,
        });
        if (!startResult || startResult.ok !== true) {
          isDownloading = false;
          setButtonLoading(downloadBtn, false);
          hideProgressBar();
          showModal({
            title: 'Download Validation Error',
            message:
              startResult?.error?.message || 'Download request was rejected before starting.',
            buttons: [{ label: 'OK' }],
          });
        }
      } catch (downloadError) {
        console.error('Unexpected error starting download:', downloadError);
        isDownloading = false;
        setButtonLoading(downloadBtn, false);
        hideProgressBar();
        showModal({
          title: 'Download Error',
          message: 'An unexpected error occurred while starting the download. Please try again.',
          buttons: [{ label: 'OK' }],
        });
      }
    };
    downloadBtn.onclick = downloadBtn._originalClick;
  }

  if (checkUpdateBtn) {
    checkUpdateBtn.onclick = checkForUpdates;
  }
  const ipcCleanupFunctions = [];

  ipcCleanupFunctions.push(
    window.api.onProgress((message) => {
      if (!outputEl) return;
      appendConsoleOutput(outputEl, message);

      const progress = parseYtdlpProgress(message);
      if (progress) {
        let detailsText = '';
        if (progress.speed && progress.eta) {
          detailsText = `${progress.totalSize} • ${progress.speed} • ETA: ${progress.eta}`;
        } else if (progress.totalSize) {
          detailsText = `Size: ${progress.totalSize}`;
        }
        updateProgressBar(progress.percent, 'Downloading...', detailsText);
      } else if (message.includes('[download] Destination:')) {
        setProgressIndeterminate('Preparing download...');
      } else if (message.includes('Merging formats')) {
        setProgressIndeterminate('Merging video and audio...');
      } else if (message.includes('Converting') || message.includes('[ffmpeg]')) {
        setProgressIndeterminate('Converting...');
      } else if (message.includes('100%')) {
        updateProgressBar(100, 'Download complete!', '');
      }

      if (message.includes('Identified file:') || message.includes('Successfully converted to')) {
        const fileMatch = message.match(/(?:Identified file:|Successfully converted to)\s*(.+)$/);
        if (fileMatch && fileMatch[1]) {
          lastDownloadedFilePath = fileMatch[1].trim();
        }
      }
    })
  );

  ipcCleanupFunctions.push(
    window.api.onComplete((statusMessage) => {
      if (downloadBtn) {
        isDownloading = false;
        setButtonLoading(downloadBtn, false);

        const normalizedStatus = String(statusMessage || '').toLowerCase();
        const isCancelled = normalizedStatus.includes('cancel');
        const isSuccess =
          !isCancelled && (statusMessage.includes('✅') || normalizedStatus.includes('complete'));

        if (isSuccess) {
          updateProgressBar(100, 'Complete!', '');

          if (settings.notifications) {
            window.api.showNotification({
              title: 'Download Complete!',
              body: lastDownloadedFilePath
                ? `Saved: ${lastDownloadedFilePath.split(/[/\\]/).pop()}`
                : 'Your download has finished.',
              filePath: lastDownloadedFilePath,
            });
          }
        }

        setTimeout(() => {
          hideProgressBar();
        }, 2000);

        const restoreDefaultDownloadButton = () => {
          setButtonLoading(downloadBtn, false);
        };

        if (isSuccess && lastDownloadedFilePath) {
          const filePath = lastDownloadedFilePath;
          downloadBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg><span>Open File Location</span>`;
          downloadBtn.disabled = false;
          downloadBtn.onclick = () => {
            window.api.openFileLocation(filePath);
          };
          setTimeout(() => {
            restoreDefaultDownloadButton();
            lastDownloadedFilePath = null;
          }, 8000);
        } else if (isSuccess) {
          downloadBtn.innerHTML = `✅ Download Complete!`;
          downloadBtn.disabled = false;
          setTimeout(() => {
            restoreDefaultDownloadButton();
          }, 2500);
        } else {
          restoreDefaultDownloadButton();
          lastDownloadedFilePath = null;
        }
      }
      if (fetchFormatsBtn) setButtonLoading(fetchFormatsBtn, false);
      if (outputEl) {
        appendConsoleOutput(outputEl, statusMessage);
      }
    })
  );

  window.addEventListener('beforeunload', () => {
    ipcCleanupFunctions.forEach((cleanup) => {
      if (typeof cleanup === 'function') {
        try {
          cleanup();
        } catch (e) {}
      }
    });
    cleanupUpdaterListeners();
    void persistSettings(true);
  });

  // Check for updates on startup
  async function checkUpdatesOnStartup() {
    const channel = window.api.getChannel();
    if (channel === 'msstore') return;
    if (!settings.checkUpdatesOnStartup) return;

    try {
      const isPackaged = await window.api.isPackaged();
      if (!isPackaged) return;

      await new Promise((resolve) => setTimeout(resolve, 2000));
      await window.api.checkForUpdates();
    } catch (e) {
      console.error('Startup update check failed:', e);
    }
  }

  if (settings.firstLaunch) {
    // Save immediately - change
    settings.firstLaunch = false;
    void persistSettings();

    showModal({
      title: 'Dependency FFMPEG is Required for this app.',
      message:
        'ROSI uses FFMPEG for yt-dlp and converting files to MP4.\nPlease ensure FFMPEG is installed and accessible in your system\'s PATH, or set a custom FFmpeg path in Settings.\nClick "More Info" for guidance.',
      buttons: [
        {
          label: 'More Info',
          action: () => window.api.openExternal('https://help.rosie.run/installing-ffmpeg'),
        },
        {
          label: 'OK',
          action: () => {
            checkDenoInstallation(settings);
            checkUpdatesOnStartup();
          },
        },
      ],
    });
  } else {
    // check Deno
    checkDenoInstallation(settings);
    checkUpdatesOnStartup();
  }

  const closeBtn = document.getElementById('close-licenses');
  if (closeBtn) {
    closeBtn.addEventListener('click', hideLicenses);
  }

  document.addEventListener('keydown', (event) => {
    const modifierPressed = isMac() ? event.metaKey : event.ctrlKey;

    // esc
    if (event.key === 'Escape') {
      const licensesOverlay = document.getElementById('licenses-overlay');
      if (licensesOverlay && licensesOverlay.classList.contains('active')) {
        hideLicenses();
        return;
      }

      const appModal = document.getElementById('app-modal');
      if (appModal && appModal.classList.contains('active')) {
        hideModal(appModal, null);
        return;
      }

      const sidebar = document.getElementById('sidebar');
      if (sidebar && sidebar.classList.contains('open')) {
        closeSidebar();
        return;
      }
    }

    if (modifierPressed && event.key === 'd') {
      event.preventDefault();
      showModal({
        title: 'Restart Application',
        message: 'Are you sure you want to restart ROSI?',
        buttons: [{ label: 'Cancel' }, { label: 'Restart', action: () => window.api.restartApp() }],
      });
    }

    if (modifierPressed && event.key === 'f') {
      event.preventDefault();
      const urlInput = document.getElementById('url');
      if (urlInput) {
        urlInput.focus();
        urlInput.select();
      }
    }

    if (modifierPressed && event.key === ',') {
      event.preventDefault();
      toggleSidebar();
    }
  });
});
