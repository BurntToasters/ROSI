function logError(context: string, error?: unknown) {
  const msg = error instanceof Error ? error.message : String(error || '');
  const text = msg ? `${context}: ${msg}` : context;
  if (window.api && typeof window.api.logError === 'function') {
    window.api.logError(text);
  }
}

interface RosiSettings {
  settingsVersion: number;
  theme: 'system' | 'light' | 'dark' | 'purple';
  showConsoleOutput: boolean;
  consoleCollapsed: boolean;
  queueCollapsed: boolean;
  downloadProfilesEnabled: boolean;
  downloadMode: 'best-video' | 'audio' | 'custom';
  askDownloadLocation: boolean;
  advancedOptions: boolean;
  audioOnly: boolean;
  audioFormat: string;
  convertEnabled: boolean;
  convertFormat: string;
  keepOriginalAfterConvert: boolean;
  firstLaunch: boolean;
  hookBrowser: boolean;
  browserChoice: string;
  animateBackground: boolean;
  flatUi: boolean;
  notifications: boolean;
  denoReminderDismissed: boolean;
  gpuAcceleration: boolean;
  gpuType: 'auto' | 'nvidia' | 'amd' | 'intel';
  bestQuality: boolean;
  ffmpegPath: string;
  downloadFolder: string;
  hideSupportModal: boolean;
  checkUpdatesOnStartup: boolean;
  updateChannel: 'auto' | 'stable' | 'beta';
  writeSubtitles: boolean;
  subtitleLangs: string;
  embedThumbnail: boolean;
  embedMetadata: boolean;
  sponsorblockRemove: boolean;
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

function getModifierKeyName() {
  if (uiModule && typeof uiModule.getModifierKeyName === 'function') {
    return uiModule.getModifierKeyName();
  }
  return isMac() ? 'Cmd' : 'Ctrl';
}

function isValidUrl(string: string) {
  if (uiModule && typeof uiModule.isValidUrl === 'function') {
    return uiModule.isValidUrl(string);
  }
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

type ThemeName = 'system' | 'light' | 'dark' | 'purple';

let systemThemeMediaQuery: MediaQueryList | null = null;
let systemThemeMediaQueryHandler: (() => void) | null = null;
let appliedTheme: ThemeName = 'dark';
let themePreference: ThemeName = 'system';

function resolveAppliedTheme(preference: ThemeName): ThemeName {
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

function syncLicensesTheme(theme: ThemeName) {
  try {
    const frame = document.getElementById('licenses-frame') as HTMLIFrameElement | null;
    const root = frame?.contentDocument?.documentElement;
    if (root) {
      root.dataset.theme = theme;
    }
  } catch {
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

function setMainContentInert(isInert: boolean) {
  const mainContent =
    document.getElementById('main-content') || document.querySelector('.main-content');
  if (!(mainContent instanceof HTMLElement)) return;
  if ('inert' in mainContent) {
    (mainContent as HTMLElement & { inert: boolean }).inert = isInert;
  }
  if (isInert) {
    mainContent.setAttribute('aria-hidden', 'true');
  } else {
    mainContent.removeAttribute('aria-hidden');
  }
}

function applyTheme(preference: string) {
  themePreference =
    preference === 'light' || preference === 'dark' || preference === 'purple'
      ? (preference as ThemeName)
      : 'system';
  ensureSystemThemeListener();
  appliedTheme = resolveAppliedTheme(themePreference);
  document.documentElement.dataset.theme = appliedTheme;
  syncLicensesTheme(appliedTheme);
  try {
    localStorage.setItem('rosi-theme', themePreference);
  } catch {
    /* ignore */
  }
  return appliedTheme;
}

function updateConsoleVisibility(show: boolean) {
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

type ToastType = 'warning' | 'error' | 'success' | 'info';

function showToast(
  message: unknown,
  { type = 'info', duration = 4000 }: { type?: ToastType; duration?: number } = {}
) {
  if (uiModule && typeof uiModule.showToast === 'function') {
    uiModule.showToast(message, { type, duration });
  }
}

function appendConsoleOutput(outputEl: HTMLElement | null, text: string) {
  if (uiModule && typeof uiModule.appendConsoleOutput === 'function') {
    uiModule.appendConsoleOutput(outputEl, text);
  }
}

function setConsoleCollapsed(collapsed: boolean) {
  const consoleSection = document.getElementById('console-section');
  const consoleToggleBtn = document.getElementById('consoleToggleBtn');
  const output = document.getElementById('output');
  if (!consoleSection) return false;
  consoleSection.classList.toggle('collapsed', !!collapsed);
  const isCollapsed = consoleSection.classList.contains('collapsed');
  if (consoleToggleBtn) consoleToggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
  if (output) output.setAttribute('aria-hidden', String(isCollapsed));
  return isCollapsed;
}

// Toggle console collapsed state
function toggleConsoleCollapse(forceCollapsed?: boolean) {
  const consoleSection = document.getElementById('console-section');
  if (!consoleSection) return false;
  if (typeof forceCollapsed === 'boolean') {
    return setConsoleCollapsed(forceCollapsed);
  }
  return setConsoleCollapsed(!consoleSection.classList.contains('collapsed'));
}

function setButtonLoading(
  button: HTMLButtonElement | null,
  isLoading: boolean,
  onCancel?: (() => void) | null,
  cancelLabel?: string
) {
  if (uiModule && typeof uiModule.setButtonLoading === 'function') {
    uiModule.setButtonLoading(button, isLoading, onCancel, cancelLabel);
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
function toggleAdvancedUI(show: boolean) {
  if (uiModule && typeof uiModule.toggleAdvancedUI === 'function') {
    uiModule.toggleAdvancedUI(show);
  }
}

// Modal queue system
interface ModalButton {
  label: string;
  action?: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}
interface ModalData {
  title: string;
  message: unknown;
  buttons?: ModalButton[];
  priority?: boolean;
  busy?: boolean;
  extra?: (() => Node | null) | Node | null;
}

const modalQueue: ModalData[] = [];
let isModalActive = false;
let currentModalData: ModalData | null = null;
let previousFocus: Element | null = null;
let modalTrapHandler: ((e: KeyboardEvent) => void) | null = null;
let modalFocusinHandler: ((e: FocusEvent) => void) | null = null;
let licensesFocusinHandler: ((e: FocusEvent) => void) | null = null;

function getFocusableElements(container: unknown): HTMLElement[] {
  if (!(container instanceof HTMLElement)) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
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

function focusFirstElement(container: unknown) {
  const focusable = getFocusableElements(container);
  const first = focusable[0];
  if (first && typeof first.focus === 'function') {
    first.focus();
    return true;
  }
  return false;
}

function showModal({ title, message, buttons = [], priority = false, extra = null }: ModalData) {
  const modalData: ModalData = { title, message, buttons, priority, extra };
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
  currentModalData = modalQueue.shift() ?? null;
  if (!currentModalData) {
    isModalActive = false;
    return;
  }
  const { title, message, buttons = [], extra } = currentModalData;

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
        extraEl.appendChild(extraNode as Node);
      }
    }
  }
  btnContainer.innerHTML = '';

  modal.setAttribute('tabindex', '-1');
  modal.setAttribute('aria-hidden', 'false');
  if (currentModalData.busy) {
    modal.setAttribute('aria-busy', 'true');
  } else {
    modal.removeAttribute('aria-busy');
  }
  modal.classList.add('showing');
  modal.classList.add('active');
  setMainContentInert(true);

  void modal.offsetWidth;
  requestAnimationFrame(() => {
    modal.classList.remove('showing');
  });

  buttons.forEach(({ label, action, primary, danger, disabled }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    if (primary) btn.classList.add('modal-btn-primary');
    if (danger) btn.classList.add('modal-btn-danger');
    if (disabled) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
    }
    if (!disabled) {
      btn.onclick = () => {
        hideModal(modal, action);
      };
    }
    btnContainer.appendChild(btn);
  });

  previousFocus = document.activeElement;

  if (modalTrapHandler) {
    modal.removeEventListener('keydown', modalTrapHandler);
  }
  if (modalFocusinHandler) {
    document.removeEventListener('focusin', modalFocusinHandler, true);
  }
  modalTrapHandler = (e: KeyboardEvent) => {
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
        last?.focus();
      }
    } else {
      if (!active || active === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };
  modal.addEventListener('keydown', modalTrapHandler);
  modalFocusinHandler = (e: FocusEvent) => {
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

function hideModal(modal: HTMLElement, action: (() => void) | null | undefined) {
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
    modal.setAttribute('aria-hidden', 'true');
    modal.removeAttribute('aria-busy');
    isModalActive = false;
    if (typeof action === 'function') action();
    if (!isModalActive) {
      displayNextModal();
    }
    if (!isModalActive) {
      setMainContentInert(false);
    }
    if (!isModalActive && previousFocus instanceof HTMLElement) {
      previousFocus.focus();
      previousFocus = null;
    }
  }, 200);
}

function showKeyboardShortcuts() {
  const modKey = getModifierKeyName();
  showModal({
    title: 'Keyboard Shortcuts',
    message: `${modKey}+D - Restart application\n${modKey}+F - Focus URL input field\n${modKey}+, - Open settings\n${modKey}+Enter - Submit queue URLs (when focused)`,
    buttons: [{ label: 'OK', primary: true }],
  });
}

let isFetchingFormats = false;
let fetchFormatsAbort: (() => void) | null = null;
async function fetchFormats() {
  const btn = document.getElementById('fetchFormatsBtn') as HTMLButtonElement | null;
  const urlInput = document.getElementById('url') as HTMLInputElement | null;
  const videoUrl = urlInput ? urlInput.value : null;

  try {
    if (!btn || !videoUrl || videoUrl.trim() === '') {
      showModal({
        title: 'Input Error',
        message: 'Please enter a video URL first.',
        buttons: [{ label: 'OK', primary: true }],
      });
      return;
    }

    // Validate URL format
    if (!isValidUrl(videoUrl.trim())) {
      showModal({
        title: 'Invalid URL',
        message: 'Please enter a valid URL starting with http:// or https://',
        buttons: [{ label: 'OK', primary: true }],
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
    setButtonLoading(
      btn,
      true,
      () => {
        if (window.api.cancelFormats) {
          window.api.cancelFormats();
        }
        fetchFormatsAbort?.();
      },
      'Cancel format check'
    );
    const videoSelect = document.getElementById('videoFormat') as HTMLSelectElement | null;
    const audioSelect = document.getElementById('audioFormat') as HTMLSelectElement | null;
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
          buttons: [{ label: 'OK', primary: true }],
        });
        return;
      }

      const lines = formatResult.data.split('\n');
      if (videoSelect) videoSelect.innerHTML = '<option value="">Select Video Format</option>';
      if (audioSelect) audioSelect.innerHTML = '<option value="">Select Audio Format</option>';
      let videoFormatsFound = 0,
        audioFormatsFound = 0;
      const FORMAT_ID = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+\S/;
      lines.forEach((line) => {
        const trimmed = line.trim();
        const idMatch = trimmed.match(FORMAT_ID);
        if (!idMatch) return;
        const formatId = idMatch[1];
        if (!formatId || formatId.toLowerCase() === 'id') return;
        if (/storyboard|images? only|mhtml/i.test(line)) return;
        const option = document.createElement('option');
        option.value = formatId;
        const labelText = trimmed;
        const resolutionMatch = labelText.match(/(\d{3,4}x\d{3,4}|\d{3,4}p)/);
        const fpsMatch = labelText.match(/@?\s*(\d+)\s*fps/i);
        const sizeMatch = labelText.match(/(\d+(\.\d+)?(MiB|GiB|KiB))/);
        const codecMatch = line.match(
          /(avc1|vp9|vp09|av01|h264|h265|hevc|opus|mp4a|aac|vorbis|flac)/i
        );
        let cleanLabel = `ID: ${formatId}`;
        if (resolutionMatch) cleanLabel += ` ${resolutionMatch[0]}`;
        if (fpsMatch) cleanLabel += ` ${fpsMatch[1]}fps`;
        if (codecMatch) cleanLabel += ` (${codecMatch[0]})`;
        if (sizeMatch) cleanLabel += ` ~${sizeMatch[0]}`;
        option.text = cleanLabel;
        option.title = trimmed;
        const isVideoOnly = /video only/i.test(line);
        const isAudioOnly = /audio only/i.test(line);
        const isVideo = /video/.test(line.toLowerCase()) && !isAudioOnly;
        const isAudio = /audio/.test(line.toLowerCase()) && !isVideoOnly;
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
      });
      if (videoFormatsFound === 0 && videoSelect)
        videoSelect.innerHTML = '<option value="">No video formats found</option>';
      if (audioFormatsFound === 0 && audioSelect)
        audioSelect.innerHTML = '<option value="">No audio formats found</option>';
    } catch (e) {
      const errorMessage = typeof e === 'string' ? e : (e as Error)?.message || 'Unknown error';
      if (videoSelect) videoSelect.innerHTML = '<option value="">Error loading formats</option>';
      if (audioSelect) audioSelect.innerHTML = '<option value="">Error loading formats</option>';
      showModal({
        title: 'Format Fetch Failed',
        message: `Could not retrieve formats.\nError: ${errorMessage}`,
        buttons: [{ label: 'OK', primary: true }],
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
      buttons: [{ label: 'OK', primary: true }],
    });
  }
}

function formatDuration(totalSeconds: number | null | undefined) {
  if (typeof totalSeconds !== 'number' || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return '';
  }
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function formatViewCount(count: number | null | undefined) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return '';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M views`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K views`;
  return `${count} views`;
}

interface RosiVideoInfo {
  title: string;
  uploader: string | null;
  durationSeconds: number | null;
  thumbnail: string | null;
  ext: string | null;
  viewCount: number | null;
  isPlaylist: boolean;
  playlistCount: number | null;
  webpageUrl: string | null;
}

let isFetchingPreview = false;
let previewAbort: (() => void) | null = null;

function hideVideoPreview() {
  const card = document.getElementById('preview-card');
  const thumb = document.getElementById('preview-thumb') as HTMLImageElement | null;
  if (card) card.classList.remove('visible', 'loading', 'is-playlist');
  if (thumb) {
    thumb.removeAttribute('src');
    thumb.alt = '';
  }
}

function renderVideoPreview(info: RosiVideoInfo) {
  const card = document.getElementById('preview-card');
  const thumb = document.getElementById('preview-thumb') as HTMLImageElement | null;
  const titleEl = document.getElementById('preview-title');
  const subEl = document.getElementById('preview-sub');
  const durationEl = document.getElementById('preview-duration');
  if (!card || !titleEl || !subEl) return;

  card.classList.remove('loading');
  card.classList.add('visible');
  card.classList.toggle('is-playlist', !!info.isPlaylist);

  titleEl.textContent = info.title || 'Untitled';

  const subParts: string[] = [];
  if (info.uploader) subParts.push(info.uploader);
  if (info.isPlaylist && info.playlistCount) {
    subParts.push(`${info.playlistCount} items`);
  } else {
    const views = formatViewCount(info.viewCount);
    if (views) subParts.push(views);
  }
  subEl.textContent = subParts.join(' • ');

  if (durationEl) {
    const duration = formatDuration(info.durationSeconds);
    durationEl.textContent = duration;
    durationEl.style.display = duration ? 'inline-block' : 'none';
  }

  if (thumb) {
    const wrap = thumb.parentElement as HTMLElement | null;
    if (info.thumbnail) {
      thumb.src = info.thumbnail;
      thumb.alt = info.title || 'Video thumbnail';
      if (wrap) wrap.style.display = '';
    } else {
      thumb.removeAttribute('src');
      thumb.alt = '';
      if (wrap) wrap.style.display = 'none';
    }
  }
}

// handles download button logic
let isDownloading = false;
let downloadAbort: (() => void) | null = null;
let lastDownloadedFilePath: string | null = null;

function setProgressPhase(phase: string) {
  const phases = document.querySelectorAll<HTMLElement>('.progress-phase');
  const phaseOrder = ['download', 'merge', 'convert'];
  const phaseIndex = phaseOrder.indexOf(phase);

  phases.forEach((el) => {
    const elPhase = el.dataset.phase ?? '';
    const elIndex = phaseOrder.indexOf(elPhase);
    el.classList.remove('active', 'completed');
    el.removeAttribute('aria-current');
    if (elIndex < phaseIndex) {
      el.classList.add('completed');
    } else if (elIndex === phaseIndex) {
      el.classList.add('active');
      el.setAttribute('aria-current', 'step');
    }
  });
}

function configureProgressPhases(showMerge: boolean, showConvert: boolean) {
  const mergePhase = document.querySelector<HTMLElement>('.progress-phase[data-phase="merge"]');
  const convertPhase = document.querySelector<HTMLElement>('.progress-phase[data-phase="convert"]');
  const connectors = document.querySelectorAll<HTMLElement>('.progress-phase-connector');

  const setPhaseVisibility = (phaseEl: HTMLElement | null, visible: boolean) => {
    if (!phaseEl) return;
    phaseEl.style.display = visible ? 'flex' : 'none';
    phaseEl.setAttribute('aria-hidden', String(!visible));
  };

  setPhaseVisibility(mergePhase, showMerge);
  setPhaseVisibility(convertPhase, showConvert);

  if (connectors[0]) {
    connectors[0].style.display = showMerge ? 'block' : 'none';
    connectors[0].setAttribute('aria-hidden', String(!showMerge));
  }
  if (connectors[1]) {
    const connectorVisible = showMerge && showConvert ? true : showConvert;
    connectors[1].style.display = connectorVisible ? 'block' : 'none';
    connectors[1].setAttribute('aria-hidden', String(!connectorVisible));
  }
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
  const bar = document.getElementById('progress-bar') as HTMLElement | null;
  const barWrapper = document.getElementById('progress-bar-wrapper');
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
  if (barWrapper) {
    barWrapper.setAttribute('aria-valuenow', '0');
    barWrapper.removeAttribute('aria-valuetext');
  }
  if (details) details.textContent = '';
  hideProgressComplete();
  setProgressPhase('download');
}

function updateProgressBar(
  percent: number,
  statusText: string | null = null,
  detailsText: string | null = null
) {
  const statusEl = document.getElementById('progress-status');
  const percentEl = document.getElementById('progress-percent');
  const bar = document.getElementById('progress-bar') as HTMLElement | null;
  const barWrapper = document.getElementById('progress-bar-wrapper');
  const details = document.getElementById('progress-details');

  const clamped = Math.max(0, Math.min(100, percent));
  const rounded = Math.round(clamped);
  if (percentEl) percentEl.textContent = `${rounded}%`;
  if (bar) {
    bar.style.width = `${clamped}%`;
    bar.classList.remove('indeterminate');
  }
  if (barWrapper) {
    barWrapper.setAttribute('aria-valuenow', String(rounded));
    barWrapper.removeAttribute('aria-valuetext');
  }
  if (statusText && statusEl) statusEl.textContent = statusText;
  if (detailsText && details) details.textContent = detailsText;
}

function setProgressIndeterminate(status = 'Processing...') {
  const statusEl = document.getElementById('progress-status');
  const percentEl = document.getElementById('progress-percent');
  const bar = document.getElementById('progress-bar');
  const barWrapper = document.getElementById('progress-bar-wrapper');
  const details = document.getElementById('progress-details');

  if (statusEl) statusEl.textContent = status;
  if (percentEl) percentEl.textContent = '';
  if (bar) bar.classList.add('indeterminate');
  if (barWrapper) {
    barWrapper.removeAttribute('aria-valuenow');
    barWrapper.setAttribute('aria-valuetext', status);
  }
  if (details) details.textContent = '';
}

function hideProgressBar() {
  const container = document.getElementById('progress-container');
  const bar = document.getElementById('progress-bar');
  const barWrapper = document.getElementById('progress-bar-wrapper');
  if (container) {
    container.classList.remove('visible');
  }
  if (bar) bar.classList.remove('active-glow');
  if (barWrapper) {
    barWrapper.setAttribute('aria-valuenow', '0');
  }
  hideProgressComplete();
}

function parseYtdlpProgress(message: string) {
  if (downloadsModule && typeof downloadsModule.parseYtdlpProgress === 'function') {
    return downloadsModule.parseYtdlpProgress(message);
  }
  return null;
}

function formatBytes(bytes: number) {
  if (downloadsModule && typeof downloadsModule.formatBytes === 'function') {
    return downloadsModule.formatBytes(bytes);
  }
  return String(bytes);
}

const HISTORY_KEY = 'rosi-download-history';
const HISTORY_MAX = 20;

interface HistoryEntry {
  filename: string;
  path: string | null;
  timestamp: number;
  status: 'success' | 'failed' | 'cancelled';
}

function loadHistory(): HistoryEntry[] {
  try {
    const data = localStorage.getItem(HISTORY_KEY);
    return data ? (JSON.parse(data) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(history: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (e) {
    if (
      e instanceof DOMException &&
      (e.name === 'QuotaExceededError' || (e as DOMException).code === 22)
    ) {
      history.length = Math.max(1, Math.floor(history.length / 2));
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
      } catch {
        /* give up */
      }
    }
  }
}

function addHistoryEntry(entry: {
  filename: string;
  path: string | null;
  status: HistoryEntry['status'];
}) {
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

function formatRelativeTime(timestamp: number) {
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

function escapeHtml(str: string) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
    item.setAttribute('role', 'listitem');

    const statusLabel =
      entry.status === 'success'
        ? 'Completed'
        : entry.status === 'cancelled'
          ? 'Cancelled'
          : 'Failed';

    const info = document.createElement('div');
    info.className = 'history-item-info';
    const filenameEl = document.createElement('span');
    filenameEl.className = 'history-filename';
    filenameEl.title = entry.filename;
    filenameEl.textContent = entry.filename;
    const timeEl = document.createElement('span');
    timeEl.className = 'history-time';
    timeEl.textContent = formatRelativeTime(entry.timestamp);
    info.append(filenameEl, timeEl);

    const actions = document.createElement('div');
    actions.className = 'history-item-actions';
    const statusEl = document.createElement('span');
    statusEl.className = `history-status ${entry.status}`;
    statusEl.textContent = statusLabel;
    actions.appendChild(statusEl);

    if (entry.status === 'success' && entry.path) {
      const filePath = entry.path;
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'history-open-btn';
      openBtn.setAttribute('aria-label', `Open file location for ${entry.filename}`);
      openBtn.textContent = 'Open';
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void window.api.openFileLocation(filePath);
      });
      actions.appendChild(openBtn);
    }

    item.append(info, actions);

    fragment.appendChild(item);
  });
  listEl.appendChild(fragment);
}

function clearHistory() {
  saveHistory([]);
  renderHistory();
}

let isManualUpdateCheck = false;
let updateCheckTimeout: ReturnType<typeof setTimeout> | null = null;
let updateCheckBtnRef: HTMLButtonElement | null = null;

function finishManualUpdateCheck() {
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
          primary: true,
          action: () => window.api.openExternal('ms-windows-store://pdp/?ProductId=9N0BQSTFL4SV'),
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

let updaterCleanupFunctions: Array<() => void> = [];

function showUpdateBanner() {
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

function hideUpdateBanner() {
  const banner = document.getElementById('update-banner');
  if (banner) {
    banner.classList.remove('active');
    banner.setAttribute('aria-busy', 'false');
  }
}

function setupAutoUpdater() {
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
          break;

        case 'available': {
          const version = data.version ?? '';
          const isBetaUpdate =
            data.isBeta ||
            (updatesModule && typeof updatesModule.isPrereleaseVersion === 'function'
              ? updatesModule.isPrereleaseVersion(version)
              : /-(beta|alpha|rc)/i.test(version));
          showModal({
            title: isBetaUpdate ? 'Beta Update Available!' : 'Update Available!',
            message: isBetaUpdate
              ? `A new beta version (v${data.version}) of ROSI is available!\n\nWould you like to download and install it?`
              : `A new version (v${data.version}) of ROSI is available!\n\nWould you like to download and install it?`,
            priority: wasManualCheck,
            buttons: [
              {
                label: 'Download & Install',
                primary: true,
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
          hideUpdateBanner();
          if (wasManualCheck) {
            showModal({
              title: 'Update Error',
              message: `An error occurred while checking for updates:\n${data.message}`,
              buttons: [{ label: 'OK', primary: true }],
              priority: true,
            });
          }
          break;

        case 'cancelled':
          hideUpdateBanner();
          showModal({
            title: 'Download Cancelled',
            message: 'The update download was cancelled.',
            buttons: [{ label: 'OK', primary: true }],
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
                primary: true,
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
      } catch {
        /* ignore */
      }
    }
  });
  updaterCleanupFunctions = [];
}

let licensesPreviousFocus: Element | null = null;
let licensesTrapHandler: ((e: KeyboardEvent) => void) | null = null;

function showLicenses() {
  const licensesOverlay = document.getElementById('licenses-overlay');
  if (licensesOverlay) {
    licensesPreviousFocus = document.activeElement;
    licensesOverlay.classList.add('active');
    licensesOverlay.setAttribute('aria-hidden', 'false');
    setMainContentInert(true);
    syncLicensesTheme(appliedTheme);
    document.body.classList.add('licenses-open');
    document.body.style.overflow = 'hidden';

    const closeBtn = licensesOverlay.querySelector<HTMLElement>('#close-licenses');
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

    licensesTrapHandler = (e: KeyboardEvent) => {
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
          last?.focus();
        }
      } else if (!active || active === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    licensesOverlay.addEventListener('keydown', licensesTrapHandler);
    if (licensesFocusinHandler) {
      document.removeEventListener('focusin', licensesFocusinHandler, true);
    }
    licensesFocusinHandler = (e: FocusEvent) => {
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
    licensesOverlay.setAttribute('aria-hidden', 'true');
    const wizardOverlay = document.getElementById('setup-wizard');
    const wizardActive = wizardOverlay?.classList.contains('active');
    if (!isModalActive && !wizardActive) {
      setMainContentInert(false);
    }
    setTimeout(() => {
      document.body.style.overflow = '';
      document.body.classList.remove('licenses-open');
    }, 300);
    if (licensesPreviousFocus instanceof HTMLElement) {
      licensesPreviousFocus.focus();
      licensesPreviousFocus = null;
    }
  }
}

function updateBackgroundAnimation(animate: boolean) {
  const body = document.body;
  if (animate) {
    body.classList.add('animate-bg');
  } else {
    body.classList.remove('animate-bg');
  }
}

// check for Deno
async function checkDenoInstallation(settings: RosiSettings, persist: () => void) {
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
            primary: true,
            action: async () => {
              showModal({
                title: 'Installing Deno...',
                message: 'Please wait while Deno is being installed. This may take a moment.',
                buttons: [{ label: 'Installing...', primary: true, disabled: true }],
                priority: true,
                busy: true,
              });

              try {
                const result = await window.api.installDeno();
                if (result && result.cancelled) {
                  showModal({
                    title: 'Installation Cancelled',
                    message: 'Deno installation was cancelled.',
                    buttons: [{ label: 'OK', primary: true }],
                    priority: true,
                  });
                  return;
                }
                showModal({
                  title: 'Installation Complete',
                  message:
                    'Deno has been successfully installed!\nRestarting the app can help pick up the updated environment.',
                  buttons: [
                    { label: 'Restart Now', primary: true, action: () => window.api.restartApp() },
                    { label: 'Later' },
                  ],
                  priority: true,
                });
              } catch (error) {
                const errMsg =
                  (error as { error?: string })?.error ||
                  (error instanceof Error ? error.message : 'Unknown error');
                showModal({
                  title: 'Installation Failed',
                  message: `Failed to install Deno automatically.\n\nPlease install manually:\nMac/Linux: curl -fsSL https://deno.land/install.sh | sh\nWindows: irm https://deno.land/install.ps1 | iex\n\nError: ${errMsg}`,
                  buttons: [
                    {
                      label: 'Open Deno Website',
                      primary: true,
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
              persist();
            },
          },
        ],
      });
    }
  } catch (error) {
    logError('Error checking Deno installation', error);
  }
}

function launchSetupWizard(
  settings: RosiSettings,
  applyThemeFn: (preference: string) => void,
  persistSettingsFn: (silent?: boolean, immediate?: boolean) => Promise<boolean> | void,
  onComplete: () => void
) {
  const TOTAL_STEPS = 4;
  let currentStep = 0;

  const overlay = document.getElementById('setup-wizard');
  const progressBar = document.getElementById('wizard-progress-bar') as HTMLElement | null;
  const backBtn = document.getElementById('wizard-back') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('wizard-next');
  const dotsContainer = document.getElementById('wizard-dots');
  const steps = overlay
    ? overlay.querySelectorAll<HTMLElement>('.wizard-step')
    : ([] as unknown as NodeListOf<HTMLElement>);

  if (!overlay || !progressBar || !backBtn || !nextBtn || !dotsContainer || steps.length === 0) {
    settings.firstLaunch = false;
    void persistSettingsFn();
    onComplete();
    return;
  }

  const overlayEl = overlay;
  const progressBarEl = progressBar;
  const wizardProgress = overlayEl.querySelector<HTMLElement>('.wizard-progress');
  const stepAnnounce = document.getElementById('wizard-step-announce');
  const backBtnEl = backBtn;
  const nextBtnEl = nextBtn;
  const dotsContainerEl = dotsContainer;

  // Build dots
  dotsContainerEl.innerHTML = '';
  for (let i = 0; i < TOTAL_STEPS; i++) {
    const dot = document.createElement('span');
    dot.className = 'wizard-dot' + (i === 0 ? ' active' : '');
    dotsContainerEl.appendChild(dot);
  }

  // Live theme preview
  const themeRadios = overlayEl.querySelectorAll<HTMLInputElement>('input[name="wizard-theme"]');
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

    progressBarEl.style.width = ((currentStep + 1) / TOTAL_STEPS) * 100 + '%';
    if (wizardProgress) {
      wizardProgress.setAttribute('aria-valuenow', String(currentStep + 1));
    }
    if (stepAnnounce) {
      stepAnnounce.textContent = `Step ${currentStep + 1} of ${TOTAL_STEPS}`;
    }

    const dots = dotsContainerEl.querySelectorAll('.wizard-dot');
    dots.forEach((dot, i) => {
      dot.classList.toggle('active', i === currentStep);
    });

    if (currentStep === 0) {
      backBtnEl.setAttribute('hidden', '');
      backBtnEl.disabled = true;
      backBtnEl.setAttribute('tabindex', '-1');
    } else {
      backBtnEl.removeAttribute('hidden');
      backBtnEl.disabled = false;
      backBtnEl.removeAttribute('tabindex');
    }

    // Next button text
    if (currentStep === 0) {
      nextBtnEl.textContent = 'Get Started';
    } else if (currentStep === TOTAL_STEPS - 1) {
      nextBtnEl.textContent = 'Finish';
    } else {
      nextBtnEl.textContent = 'Next';
    }
  }

  function gatherSettings() {
    // Theme
    const selectedTheme = overlayEl.querySelector<HTMLInputElement>(
      'input[name="wizard-theme"]:checked'
    );
    if (selectedTheme) {
      settings.theme = selectedTheme.value as RosiSettings['theme'];
      applyThemeFn(settings.theme);
    }

    // Download prefs
    const notifications = document.getElementById(
      'wizard-notifications'
    ) as HTMLInputElement | null;
    const autoUpdates = document.getElementById('wizard-auto-updates') as HTMLInputElement | null;

    if (notifications) settings.notifications = notifications.checked;
    if (autoUpdates) settings.checkUpdatesOnStartup = autoUpdates.checked;
  }

  function finalizeWizard() {
    gatherSettings();
    settings.firstLaunch = false;
    void persistSettingsFn(false, true);

    const themeSelect = document.getElementById('themeSelect') as HTMLSelectElement | null;
    if (themeSelect) themeSelect.value = settings.theme || 'system';
    const notificationsToggle = document.getElementById(
      'notificationsToggle'
    ) as HTMLInputElement | null;
    if (notificationsToggle) notificationsToggle.checked = settings.notifications;
    const checkUpdatesToggle = document.getElementById(
      'checkUpdatesOnStartupToggle'
    ) as HTMLInputElement | null;
    if (checkUpdatesToggle) checkUpdatesToggle.checked = settings.checkUpdatesOnStartup;

    onComplete();
  }

  nextBtn.addEventListener('click', () => {
    if (currentStep < TOTAL_STEPS - 1) {
      currentStep++;
      updateUI();
    } else {
      closeWizard();
    }
  });

  backBtnEl.addEventListener('click', () => {
    if (currentStep > 0) {
      currentStep--;
      updateUI();
    }
  });

  // Set initial selected theme radio to match current settings
  const initialTheme = settings.theme || 'system';
  const matchingRadio = overlayEl.querySelector<HTMLInputElement>(
    `input[name="wizard-theme"][value="${initialTheme}"]`
  );
  if (matchingRadio) matchingRadio.checked = true;

  let wizardPreviousFocus: Element | null = null;
  let wizardTrapHandler: ((e: KeyboardEvent) => void) | null = null;
  let wizardFocusinHandler: ((e: FocusEvent) => void) | null = null;

  function closeWizard() {
    if (wizardTrapHandler) {
      overlayEl.removeEventListener('keydown', wizardTrapHandler);
      wizardTrapHandler = null;
    }
    if (wizardFocusinHandler) {
      document.removeEventListener('focusin', wizardFocusinHandler, true);
      wizardFocusinHandler = null;
    }
    overlayEl.classList.remove('active');
    overlayEl.setAttribute('aria-hidden', 'true');
    setMainContentInert(false);
    if (wizardPreviousFocus instanceof HTMLElement) {
      wizardPreviousFocus.focus();
      wizardPreviousFocus = null;
    }
    finalizeWizard();
  }

  wizardPreviousFocus = document.activeElement;
  overlayEl.setAttribute('aria-hidden', 'false');
  setMainContentInert(true);

  wizardTrapHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      showModal({
        title: 'Skip setup?',
        message: 'Skip setup and use the standard ROSI download settings?',
        buttons: [
          { label: 'Keep setting up', primary: true },
          { label: 'Skip setup', action: closeWizard },
        ],
      });
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = getFocusableElements(overlayEl);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (!active || active === first) {
        e.preventDefault();
        last?.focus();
      }
    } else if (!active || active === last) {
      e.preventDefault();
      first?.focus();
    }
  };
  overlayEl.addEventListener('keydown', wizardTrapHandler);

  wizardFocusinHandler = (e: FocusEvent) => {
    if (!overlayEl.classList.contains('active')) return;
    const target = e.target;
    if (target instanceof Node && overlayEl.contains(target)) return;
    if (!focusFirstElement(overlayEl) && typeof overlayEl.focus === 'function') {
      overlayEl.focus();
    }
  };
  document.addEventListener('focusin', wizardFocusinHandler, true);

  updateUI();
  overlayEl.classList.add('active');
  requestAnimationFrame(() => {
    if (!focusFirstElement(overlayEl)) {
      nextBtnEl.focus();
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  let settings: RosiSettings;
  try {
    settings = (await window.api.getSettings()) as RosiSettings;
  } catch (error) {
    logError('Failed to load settings', error);
    settings = {
      settingsVersion: 5,
      theme: 'system',
      showConsoleOutput: false,
      consoleCollapsed: false,
      queueCollapsed: false,
      downloadProfilesEnabled: false,
      downloadMode: 'best-video',
      askDownloadLocation: false,
      advancedOptions: false,
      audioFormat: 'mp3',
      convertEnabled: false,
      convertFormat: 'mp4',
      keepOriginalAfterConvert: true,
      firstLaunch: true,
      hookBrowser: false,
      browserChoice: 'Chrome',
      animateBackground: true,
      flatUi: localStorage.getItem('rosi-flat-ui') === 'true',
      notifications: true,
      denoReminderDismissed: false,
      gpuAcceleration: false,
      gpuType: 'auto',
      bestQuality: false,
      ffmpegPath: '',
      downloadFolder: '',
      hideSupportModal: false,
      checkUpdatesOnStartup: true,
      updateChannel: 'auto',
      audioOnly: false,
      writeSubtitles: false,
      subtitleLangs: 'en',
      embedThumbnail: false,
      embedMetadata: false,
      sponsorblockRemove: false,
    };
    showModal({
      title: 'Settings Error',
      message: 'Could not load settings. Using defaults.',
      buttons: [{ label: 'OK', primary: true }],
    });
  }
  applyTheme(settings.theme ?? 'system');

  try {
    const version = await window.api.getAppVersion();
    const versionLink = document.getElementById('versionLink');
    const betaBadge = document.getElementById('betaBadge');
    if (versionLink && version) {
      versionLink.textContent = `v${version}`;
      versionLink.setAttribute(
        'aria-label',
        `View release notes for v${version} (opens externally)`
      );
      versionLink.addEventListener('click', (event) => {
        event.preventDefault();
        void window.api.openExternal(
          `https://github.com/BurntToasters/ROSI/releases/tag/v${version}`
        );
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
    const versionLink = document.getElementById('versionLink');
    if (versionLink) {
      versionLink.textContent = 'Version unknown';
      versionLink.setAttribute('aria-label', 'View release notes (opens externally)');
    }
  }

  if (window.api.getChannel() !== 'msstore') {
    try {
      setupAutoUpdater();
    } catch (e) {
      logError('Failed to setup auto-updater', e);
    }
  }
  let settingsSaveErrorShownAt = 0;

  function showSettingsSaveError(message: string) {
    const now = Date.now();
    if (now - settingsSaveErrorShownAt < 5000) {
      return;
    }
    settingsSaveErrorShownAt = now;
    showModal({
      title: 'Settings Save Failed',
      message,
      buttons: [{ label: 'OK', primary: true }],
      priority: true,
    });
  }

  let persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function persistSettings(silent = false, immediate = false): Promise<boolean> {
    if (persistDebounceTimer) clearTimeout(persistDebounceTimer);
    const executeSave = async (resolve: (value: boolean) => void) => {
      try {
        const result = await window.api.saveSettings(
          settings as unknown as Parameters<typeof window.api.saveSettings>[0]
        );
        if (!result || result.ok !== true) {
          if (!silent) {
            const message = result?.error?.message || 'Could not save settings.';
            showSettingsSaveError(`${message}\nChanges may not persist after restart.`);
          }
          resolve(false);
          return;
        }
        settings = result.data as RosiSettings;
        resolve(true);
      } catch {
        if (!silent) {
          showSettingsSaveError('Could not save settings due to an unexpected error.');
        }
        resolve(false);
      }
    };
    return new Promise<boolean>((resolve) => {
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

  const byId = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

  const consoleToggle = byId<HTMLInputElement>('consoleToggle');
  const keepOriginalToggle = byId<HTMLInputElement>('keepOriginalToggle');
  const hookBrowserToggle = byId<HTMLInputElement>('hookBrowserToggle');
  const browserChoiceContainer = byId('browserChoiceContainer');
  const browserChoiceSelect = byId<HTMLSelectElement>('browserChoice');
  const convertToggle = byId<HTMLInputElement>('convertToggle');
  const convertFormatContainer = byId('convertFormatContainer');
  const convertFormatSelect = byId<HTMLSelectElement>('convertFormat');
  const keepOriginalLabel = byId('keepOriginalLabel');
  const gpuAccelerationToggle = byId<HTMLInputElement>('gpuAccelerationToggle');
  const gpuAccelerationLabel = byId('gpuAccelerationLabel');
  const gpuTypeContainer = byId('gpuTypeContainer');
  const gpuTypeSelect = byId<HTMLSelectElement>('gpuType');
  const ffmpegPathInput = byId<HTMLInputElement>('ffmpegPathInput');
  const outputEl = byId('output');
  const resetSettingsBtn = byId<HTMLButtonElement>('resetSettings');
  const fetchFormatsBtn = byId<HTMLButtonElement>('fetchFormatsBtn');
  const downloadBtn = byId<HTMLButtonElement>('downloadBtn');
  const checkUpdateBtn = byId<HTMLButtonElement>('checkUpdateBtn');
  const animateBackgroundToggle = byId<HTMLInputElement>('animateBackgroundToggle');
  const themeSelect = byId<HTMLSelectElement>('themeSelect');
  const flatUiToggle = byId<HTMLInputElement>('flatUiToggle');
  const downloadProfilesToggle = byId<HTMLInputElement>('downloadProfilesToggle');
  const downloadProfilesComposer = byId('downloadProfilesComposer');
  const profileBestVideoBtn = byId<HTMLButtonElement>('profileBestVideoBtn');
  const profileAudioBtn = byId<HTMLButtonElement>('profileAudioBtn');
  const profileCustomBtn = byId<HTMLButtonElement>('profileCustomBtn');
  const profileAudioFormatContainer = byId('profileAudioFormatContainer');
  const profileAudioFormatSelect = byId<HTMLSelectElement>('profileAudioFormatSelect');
  const downloadFolderSummary = byId('downloadFolderSummary');
  const changeDownloadFolderBtn = byId<HTMLButtonElement>('changeDownloadFolderBtn');
  const askDownloadLocationToggle = byId<HTMLInputElement>('askDownloadLocationToggle');
  const downloadOutputSummary = byId('downloadOutputSummary');
  const notificationsToggle = byId<HTMLInputElement>('notificationsToggle');
  const checkUpdatesOnStartupToggle = byId<HTMLInputElement>('checkUpdatesOnStartupToggle');
  const checkUpdatesOnStartupLabel = byId('checkUpdatesOnStartupLabel');
  const updateChannelSelect = byId<HTMLSelectElement>('updateChannelSelect');
  const updateChannelContainer = byId('updateChannelContainer');
  const showUpdateChannelBtn = byId<HTMLButtonElement>('showUpdateChannelBtn');

  const settingsBtn = byId('settingsBtn');
  const closeSidebarBtn = byId('closeSidebar');
  const sidebarOverlay = byId('sidebar-overlay');
  const shortcutsBtn = byId('shortcutsBtn');
  const clearUrlBtn = byId<HTMLButtonElement>('clearUrl');
  const pasteUrlBtn = byId<HTMLButtonElement>('pasteUrl');
  const clearConsoleBtn = byId<HTMLButtonElement>('clearConsole');
  const urlInput = byId<HTMLInputElement>('url');
  const urlValidationMessage = byId('urlValidationMessage');
  const urlInputContainer = document.querySelector<HTMLElement>('.url-input-container');
  const downloadCard = document.querySelector<HTMLElement>('.download-card');
  const previewBtn = byId<HTMLButtonElement>('previewBtn');
  const previewCloseBtn = byId<HTMLButtonElement>('previewClose');
  const historyToggle = byId<HTMLButtonElement>('historyToggle');
  const clearHistoryBtn = byId<HTMLButtonElement>('clearHistory');
  const browserCookiesHelp = byId('browserCookiesHelp');
  const helpLink = byId('helpLink');
  const supportLink = byId('supportLink');
  const websiteLink = byId('websiteLink');
  const supportProjectLink = byId('supportProjectLink');
  const licensesLink = byId('licensesLink');
  const licensesFrame = byId('licenses-frame');
  const exportSettingsBtn = byId<HTMLButtonElement>('exportSettingsBtn');
  const importSettingsBtn = byId<HTMLButtonElement>('importSettingsBtn');
  const viewStatsBtn = byId<HTMLButtonElement>('viewStatsBtn');
  const embedMetadataToggle = byId<HTMLInputElement>('embedMetadataToggle');
  const embedThumbnailToggle = byId<HTMLInputElement>('embedThumbnailToggle');
  const sponsorblockToggle = byId<HTMLInputElement>('sponsorblockToggle');
  const sponsorblockHelp = byId('sponsorblockHelp');
  const writeSubtitlesToggle = byId<HTMLInputElement>('writeSubtitlesToggle');
  const subtitleLangsContainer = byId('subtitleLangsContainer');
  const subtitleLangsInput = byId<HTMLInputElement>('subtitleLangsInput');
  const queueToggleBtn = byId<HTMLButtonElement>('queueToggleBtn');
  const queueBody = byId<HTMLElement>('queueBody');
  const queueUrlInput = byId<HTMLTextAreaElement>('queueUrlInput');
  const addToQueueBtn = byId<HTMLButtonElement>('addToQueueBtn');
  const startQueueBtn = byId<HTMLButtonElement>('startQueueBtn');
  const clearQueueBtn = byId<HTMLButtonElement>('clearQueueBtn');
  const cancelQueueBtn = byId<HTMLButtonElement>('cancelQueueBtn');
  const queueStatusMessage = byId('queueStatusMessage');
  const queueList = byId('queueList');
  const queueCount = byId('queueCount');
  const queueSection =
    (queueModule && typeof queueModule.resolveQueueSectionElement === 'function'
      ? queueModule.resolveQueueSectionElement(document)
      : null) || byId('queueSection');

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
    const browserWindowsHint = document.getElementById('browserWindowsHint');
    if (browserWindowsHint) browserWindowsHint.classList.remove('hidden');
  }

  function setQueueCollapsed(collapsed: boolean) {
    if (!queueSection) return false;
    queueSection.classList.toggle('collapsed', !!collapsed);
    const isCollapsed = queueSection.classList.contains('collapsed');
    if (queueToggleBtn) {
      queueToggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
    }
    if (queueBody instanceof HTMLElement) {
      queueBody.setAttribute('aria-hidden', String(isCollapsed));
      queueBody.inert = isCollapsed;
    }
    return isCollapsed;
  }

  function toggleQueueCollapsed(collapsed?: boolean) {
    if (typeof collapsed === 'boolean') {
      return setQueueCollapsed(collapsed);
    }
    if (!queueSection) return false;
    return setQueueCollapsed(!queueSection.classList.contains('collapsed'));
  }

  // update UI from settings
  const updateUIFromSettings = () => {
    if (
      !consoleToggle ||
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
    setQueueCollapsed(!!settings.queueCollapsed);

    toggleAdvancedUI(!!settings.downloadProfilesEnabled && settings.downloadMode === 'custom');

    // Update additional options
    if (animateBackgroundToggle) {
      animateBackgroundToggle.checked = settings.animateBackground ?? true;
      updateBackgroundAnimation(settings.animateBackground ?? true);
    }
    if (flatUiToggle) {
      const isFlat =
        typeof settings.flatUi === 'boolean'
          ? settings.flatUi
          : localStorage.getItem('rosi-flat-ui') === 'true';
      settings.flatUi = isFlat;
      flatUiToggle.checked = isFlat;
      if (isFlat) {
        document.documentElement.dataset.flatUi = 'true';
        localStorage.setItem('rosi-flat-ui', 'true');
      } else {
        delete document.documentElement.dataset.flatUi;
        localStorage.setItem('rosi-flat-ui', 'false');
      }
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
    if (downloadProfilesToggle) {
      downloadProfilesToggle.checked = !!settings.downloadProfilesEnabled;
    }
    if (downloadProfilesComposer) {
      downloadProfilesComposer.classList.toggle('hidden', !settings.downloadProfilesEnabled);
    }
    const profileButtons = [
      ['best-video', profileBestVideoBtn],
      ['audio', profileAudioBtn],
      ['custom', profileCustomBtn],
    ] as const;
    profileButtons.forEach(([mode, button]) => {
      if (!button) return;
      const isSelected = settings.downloadProfilesEnabled && settings.downloadMode === mode;
      button.classList.toggle('selected', isSelected);
      button.setAttribute('aria-pressed', String(isSelected));
    });
    if (profileAudioFormatSelect) {
      profileAudioFormatSelect.value = settings.audioFormat ?? 'mp3';
    }
    if (profileAudioFormatContainer) {
      profileAudioFormatContainer.classList.toggle(
        'hidden',
        !settings.downloadProfilesEnabled || settings.downloadMode !== 'audio'
      );
    }
    if (askDownloadLocationToggle) {
      askDownloadLocationToggle.checked = !!settings.askDownloadLocation;
    }
    if (downloadFolderSummary) {
      const folder = settings.downloadFolder?.trim();
      downloadFolderSummary.textContent = folder || 'Choose a folder';
      downloadFolderSummary.title = folder || 'Choose a folder before downloading';
    }
    if (downloadOutputSummary) {
      if (!settings.downloadProfilesEnabled) {
        downloadOutputSummary.textContent = 'Standard compatible video';
      } else if (settings.downloadMode === 'best-video') {
        downloadOutputSummary.textContent = 'Highest available video and audio quality';
      } else if (settings.downloadMode === 'audio') {
        downloadOutputSummary.textContent = `${(settings.audioFormat || 'mp3').toUpperCase()} audio`;
      } else {
        downloadOutputSummary.textContent = 'Custom video and audio formats';
      }
    }
    // disable convert when audio-only is enabled
    if (convertToggle) {
      convertToggle.disabled = settings.audioOnly ?? false;
      if (settings.audioOnly) {
        convertToggle.parentElement!.classList.add('disabled');
        convertToggle.parentElement!.title = 'Disabled when Audio-only mode is enabled';
      } else {
        convertToggle.parentElement!.classList.remove('disabled');
        convertToggle.parentElement!.title = '';
      }
    }
    if (notificationsToggle) {
      notificationsToggle.checked = settings.notifications ?? true;
    }

    if (embedMetadataToggle) {
      embedMetadataToggle.checked = settings.embedMetadata ?? false;
    }
    if (embedThumbnailToggle) {
      embedThumbnailToggle.checked = settings.embedThumbnail ?? false;
    }
    if (sponsorblockToggle) {
      sponsorblockToggle.checked = settings.sponsorblockRemove ?? false;
    }
    if (writeSubtitlesToggle) {
      writeSubtitlesToggle.checked = settings.writeSubtitles ?? false;
    }
    if (subtitleLangsInput) {
      subtitleLangsInput.value = settings.subtitleLangs ?? 'en';
    }
    if (subtitleLangsContainer) {
      subtitleLangsContainer.classList.toggle('visible', !!settings.writeSubtitles);
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

  const applyDownloadProfile = (mode: RosiSettings['downloadMode']) => {
    settings.downloadMode = mode;
    settings.bestQuality = mode === 'best-video';
    settings.audioOnly = mode === 'audio';
    settings.advancedOptions = mode === 'custom';
    if (mode === 'audio') settings.convertEnabled = false;
  };

  const setDownloadProfilesEnabled = (enabled: boolean) => {
    settings.downloadProfilesEnabled = enabled;
    if (enabled) {
      applyDownloadProfile(settings.downloadMode || 'best-video');
    } else {
      settings.bestQuality = false;
      settings.audioOnly = false;
      settings.advancedOptions = false;
    }
    updateUIFromSettings();
  };

  try {
    updateUIFromSettings();
  } catch (e) {
    logError('Failed to update UI from settings', e);
  }

  function maybeShowSupportModal() {
    if (settings.hideSupportModal || settings.firstLaunch) return;
    if (isModalActive || modalQueue.length > 0) {
      setTimeout(maybeShowSupportModal, 1500);
      return;
    }
    showModal({
      title: 'Support This Project?',
      message:
        'Would you like to support the development of ROSI?\nYour help keeps this project alive!',
      buttons: [
        {
          label: '❤️ Yes Support!',
          primary: true,
          action: () => {
            void window.api.openExternal('https://rosie.run/support');
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

  const bindExternalLink = (element: HTMLElement | null, url: string) => {
    if (settingsModule && typeof settingsModule.bindExternalLink === 'function') {
      settingsModule.bindExternalLink(element, url, window.api.openExternal);
      return;
    }
    if (element) {
      element.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void window.api.openExternal(url);
      });
    }
  };

  bindExternalLink(browserCookiesHelp, 'https://help.rosie.run/rosi/en-us/about-browser-cookies');
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
  let lastPreviewUrl: string | null = null;
  function syncPrimaryActionState() {
    const hasInput = !!urlInput;
    const hasPrimaryButton = !!downloadBtn;
    if (!hasInput || !hasPrimaryButton || !urlInput || !downloadBtn) return;
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

    if (previewBtn && !previewBtn.classList.contains('loading')) {
      previewBtn.disabled = !validUrl;
    }
    if (trimmed !== lastPreviewUrl) {
      hideVideoPreview();
      lastPreviewUrl = null;
    }
  }

  function updateUrlButtons() {
    const hasValue = !!(urlInput && urlInput.value.length > 0);
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
    urlInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const trimmed = urlInput.value.trim();
      if (trimmed && isValidUrl(trimmed) && downloadBtn && !downloadBtn.disabled) {
        downloadBtn.click();
      } else {
        hasUrlValidationIntent = true;
        syncPrimaryActionState();
      }
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
      const dragEvent = e as DragEvent;
      dragEvent.preventDefault();
      downloadCard.classList.remove('drag-over');
      const dt = dragEvent.dataTransfer;
      const text = dt ? dt.getData('text/uri-list') || dt.getData('text/plain') : '';
      if (text && isValidUrl(text.trim()) && urlInput) {
        urlInput.value = text.trim();
        urlInput.dispatchEvent(new Event('input'));
        hasUrlValidationIntent = true;
        syncPrimaryActionState();
      } else if (text) {
        showToast('Dropped content is not a valid URL.', { type: 'warning' });
      }
    });
  }

  async function runVideoPreview() {
    if (!urlInput || !previewBtn) return;
    const url = urlInput.value.trim();
    if (!url || !isValidUrl(url)) {
      showToast('Enter a valid URL first.', { type: 'warning' });
      return;
    }
    if (isFetchingPreview) return;
    isFetchingPreview = true;

    const card = document.getElementById('preview-card');
    if (card) card.classList.add('visible', 'loading');

    let wasCancelled = false;
    previewAbort = () => {
      wasCancelled = true;
      isFetchingPreview = false;
      setButtonLoading(previewBtn, false);
    };
    setButtonLoading(
      previewBtn,
      true,
      () => {
        if (window.api.cancelVideoInfo) window.api.cancelVideoInfo();
        previewAbort?.();
        hideVideoPreview();
      },
      'Cancel preview'
    );

    try {
      const result = await window.api.getVideoInfo(url);
      if (wasCancelled) return;
      if (!result || result.ok !== true) {
        const message = result?.error?.message || 'Could not load preview.';
        if (typeof message === 'string' && message.toLowerCase().includes('cancel')) return;
        hideVideoPreview();
        showToast(`Could not load preview. ${message}`, { type: 'error' });
        return;
      }
      lastPreviewUrl = url;
      renderVideoPreview(result.data as RosiVideoInfo);
    } catch (e) {
      if (!wasCancelled) {
        hideVideoPreview();
        showToast('Could not load preview.', { type: 'error' });
        logError('Video preview failed', e);
      }
    } finally {
      if (!wasCancelled) {
        isFetchingPreview = false;
        setButtonLoading(previewBtn, false);
      }
    }
  }

  if (previewBtn) {
    previewBtn._originalClick = runVideoPreview;
    previewBtn.onclick = runVideoPreview;
  }
  if (previewCloseBtn) {
    previewCloseBtn.addEventListener('click', () => {
      if (window.api.cancelVideoInfo) window.api.cancelVideoInfo();
      hideVideoPreview();
      lastPreviewUrl = null;
    });
  }

  renderHistory();

  if (historyToggle) {
    const historySection = document.getElementById('download-history');
    const historyList = document.getElementById('history-list');
    const setHistoryCollapsed = (collapsed: boolean) => {
      if (!historySection) return false;
      historySection.classList.toggle('collapsed', !!collapsed);
      const isCollapsed = historySection.classList.contains('collapsed');
      historyToggle.setAttribute('aria-expanded', String(!isCollapsed));
      if (historyList instanceof HTMLElement) {
        historyList.setAttribute('aria-hidden', String(isCollapsed));
        historyList.inert = isCollapsed;
      }
      return isCollapsed;
    };
    const toggleHistoryCollapsed = () => {
      if (!historySection) return false;
      return setHistoryCollapsed(!historySection.classList.contains('collapsed'));
    };
    if (historySection) {
      setHistoryCollapsed(historySection.classList.contains('collapsed'));
    }

    historyToggle.addEventListener('click', () => {
      toggleHistoryCollapsed();
    });
    historyToggle.addEventListener('keydown', (e) => {
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
            danger: true,
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

  const settingsHeaders = Array.from(
    document.querySelectorAll<HTMLElement>('.settings-section-header')
  ).filter((header) => header instanceof HTMLElement);
  const setSettingsSectionCollapsed = (header: HTMLElement, collapsed: boolean) => {
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
      if (sectionBody instanceof HTMLElement) {
        sectionBody.inert = isCollapsed;
      }
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
        settingsHeaders[nextIndex]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const nextIndex = (currentIndex - 1 + settingsHeaders.length) % settingsHeaders.length;
        settingsHeaders[nextIndex]?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        settingsHeaders[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        settingsHeaders[settingsHeaders.length - 1]?.focus();
      }
    });
  });

  if (consoleToggle)
    consoleToggle.addEventListener('change', (e) => {
      settings.showConsoleOutput = (e.target as HTMLInputElement).checked;
      void persistSettings();
      updateConsoleVisibility(settings.showConsoleOutput);
    });

  const consoleToggleBtn = document.getElementById('consoleToggleBtn');
  if (consoleToggleBtn) {
    consoleToggleBtn.addEventListener('click', () => {
      const isCollapsed = toggleConsoleCollapse();
      settings.consoleCollapsed = isCollapsed;
      void persistSettings();
    });
    consoleToggleBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
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

  if (downloadProfilesToggle) {
    downloadProfilesToggle.addEventListener('change', (e) => {
      setDownloadProfilesEnabled((e.target as HTMLInputElement).checked);
      void persistSettings(true, true);
    });
  }
  const profileButtons = [
    ['best-video', profileBestVideoBtn],
    ['audio', profileAudioBtn],
    ['custom', profileCustomBtn],
  ] as const;
  profileButtons.forEach(([mode, button]) => {
    button?.addEventListener('click', () => {
      if (!settings.downloadProfilesEnabled) return;
      applyDownloadProfile(mode);
      updateUIFromSettings();
      void persistSettings(true, true);
    });
  });
  if (profileAudioFormatSelect) {
    profileAudioFormatSelect.addEventListener('change', (e) => {
      settings.audioFormat = (e.target as HTMLSelectElement).value;
      updateUIFromSettings();
      void persistSettings(true, true);
    });
  }
  if (askDownloadLocationToggle) {
    askDownloadLocationToggle.addEventListener('change', (e) => {
      settings.askDownloadLocation = (e.target as HTMLInputElement).checked;
      void persistSettings();
    });
  }
  if (changeDownloadFolderBtn) {
    changeDownloadFolderBtn.addEventListener('click', async () => {
      const savePath = await window.api.selectDownloadLocation();
      if (!savePath) return;
      settings.downloadFolder = savePath;
      updateUIFromSettings();
      void persistSettings(true, true);
    });
  }
  if (keepOriginalToggle)
    keepOriginalToggle.addEventListener('change', (e) => {
      if (!(e.target as HTMLInputElement).disabled) {
        settings.keepOriginalAfterConvert = (e.target as HTMLInputElement).checked;
        void persistSettings();
      } else {
        e.preventDefault();
      }
    });
  if (hookBrowserToggle)
    hookBrowserToggle.addEventListener('change', (e) => {
      settings.hookBrowser = (e.target as HTMLInputElement).checked;
      if (browserChoiceContainer) {
        if ((e.target as HTMLInputElement).checked) {
          browserChoiceContainer.classList.add('visible');
        } else {
          browserChoiceContainer.classList.remove('visible');
        }
      }
      void persistSettings();
    });
  if (browserChoiceSelect)
    browserChoiceSelect.addEventListener('change', (e) => {
      settings.browserChoice = (e.target as HTMLInputElement | HTMLSelectElement).value;
      void persistSettings();
    });
  if (convertToggle)
    convertToggle.addEventListener('change', (e) => {
      settings.convertEnabled = (e.target as HTMLInputElement).checked;
      if ((e.target as HTMLInputElement).checked) {
        convertFormatContainer?.classList.add('visible');
        keepOriginalLabel?.classList.add('visible');
        if (gpuAccelerationLabel) gpuAccelerationLabel.classList.add('visible');
      } else {
        convertFormatContainer?.classList.remove('visible');
        keepOriginalLabel?.classList.remove('visible');
        if (gpuAccelerationLabel) gpuAccelerationLabel.classList.remove('visible');
        if (gpuTypeContainer) gpuTypeContainer.classList.remove('visible');
      }
      if (!(e.target as HTMLInputElement).checked) {
        settings.keepOriginalAfterConvert = true;
        if (keepOriginalToggle) keepOriginalToggle.checked = true;
      }
      void persistSettings();
    });
  if (convertFormatSelect)
    convertFormatSelect.addEventListener('change', (e) => {
      settings.convertFormat = (e.target as HTMLInputElement | HTMLSelectElement).value;
      void persistSettings();
    });
  if (ffmpegPathInput) {
    ffmpegPathInput.addEventListener('input', (e) => {
      settings.ffmpegPath = (e.target as HTMLInputElement | HTMLSelectElement).value;
    });
    ffmpegPathInput.addEventListener('change', (e) => {
      settings.ffmpegPath = (e.target as HTMLInputElement | HTMLSelectElement).value;
      void persistSettings();
    });
  }
  // GPU acceleration toggle
  if (gpuAccelerationToggle) {
    gpuAccelerationToggle.addEventListener('change', (e) => {
      settings.gpuAcceleration = (e.target as HTMLInputElement).checked;
      if (gpuTypeContainer) {
        if ((e.target as HTMLInputElement).checked) {
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
      settings.gpuType = (e.target as HTMLSelectElement).value as RosiSettings['gpuType'];
      void persistSettings();
    });
  }
  // Animate Background toggle
  if (animateBackgroundToggle) {
    animateBackgroundToggle.addEventListener('change', (e) => {
      settings.animateBackground = (e.target as HTMLInputElement).checked;
      updateBackgroundAnimation((e.target as HTMLInputElement).checked);
      void persistSettings();
    });
  }
  if (themeSelect) {
    themeSelect.addEventListener('change', (e) => {
      settings.theme = (e.target as HTMLSelectElement).value as RosiSettings['theme'];
      applyTheme(settings.theme);
      void persistSettings();
    });
  }
  if (flatUiToggle) {
    flatUiToggle.addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      settings.flatUi = checked;
      if (checked) {
        document.documentElement.dataset.flatUi = 'true';
        localStorage.setItem('rosi-flat-ui', 'true');
      } else {
        delete document.documentElement.dataset.flatUi;
        localStorage.setItem('rosi-flat-ui', 'false');
      }
      void persistSettings();
    });
  }

  // Notifications toggle
  if (notificationsToggle) {
    notificationsToggle.addEventListener('change', (e) => {
      settings.notifications = (e.target as HTMLInputElement).checked;
      void persistSettings();
    });
  }

  if (embedMetadataToggle) {
    embedMetadataToggle.addEventListener('change', (e) => {
      settings.embedMetadata = (e.target as HTMLInputElement).checked;
      void persistSettings();
    });
  }

  if (embedThumbnailToggle) {
    embedThumbnailToggle.addEventListener('change', (e) => {
      settings.embedThumbnail = (e.target as HTMLInputElement).checked;
      void persistSettings();
    });
  }

  if (sponsorblockToggle) {
    sponsorblockToggle.addEventListener('change', (e) => {
      settings.sponsorblockRemove = (e.target as HTMLInputElement).checked;
      void persistSettings();
    });
  }

  bindExternalLink(sponsorblockHelp, 'https://sponsor.ajay.app/');

  const SUBTITLE_LANGS_RE = /^[A-Za-z0-9.*-]+(,[A-Za-z0-9.*-]+)*$/;
  if (writeSubtitlesToggle) {
    writeSubtitlesToggle.addEventListener('change', (e) => {
      settings.writeSubtitles = (e.target as HTMLInputElement).checked;
      if (subtitleLangsContainer) {
        subtitleLangsContainer.classList.toggle('visible', (e.target as HTMLInputElement).checked);
      }
      void persistSettings();
    });
  }

  const subtitleLangsError = document.getElementById('subtitleLangsError');
  if (subtitleLangsInput) {
    const showSubtitleLangsError = (message: string) => {
      subtitleLangsInput.setAttribute('aria-invalid', 'true');
      if (subtitleLangsError) {
        subtitleLangsError.textContent = message;
      } else {
        showToast(message, { type: 'warning' });
      }
    };
    const clearSubtitleLangsError = () => {
      subtitleLangsInput.removeAttribute('aria-invalid');
      if (subtitleLangsError) subtitleLangsError.textContent = '';
    };
    const commitSubtitleLangs = () => {
      const raw = subtitleLangsInput.value.trim();
      if (!raw || !SUBTITLE_LANGS_RE.test(raw) || raw.length > 256) {
        showSubtitleLangsError(
          'Enter comma-separated language codes (for example en,es) or use all.'
        );
        return;
      }
      clearSubtitleLangsError();
      settings.subtitleLangs = raw;
      void persistSettings();
    };
    subtitleLangsInput.addEventListener('change', commitSubtitleLangs);
    subtitleLangsInput.addEventListener('blur', commitSubtitleLangs);
    subtitleLangsInput.addEventListener('input', () => {
      if (subtitleLangsInput.hasAttribute('aria-invalid')) {
        clearSubtitleLangsError();
      }
    });
  }

  // Check updates on startup
  if (checkUpdatesOnStartupToggle) {
    checkUpdatesOnStartupToggle.addEventListener('change', (e) => {
      settings.checkUpdatesOnStartup = (e.target as HTMLInputElement).checked;
      void persistSettings();
    });
  }

  if (showUpdateChannelBtn && updateChannelContainer) {
    const syncUpdateChannelAria = () => {
      const isVisible = updateChannelContainer.classList.contains('visible');
      updateChannelContainer.setAttribute('aria-hidden', String(!isVisible));
      showUpdateChannelBtn.setAttribute('aria-expanded', String(isVisible));
    };
    syncUpdateChannelAria();
    showUpdateChannelBtn.addEventListener('click', () => {
      const isVisible = updateChannelContainer.classList.contains('visible');
      updateChannelContainer.classList.toggle('visible', !isVisible);
      syncUpdateChannelAria();
      showUpdateChannelBtn.textContent = isVisible
        ? '▸ Update channel settings'
        : '▾ Hide update channel';
    });
  }

  if (updateChannelSelect) {
    updateChannelSelect.addEventListener('change', (e) => {
      settings.updateChannel = (e.target as HTMLSelectElement)
        .value as RosiSettings['updateChannel'];
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
          {
            label: '⟳ Reset & Restart',
            danger: true,
            action: () => {
              localStorage.removeItem('rosi-flat-ui');
              localStorage.removeItem('rosi-theme');
              window.api.resetSettings();
            },
          },
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
        message: 'Importing settings will overwrite your current settings. Continue?',
        buttons: [
          { label: 'Cancel' },
          {
            label: 'Import',
            primary: true,
            action: async () => {
              try {
                const result = await window.api.importSettings();
                if (result && result.ok) {
                  showToast('Settings imported successfully.', { type: 'success' });
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
            { label: 'Close', primary: true },
          ],
        });
      } catch {
        showToast('Could not load statistics.', { type: 'error' });
      }
    });
  }

  let focusQueueItemId: string | null = null;
  let currentQueue: RosiQueueItem[] = [];

  function updateQueueButtonStates(queue: RosiQueueItem[]) {
    const hasPending = queue.some((item) => item.status === 'pending');
    const isRunning = queue.some((item) => item.status === 'downloading');
    if (startQueueBtn) {
      startQueueBtn.disabled = queueActionLocks > 0 || !hasPending;
    }
    if (cancelQueueBtn) {
      cancelQueueBtn.disabled = queueActionLocks > 0 || !isRunning;
    }
  }

  function renderQueue(queue: RosiQueueItem[]) {
    currentQueue = queue;
    updateQueueButtonStates(queue);
    if (queueModule && typeof queueModule.renderQueue === 'function') {
      queueModule.renderQueue(
        queue,
        { queueList, queueSection, queueCount },
        {
          escapeHtml,
          focusQueueItemId,
          removeFromQueue: async (id: string) => {
            const removeIndex = currentQueue.findIndex((item) => item.id === id);
            const nextFocusId =
              removeIndex >= 0
                ? currentQueue.slice(removeIndex + 1).find((item) => item.status === 'pending')
                    ?.id ||
                  currentQueue
                    .slice(0, removeIndex)
                    .reverse()
                    .find((item) => item.status === 'pending')?.id ||
                  null
                : null;
            focusQueueItemId = nextFocusId;
            const endQueueAction = beginQueueAction();
            try {
              const result = await window.api.removeFromQueue(id);
              if (!result || !result.ok) {
                focusQueueItemId = null;
                const message = result?.error?.message || 'Could not remove the queue item.';
                setQueueStatusMessage(message);
                showToast(message, { type: 'error' });
              } else {
                setQueueStatusMessage('Removed item from the queue.');
              }
            } catch {
              focusQueueItemId = null;
              const message = 'Could not remove the queue item.';
              setQueueStatusMessage(message);
              showToast(message, { type: 'error' });
            } finally {
              endQueueAction();
            }
          },
        }
      );
      focusQueueItemId = null;
    }
  }

  let queueStatusTimer: ReturnType<typeof setTimeout> | null = null;
  function setQueueStatusMessage(message: unknown) {
    const statusEl = queueStatusMessage;
    if (!statusEl) return;
    if (queueStatusTimer) {
      clearTimeout(queueStatusTimer);
      queueStatusTimer = null;
    }

    const nextMessage =
      typeof message === 'string' ? message.trim() : message == null ? '' : String(message).trim();
    statusEl.textContent = '';

    if (!nextMessage) return;

    queueStatusTimer = setTimeout(() => {
      statusEl.textContent = nextMessage;
      queueStatusTimer = null;
    }, 0);
  }

  function queueMessageForCount(count: number, singular: string, plural: string) {
    return count === 1 ? singular : plural.replace('{count}', String(count));
  }

  function announceQueueAction(message: string, toastType?: ToastType) {
    setQueueStatusMessage(message);
    if (toastType === 'error' || toastType === 'warning') {
      showToast(message, { type: toastType });
    }
  }

  const queueActionButtons = [addToQueueBtn, startQueueBtn, clearQueueBtn, cancelQueueBtn].filter(
    (button) => button instanceof HTMLButtonElement
  );
  let queueActionLocks = 0;
  function syncQueueActionBusyState() {
    const isBusy = queueActionLocks > 0;
    queueActionButtons.forEach((button) => {
      button.setAttribute('aria-busy', String(isBusy));
    });
    if (addToQueueBtn) addToQueueBtn.disabled = isBusy;
    if (clearQueueBtn) clearQueueBtn.disabled = isBusy;
    updateQueueButtonStates(currentQueue);
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

  if (queueToggleBtn) {
    setQueueCollapsed(!!settings.queueCollapsed);
    queueToggleBtn.addEventListener('click', () => {
      settings.queueCollapsed = toggleQueueCollapsed();
      void persistSettings();
    });
    queueToggleBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        settings.queueCollapsed = toggleQueueCollapsed();
        void persistSettings();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        settings.queueCollapsed = setQueueCollapsed(true);
        void persistSettings();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        settings.queueCollapsed = setQueueCollapsed(false);
        void persistSettings();
      }
    });
  }

  if (addToQueueBtn && queueUrlInput) {
    // Allow Ctrl/Cmd+Enter to submit from the textarea (standard multi-line UX).
    queueUrlInput.addEventListener('keydown', (e) => {
      const modKey = isMac() ? e.metaKey : e.ctrlKey;
      if (modKey && e.key === 'Enter') {
        e.preventDefault();
        addToQueueBtn.click();
      }
    });

    // Accept drag-and-drop of URLs into the queue textarea.
    queueUrlInput.addEventListener('dragover', (e) => {
      e.preventDefault();
      queueUrlInput.classList.add('drag-over');
    });
    queueUrlInput.addEventListener('dragleave', () => {
      queueUrlInput.classList.remove('drag-over');
    });
    queueUrlInput.addEventListener('drop', (e) => {
      const dragEvent = e as DragEvent;
      dragEvent.preventDefault();
      queueUrlInput.classList.remove('drag-over');
      const dt = dragEvent.dataTransfer;
      const text = dt ? dt.getData('text/uri-list') || dt.getData('text/plain') : '';
      if (text.trim()) {
        const existing = queueUrlInput.value.trim();
        queueUrlInput.value = existing ? `${existing}\n${text.trim()}` : text.trim();
        queueUrlInput.dispatchEvent(new Event('input'));
      }
    });

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
          announceQueueAction(message);
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
    clearQueueBtn.addEventListener('click', () => {
      if (queueActionLocks > 0) return;
      showModal({
        title: 'Clear Queue',
        message: 'Remove all queued and completed items?',
        buttons: [
          { label: 'Cancel' },
          {
            label: 'Clear',
            danger: true,
            action: async () => {
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
            },
          },
        ],
      });
    });
  }

  if (cancelQueueBtn) {
    cancelQueueBtn.addEventListener('click', () => {
      if (queueActionLocks > 0) return;
      showModal({
        title: 'Cancel Queue',
        message: 'Stop processing the active download queue?',
        buttons: [
          { label: 'Keep Running' },
          {
            label: 'Cancel Queue',
            danger: true,
            action: async () => {
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
            },
          },
        ],
      });
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

        const urlInput = document.getElementById('url') as HTMLInputElement | null;
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

        const videoSelect = document.getElementById('videoFormat') as HTMLSelectElement | null;
        const audioSelect = document.getElementById('audioFormat') as HTMLSelectElement | null;
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

        let savePath = settings.askDownloadLocation
          ? null
          : settings.downloadFolder?.trim() || null;
        if (!savePath) {
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
        }

        if (!savePath) {
          isDownloading = false;
          syncPrimaryActionState();
          if (outputEl) outputEl.textContent = '⚠️ Download cancelled: No save location selected.';
          return;
        }
        settings.downloadFolder = savePath;
        updateUIFromSettings();
        const saved = await persistSettings(true, true);
        if (!saved) {
          isDownloading = false;
          syncPrimaryActionState();
          showToast('Could not save download settings. Please try again.', { type: 'error' });
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
          downloadAbort?.();
          hideProgressBar();
        });

        const videoFormat = settings.advancedOptions ? videoSelect?.value : undefined;
        const audioFormat = settings.advancedOptions ? audioSelect?.value : undefined;
        const convertFormat = settings.convertEnabled ? convertFormatSelect?.value : undefined;
        const needsMerge = settings.bestQuality || (videoFormat && audioFormat);
        const needsConvert = settings.convertEnabled && convertFormat;
        configureProgressPhases(!!needsMerge, !!needsConvert);
        showProgressBar('Starting download...');
        const keepOriginal = settings.convertEnabled ? keepOriginalToggle?.checked : undefined;
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
  const ipcCleanupFunctions: Array<() => void> = [];

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
            void window.api.showNotification({
              title: 'Download Complete!',
              body: lastDownloadedFilePath
                ? `Saved: ${lastDownloadedFilePath.split(/[/\\]/).pop()}`
                : 'Your download has finished.',
              filePath: lastDownloadedFilePath ?? undefined,
            });
          }
        }

        setTimeout(() => {
          hideProgressBar();
        }, 2000);

        const filename = lastDownloadedFilePath
          ? (lastDownloadedFilePath.split(/[/\\]/).pop() ?? 'Unknown file')
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
            void window.api.openFileLocation(filePath);
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

  ipcCleanupFunctions.push(
    window.api.onSettingsImported((importedSettings) => {
      settings = importedSettings;
      try {
        updateUIFromSettings();
        applyTheme(settings.theme ?? 'system');
        localStorage.setItem('rosi-flat-ui', settings.flatUi ? 'true' : 'false');
      } catch (e) {
        logError('Failed to refresh UI after settings import', e);
      }
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
        } catch {}
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
      void checkDenoInstallation(settings, () => void persistSettings());
      void checkUpdatesOnStartup();
    });
  } else {
    void checkDenoInstallation(settings, () => void persistSettings());
    void checkUpdatesOnStartup();
    setTimeout(maybeShowSupportModal, 1500);
  }

  const licensesOverlayEl = document.getElementById('licenses-overlay');
  if (licensesOverlayEl) {
    licensesOverlayEl.addEventListener('click', (event) => {
      if (event.target === licensesOverlayEl) {
        hideLicenses();
      }
    });
  }

  const closeBtn = document.getElementById('close-licenses');
  if (closeBtn) {
    closeBtn.addEventListener('click', hideLicenses);
  }

  document.addEventListener('keydown', (event) => {
    const modifierPressed = isMac() ? event.metaKey : event.ctrlKey;
    const wizardOverlay = document.getElementById('setup-wizard');
    const wizardActive = wizardOverlay?.classList.contains('active');
    const licensesOverlay = document.getElementById('licenses-overlay');
    const licensesActive = licensesOverlay?.classList.contains('active');

    if (event.key === 'Escape') {
      if (licensesActive) {
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

    if (wizardActive || isModalActive || licensesActive) {
      return;
    }

    if (modifierPressed && event.key === 'd') {
      event.preventDefault();
      showModal({
        title: 'Restart Application',
        message: 'Are you sure you want to restart ROSI?',
        buttons: [
          { label: 'Cancel' },
          { label: 'Restart', primary: true, action: () => window.api.restartApp() },
        ],
      });
    }

    if (modifierPressed && event.key === 'f') {
      event.preventDefault();
      const urlInput = document.getElementById('url') as HTMLInputElement | null;
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
