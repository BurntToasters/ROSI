function logError(context, error) {
  const msg = error instanceof Error ? error.message : String(error || '');
  const text = msg ? `${context}: ${msg}` : context;
  if (window.api && typeof window.api.logError === 'function') {
    window.api.logError(text);
  }
}

const rosiModules = window.rosiModules || {};
const uiModule = rosiModules.ui || null;
const downloadsModule = rosiModules.downloads || null;
const queueModule = rosiModules.queue || null;
const settingsModule = rosiModules.settings || null;
const updatesModule = rosiModules.updates || null;

function isMac() {
  if (uiModule && typeof uiModule.isMac === 'function') {
    return uiModule.isMac();
  }
  return navigator.platform.toLowerCase().includes('mac');
}

function getModifierKey() {
  if (uiModule && typeof uiModule.getModifierKey === 'function') {
    return uiModule.getModifierKey();
  }
  return isMac() ? 'metaKey' : 'ctrlKey';
}

function getModifierKeyName() {
  if (uiModule && typeof uiModule.getModifierKeyName === 'function') {
    return uiModule.getModifierKeyName();
  }
  return isMac() ? 'Cmd' : 'Ctrl';
}

function isValidUrl(string) {
  if (uiModule && typeof uiModule.isValidUrl === 'function') {
    return uiModule.isValidUrl(string);
  }
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

let systemThemeMediaQuery = null;
let systemThemeMediaQueryHandler = null;
let appliedTheme = 'dark';
let themePreference = 'system';

function resolveAppliedTheme(preference) {
  if (preference === 'light' || preference === 'dark' || preference === 'purple') {
    return preference;
  }
  const query =
    systemThemeMediaQuery ||
    (typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null);
  return query && query.matches ? 'dark' : 'light';
}

function syncLicensesTheme(theme) {
  try {
    const frame = document.getElementById('licenses-frame');
    const root = frame?.contentDocument?.documentElement;
    if (root) {
      root.dataset.theme = theme;
    }
  } catch (_) {
    /* ignore */
  }
}

function teardownSystemThemeListener() {
  if (!systemThemeMediaQuery || !systemThemeMediaQueryHandler) {
    return;
  }
  if (typeof systemThemeMediaQuery.removeEventListener === 'function') {
    systemThemeMediaQuery.removeEventListener('change', systemThemeMediaQueryHandler);
  } else if (typeof systemThemeMediaQuery.removeListener === 'function') {
    systemThemeMediaQuery.removeListener(systemThemeMediaQueryHandler);
  }
  systemThemeMediaQueryHandler = null;
}

function ensureSystemThemeListener() {
  if (themePreference !== 'system') {
    teardownSystemThemeListener();
    return;
  }
  if (!systemThemeMediaQuery && typeof window.matchMedia === 'function') {
    systemThemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  }
  if (!systemThemeMediaQuery || systemThemeMediaQueryHandler) {
    return;
  }
  systemThemeMediaQueryHandler = () => {
    if (themePreference !== 'system') {
      return;
    }
    appliedTheme = resolveAppliedTheme('system');
    document.documentElement.dataset.theme = appliedTheme;
    syncLicensesTheme(appliedTheme);
  };
  if (typeof systemThemeMediaQuery.addEventListener === 'function') {
    systemThemeMediaQuery.addEventListener('change', systemThemeMediaQueryHandler);
  } else if (typeof systemThemeMediaQuery.addListener === 'function') {
    systemThemeMediaQuery.addListener(systemThemeMediaQueryHandler);
  }
}

function applyTheme(preference) {
  themePreference =
    preference === 'light' || preference === 'dark' || preference === 'purple'
      ? preference
      : 'system';
  ensureSystemThemeListener();
  appliedTheme = resolveAppliedTheme(themePreference);
  document.documentElement.dataset.theme = appliedTheme;
  syncLicensesTheme(appliedTheme);
  return appliedTheme;
}

function updateConsoleVisibility(show) {
  if (uiModule && typeof uiModule.updateConsoleVisibility === 'function') {
    uiModule.updateConsoleVisibility(show);
    return;
  }
  const consoleSection = document.getElementById('console-section');
  if (consoleSection) {
    consoleSection.classList.toggle('visible', !!show);
  }
  document.body.classList.toggle('console-visible', !!show);
}

function showToast(message, { type = 'info', duration = 4000 } = {}) {
  if (uiModule && typeof uiModule.showToast === 'function') {
    uiModule.showToast(message, { type, duration });
  }
}

function appendConsoleOutput(outputEl, text) {
  if (uiModule && typeof uiModule.appendConsoleOutput === 'function') {
    uiModule.appendConsoleOutput(outputEl, text);
  }
}

function setConsoleCollapsed(collapsed) {
  const consoleSection = document.getElementById('console-section');
  const consoleHeader = document.getElementById('consoleHeader');
  const output = document.getElementById('output');
  if (!consoleSection) return false;
  consoleSection.classList.toggle('collapsed', !!collapsed);
  const isCollapsed = consoleSection.classList.contains('collapsed');
  if (consoleHeader) consoleHeader.setAttribute('aria-expanded', String(!isCollapsed));
  if (output) output.setAttribute('aria-hidden', String(isCollapsed));
  return isCollapsed;
}

// Toggle console collapsed state
function toggleConsoleCollapse(forceCollapsed) {
  const consoleSection = document.getElementById('console-section');
  if (!consoleSection) return false;
  if (typeof forceCollapsed === 'boolean') {
    return setConsoleCollapsed(forceCollapsed);
  }
  return setConsoleCollapsed(!consoleSection.classList.contains('collapsed'));
}

function setButtonLoading(button, isLoading, onCancel) {
  if (uiModule && typeof uiModule.setButtonLoading === 'function') {
    uiModule.setButtonLoading(button, isLoading, onCancel);
  }
}

function toggleSidebar() {
  if (uiModule && typeof uiModule.toggleSidebar === 'function') {
    uiModule.toggleSidebar();
  }
}

function closeSidebar() {
  if (uiModule && typeof uiModule.closeSidebar === 'function') {
    uiModule.closeSidebar();
  }
}
function toggleAdvancedUI(show) {
  if (uiModule && typeof uiModule.toggleAdvancedUI === 'function') {
    uiModule.toggleAdvancedUI(show);
  }
}

// Modal queue system
const modalQueue = [];
let isModalActive = false;
let currentModalData = null;
let previousFocus = null;
let modalTrapHandler = null;
let modalFocusinHandler = null;
let licensesFocusinHandler = null;

function getFocusableElements(container) {
  if (!(container instanceof HTMLElement)) return [];
  return Array.from(
    container.querySelectorAll(
      'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
    )
  ).filter(
    (element) =>
      !element.hasAttribute('disabled') &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.tabIndex !== -1 &&
      element.offsetParent !== null
  );
}

function focusFirstElement(container) {
  const focusable = getFocusableElements(container);
  const first = focusable[0];
  if (first && typeof first.focus === 'function') {
    first.focus();
    return true;
  }
  return false;
}

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

  modal.setAttribute('tabindex', '-1');
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
  if (modalFocusinHandler) {
    document.removeEventListener('focusin', modalFocusinHandler, true);
  }
  modalTrapHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hideModal(modal, null);
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = getFocusableElements(modal);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (!active || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (!active || active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  modal.addEventListener('keydown', modalTrapHandler);
  modalFocusinHandler = (e) => {
    if (!isModalActive || !modal.classList.contains('active')) return;
    const target = e.target;
    if (target instanceof Node && modal.contains(target)) return;
    if (!focusFirstElement(modal) && typeof modal.focus === 'function') {
      modal.focus();
    }
  };
  document.addEventListener('focusin', modalFocusinHandler, true);

  requestAnimationFrame(() => {
    if (!focusFirstElement(modal) && typeof modal.focus === 'function') {
      modal.focus();
    }
  });
}

function hideModal(modal, action) {
  modal.classList.add('hiding');
  currentModalData = null;
  if (modalTrapHandler) {
    modal.removeEventListener('keydown', modalTrapHandler);
    modalTrapHandler = null;
  }
  if (modalFocusinHandler) {
    document.removeEventListener('focusin', modalFocusinHandler, true);
    modalFocusinHandler = null;
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
      const formatResult = await window.api.getFormats(videoUrl);
      if (wasCancelled) return;
      if (!formatResult || formatResult.ok !== true) {
        const errorMessage = formatResult?.error?.message || 'Unknown error';
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
        return;
      }

      const lines = formatResult.data.split('\n');
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
    logError('Unexpected error in fetchFormats', outerError);
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

function setProgressPhase(phase) {
  const phases = document.querySelectorAll('.progress-phase');
  const phaseOrder = ['download', 'merge', 'convert'];
  const phaseIndex = phaseOrder.indexOf(phase);

  phases.forEach((el) => {
    const elPhase = el.dataset.phase;
    const elIndex = phaseOrder.indexOf(elPhase);
    el.classList.remove('active', 'completed');
    if (elIndex < phaseIndex) {
      el.classList.add('completed');
    } else if (elIndex === phaseIndex) {
      el.classList.add('active');
    }
  });
}

function configureProgressPhases(showMerge, showConvert) {
  const mergePhase = document.querySelector('.progress-phase[data-phase="merge"]');
  const convertPhase = document.querySelector('.progress-phase[data-phase="convert"]');
  const connectors = document.querySelectorAll('.progress-phase-connector');

  if (mergePhase) mergePhase.style.display = showMerge ? 'flex' : 'none';
  if (convertPhase) convertPhase.style.display = showConvert ? 'flex' : 'none';

  if (connectors[0]) connectors[0].style.display = showMerge ? 'block' : 'none';
  if (connectors[1])
    connectors[1].style.display =
      showMerge && showConvert ? 'block' : showConvert ? 'block' : 'none';
}

function showProgressComplete() {
  const icon = document.getElementById('progress-complete-icon');
  if (icon) icon.classList.add('visible');
}

function hideProgressComplete() {
  const icon = document.getElementById('progress-complete-icon');
  if (icon) icon.classList.remove('visible');
}

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
    bar.classList.add('active-glow');
  }
  if (details) details.textContent = '';
  hideProgressComplete();
  setProgressPhase('download');
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
  const bar = document.getElementById('progress-bar');
  if (container) {
    container.classList.remove('visible');
  }
  if (bar) bar.classList.remove('active-glow');
  hideProgressComplete();
}

function parseYtdlpProgress(message) {
  if (downloadsModule && typeof downloadsModule.parseYtdlpProgress === 'function') {
    return downloadsModule.parseYtdlpProgress(message);
  }
  return null;
}

function formatBytes(bytes) {
  if (downloadsModule && typeof downloadsModule.formatBytes === 'function') {
    return downloadsModule.formatBytes(bytes);
  }
  return String(bytes);
}

const HISTORY_KEY = 'rosi-download-history';
const HISTORY_MAX = 20;

function loadHistory() {
  try {
    const data = localStorage.getItem(HISTORY_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)) {
      history.length = Math.max(1, Math.floor(history.length / 2));
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
      } catch {
        /* give up */
      }
    }
  }
}

function addHistoryEntry(entry) {
  const history = loadHistory();
  history.unshift({
    filename: entry.filename,
    path: entry.path || null,
    timestamp: Date.now(),
    status: entry.status,
  });
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  saveHistory(history);
  renderHistory();
}

function formatRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderHistory() {
  const historySection = document.getElementById('download-history');
  const listEl = document.getElementById('history-list');
  const countEl = document.getElementById('history-count');
  if (!listEl || !historySection) return;

  const history = loadHistory();
  if (countEl) countEl.textContent = String(history.length);

  if (history.length === 0) {
    historySection.classList.remove('visible');
    listEl.innerHTML = '';
    return;
  }

  historySection.classList.add('visible');
  listEl.innerHTML = '';
  const fragment = document.createDocumentFragment();

  history.forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'history-item';

    const statusLabel =
      entry.status === 'success'
        ? 'Completed'
        : entry.status === 'cancelled'
          ? 'Cancelled'
          : 'Failed';

    item.innerHTML = `
      <div class="history-item-info">
        <span class="history-filename" title="${escapeHtml(entry.filename)}">${escapeHtml(entry.filename)}</span>
        <span class="history-time">${formatRelativeTime(entry.timestamp)}</span>
      </div>
      <div class="history-item-actions">
        <span class="history-status ${entry.status}">${statusLabel}</span>
        ${entry.status === 'success' && entry.path ? '<button class="history-open-btn">Open</button>' : ''}
      </div>
    `;

    if (entry.path) {
      const openBtn = item.querySelector('.history-open-btn');
      if (openBtn) {
        openBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.api.openFileLocation(entry.path);
        });
      }
    }

    fragment.appendChild(item);
  });
  listEl.appendChild(fragment);
}

function clearHistory() {
  saveHistory([]);
  renderHistory();
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
    banner.setAttribute('aria-busy', 'true');
  }
}

function hideUpdateBanner() {
  const banner = document.getElementById('update-banner');
  if (banner) {
    banner.classList.remove('active');
    banner.setAttribute('aria-busy', 'false');
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
          const isBetaUpdate =
            data.isBeta ||
            (updatesModule && typeof updatesModule.isPrereleaseVersion === 'function'
              ? updatesModule.isPrereleaseVersion(data.version)
              : /-(beta|alpha|rc)/i.test(data.version));
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
        if (updatesModule && typeof updatesModule.formatUpdateProgressInfo === 'function') {
          progressInfo.textContent = updatesModule.formatUpdateProgressInfo(data, formatBytes);
        } else {
          const speed = formatBytes(data.bytesPerSecond) + '/s';
          const downloaded = formatBytes(data.transferred);
          const total = formatBytes(data.total);
          progressInfo.textContent = `${downloaded} / ${total} (${speed}) — ${Math.round(data.percent)}%`;
        }
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
    syncLicensesTheme(appliedTheme);
    document.body.classList.add('licenses-open');
    document.body.style.overflow = 'hidden';

    const closeBtn = licensesOverlay.querySelector('#close-licenses');
    licensesOverlay.setAttribute('tabindex', '-1');
    requestAnimationFrame(() => {
      if (closeBtn) {
        closeBtn.focus();
        return;
      }
      if (!focusFirstElement(licensesOverlay) && typeof licensesOverlay.focus === 'function') {
        licensesOverlay.focus();
      }
    });

    licensesTrapHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hideLicenses();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = getFocusableElements(licensesOverlay);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (!active || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!active || active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    licensesOverlay.addEventListener('keydown', licensesTrapHandler);
    if (licensesFocusinHandler) {
      document.removeEventListener('focusin', licensesFocusinHandler, true);
    }
    licensesFocusinHandler = (e) => {
      if (!licensesOverlay.classList.contains('active')) return;
      const target = e.target;
      if (target instanceof Node && licensesOverlay.contains(target)) return;
      if (!focusFirstElement(licensesOverlay) && typeof licensesOverlay.focus === 'function') {
        licensesOverlay.focus();
      }
    };
    document.addEventListener('focusin', licensesFocusinHandler, true);
  }
}

function hideLicenses() {
  const licensesOverlay = document.getElementById('licenses-overlay');
  if (licensesOverlay) {
    if (licensesTrapHandler) {
      licensesOverlay.removeEventListener('keydown', licensesTrapHandler);
      licensesTrapHandler = null;
    }
    if (licensesFocusinHandler) {
      document.removeEventListener('focusin', licensesFocusinHandler, true);
      licensesFocusinHandler = null;
    }
    licensesOverlay.classList.remove('active');
    setTimeout(() => {
      document.body.style.overflow = '';
      document.body.classList.remove('licenses-open');
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
    logError('Error checking Deno installation', error);
  }
}

function launchSetupWizard(settings, applyThemeFn, persistSettingsFn, onComplete) {
  const TOTAL_STEPS = 4;
  let currentStep = 0;

  const overlay = document.getElementById('setup-wizard');
  const progressBar = document.getElementById('wizard-progress-bar');
  const backBtn = document.getElementById('wizard-back');
  const nextBtn = document.getElementById('wizard-next');
  const dotsContainer = document.getElementById('wizard-dots');
  const steps = overlay ? overlay.querySelectorAll('.wizard-step') : [];

  if (!overlay || !progressBar || !backBtn || !nextBtn || !dotsContainer || steps.length === 0) {
    settings.firstLaunch = false;
    void persistSettingsFn();
    onComplete();
    return;
  }

  // Build dots
  dotsContainer.innerHTML = '';
  for (let i = 0; i < TOTAL_STEPS; i++) {
    const dot = document.createElement('span');
    dot.className = 'wizard-dot' + (i === 0 ? ' active' : '');
    dotsContainer.appendChild(dot);
  }

  // Live theme preview
  const themeRadios = overlay.querySelectorAll('input[name="wizard-theme"]');
  themeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      applyThemeFn(radio.value);
    });
  });

  function updateUI() {
    // Steps
    steps.forEach((step, i) => {
      step.classList.toggle('active', i === currentStep);
    });

    // Progress bar
    progressBar.style.width = ((currentStep + 1) / TOTAL_STEPS) * 100 + '%';

    // Dots
    const dots = dotsContainer.querySelectorAll('.wizard-dot');
    dots.forEach((dot, i) => {
      dot.classList.toggle('active', i === currentStep);
    });

    // Back button
    backBtn.classList.toggle('hidden', currentStep === 0);

    // Next button text
    if (currentStep === 0) {
      nextBtn.textContent = 'Get Started';
    } else if (currentStep === TOTAL_STEPS - 1) {
      nextBtn.textContent = 'Finish';
    } else {
      nextBtn.textContent = 'Next';
    }
  }

  function gatherSettings() {
    // Theme
    const selectedTheme = overlay.querySelector('input[name="wizard-theme"]:checked');
    if (selectedTheme) {
      settings.theme = selectedTheme.value;
      applyThemeFn(settings.theme);
    }

    // Download prefs
    const bestQuality = document.getElementById('wizard-best-quality');
    const audioOnly = document.getElementById('wizard-audio-only');
    const notifications = document.getElementById('wizard-notifications');
    const autoUpdates = document.getElementById('wizard-auto-updates');

    if (bestQuality) settings.bestQuality = bestQuality.checked;
    if (audioOnly) settings.audioOnly = audioOnly.checked;
    if (notifications) settings.notifications = notifications.checked;
    if (autoUpdates) settings.checkUpdatesOnStartup = autoUpdates.checked;
  }

  function close() {
    gatherSettings();
    settings.firstLaunch = false;
    void persistSettingsFn(false, true);
    overlay.classList.remove('active');

    // Sync sidebar controls to reflect wizard choices
    const themeSelect = document.getElementById('themeSelect');
    if (themeSelect) themeSelect.value = settings.theme || 'system';
    const bestQualityToggle = document.getElementById('bestQualityToggle');
    if (bestQualityToggle) bestQualityToggle.checked = settings.bestQuality;
    const audioOnlyToggle = document.getElementById('audioOnlyToggle');
    if (audioOnlyToggle) audioOnlyToggle.checked = settings.audioOnly;
    const notificationsToggle = document.getElementById('notificationsToggle');
    if (notificationsToggle) notificationsToggle.checked = settings.notifications;
    const checkUpdatesToggle = document.getElementById('checkUpdatesOnStartupToggle');
    if (checkUpdatesToggle) checkUpdatesToggle.checked = settings.checkUpdatesOnStartup;

    onComplete();
  }

  nextBtn.addEventListener('click', () => {
    if (currentStep < TOTAL_STEPS - 1) {
      currentStep++;
      updateUI();
    } else {
      close();
    }
  });

  backBtn.addEventListener('click', () => {
    if (currentStep > 0) {
      currentStep--;
      updateUI();
    }
  });

  // Set initial selected theme radio to match current settings
  const initialTheme = settings.theme || 'system';
  const matchingRadio = overlay.querySelector(
    `input[name="wizard-theme"][value="${initialTheme}"]`
  );
  if (matchingRadio) matchingRadio.checked = true;

  updateUI();
  overlay.classList.add('active');
}

document.addEventListener('DOMContentLoaded', async () => {
  let settings;
  try {
    settings = await window.api.getSettings();
  } catch (error) {
    settings = {
      settingsVersion: 2,
      theme: 'system',
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
  applyTheme(settings.theme ?? 'system');

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
      const isBeta =
        updatesModule && typeof updatesModule.isPrereleaseVersion === 'function'
          ? updatesModule.isPrereleaseVersion(version)
          : /-(beta|alpha|rc)/i.test(version);
      if (isBeta) {
        versionLink.classList.add('beta-version');
        if (betaBadge) betaBadge.classList.remove('hidden');
      }
    }
  } catch (e) {
    logError('Could not get app version', e);
  }

  try {
    setupAutoUpdater();
  } catch (e) {
    logError('Failed to setup auto-updater', e);
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

  let persistDebounceTimer = null;

  async function persistSettings(silent = false, immediate = false) {
    if (persistDebounceTimer) clearTimeout(persistDebounceTimer);
    const executeSave = async (resolve) => {
      try {
        const result = await window.api.saveSettings(settings);
        if (!result || result.ok !== true) {
          if (!silent) {
            const message = result?.error?.message || 'Could not save settings.';
            showSettingsSaveError(`${message}\nChanges may not persist after restart.`);
          }
          resolve(false);
          return;
        }
        settings = result.data;
        resolve(true);
      } catch (_error) {
        if (!silent) {
          showSettingsSaveError('Could not save settings due to an unexpected error.');
        }
        resolve(false);
      }
    };
    return new Promise((resolve) => {
      if (immediate) {
        persistDebounceTimer = null;
        void executeSave(resolve);
        return;
      }
      persistDebounceTimer = setTimeout(() => {
        persistDebounceTimer = null;
        void executeSave(resolve);
      }, 300);
    });
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
  const themeSelect = document.getElementById('themeSelect');
  const bestQualityToggle = document.getElementById('bestQualityToggle');
  const audioOnlyToggle = document.getElementById('audioOnlyToggle');
  const audioFormatContainer = document.getElementById('audioFormatContainer');
  const audioFormatSelect = document.getElementById('audioFormatSelect');
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
  const pasteUrlBtn = document.getElementById('pasteUrl');
  const clearConsoleBtn = document.getElementById('clearConsole');
  const urlInput = document.getElementById('url');
  const urlValidationMessage = document.getElementById('urlValidationMessage');
  const urlInputContainer = document.querySelector('.url-input-container');
  const downloadCard = document.querySelector('.download-card');
  const historyHeader = document.getElementById('historyHeader');
  const clearHistoryBtn = document.getElementById('clearHistory');
  const browserCookiesHelp = document.getElementById('browserCookiesHelp');
  const helpLink = document.getElementById('helpLink');
  const supportLink = document.getElementById('supportLink');
  const websiteLink = document.getElementById('websiteLink');
  const supportProjectLink = document.getElementById('supportProjectLink');
  const licensesLink = document.getElementById('licensesLink');
  const licensesFrame = document.getElementById('licenses-frame');
  const exportSettingsBtn = document.getElementById('exportSettingsBtn');
  const importSettingsBtn = document.getElementById('importSettingsBtn');
  const viewStatsBtn = document.getElementById('viewStatsBtn');
  const queueUrlInput = document.getElementById('queueUrlInput');
  const addToQueueBtn = document.getElementById('addToQueueBtn');
  const startQueueBtn = document.getElementById('startQueueBtn');
  const clearQueueBtn = document.getElementById('clearQueueBtn');
  const cancelQueueBtn = document.getElementById('cancelQueueBtn');
  const queueStatusMessage = document.getElementById('queueStatusMessage');
  const queueList = document.getElementById('queueList');
  const queueCount = document.getElementById('queueCount');
  const queueSection =
    (queueModule && typeof queueModule.resolveQueueSectionElement === 'function'
      ? queueModule.resolveQueueSectionElement(document)
      : null) || document.getElementById('queueSection');

  if (queueStatusMessage) {
    queueStatusMessage.setAttribute('role', 'status');
    queueStatusMessage.setAttribute('aria-live', 'polite');
    queueStatusMessage.setAttribute('aria-atomic', 'true');
  }

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
    setConsoleCollapsed(!!settings.consoleCollapsed);

    toggleAdvancedUI(settings.advancedOptions);

    // Update additional options
    if (animateBackgroundToggle) {
      animateBackgroundToggle.checked = settings.animateBackground ?? true;
      updateBackgroundAnimation(settings.animateBackground ?? true);
    }
    if (themeSelect) {
      const nextTheme =
        settings.theme === 'light' ||
        settings.theme === 'dark' ||
        settings.theme === 'purple' ||
        settings.theme === 'system'
          ? settings.theme
          : 'system';
      themeSelect.value = nextTheme;
      applyTheme(nextTheme);
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
    if (audioFormatSelect) {
      audioFormatSelect.value = settings.audioFormat ?? 'mp3';
    }
    if (audioFormatContainer) {
      if (settings.audioOnly) {
        audioFormatContainer.classList.add('visible');
      } else {
        audioFormatContainer.classList.remove('visible');
      }
    }
    // disable convert when audio-only is enabled
    if (convertToggle) {
      convertToggle.disabled = settings.audioOnly ?? false;
      if (settings.audioOnly) {
        convertToggle.parentElement.classList.add('disabled');
        convertToggle.parentElement.title = 'Disabled when Audio-only mode is enabled';
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
    logError('Failed to update UI from settings', e);
  }

  if (!settings.hideSupportModal && !settings.firstLaunch) {
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
    if (settingsModule && typeof settingsModule.bindExternalLink === 'function') {
      settingsModule.bindExternalLink(element, url, window.api.openExternal);
      return;
    }
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
  if (licensesFrame) {
    licensesFrame.addEventListener('load', () => {
      syncLicensesTheme(appliedTheme);
    });
  }

  let hasUrlValidationIntent = false;
  function syncPrimaryActionState() {
    const hasInput = !!urlInput;
    const hasPrimaryButton = !!downloadBtn;
    if (!hasInput || !hasPrimaryButton) return;
    const raw = urlInput.value || '';
    const trimmed = raw.trim();
    const hasValue = trimmed.length > 0;
    const validUrl = hasValue && isValidUrl(trimmed);
    const showInvalid = hasUrlValidationIntent && hasValue && !validUrl;

    if (urlInputContainer) {
      urlInputContainer.classList.toggle('is-empty', !hasValue);
      urlInputContainer.classList.toggle('is-valid', validUrl);
      urlInputContainer.classList.toggle('is-invalid', showInvalid);
    }
    if (downloadCard) {
      downloadCard.classList.toggle('is-ready', validUrl);
    }
    if (showInvalid) {
      urlInput.setAttribute('aria-invalid', 'true');
      if (urlValidationMessage) {
        urlValidationMessage.textContent = 'Enter a valid URL starting with http:// or https://';
      }
    } else {
      urlInput.removeAttribute('aria-invalid');
      if (urlValidationMessage) {
        urlValidationMessage.textContent = '';
      }
    }

    const isLoading = downloadBtn.classList.contains('loading');
    if (!isLoading) {
      downloadBtn.disabled = !validUrl;
      downloadBtn.classList.toggle('is-disabled', !validUrl);
    }
  }

  function updateUrlButtons() {
    const hasValue = urlInput && urlInput.value.length > 0;
    if (clearUrlBtn) clearUrlBtn.classList.toggle('hidden', !hasValue);
    if (pasteUrlBtn) pasteUrlBtn.classList.toggle('hidden', hasValue);
    syncPrimaryActionState();
  }

  if (clearUrlBtn && urlInput) {
    clearUrlBtn.addEventListener('click', () => {
      urlInput.value = '';
      urlInput.focus();
      hasUrlValidationIntent = false;
      updateUrlButtons();
    });
    urlInput.addEventListener('input', () => {
      hasUrlValidationIntent = true;
      updateUrlButtons();
    });
    urlInput.addEventListener('blur', () => {
      hasUrlValidationIntent = true;
      syncPrimaryActionState();
    });
    updateUrlButtons();
  }

  if (pasteUrlBtn && urlInput) {
    pasteUrlBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          urlInput.value = text.trim();
          urlInput.dispatchEvent(new Event('input'));
          urlInput.focus();
          hasUrlValidationIntent = true;
          syncPrimaryActionState();
        }
      } catch {
        showToast(`Unable to read clipboard. Try pasting with ${getModifierKeyName()}+V.`, {
          type: 'info',
        });
      }
    });
  }

  if (downloadCard && urlInput) {
    downloadCard.addEventListener('dragover', (e) => {
      e.preventDefault();
      downloadCard.classList.add('drag-over');
    });
    downloadCard.addEventListener('dragleave', () => {
      downloadCard.classList.remove('drag-over');
    });
    downloadCard.addEventListener('drop', (e) => {
      e.preventDefault();
      downloadCard.classList.remove('drag-over');
      const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      if (text && isValidUrl(text.trim())) {
        urlInput.value = text.trim();
        urlInput.dispatchEvent(new Event('input'));
        hasUrlValidationIntent = true;
        syncPrimaryActionState();
      } else if (text) {
        showToast('Dropped content is not a valid URL.', { type: 'warning' });
      }
    });
  }

  renderHistory();

  if (historyHeader) {
    const historySection = document.getElementById('download-history');
    const historyList = document.getElementById('history-list');
    const setHistoryCollapsed = (collapsed) => {
      if (!historySection) return false;
      historySection.classList.toggle('collapsed', !!collapsed);
      const isCollapsed = historySection.classList.contains('collapsed');
      historyHeader.setAttribute('aria-expanded', String(!isCollapsed));
      if (historyList) historyList.setAttribute('aria-hidden', String(isCollapsed));
      return isCollapsed;
    };
    const toggleHistoryCollapsed = () => {
      if (!historySection) return false;
      return setHistoryCollapsed(!historySection.classList.contains('collapsed'));
    };
    if (historySection) {
      setHistoryCollapsed(historySection.classList.contains('collapsed'));
    }

    historyHeader.addEventListener('click', (e) => {
      if (e.target.closest('.history-clear-btn')) return;
      toggleHistoryCollapsed();
    });
    historyHeader.addEventListener('keydown', (e) => {
      if (e.target.closest('.history-clear-btn')) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleHistoryCollapsed();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setHistoryCollapsed(true);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setHistoryCollapsed(false);
      }
    });
  }

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showModal({
        title: 'Clear History',
        message: 'Clear all download history?',
        buttons: [
          { label: 'Cancel' },
          {
            label: 'Clear',
            action: () => {
              clearHistory();
              showToast('Download history cleared.', { type: 'info' });
            },
          },
        ],
      });
    });
  }

  if (clearConsoleBtn && outputEl) {
    clearConsoleBtn.addEventListener('click', () => {
      outputEl.textContent = '';
    });
  }

  const settingsHeaders = Array.from(document.querySelectorAll('.settings-section-header')).filter(
    (header) => header instanceof HTMLElement
  );
  const setSettingsSectionCollapsed = (header, collapsed) => {
    if (!(header instanceof HTMLElement)) return false;
    const section = header.closest('.settings-section');
    if (!(section instanceof HTMLElement)) return false;
    section.classList.toggle('collapsed', !!collapsed);
    const isCollapsed = section.classList.contains('collapsed');
    header.setAttribute('aria-expanded', String(!isCollapsed));
    const controlledId = header.getAttribute('aria-controls');
    const sectionBody =
      (controlledId ? document.getElementById(controlledId) : null) ||
      section.querySelector('.settings-section-body');
    if (sectionBody) {
      sectionBody.setAttribute('aria-hidden', String(isCollapsed));
      if (!controlledId && sectionBody.id) {
        header.setAttribute('aria-controls', sectionBody.id);
      }
    }
    return isCollapsed;
  };

  settingsHeaders.forEach((header, index) => {
    const section = header.closest('.settings-section');
    if (!(section instanceof HTMLElement)) return;

    const controlledId = header.getAttribute('aria-controls');
    const sectionBody =
      (controlledId ? document.getElementById(controlledId) : null) ||
      section.querySelector('.settings-section-body');
    if (sectionBody instanceof HTMLElement) {
      if (!sectionBody.id) {
        sectionBody.id = `settingsSectionBodyAuto${index + 1}`;
      }
      if (!header.getAttribute('aria-controls')) {
        header.setAttribute('aria-controls', sectionBody.id);
      }
      if (!header.id) {
        header.id = `settingsSectionHeaderAuto${index + 1}`;
      }
      if (!sectionBody.getAttribute('aria-labelledby')) {
        sectionBody.setAttribute('aria-labelledby', header.id);
      }
    }

    setSettingsSectionCollapsed(header, section.classList.contains('collapsed'));

    header.addEventListener('click', () => {
      const isCollapsed = section.classList.contains('collapsed');
      setSettingsSectionCollapsed(header, !isCollapsed);
    });
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const isCollapsed = section.classList.contains('collapsed');
        setSettingsSectionCollapsed(header, !isCollapsed);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setSettingsSectionCollapsed(header, true);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setSettingsSectionCollapsed(header, false);
        return;
      }

      const currentIndex = settingsHeaders.indexOf(header);
      if (currentIndex === -1) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIndex = (currentIndex + 1) % settingsHeaders.length;
        settingsHeaders[nextIndex].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const nextIndex = (currentIndex - 1 + settingsHeaders.length) % settingsHeaders.length;
        settingsHeaders[nextIndex].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        settingsHeaders[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        settingsHeaders[settingsHeaders.length - 1].focus();
      }
    });
  });

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
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        settings.consoleCollapsed = toggleConsoleCollapse(true);
        void persistSettings();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        settings.consoleCollapsed = toggleConsoleCollapse(false);
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
  if (themeSelect) {
    themeSelect.addEventListener('change', (e) => {
      settings.theme = e.target.value;
      applyTheme(settings.theme);
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

      if (audioFormatContainer) {
        if (e.target.checked) {
          audioFormatContainer.classList.add('visible');
        } else {
          audioFormatContainer.classList.remove('visible');
        }
      }

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
          convertToggle.parentElement.title = 'Disabled when Audio-only mode is enabled';
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

  if (audioFormatSelect) {
    audioFormatSelect.addEventListener('change', (e) => {
      settings.audioFormat = e.target.value;
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
    showUpdateChannelBtn.setAttribute(
      'aria-expanded',
      String(updateChannelContainer.classList.contains('visible'))
    );
    showUpdateChannelBtn.addEventListener('click', () => {
      const isVisible = updateChannelContainer.classList.contains('visible');
      updateChannelContainer.classList.toggle('visible', !isVisible);
      showUpdateChannelBtn.setAttribute('aria-expanded', String(!isVisible));
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

  if (exportSettingsBtn) {
    exportSettingsBtn.addEventListener('click', async () => {
      try {
        const result = await window.api.exportSettings();
        if (result && result.ok) {
          showToast('Settings exported successfully.', { type: 'success' });
        } else if (result && !result.ok) {
          showToast(result.error?.message || 'Export failed.', { type: 'error' });
        }
      } catch {
        showToast('An unexpected error occurred during export.', { type: 'error' });
      }
    });
  }

  if (importSettingsBtn) {
    importSettingsBtn.addEventListener('click', async () => {
      showModal({
        title: 'Import Settings',
        message:
          'Importing settings will overwrite your current settings and restart ROSI. Continue?',
        buttons: [
          { label: 'Cancel' },
          {
            label: 'Import',
            action: async () => {
              try {
                const result = await window.api.importSettings();
                if (result && result.ok) {
                  showToast('Settings imported. Restarting...', { type: 'success' });
                  setTimeout(() => window.api.restartApp(), 1000);
                } else {
                  showToast(result?.error?.message || 'Import failed or was cancelled.', {
                    type: 'error',
                  });
                }
              } catch {
                showToast('An unexpected error occurred during import.', { type: 'error' });
              }
            },
          },
        ],
      });
    });
  }

  if (viewStatsBtn) {
    viewStatsBtn.addEventListener('click', async () => {
      try {
        const stats = await window.api.getStats();
        const formatList = Object.entries(stats.formatCounts || {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([fmt, count]) => `${fmt}: ${count}`)
          .join(', ');
        showModal({
          title: 'Download Statistics',
          message: [
            `Total downloads: ${stats.totalDownloads}`,
            `Successful: ${stats.successfulDownloads}`,
            `Failed: ${stats.failedDownloads}`,
            `Cancelled: ${stats.cancelledDownloads}`,
            `Total downloaded: ${formatBytes(stats.totalBytesDownloaded)}`,
            formatList ? `Top formats: ${formatList}` : '',
            stats.lastDownloadAt
              ? `Last download: ${formatRelativeTime(stats.lastDownloadAt)}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
          buttons: [
            {
              label: 'Reset Stats',
              action: async () => {
                await window.api.resetStats();
                showToast('Statistics reset.', { type: 'info' });
              },
            },
            { label: 'Close' },
          ],
        });
      } catch (e) {
        showToast('Could not load statistics.', { type: 'error' });
      }
    });
  }

  function renderQueue(queue) {
    if (queueModule && typeof queueModule.renderQueue === 'function') {
      queueModule.renderQueue(
        queue,
        { queueList, queueSection, queueCount },
        {
          escapeHtml,
          removeFromQueue: async (id) => {
            const endQueueAction = beginQueueAction();
            try {
              const result = await window.api.removeFromQueue(id);
              if (!result || !result.ok) {
                const message = result?.error?.message || 'Could not remove the queue item.';
                setQueueStatusMessage(message);
                showToast(message, {
                  type: 'error',
                });
              } else {
                announceQueueAction('Removed item from the queue.');
              }
            } catch {
              const message = 'Could not remove the queue item.';
              setQueueStatusMessage(message);
              showToast(message, { type: 'error' });
            } finally {
              endQueueAction();
            }
          },
        }
      );
    }
  }

  let queueStatusTimer = null;
  function setQueueStatusMessage(message) {
    if (!queueStatusMessage) return;
    if (queueStatusTimer) {
      clearTimeout(queueStatusTimer);
      queueStatusTimer = null;
    }

    const nextMessage =
      typeof message === 'string' ? message.trim() : message == null ? '' : String(message).trim();
    queueStatusMessage.textContent = '';

    if (!nextMessage) return;

    queueStatusTimer = setTimeout(() => {
      queueStatusMessage.textContent = nextMessage;
      queueStatusTimer = null;
    }, 0);
  }

  function queueMessageForCount(count, singular, plural) {
    return count === 1 ? singular : plural.replace('{count}', String(count));
  }

  function announceQueueAction(message, toastType = 'info') {
    setQueueStatusMessage(message);
    showToast(message, { type: toastType });
  }

  const queueActionButtons = [addToQueueBtn, startQueueBtn, clearQueueBtn, cancelQueueBtn].filter(
    (button) => button instanceof HTMLButtonElement
  );
  let queueActionLocks = 0;
  function syncQueueActionBusyState() {
    const isBusy = queueActionLocks > 0;
    queueActionButtons.forEach((button) => {
      button.disabled = isBusy;
      button.setAttribute('aria-busy', String(isBusy));
    });
    if (queueUrlInput) {
      queueUrlInput.disabled = isBusy;
    }
    if (queueSection) {
      queueSection.setAttribute('aria-busy', String(isBusy));
    }
  }
  function beginQueueAction() {
    queueActionLocks += 1;
    syncQueueActionBusyState();
    return () => {
      queueActionLocks = Math.max(0, queueActionLocks - 1);
      syncQueueActionBusyState();
    };
  }
  syncQueueActionBusyState();

  if (addToQueueBtn && queueUrlInput) {
    addToQueueBtn.addEventListener('click', async () => {
      if (queueActionLocks > 0) return;
      const raw = queueUrlInput.value.trim();
      if (!raw) {
        const message = 'Enter one or more URLs, one per line.';
        setQueueStatusMessage(message);
        showToast(message, { type: 'warning' });
        return;
      }
      const endQueueAction = beginQueueAction();
      try {
        const urls = raw
          .split(/\r?\n+/)
          .map((u) => u.trim())
          .filter((u) => u.length > 0);
        const result = await window.api.addToQueue(urls);
        if (result && result.ok) {
          queueUrlInput.value = '';
          const message = queueMessageForCount(
            result.data.added,
            'Added 1 URL to the queue.',
            'Added {count} URLs to the queue.'
          );
          announceQueueAction(message, 'success');
        } else {
          const message = result?.error?.message || 'Could not add URLs to the queue.';
          setQueueStatusMessage(message);
          showToast(message, { type: 'error' });
        }
      } catch {
        const message = 'Could not add URLs to the queue.';
        setQueueStatusMessage(message);
        showToast(message, { type: 'error' });
      } finally {
        endQueueAction();
      }
    });
  }

  if (startQueueBtn) {
    startQueueBtn.addEventListener('click', async () => {
      if (queueActionLocks > 0) return;
      const endQueueAction = beginQueueAction();
      try {
        const result = await window.api.startQueue();
        if (result && result.ok) {
          announceQueueAction('Queue started processing.');
        } else {
          const message = result?.error?.message || 'Could not start the queue.';
          setQueueStatusMessage(message);
          showToast(message, { type: 'warning' });
        }
      } catch {
        const message = 'Could not start the queue.';
        setQueueStatusMessage(message);
        showToast(message, { type: 'warning' });
      } finally {
        endQueueAction();
      }
    });
  }

  if (clearQueueBtn) {
    clearQueueBtn.addEventListener('click', async () => {
      if (queueActionLocks > 0) return;
      const endQueueAction = beginQueueAction();
      try {
        const result = await window.api.clearQueue();
        if (result && result.ok) {
          announceQueueAction('Queue cleared.');
        } else {
          const message = result?.error?.message || 'Could not clear the queue.';
          setQueueStatusMessage(message);
          showToast(message, { type: 'error' });
        }
      } catch {
        const message = 'Could not clear the queue.';
        setQueueStatusMessage(message);
        showToast(message, { type: 'error' });
      } finally {
        endQueueAction();
      }
    });
  }

  if (cancelQueueBtn) {
    cancelQueueBtn.addEventListener('click', async () => {
      if (queueActionLocks > 0) return;
      const endQueueAction = beginQueueAction();
      try {
        const result = await window.api.cancelQueue();
        if (result && result.ok) {
          announceQueueAction('Queue cancelled.');
        } else {
          const message = result?.error?.message || 'Could not cancel the queue.';
          setQueueStatusMessage(message);
          showToast(message, { type: 'error' });
        }
      } catch {
        const message = 'Could not cancel the queue.';
        setQueueStatusMessage(message);
        showToast(message, { type: 'error' });
      } finally {
        endQueueAction();
      }
    });
  }

  if (fetchFormatsBtn) {
    fetchFormatsBtn.onclick = fetchFormats;
  }

  // download button
  if (downloadBtn) {
    downloadBtn._originalClick = async function () {
      try {
        if (isDownloading) return;

        isDownloading = true;
        hasUrlValidationIntent = true;
        syncPrimaryActionState();

        const urlInput = document.getElementById('url');
        const url = urlInput ? urlInput.value : null;
        if (!url || url.trim() === '') {
          isDownloading = false;
          syncPrimaryActionState();
          showToast('Please enter a video URL.', { type: 'warning' });
          return;
        }

        // Validate URL format
        if (!isValidUrl(url.trim())) {
          isDownloading = false;
          syncPrimaryActionState();
          showToast('Please enter a valid URL starting with http:// or https://', {
            type: 'warning',
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
          syncPrimaryActionState();
          showToast('Please check resolutions and select video/audio formats first.', {
            type: 'warning',
          });
          return;
        }

        let savePath;
        try {
          savePath = await window.api.selectDownloadLocation();
        } catch (dialogError) {
          logError('Error opening save dialog', dialogError);
          isDownloading = false;
          syncPrimaryActionState();
          showToast('Could not open the save location dialog. Please try again.', {
            type: 'error',
          });
          return;
        }

        if (!savePath) {
          isDownloading = false;
          syncPrimaryActionState();
          if (outputEl) outputEl.textContent = '⚠️ Download cancelled: No save location selected.';
          return;
        }
        if (outputEl) outputEl.textContent = '';
        downloadAbort = () => {
          isDownloading = false;
          setButtonLoading(downloadBtn, false);
          syncPrimaryActionState();
        };
        setButtonLoading(downloadBtn, true, () => {
          window.api.cancelDownload();
          downloadAbort();
          hideProgressBar();
        });

        const videoFormat = settings.advancedOptions ? videoSelect.value : null;
        const audioFormat = settings.advancedOptions ? audioSelect.value : null;
        const convertFormat = settings.convertEnabled ? convertFormatSelect.value : null;
        const needsMerge = settings.bestQuality || (videoFormat && audioFormat);
        const needsConvert = settings.convertEnabled && convertFormat;
        configureProgressPhases(!!needsMerge, !!needsConvert);
        showProgressBar('Starting download...');
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
          syncPrimaryActionState();
          hideProgressBar();
          showToast(
            startResult?.error?.message || 'Download request was rejected before starting.',
            { type: 'error' }
          );
        }
      } catch (downloadError) {
        logError('Unexpected error starting download', downloadError);
        isDownloading = false;
        setButtonLoading(downloadBtn, false);
        syncPrimaryActionState();
        hideProgressBar();
        showToast('An unexpected error occurred while starting the download. Please try again.', {
          type: 'error',
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
        setProgressPhase('merge');
        setProgressIndeterminate('Merging video and audio...');
      } else if (message.includes('Converting') || message.includes('[ffmpeg]')) {
        setProgressPhase('convert');
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
        syncPrimaryActionState();

        const normalizedStatus = String(statusMessage || '').toLowerCase();
        const isCancelled = normalizedStatus.includes('cancel');
        const isSuccess =
          !isCancelled && (statusMessage.includes('✅') || normalizedStatus.includes('complete'));

        if (isSuccess) {
          updateProgressBar(100, 'Complete!', '');
          showProgressComplete();

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

        const filename = lastDownloadedFilePath
          ? lastDownloadedFilePath.split(/[/\\]/).pop()
          : 'Unknown file';
        addHistoryEntry({
          filename,
          path: lastDownloadedFilePath,
          status: isSuccess ? 'success' : isCancelled ? 'cancelled' : 'failed',
        });

        const restoreDefaultDownloadButton = () => {
          setButtonLoading(downloadBtn, false);
          syncPrimaryActionState();
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

  ipcCleanupFunctions.push(
    window.api.onQueueUpdate((queue) => {
      renderQueue(queue);
    })
  );

  let closePreparationInProgress = false;
  ipcCleanupFunctions.push(
    window.api.onPrepareForClose(async () => {
      if (closePreparationInProgress) {
        return;
      }
      closePreparationInProgress = true;
      try {
        await persistSettings(true, true);
      } catch {}
      window.api.notifySettingsFlushed();
    })
  );

  window.api
    .getQueue()
    .then((queue) => renderQueue(queue))
    .catch(() => {});

  window.addEventListener('beforeunload', () => {
    ipcCleanupFunctions.forEach((cleanup) => {
      if (typeof cleanup === 'function') {
        try {
          cleanup();
        } catch (e) {}
      }
    });
    cleanupUpdaterListeners();
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
      logError('Startup update check failed', e);
    }
  }

  if (settings.firstLaunch) {
    launchSetupWizard(settings, applyTheme, persistSettings, () => {
      checkDenoInstallation(settings);
      checkUpdatesOnStartup();
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
