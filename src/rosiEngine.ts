function logError(context: string, error?: unknown) {
  const msg = error instanceof Error ? error.message : String(error || '');
  const text = msg ? `${context}: ${msg}` : context;
  if (window.api && typeof window.api.logError === 'function') {
    window.api.logError(text);
  }
}

interface RosiPlaylistSelection {
  mode: 'current' | 'all' | 'range';
  start?: number;
  end?: number;
}

interface RosiDownloadPreset {
  id: string;
  name: string;
  profile: 'compatible' | 'best-video' | 'audio' | 'custom';
  bestQuality?: boolean;
  audioOnly?: boolean;
  audioFormat?: string;
  videoFormat?: string;
  audioFormatId?: string;
  convertEnabled?: boolean;
  convertFormat?: string;
  keepOriginalAfterConvert?: boolean;
  gpuAcceleration?: boolean;
  gpuType?: 'auto' | 'nvidia' | 'amd' | 'intel';
  writeSubtitles?: boolean;
  subtitleLangs?: string;
  embedThumbnail?: boolean;
  embedMetadata?: boolean;
  sponsorblockRemove?: boolean;
  playlist?: RosiPlaylistSelection;
}

interface RosiSettings {
  settingsVersion: number;
  theme: 'system' | 'light' | 'dark' | 'purple';
  showConsoleOutput: boolean;
  dockTab: 'queue' | 'activity' | 'console';
  dockCollapsed: boolean;
  downloadMode: 'compatible' | 'best-video' | 'audio' | 'custom';
  downloadPresets: RosiDownloadPreset[];
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
  showTaskbarProgress: boolean;
}

interface RosiJobProgressEvent {
  sessionId?: number;
  phase: 'download' | 'merge' | 'convert' | 'idle';
  phasePercent: number | null;
  itemOverallPercent: number;
  overallPercent: number;
  queueItemId?: string;
  status: string;
  details?: string;
  indeterminate?: boolean;
  downloadedBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
}

function resolveProgressPhaseFlags(
  activeSettings: RosiSettings,
  advancedFormats?: { videoFormat?: string; audioFormat?: string }
) {
  if (activeSettings.audioOnly || activeSettings.downloadMode === 'audio') {
    return { needsMerge: false, needsConvert: activeSettings.convertEnabled };
  }
  const baseMerge = activeSettings.bestQuality || activeSettings.advancedOptions;
  const needsMerge =
    Boolean(advancedFormats?.videoFormat && advancedFormats?.audioFormat) || baseMerge;
  return {
    needsMerge,
    needsConvert: activeSettings.convertEnabled,
  };
}

function applyActiveDownloadProgressPhases(
  activeSettings: RosiSettings,
  status = 'Downloading...',
  advancedFormats?: { videoFormat?: string; audioFormat?: string }
) {
  const { needsMerge, needsConvert } = resolveProgressPhaseFlags(activeSettings, advancedFormats);
  configureProgressPhases(needsMerge, needsConvert);
  showProgressBar(status);
}

const rosiModules = window.rosiModules || {};
const uiModule = rosiModules.ui || null;
const downloadsModule = rosiModules.downloads || null;
const queueModule = rosiModules.queue || null;
const settingsModule = rosiModules.settings || null;
const updatesModule = rosiModules.updates || null;
const dockModule = rosiModules.dock || null;
const iconsModule = rosiModules.icons || null;

/** Write a status line, showing a leading Rust status emoji as an icon. */
function renderStatusText(target: HTMLElement, text: string) {
  if (iconsModule) iconsModule.renderStatus(target, text);
  else target.textContent = text;
}

/** Replace a button's content with a Lucide icon and a text label. */
function setButtonIconLabel(button: HTMLElement, iconName: string, label: string, size = 18) {
  const svg = iconsModule?.icon(iconName, size) ?? null;
  const text = document.createElement('span');
  text.textContent = label;
  button.replaceChildren(...(svg ? [svg] : []), text);
}

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

interface ExtractedUrlSet {
  urls: string[];
  rejected: number;
}

function normalizeHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!isValidUrl(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function extractHttpUrls(rawValue: string): ExtractedUrlSet {
  const candidates: string[] = [];
  rawValue.split(/\r?\n/).forEach((line) => {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) return;
    candidates.push(...trimmedLine.split(/\s+/).filter(Boolean));
  });

  const urls: string[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  candidates.forEach((candidate) => {
    const normalized = normalizeHttpUrl(candidate);
    if (!normalized) {
      rejected += 1;
      return;
    }
    if (seen.has(normalized)) return;
    seen.add(normalized);
    urls.push(normalized);
  });
  return { urls, rejected };
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

/**
 * Show the save folder with its last segment pinned, so a long path loses its
 * middle to the ellipsis and the folder name stays readable.
 */
function renderFolderSummary(target: HTMLElement, folderSetting: string | undefined) {
  const folder = folderSetting?.trim() ?? '';
  target.title = folder || 'Choose a folder before downloading';
  if (!folder) {
    target.textContent = 'Choose a folder';
    return;
  }
  const [, parents, name] = /^(.*[\\/])([^\\/]+)[\\/]?$/.exec(folder) ?? [];
  const head = document.createElement('span');
  head.className = 'download-destination-head';
  head.textContent = parents ?? folder;
  const parts: HTMLElement[] = [head];
  if (name) {
    const tail = document.createElement('span');
    tail.className = 'download-destination-tail';
    tail.textContent = name;
    parts.push(tail);
  }
  target.replaceChildren(...parts);
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

// Pin the native title bar to the rendered theme rather than the system
// appearance, so a dark page never sits under a light bar.
function syncWindowTheme(theme: ThemeName) {
  window.api?.setWindowTheme?.(theme === 'light' ? 'light' : 'dark');
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
    syncWindowTheme(appliedTheme);
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
  const shouldBeInert = isInert || getTopActiveOverlayId() !== null;
  if ('inert' in mainContent) {
    (mainContent as HTMLElement & { inert: boolean }).inert = shouldBeInert;
  }
  if (shouldBeInert) {
    mainContent.setAttribute('aria-hidden', 'true');
  } else {
    mainContent.removeAttribute('aria-hidden');
  }
}

function getTopActiveOverlayId(): string | null {
  const overlayOrder = ['app-modal', 'licenses-overlay', 'setup-wizard', 'sidebar'];
  for (const id of overlayOrder) {
    const overlay = document.getElementById(id);
    const active =
      id === 'sidebar'
        ? overlay?.classList.contains('open')
        : overlay?.classList.contains('active');
    if (active) return id;
  }
  return null;
}

function syncModalAccessibility() {
  const topOverlayId = getTopActiveOverlayId();
  for (const id of ['app-modal', 'licenses-overlay', 'setup-wizard']) {
    const overlay = document.getElementById(id);
    if (overlay) overlay.setAttribute('aria-modal', String(topOverlayId === id));
  }
}

function focusTopOverlayOr(target: Element | null) {
  const topOverlayId = getTopActiveOverlayId();
  if (topOverlayId) {
    const overlay = document.getElementById(topOverlayId);
    if (focusFirstElement(overlay)) return;
    if (overlay instanceof HTMLElement) overlay.focus();
    return;
  }

  setMainContentInert(false);
  if (!(target instanceof HTMLElement) || !target.isConnected || target.hasAttribute('disabled')) {
    return;
  }
  if (target.closest('[aria-hidden="true"]')) {
    const fallback = document.getElementById('url');
    if (fallback instanceof HTMLElement && !fallback.closest('[aria-hidden="true"]')) {
      fallback.focus();
    }
    return;
  }
  target.focus();
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
  syncWindowTheme(appliedTheme);
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
  dockModule?.markUnseen('console');
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
  icon?: string;
  action?: () => void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}
interface ModalData {
  title: string;
  message: unknown;
  key?: string;
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
let modalHideTimer: ReturnType<typeof setTimeout> | null = null;
let modalHideGeneration = 0;
let modalHidingData: ModalData | null = null;

function detachModalFocusHandlers(modal: HTMLElement | null) {
  if (modal && modalTrapHandler) modal.removeEventListener('keydown', modalTrapHandler);
  if (modalFocusinHandler) document.removeEventListener('focusin', modalFocusinHandler, true);
  modalTrapHandler = null;
  modalFocusinHandler = null;
}

function cancelModalHide() {
  modalHideGeneration += 1;
  if (modalHideTimer !== null) clearTimeout(modalHideTimer);
  modalHideTimer = null;
  modalHidingData = null;
}

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

function showModal({
  title,
  message,
  key,
  buttons = [],
  priority = false,
  extra = null,
}: ModalData) {
  const modalData: ModalData = { title, message, key, buttons, priority, extra };
  if (priority && isModalActive) {
    cancelModalHide();
    const modal = document.getElementById('app-modal');
    if (modal) {
      modal.classList.remove('active', 'showing', 'hiding');
      modal.setAttribute('aria-hidden', 'true');
      detachModalFocusHandlers(modal);
    }
    isModalActive = false;
    currentModalData = null;
    syncModalAccessibility();
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
  const displayedModalData = currentModalData;
  const { title, message, buttons = [], extra } = displayedModalData;

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
  syncModalAccessibility();
  setMainContentInert(true);

  void modal.offsetWidth;
  requestAnimationFrame(() => {
    if (currentModalData === displayedModalData) modal.classList.remove('showing');
  });

  buttons.forEach(({ label, icon, action, primary, danger, disabled }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    if (icon) setButtonIconLabel(btn, icon, label, 16);
    else btn.textContent = label;
    btn.className = 'btn';
    if (primary) btn.classList.add('modal-btn-primary', 'btn--primary');
    else if (danger) btn.classList.add('modal-btn-danger', 'btn--danger');
    else btn.classList.add('btn--neutral');
    if (disabled) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
    }
    if (!disabled) {
      btn.onclick = () => {
        if (currentModalData !== displayedModalData || !modal.classList.contains('active')) return;
        hideModal(modal, action);
      };
    }
    btnContainer.appendChild(btn);
  });

  if (!previousFocus) previousFocus = document.activeElement;

  detachModalFocusHandlers(modal);
  modalTrapHandler = (e: KeyboardEvent) => {
    if (currentModalData !== displayedModalData || getTopActiveOverlayId() !== 'app-modal') {
      return;
    }
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
    if (
      !isModalActive ||
      currentModalData !== displayedModalData ||
      !modal.classList.contains('active') ||
      getTopActiveOverlayId() !== 'app-modal'
    ) {
      return;
    }
    const target = e.target;
    if (target instanceof Node && modal.contains(target)) return;
    if (!focusFirstElement(modal) && typeof modal.focus === 'function') {
      modal.focus();
    }
  };
  document.addEventListener('focusin', modalFocusinHandler, true);

  requestAnimationFrame(() => {
    if (currentModalData !== displayedModalData || getTopActiveOverlayId() !== 'app-modal') {
      return;
    }
    if (!focusFirstElement(modal) && typeof modal.focus === 'function') {
      modal.focus();
    }
  });
}

function hideModal(modal: HTMLElement, action: (() => void) | null | undefined) {
  if (!currentModalData || modalHideTimer !== null) return;
  const closingModalData = currentModalData;
  const hideGeneration = ++modalHideGeneration;
  modalHidingData = closingModalData;
  modal.classList.add('hiding');
  currentModalData = null;
  detachModalFocusHandlers(modal);
  modalHideTimer = setTimeout(() => {
    if (hideGeneration !== modalHideGeneration || modalHidingData !== closingModalData) return;
    modalHideTimer = null;
    modalHidingData = null;
    modal.classList.remove('active', 'hiding');
    modal.setAttribute('aria-hidden', 'true');
    modal.removeAttribute('aria-busy');
    isModalActive = false;
    syncModalAccessibility();
    if (typeof action === 'function') action();
    if (!isModalActive && modalQueue.length > 0) displayNextModal();
    if (!isModalActive && modalQueue.length === 0) {
      setMainContentInert(false);
      focusTopOverlayOr(previousFocus);
      previousFocus = null;
    }
  }, 200);
}

function retireModal(key: string) {
  for (let index = modalQueue.length - 1; index >= 0; index -= 1) {
    if (modalQueue[index]?.key === key) modalQueue.splice(index, 1);
  }
  const retiresVisibleModal = currentModalData?.key === key;
  const retiresHidingModal = modalHidingData?.key === key && modalHideTimer !== null;
  if (!retiresVisibleModal && !retiresHidingModal) return;

  cancelModalHide();
  const modal = document.getElementById('app-modal');
  if (modal) {
    modal.classList.remove('active', 'showing', 'hiding');
    modal.setAttribute('aria-hidden', 'true');
    modal.removeAttribute('aria-busy');
  }
  detachModalFocusHandlers(modal);
  currentModalData = null;
  isModalActive = false;
  syncModalAccessibility();

  if (modalQueue.length > 0) {
    displayNextModal();
    return;
  }
  setMainContentInert(false);
  focusTopOverlayOr(previousFocus);
  previousFocus = null;
}

function showKeyboardShortcuts() {
  const modKey = getModifierKeyName();
  showModal({
    title: 'Keyboard Shortcuts',
    message: `${modKey}+D - Restart application\n${modKey}+F - Focus URL input field\n${modKey}+, - Open settings\n${modKey}+Shift+, - Toggle settings sidebar\n${modKey}+Enter - Submit queue URLs (when focused)\nAlt+↑ / Alt+↓ - Move a pending queue item (when focused)
Alt+1 / Alt+2 / Alt+3 - Show Queue, Activity, or Console`,
    buttons: [{ label: 'OK', primary: true }],
  });
}

let isFetchingFormats = false;
let fetchFormatsAbort: (() => void) | null = null;

let formatRequestGeneration = 0;
let formatRequestUrl: string | null = null;
let formatSelectionsUrl: string | null = null;

function clearAdvancedFormatSelections() {
  const videoSelect = document.getElementById('videoFormat') as HTMLSelectElement | null;
  const audioSelect = document.getElementById('audioFormat') as HTMLSelectElement | null;
  if (videoSelect) videoSelect.innerHTML = '<option value="">Select Video Format</option>';
  if (audioSelect) audioSelect.innerHTML = '<option value="">Select Audio Format</option>';
  formatSelectionsUrl = null;
}

function invalidateFormatRequest() {
  if (formatRequestUrl === null) return;
  formatRequestGeneration += 1;
  formatRequestUrl = null;
  isFetchingFormats = false;
  fetchFormatsAbort = null;
  window.api.cancelFormats?.();
  const btn = document.getElementById('fetchFormatsBtn') as HTMLButtonElement | null;
  if (btn) setButtonLoading(btn, false);
}

async function fetchFormats() {
  const btn = document.getElementById('fetchFormatsBtn') as HTMLButtonElement | null;
  const urlInput = document.getElementById('url') as HTMLInputElement | null;
  const videoUrl = urlInput?.value.trim() || null;

  try {
    if (!btn || !videoUrl) {
      showModal({
        title: 'Input Error',
        message: 'Please enter a video URL first.',
        buttons: [{ label: 'OK', primary: true }],
      });
      return;
    }

    // Validate URL format
    if (!isValidUrl(videoUrl)) {
      showModal({
        title: 'Invalid URL',
        message: 'Please enter a valid URL starting with http:// or https://',
        buttons: [{ label: 'OK', primary: true }],
      });
      return;
    }

    if (isFetchingFormats) return;
    isFetchingFormats = true;
    const requestGeneration = ++formatRequestGeneration;
    formatRequestUrl = videoUrl;
    formatSelectionsUrl = null;
    const isCurrentRequest = () =>
      requestGeneration === formatRequestGeneration && formatRequestUrl === videoUrl;
    let wasCancelled = false;
    fetchFormatsAbort = () => {
      if (!isCurrentRequest()) return;
      wasCancelled = true;
      formatRequestGeneration += 1;
      formatRequestUrl = null;
      formatSelectionsUrl = null;
      isFetchingFormats = false;
      fetchFormatsAbort = null;
      clearAdvancedFormatSelections();
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
      if (wasCancelled || !isCurrentRequest()) return;
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
      formatSelectionsUrl = videoUrl;
    } catch (e) {
      if (!isCurrentRequest()) return;
      const errorMessage = typeof e === 'string' ? e : (e as Error)?.message || 'Unknown error';
      if (videoSelect) videoSelect.innerHTML = '<option value="">Error loading formats</option>';
      if (audioSelect) audioSelect.innerHTML = '<option value="">Error loading formats</option>';
      showModal({
        title: 'Format Fetch Failed',
        message: `Could not retrieve formats.\nError: ${errorMessage}`,
        buttons: [{ label: 'OK', primary: true }],
      });
    } finally {
      if (isCurrentRequest()) {
        isFetchingFormats = false;
        formatRequestUrl = null;
        fetchFormatsAbort = null;
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

const MAX_PREVIEW_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const PREVIEW_THUMBNAIL_DATA_URL_PATTERN =
  /^data:image\/(?:jpeg|png|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/i;

function isSafePreviewThumbnail(value: string | null): value is string {
  if (!value) return false;
  const encoded = PREVIEW_THUMBNAIL_DATA_URL_PATTERN.exec(value)?.[1];
  if (!encoded) return false;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const decodedBytes = (encoded.length / 4) * 3 - padding;
  return decodedBytes <= MAX_PREVIEW_THUMBNAIL_BYTES;
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
    if (isSafePreviewThumbnail(info.thumbnail)) {
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
  if (statusEl) renderStatusText(statusEl, status);
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
  if (statusText && statusEl) renderStatusText(statusEl, statusText);
  if (detailsText && details) details.textContent = detailsText;
}

function setProgressIndeterminate(status = 'Processing...') {
  const statusEl = document.getElementById('progress-status');
  const percentEl = document.getElementById('progress-percent');
  const bar = document.getElementById('progress-bar');
  const barWrapper = document.getElementById('progress-bar-wrapper');
  const details = document.getElementById('progress-details');

  if (statusEl) renderStatusText(statusEl, status);
  if (percentEl) percentEl.textContent = '';
  if (bar) bar.classList.add('indeterminate');
  if (barWrapper) {
    barWrapper.removeAttribute('aria-valuenow');
    barWrapper.setAttribute('aria-valuetext', status);
  }
  if (details) details.textContent = '';
}

function applyJobProgress(event: RosiJobProgressEvent) {
  if (event.phase && event.phase !== 'idle') {
    setProgressPhase(event.phase);
  }
  if (event.indeterminate) {
    setProgressIndeterminate(event.status);
    return;
  }
  const displayPercent = Number.isFinite(event.overallPercent)
    ? event.overallPercent
    : (event.phasePercent ?? 0);
  updateProgressBar(displayPercent, event.status, event.details ?? null);
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

function formatBytes(bytes: number) {
  if (downloadsModule && typeof downloadsModule.formatBytes === 'function') {
    return downloadsModule.formatBytes(bytes);
  }
  return String(bytes);
}

const HISTORY_KEY = 'rosi-download-history';

interface LegacyHistoryEntry {
  filename: string;
  path: string | null;
  timestamp: number;
  status: 'success' | 'failed' | 'cancelled';
}

/**
 * Pre-4.3 downloads were tracked in localStorage. The main process is now the
 * authoritative store, so these records are only read for display when the
 * durable activity log is still empty.
 */
function loadLegacyHistory(): LegacyHistoryEntry[] {
  try {
    const data = localStorage.getItem(HISTORY_KEY);
    const parsed: unknown = data ? JSON.parse(data) : [];
    return Array.isArray(parsed) ? (parsed as LegacyHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

type ActivityFilter = 'all' | 'success' | 'failed' | 'cancelled';

interface ActivityRow {
  id: string;
  outcome: 'success' | 'failed' | 'cancelled';
  title: string;
  subtitle: string;
  timestamp: number;
  url: string | null;
  outputPath?: string;
  outputPaths?: string[];
  error?: string;
  request?: Record<string, unknown>;
}

let activityEntries: RosiDownloadActivity[] = [];
let activityFilter: ActivityFilter = 'all';
let activityReplayHandler: ((entry: RosiDownloadActivity) => void) | null = null;
let activityLoaded = false;

function hostFromUrl(url: string | null | undefined) {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function describeActivityProfile(entry: RosiDownloadActivity) {
  if (entry.presetName) return entry.presetName;
  if (entry.profile === 'compatible') return 'Compatible';
  if (entry.profile === 'best-video') return 'Best video';
  if (entry.profile === 'audio') return 'Audio';
  if (entry.profile === 'custom') return 'Custom';
  return '';
}

function toActivityRows(): ActivityRow[] {
  if (activityEntries.length > 0) {
    return activityEntries.map((entry) => {
      const successfulOutputs = entry.outputPaths?.length ?? (entry.outputPath ? 1 : 0);
      const failedOutputs = entry.failedPaths?.length ?? 0;
      const parts = [
        hostFromUrl(entry.url),
        describeActivityProfile(entry),
        typeof entry.sizeBytes === 'number' ? formatBytes(entry.sizeBytes) : '',
        failedOutputs > 0
          ? `${successfulOutputs} of ${successfulOutputs + failedOutputs} entries completed`
          : successfulOutputs > 1
            ? `${successfulOutputs} files saved`
            : '',
        formatRelativeTime(entry.completedAt),
      ].filter(Boolean);
      return {
        id: entry.id,
        outcome: entry.outcome,
        title: entry.filename || hostFromUrl(entry.url) || entry.url,
        subtitle: parts.join(' • '),
        timestamp: entry.completedAt,
        url: entry.url,
        outputPath: entry.outputPath,
        outputPaths: entry.outputPaths,
        error: entry.error,
        request: entry.request,
      };
    });
  }

  return loadLegacyHistory().map((entry, index) => ({
    id: `legacy-${index}`,
    outcome: entry.status,
    title: entry.filename || 'Unknown file',
    subtitle: formatRelativeTime(entry.timestamp),
    timestamp: entry.timestamp,
    url: null,
    outputPath: entry.path ?? undefined,
  }));
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

/** Opening a folder can fail (moved file, unmounted volume); surface that. */
async function revealFileLocation(filePath: string) {
  try {
    const result = await window.api.openFileLocation(filePath);
    if (!result || !result.ok) {
      showToast(result?.error?.message || 'Could not open that file location.', {
        type: 'warning',
      });
    }
  } catch {
    showToast('Could not open that file location.', { type: 'warning' });
  }
}

function createActivityActionButton(
  iconName: string,
  label: string,
  ariaLabel: string,
  action: () => void
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'history-open-btn btn btn--ghost btn--xs btn--icon btn--accent-hover';
  button.setAttribute('aria-label', ariaLabel);
  button.title = label;
  const svg = iconsModule?.icon(iconName, 16) ?? null;
  if (svg) button.appendChild(svg);
  else button.textContent = label;
  button.addEventListener('focus', () => button.classList.add('is-focused'));
  button.addEventListener('blur', () => button.classList.remove('is-focused'));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    action();
  });
  return button;
}

function renderActivity() {
  const historySection = document.getElementById('download-history');
  const listEl = document.getElementById('history-list');
  const countEl = document.getElementById('history-count');
  if (!listEl || !historySection) return;

  const rows = toActivityRows();
  const visibleRows =
    activityFilter === 'all' ? rows : rows.filter((row) => row.outcome === activityFilter);
  if (countEl) countEl.textContent = String(rows.length);

  // The panel now stays mounted so the empty state remains discoverable.
  historySection.classList.add('visible');
  listEl.replaceChildren();

  if (visibleRows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent =
      rows.length === 0
        ? 'No downloads yet. Finished, failed, and cancelled downloads will appear here.'
        : 'No downloads match this filter.';
    listEl.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  visibleRows.forEach((row) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.setAttribute('role', 'listitem');

    const statusLabel =
      row.outcome === 'success'
        ? 'Completed'
        : row.outcome === 'cancelled'
          ? 'Cancelled'
          : 'Failed';

    const info = document.createElement('div');
    info.className = 'history-item-info';
    const filenameEl = document.createElement('span');
    filenameEl.className = 'history-filename';
    filenameEl.title = row.url || row.title;
    filenameEl.textContent = row.title;
    const timeEl = document.createElement('span');
    timeEl.className = 'history-time';
    timeEl.textContent = row.subtitle || formatRelativeTime(row.timestamp);
    info.append(filenameEl, timeEl);
    if (row.error) {
      const errorEl = document.createElement('span');
      errorEl.className = 'history-error';
      renderStatusText(errorEl, row.error);
      info.appendChild(errorEl);
    }

    const actions = document.createElement('div');
    actions.className = 'history-item-actions';
    const statusEl = document.createElement('span');
    statusEl.className = `history-status ${row.outcome}`;
    statusEl.textContent = statusLabel;
    actions.appendChild(statusEl);

    if (row.request && activityReplayHandler) {
      const entry = activityEntries.find((candidate) => candidate.id === row.id);
      if (entry) {
        actions.appendChild(
          createActivityActionButton(
            'rotate-ccw',
            'Download again',
            `Download ${row.title} again`,
            () => {
              activityReplayHandler?.(entry);
            }
          )
        );
      }
    }
    if (row.url) {
      const sourceUrl = row.url;
      actions.appendChild(
        createActivityActionButton(
          'link',
          'Copy source',
          `Copy source link for ${row.title}`,
          () => {
            void navigator.clipboard.writeText(sourceUrl).then(
              () => showToast('Source link copied.', { type: 'info' }),
              () => showToast('Could not copy the source link.', { type: 'warning' })
            );
          }
        )
      );
    }
    if (row.outputPath && (row.outcome === 'success' || row.outputPaths?.length)) {
      const filePath = row.outputPath;
      actions.appendChild(
        createActivityActionButton(
          'folder-open',
          'Open folder',
          `Open file location for ${row.title}`,
          () => {
            void revealFileLocation(filePath);
          }
        )
      );
    }

    item.append(info, actions);
    fragment.appendChild(item);
  });
  listEl.appendChild(fragment);
}

function setActivityEntries(entries: RosiDownloadActivity[]) {
  const previousCount = activityEntries.length;
  activityEntries = Array.isArray(entries) ? entries : [];
  // The first load is history from earlier sessions, which is not news.
  if (activityLoaded && activityEntries.length > previousCount) {
    dockModule?.markUnseen('activity');
  }
  activityLoaded = true;
  renderActivity();
}

function setActivityFilter(filter: ActivityFilter) {
  activityFilter = filter;
  document.querySelectorAll<HTMLButtonElement>('.activity-filter').forEach((button) => {
    const isSelected = button.dataset.activityFilter === filter;
    button.classList.toggle('selected', isSelected);
    button.setAttribute('aria-pressed', String(isSelected));
  });
  renderActivity();
}

async function clearActivity(): Promise<boolean> {
  if (typeof window.api.clearDownloadActivity !== 'function') {
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* ignore */
    }
    setActivityEntries([]);
    return true;
  }
  try {
    const result = await window.api.clearDownloadActivity();
    if (!result || !result.ok) {
      showToast(result?.error?.message || 'Could not clear activity.', { type: 'error' });
      return false;
    }
  } catch {
    showToast('Could not clear activity.', { type: 'error' });
    return false;
  }
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* ignore */
  }
  setActivityEntries([]);
  return true;
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
let updaterCandidateId: number | null = null;

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

function showRestartFailure(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  showModal({
    title: 'Could Not Restart ROSI',
    message: `ROSI could not complete the restart safely, so the app remains open.\n\n${detail}`,
    buttons: [{ label: 'OK', primary: true }],
    priority: true,
  });
}

function setupAutoUpdater(flushSettingsBeforeRestart: () => Promise<boolean>) {
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
    syncModalAccessibility();
    setMainContentInert(true);
    syncLicensesTheme(appliedTheme);
    document.body.classList.add('licenses-open');
    document.body.style.overflow = 'hidden';

    const closeBtn = licensesOverlay.querySelector<HTMLElement>('#close-licenses');
    licensesOverlay.setAttribute('tabindex', '-1');
    requestAnimationFrame(() => {
      if (getTopActiveOverlayId() !== 'licenses-overlay') return;
      if (closeBtn) {
        closeBtn.focus();
        return;
      }
      if (!focusFirstElement(licensesOverlay) && typeof licensesOverlay.focus === 'function') {
        licensesOverlay.focus();
      }
    });

    licensesTrapHandler = (e: KeyboardEvent) => {
      if (getTopActiveOverlayId() !== 'licenses-overlay') return;
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
      if (
        !licensesOverlay.classList.contains('active') ||
        getTopActiveOverlayId() !== 'licenses-overlay'
      ) {
        return;
      }
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
    if (previousFocus instanceof Node && licensesOverlay.contains(previousFocus)) {
      previousFocus = licensesPreviousFocus;
    }
    const focusToRestore = licensesPreviousFocus;
    licensesPreviousFocus = null;
    syncModalAccessibility();
    setMainContentInert(false);
    setTimeout(() => {
      document.body.style.overflow = '';
      document.body.classList.remove('licenses-open');
    }, 300);
    focusTopOverlayOr(focusToRestore);
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

const SUBTITLE_LANGS_RE = /^[A-Za-z0-9.*-]+(,[A-Za-z0-9.*-]+)*$/;

function isValidSubtitleLangs(raw: string) {
  return raw.length > 0 && raw.length <= 256 && SUBTITLE_LANGS_RE.test(raw);
}

// Automatic Deno install uses winget (Windows) or Homebrew (macOS) only.
function isLinuxPlatform() {
  return /linux/i.test(navigator.userAgent) && !/android/i.test(navigator.userAgent);
}

const DENO_INSTALL_DOCS = 'https://docs.deno.com/runtime/getting_started/installation/';

// check for Deno
async function checkDenoInstallation(
  settings: RosiSettings,
  persist: () => Promise<boolean>,
  flushBeforeRestart: () => Promise<boolean>
) {
  if (settings.denoReminderDismissed) {
    return;
  }

  try {
    const isInstalled = await window.api.checkDenoInstalled();

    if (!isInstalled && isLinuxPlatform()) {
      showModal({
        title: 'Deno Required for Full YouTube Functionality',
        message:
          'Recent updates to yt-dlp require Deno for full YouTube functionality.\n\nInstall Deno with the official instructions (or your package manager), then restart ROSI.',
        buttons: [
          {
            label: 'Open Deno Instructions',
            primary: true,
            action: () => window.api.openExternal(DENO_INSTALL_DOCS),
          },
          { label: 'Later' },
          {
            label: "No, don't remind me",
            action: () => {
              settings.denoReminderDismissed = true;
              void persist();
            },
          },
        ],
      });
    } else if (!isInstalled) {
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
                if (result?.success !== true) {
                  throw new Error(
                    result?.error || 'Deno installation did not complete successfully.'
                  );
                }
                showModal({
                  title: 'Installation Complete',
                  message:
                    'Deno has been successfully installed!\nRestarting the app can help pick up the updated environment.',
                  buttons: [
                    {
                      label: 'Restart Now',
                      primary: true,
                      action: async () => {
                        if (!(await flushBeforeRestart())) return;
                        try {
                          await window.api.restartApp();
                        } catch (error) {
                          showRestartFailure(error);
                        }
                      },
                    },
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
                  message: `Failed to install Deno automatically.\n\nUse the official Deno installation instructions.\n\nError: ${errMsg}`,
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
              void persist();
            },
          },
        ],
      });
    }
  } catch (error) {
    logError('Error checking Deno installation', error);
  }
}

/** Settings the setup wizard asks about; Skip resets exactly these. */
const WIZARD_SETTING_KEYS = [
  'theme',
  'flatUi',
  'animateBackground',
  'askDownloadLocation',
  'downloadMode',
  'bestQuality',
  'audioOnly',
  'advancedOptions',
  'embedMetadata',
  'embedThumbnail',
  'sponsorblockRemove',
  'writeSubtitles',
  'subtitleLangs',
  'notifications',
  'checkUpdatesOnStartup',
] as const satisfies readonly (keyof RosiSettings)[];

interface WizardOutcome {
  skipped: boolean;
  /** The user already saw the Deno step, so no follow-up prompt is needed. */
  denoReviewed: boolean;
}

function applyFlatUi(isFlat: boolean) {
  if (isFlat) document.documentElement.dataset.flatUi = 'true';
  else delete document.documentElement.dataset.flatUi;
  try {
    localStorage.setItem('rosi-flat-ui', isFlat ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}

function launchSetupWizard(
  settings: RosiSettings,
  applyThemeFn: (preference: string) => void,
  persistSettingsFn: (silent?: boolean, immediate?: boolean) => Promise<boolean>,
  onComplete: (outcome: WizardOutcome) => void
) {
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
    void persistSettingsFn(false, true).then((saved) => {
      if (saved) onComplete({ skipped: true, denoReviewed: false });
    });
    return;
  }
  const TOTAL_STEPS = steps.length;

  const overlayEl = overlay;
  const progressBarEl = progressBar;
  const wizardProgress = overlayEl.querySelector<HTMLElement>('.wizard-progress');
  wizardProgress?.setAttribute('aria-valuemax', String(TOTAL_STEPS));
  const skipBtn = document.getElementById('wizard-skip') as HTMLButtonElement | null;
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

  // Destination step: the folder is optional when asking every time.
  let wizardChosenFolder = settings.downloadFolder?.trim() || '';
  const wizardFolderSummary = document.getElementById('wizard-folder-summary');
  const wizardChooseFolderBtn = document.getElementById(
    'wizard-choose-folder'
  ) as HTMLButtonElement | null;
  const wizardAskLocation = document.getElementById(
    'wizard-ask-location'
  ) as HTMLInputElement | null;

  const syncWizardFolderSummary = () => {
    if (!wizardFolderSummary) return;
    if (wizardAskLocation?.checked) {
      wizardFolderSummary.textContent = 'ROSI will ask before every download';
      return;
    }
    wizardFolderSummary.textContent = wizardChosenFolder || 'Choose a folder or ask each time';
  };
  if (wizardAskLocation) {
    wizardAskLocation.checked = !!settings.askDownloadLocation;
    wizardAskLocation.addEventListener('change', syncWizardFolderSummary);
  }
  if (wizardChooseFolderBtn) {
    wizardChooseFolderBtn.addEventListener('click', async () => {
      wizardChooseFolderBtn.disabled = true;
      try {
        const chosen = await window.api.selectDownloadLocation();
        if (chosen) {
          wizardChosenFolder = chosen;
          if (wizardAskLocation) wizardAskLocation.checked = false;
          syncWizardFolderSummary();
        }
      } finally {
        wizardChooseFolderBtn.disabled = false;
      }
    });
  }
  const initialProfileValue =
    settings.downloadMode === 'best-video' || settings.downloadMode === 'audio'
      ? settings.downloadMode
      : 'compatible';
  const initialProfileRadio = overlayEl.querySelector<HTMLInputElement>(
    `input[name="wizard-profile"][value="${initialProfileValue}"]`
  );
  if (initialProfileRadio) initialProfileRadio.checked = true;
  syncWizardFolderSummary();

  const wizardCheckbox = (id: string) => document.getElementById(id) as HTMLInputElement | null;

  // Look and feel: preview live, like the theme cards.
  const flatUiInput = wizardCheckbox('wizard-flat-ui');
  const animateBgInput = wizardCheckbox('wizard-animate-bg');
  if (flatUiInput) {
    flatUiInput.checked = !!settings.flatUi;
    flatUiInput.addEventListener('change', () => applyFlatUi(flatUiInput.checked));
  }
  if (animateBgInput) {
    animateBgInput.checked = settings.animateBackground ?? true;
    animateBgInput.addEventListener('change', () =>
      updateBackgroundAnimation(animateBgInput.checked)
    );
  }

  // Download extras.
  const extraInputs: [
    HTMLInputElement | null,
    'embedMetadata' | 'embedThumbnail' | 'sponsorblockRemove' | 'writeSubtitles',
  ][] = [
    [wizardCheckbox('wizard-embed-metadata'), 'embedMetadata'],
    [wizardCheckbox('wizard-embed-thumbnail'), 'embedThumbnail'],
    [wizardCheckbox('wizard-sponsorblock'), 'sponsorblockRemove'],
    [wizardCheckbox('wizard-subtitles'), 'writeSubtitles'],
  ];
  extraInputs.forEach(([input, key]) => {
    if (input) input.checked = !!settings[key];
  });
  const subtitlesInput = wizardCheckbox('wizard-subtitles');
  const subtitleLangsRow = document.getElementById('wizard-subtitle-langs-row');
  const subtitleLangsInput = wizardCheckbox('wizard-subtitle-langs');
  const subtitleLangsError = document.getElementById('wizard-subtitle-langs-error');
  if (subtitleLangsInput) subtitleLangsInput.value = settings.subtitleLangs || 'en';
  const setSubtitleLangsError = (message: string) => {
    if (subtitleLangsError) subtitleLangsError.textContent = message;
    if (message) subtitleLangsInput?.setAttribute('aria-invalid', 'true');
    else subtitleLangsInput?.removeAttribute('aria-invalid');
  };
  const syncSubtitleRow = () => {
    if (subtitleLangsRow) subtitleLangsRow.hidden = !subtitlesInput?.checked;
    if (!subtitlesInput?.checked) setSubtitleLangsError('');
  };
  subtitlesInput?.addEventListener('change', syncSubtitleRow);
  subtitleLangsInput?.addEventListener('input', () => setSubtitleLangsError(''));
  syncSubtitleRow();

  /** Block leaving the extras step with languages the backend would reject. */
  function subtitleLangsValid() {
    if (!subtitlesInput?.checked || !subtitleLangsInput) return true;
    if (isValidSubtitleLangs(subtitleLangsInput.value.trim())) return true;
    setSubtitleLangsError('Enter language codes such as en,es, or use all.');
    subtitleLangsInput.focus();
    return false;
  }

  // YouTube helper: check for Deno the first time the step is shown.
  const stepIndex = (name: string) =>
    Array.from(steps).findIndex((step) => step.dataset.wizardStep === name);
  const extrasStepIndex = stepIndex('extras');
  const denoStepIndex = stepIndex('deno');
  const denoStatus = document.getElementById('wizard-deno-status');
  const denoAction = document.getElementById('wizard-deno-action') as HTMLButtonElement | null;
  let denoChecked = false;
  let denoReviewed = false;

  function setDenoStatus(
    state: 'checking' | 'installed' | 'missing' | 'installing' | 'error',
    text: string
  ) {
    if (!denoStatus) return;
    denoStatus.dataset.state = state;
    const iconName = {
      checking: 'hourglass',
      installing: 'hourglass',
      installed: 'circle-check',
      missing: 'triangle-alert',
      error: 'circle-x',
    }[state];
    const iconSlot = denoStatus.querySelector<HTMLElement>('.wizard-status-icon');
    const textSlot = denoStatus.querySelector<HTMLElement>('.wizard-status-text');
    const svg = iconsModule?.icon(iconName, 18) ?? null;
    if (iconSlot) iconSlot.replaceChildren(...(svg ? [svg] : []));
    if (textSlot) textSlot.textContent = text;
  }

  function setDenoAction(label: string | null, action: (() => void) | null) {
    if (!denoAction) return;
    denoAction.hidden = !label;
    denoAction.disabled = false;
    denoAction.textContent = label ?? '';
    denoAction.onclick = action;
  }

  function showDenoMissing() {
    setDenoStatus(
      'missing',
      "Deno isn't installed. Some YouTube videos may not download until it is."
    );
    if (isLinuxPlatform()) {
      setDenoAction('Open install instructions', () => {
        void window.api.openExternal(DENO_INSTALL_DOCS);
      });
    } else {
      setDenoAction('Install Deno', () => void installDenoFromWizard());
    }
  }

  async function installDenoFromWizard() {
    setDenoStatus('installing', 'Installing Deno. This may take a moment…');
    if (denoAction) denoAction.disabled = true;
    try {
      const result = await window.api.installDeno();
      if (result && result.cancelled) {
        showDenoMissing();
        return;
      }
      if (result?.success !== true) {
        throw new Error(result?.error || 'Deno installation did not complete successfully.');
      }
      setDenoStatus('installed', 'Deno is installed. Restart ROSI after setup to use it.');
      setDenoAction(null, null);
    } catch (error) {
      const message =
        (error as { error?: string })?.error ||
        (error instanceof Error ? error.message : 'Unknown error');
      setDenoStatus('error', `Automatic install failed: ${message}`);
      setDenoAction('Open Deno website', () => {
        void window.api.openExternal('https://deno.land');
      });
    }
  }

  async function checkDenoForWizard() {
    if (denoChecked) return;
    denoChecked = true;
    setDenoStatus('checking', 'Checking for Deno…');
    setDenoAction(null, null);
    try {
      if (await window.api.checkDenoInstalled()) {
        setDenoStatus('installed', 'Deno is installed. YouTube downloads are fully supported.');
      } else {
        showDenoMissing();
      }
    } catch (error) {
      logError('Wizard Deno check failed', error);
      setDenoStatus('error', "Couldn't check for Deno.");
      setDenoAction('Open install instructions', () => {
        void window.api.openExternal(DENO_INSTALL_DOCS);
      });
    }
  }

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

    if (skipBtn) skipBtn.hidden = currentStep === TOTAL_STEPS - 1;
    if (currentStep === denoStepIndex) {
      denoReviewed = true;
      void checkDenoForWizard();
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

    // Destination
    const askLocation = document.getElementById('wizard-ask-location') as HTMLInputElement | null;
    if (askLocation) settings.askDownloadLocation = askLocation.checked;
    if (wizardChosenFolder) settings.downloadFolder = wizardChosenFolder;

    // Default profile
    const selectedProfile = overlayEl.querySelector<HTMLInputElement>(
      'input[name="wizard-profile"]:checked'
    );
    const profile = selectedProfile?.value;
    const mode = profile === 'best-video' || profile === 'audio' ? profile : 'compatible';
    settings.downloadMode = mode;
    settings.bestQuality = mode === 'best-video';
    settings.audioOnly = mode === 'audio';
    settings.advancedOptions = false;
    if (mode === 'audio') settings.convertEnabled = false;

    // Download prefs
    const notifications = document.getElementById(
      'wizard-notifications'
    ) as HTMLInputElement | null;
    const autoUpdates = document.getElementById('wizard-auto-updates') as HTMLInputElement | null;

    if (notifications) settings.notifications = notifications.checked;
    if (autoUpdates) settings.checkUpdatesOnStartup = autoUpdates.checked;

    // Look and feel
    if (flatUiInput) settings.flatUi = flatUiInput.checked;
    if (animateBgInput) settings.animateBackground = animateBgInput.checked;

    // Download extras
    extraInputs.forEach(([input, key]) => {
      if (input) settings[key] = input.checked;
    });
    const langs = subtitleLangsInput?.value.trim() ?? '';
    if (settings.writeSubtitles && isValidSubtitleLangs(langs)) settings.subtitleLangs = langs;
  }

  /** Skip: put every wizard-managed setting back to its default. */
  async function applyWizardDefaults() {
    let defaults: Partial<RosiSettings> | null = null;
    try {
      const result = await window.api.getDefaultSettings();
      if (result && result.ok) defaults = result.data as Partial<RosiSettings>;
    } catch (error) {
      logError('Could not load default settings for setup skip', error);
    }
    if (defaults) {
      const target = settings as unknown as Record<string, unknown>;
      const source = defaults as unknown as Record<string, unknown>;
      WIZARD_SETTING_KEYS.forEach((key) => {
        if (key in source) target[key] = source[key];
      });
    }
    applyThemeFn(settings.theme || 'system');
    applyFlatUi(!!settings.flatUi);
    updateBackgroundAnimation(settings.animateBackground ?? true);
  }

  async function finalizeWizard(skipped: boolean): Promise<boolean> {
    if (!skipped) gatherSettings();
    settings.firstLaunch = false;
    const saved = await persistSettingsFn(false, true);
    if (!saved) return false;

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
    const askLocationToggle = document.getElementById(
      'askDownloadLocationToggle'
    ) as HTMLInputElement | null;
    if (askLocationToggle) askLocationToggle.checked = settings.askDownloadLocation;
    const folderSummary = document.getElementById('downloadFolderSummary');
    if (folderSummary) renderFolderSummary(folderSummary, settings.downloadFolder);

    return true;
  }

  nextBtn.addEventListener('click', () => {
    if (currentStep === extrasStepIndex && !subtitleLangsValid()) return;
    if (currentStep < TOTAL_STEPS - 1) {
      currentStep++;
      updateUI();
    } else {
      void closeWizard(false);
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

  let wizardSkipping = false;
  let wizardClosed = false;
  let wizardSaving = false;

  async function skipWizard() {
    if (wizardSkipping || wizardClosed) return;
    wizardSkipping = true;
    if (skipBtn) skipBtn.disabled = true;
    await applyWizardDefaults();
    await closeWizard(true);
  }
  skipBtn?.addEventListener('click', () => void skipWizard());

  async function closeWizard(skipped = false) {
    if (wizardClosed || wizardSaving) return;
    wizardSaving = true;
    const nextButton = nextBtn as HTMLButtonElement;
    nextButton.disabled = true;
    backBtnEl.disabled = true;
    if (skipBtn) skipBtn.disabled = true;
    const saved = await finalizeWizard(skipped);
    if (!saved) {
      wizardSaving = false;
      wizardSkipping = false;
      nextButton.disabled = false;
      backBtnEl.disabled = false;
      if (skipBtn) skipBtn.disabled = false;
      return;
    }
    wizardClosed = true;
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
    syncModalAccessibility();
    setMainContentInert(false);
    focusTopOverlayOr(wizardPreviousFocus);
    wizardPreviousFocus = null;
    onComplete({ skipped, denoReviewed: !skipped && denoReviewed });
  }

  wizardPreviousFocus = document.activeElement;
  overlayEl.setAttribute('aria-hidden', 'false');
  setMainContentInert(true);

  wizardTrapHandler = (e: KeyboardEvent) => {
    if (getTopActiveOverlayId() !== 'setup-wizard') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      showModal({
        title: 'Skip setup?',
        message: 'Skip setup and start with the default settings?',
        buttons: [
          { label: 'Keep setting up', primary: true },
          { label: 'Skip setup', action: () => void skipWizard() },
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
    if (!overlayEl.classList.contains('active') || getTopActiveOverlayId() !== 'setup-wizard') {
      return;
    }
    const target = e.target;
    if (target instanceof Node && overlayEl.contains(target)) return;
    if (!focusFirstElement(overlayEl) && typeof overlayEl.focus === 'function') {
      overlayEl.focus();
    }
  };
  document.addEventListener('focusin', wizardFocusinHandler, true);

  updateUI();
  overlayEl.classList.add('active');
  syncModalAccessibility();
  requestAnimationFrame(() => {
    if (getTopActiveOverlayId() !== 'setup-wizard') return;
    if (!focusFirstElement(overlayEl)) {
      nextBtnEl.focus();
    }
  });
}

type PrepareForCloseHandler = (generation: number) => Promise<void>;

let resolveRendererStartupReady!: () => void;
const rendererStartupReady = new Promise<void>((resolve) => {
  resolveRendererStartupReady = resolve;
});
window.__ROSI_RENDERER_STARTUP_READY__ = rendererStartupReady;

let resolvePrepareForCloseHandler!: (handler: PrepareForCloseHandler) => void;
let prepareForCloseHandlerIsSet = false;
const prepareForCloseHandlerReady = new Promise<PrepareForCloseHandler>((resolve) => {
  resolvePrepareForCloseHandler = resolve;
});

function setPrepareForCloseHandler(handler: PrepareForCloseHandler) {
  if (prepareForCloseHandlerIsSet) return;
  prepareForCloseHandlerIsSet = true;
  resolvePrepareForCloseHandler(handler);
}

async function initializeRenderer() {
  const ipcCleanupFunctions: Array<() => void> = [];
  ipcCleanupFunctions.push(
    window.api.onPrepareForClose(async (generation) => {
      try {
        const handler = await prepareForCloseHandlerReady;
        await handler(generation);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        showModal({
          title: 'ROSI Could Not Close Safely',
          message: `ROSI could not confirm that settings and the download queue were saved. The app will remain open so you can retry.\n\n${detail}`,
          buttons: [{ label: 'OK', primary: true }],
          priority: true,
        });
      }
    })
  );
  let settingsRevision = 0;
  let settings: RosiSettings;
  let manualDownloadOperation = 0;
  let manualDownloadSessionId: number | null = null;
  let manualSessionIdentityReceived = false;
  let manualDownloadStartPending = false;
  const pendingManualCompletions = new Map<number, RosiDownloadCompletion>();
  let downloadResultTimer: ReturnType<typeof setTimeout> | null = null;
  let progressHideTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    settings = (await window.api.getSettings()) as RosiSettings;
  } catch (error) {
    logError('Failed to load settings', error);
    settings = {
      settingsVersion: 7,
      theme: 'system',
      showConsoleOutput: false,
      dockTab: 'queue',
      dockCollapsed: false,
      downloadMode: 'compatible',
      downloadPresets: [],
      askDownloadLocation: false,
      advancedOptions: false,
      audioFormat: 'mp3',
      convertEnabled: false,
      convertFormat: 'mp4',
      keepOriginalAfterConvert: true,
      firstLaunch: true,
      hookBrowser: false,
      browserChoice: 'chrome',
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
      showTaskbarProgress: true,
    };
    showModal({
      title: 'Settings Error',
      message: 'Could not load settings. Using defaults.',
      buttons: [{ label: 'OK', primary: true }],
    });
  }
  let reconcilingSettings = false;
  const trackSettings = (value: RosiSettings): RosiSettings =>
    new Proxy(value, {
      set(target, property, next, receiver) {
        const previous = Reflect.get(target, property, receiver);
        const applied = Reflect.set(target, property, next, receiver);
        if (applied && !reconcilingSettings && !Object.is(previous, next)) {
          settingsRevision += 1;
        }
        return applied;
      },
      deleteProperty(target, property) {
        const existed = Object.prototype.hasOwnProperty.call(target, property);
        const applied = Reflect.deleteProperty(target, property);
        if (applied && existed && !reconcilingSettings) settingsRevision += 1;
        return applied;
      },
    });
  const reconcileSettingsInPlace = (value: RosiSettings) => {
    const current = settings as unknown as Record<string, unknown>;
    const next = value as unknown as Record<string, unknown>;
    reconcilingSettings = true;
    try {
      Object.keys(current).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(next, key)) delete current[key];
      });
      Object.assign(current, next);
    } finally {
      reconcilingSettings = false;
    }
  };
  settings = trackSettings(settings);
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

  try {
    const platform = await window.api.getAppPlatform();
    const taskbarSetting = document.getElementById('taskbarProgressSetting');
    const taskbarLinuxNote = document.getElementById('taskbarProgressLinuxNote');
    if (platform === 'linux') {
      taskbarSetting?.setAttribute('hidden', '');
      taskbarLinuxNote?.classList.remove('hidden');
    }
  } catch (e) {
    logError('Could not resolve app platform for settings UI', e);
  }

  if (window.api.getChannel() !== 'msstore') {
    try {
      setupAutoUpdater(() => persistSettings(false, true));
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
  let settingsSaveInFlight = false;
  let settingsSaveWaiters: Array<{
    revision: number;
    immediate: boolean;
    silent: boolean;
    resolve: (saved: boolean) => void;
  }> = [];

  function settleSettingsSaveWaiters(revision: number, saved: boolean, latestRevision: number) {
    const settled: typeof settingsSaveWaiters = [];
    const remaining: typeof settingsSaveWaiters = [];
    settingsSaveWaiters.forEach((waiter) => {
      if (waiter.revision > revision) {
        remaining.push(waiter);
      } else if (waiter.immediate && latestRevision > revision) {
        // Lifecycle callers need the latest revision, even if their original
        // snapshot succeeded while a newer edit was waiting behind it.
        waiter.revision = latestRevision;
        remaining.push(waiter);
      } else {
        settled.push(waiter);
      }
    });
    settingsSaveWaiters = remaining;
    settled.forEach((waiter) => waiter.resolve(saved));
    return settled;
  }

  async function drainSettingsSaves() {
    if (settingsSaveInFlight || settingsSaveWaiters.length === 0) return;
    settingsSaveInFlight = true;
    const snapshotRevision = settingsRevision;
    const snapshot = JSON.parse(JSON.stringify(settings)) as RosiSettings;
    let saved = false;
    let errorMessage = 'Could not save settings due to an unexpected error.';

    try {
      const result = await window.api.saveSettings(
        snapshot as unknown as Parameters<typeof window.api.saveSettings>[0]
      );
      if (result?.ok === true) {
        saved = true;
        // The backend may normalize values. Reconcile only if this immutable
        // snapshot is still the newest renderer revision.
        if (snapshotRevision === settingsRevision) {
          reconcileSettingsInPlace(result.data as RosiSettings);
        }
      } else {
        errorMessage = result?.error?.message || 'Could not save settings.';
      }
    } catch {
      // Keep the latest renderer state available for a later retry.
    }

    const latestRevision = settingsRevision;
    const settled = settleSettingsSaveWaiters(snapshotRevision, saved, latestRevision);
    if (!saved && snapshotRevision === latestRevision && settled.some((waiter) => !waiter.silent)) {
      showSettingsSaveError(`${errorMessage}\nChanges may not persist after restart.`);
    }
    settingsSaveInFlight = false;

    // A save requested during this request either fired its debounce already,
    // or explicitly asked for an immediate flush. Preserve debounce spacing
    // for ordinary edits while draining immediate lifecycle callers now.
    const mustContinue = settingsSaveWaiters.some((waiter) => waiter.immediate);
    if (settingsSaveWaiters.length > 0 && (mustContinue || !persistDebounceTimer)) {
      void drainSettingsSaves();
    }
  }

  async function persistSettings(silent = false, immediate = false): Promise<boolean> {
    if (persistDebounceTimer) {
      clearTimeout(persistDebounceTimer);
      persistDebounceTimer = null;
    }
    const promise = new Promise<boolean>((resolve) => {
      settingsSaveWaiters.push({
        revision: settingsRevision,
        immediate,
        silent,
        resolve,
      });
    });
    if (immediate) {
      void drainSettingsSaves();
    } else {
      persistDebounceTimer = setTimeout(() => {
        persistDebounceTimer = null;
        void drainSettingsSaves();
      }, 300);
    }
    return promise;
  }

  setPrepareForCloseHandler(async (generation) => {
    try {
      const saved = await persistSettings(false, true);
      if (!saved) return;
      await window.api.notifySettingsFlushed(generation);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      showModal({
        title: 'ROSI Could Not Close Safely',
        message: `ROSI could not confirm that settings and the download queue were saved. The app will remain open so you can retry.\n\n${detail}`,
        buttons: [{ label: 'OK', primary: true }],
        priority: true,
      });
    }
  });

  async function restartAfterSettingsFlush() {
    if (!(await persistSettings(false, true))) return;
    try {
      await window.api.restartApp();
    } catch (error) {
      showRestartFailure(error);
    }
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
  const profileCompatibleBtn = byId<HTMLButtonElement>('profileCompatibleBtn');
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
  const taskbarProgressToggle = byId<HTMLInputElement>('taskbarProgressToggle');
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
      if (opt.value !== 'firefox') {
        browserChoiceSelect.removeChild(opt);
      }
    });
    browserChoiceSelect.value = 'firefox';
    if (settings.browserChoice?.toLowerCase() !== 'firefox') {
      settings.browserChoice = 'firefox';
      void persistSettings();
    }
    const browserWindowsHint = document.getElementById('browserWindowsHint');
    if (browserWindowsHint) browserWindowsHint.classList.remove('hidden');
  }

  const profileButtons = [
    ['compatible', profileCompatibleBtn],
    ['best-video', profileBestVideoBtn],
    ['audio', profileAudioBtn],
    ['custom', profileCustomBtn],
  ] as const;

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
    // Settings store yt-dlp's lowercase names; older builds sent TitleCase.
    browserChoiceSelect.value = (settings.browserChoice ?? 'chrome').toLowerCase();
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

    toggleAdvancedUI(settings.downloadMode === 'custom');

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
    profileButtons.forEach(([mode, button]) => {
      if (!button) return;
      const isSelected = settings.downloadMode === mode;
      button.classList.toggle('selected', isSelected);
      button.setAttribute('aria-pressed', String(isSelected));
    });
    if (profileAudioFormatSelect) {
      profileAudioFormatSelect.value = settings.audioFormat ?? 'mp3';
    }
    if (profileAudioFormatContainer) {
      profileAudioFormatContainer.classList.toggle('hidden', settings.downloadMode !== 'audio');
    }
    if (askDownloadLocationToggle) {
      askDownloadLocationToggle.checked = !!settings.askDownloadLocation;
    }
    if (downloadFolderSummary) {
      renderFolderSummary(downloadFolderSummary, settings.downloadFolder);
    }
    if (downloadOutputSummary) {
      if (settings.downloadMode === 'best-video') {
        downloadOutputSummary.textContent =
          'Highest available video and audio quality, merged into one file';
      } else if (settings.downloadMode === 'audio') {
        downloadOutputSummary.textContent = `Audio only, saved as ${(settings.audioFormat || 'mp3').toUpperCase()}`;
      } else if (settings.downloadMode === 'custom') {
        downloadOutputSummary.textContent = 'Pick exact video and audio formats below';
      } else {
        downloadOutputSummary.textContent =
          'Prefer MP4 when available; otherwise use the best available format';
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
    if (taskbarProgressToggle) {
      taskbarProgressToggle.checked = settings.showTaskbarProgress ?? true;
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

  try {
    updateUIFromSettings();
  } catch (e) {
    logError('Failed to update UI from settings', e);
  }

  // Runs after a settings pass, so the Console tab is already offered or not.
  function syncDockFromSettings() {
    dockModule?.initDock({
      initialTab: settings.dockTab,
      collapsed: settings.dockCollapsed,
      onChange: ({ tab, collapsed }) => {
        settings.dockTab = tab;
        settings.dockCollapsed = collapsed;
        void persistSettings();
      },
    });
  }
  syncDockFromSettings();

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
          label: 'Yes Support!',
          icon: 'heart',
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
      // Look the bridge up per click so it is never a stale reference.
      settingsModule.bindExternalLink(element, url, (target) => window.api.openExternal(target));
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

  // ── Playlist scope ──────────────────────────────────────────────────────────
  const playlistScope = byId<HTMLElement>('playlistScope');
  const playlistRangeFields = byId<HTMLElement>('playlistRangeFields');
  const playlistRangeStart = byId<HTMLInputElement>('playlistRangeStart');
  const playlistRangeEnd = byId<HTMLInputElement>('playlistRangeEnd');
  const playlistScopeError = byId<HTMLElement>('playlistScopeError');
  const MAX_PLAYLIST_INDEX = 10_000;

  function getPlaylistMode(): 'current' | 'all' | 'range' {
    const selected = document.querySelector<HTMLInputElement>(
      'input[name="playlist-scope"]:checked'
    );
    const value = selected?.value;
    return value === 'all' || value === 'range' ? value : 'current';
  }

  function syncPlaylistRangeVisibility() {
    playlistRangeFields?.classList.toggle('hidden', getPlaylistMode() !== 'range');
  }

  function resetPlaylistScope() {
    playlistScope?.classList.add('hidden');
    if (playlistScopeError) playlistScopeError.textContent = '';
    const currentRadio = document.querySelector<HTMLInputElement>(
      'input[name="playlist-scope"][value="current"]'
    );
    if (currentRadio) currentRadio.checked = true;
    syncPlaylistRangeVisibility();
  }

  function showPlaylistScope(itemCount: number | null) {
    const wasHidden = !playlistScope || playlistScope.classList.contains('hidden');
    playlistScope?.classList.remove('hidden');
    // Only seed the range on first reveal so a typed value is never clobbered
    // by a repeated preview of the same URL.
    if (wasHidden && playlistRangeEnd && itemCount && itemCount > 0) {
      playlistRangeEnd.value = String(Math.min(itemCount, MAX_PLAYLIST_INDEX));
    }
    syncPlaylistRangeVisibility();
  }

  /** Returns a validated typed selection, or null when the range is invalid. */
  function resolvePlaylistSelection(): RosiPlaylistSelection | null {
    if (!playlistScope || playlistScope.classList.contains('hidden')) {
      return { mode: 'current' };
    }
    const mode = getPlaylistMode();
    if (mode !== 'range') {
      if (playlistScopeError) playlistScopeError.textContent = '';
      return { mode };
    }
    const start = Number(playlistRangeStart?.value);
    const end = Number(playlistRangeEnd?.value);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start ||
      end > MAX_PLAYLIST_INDEX
    ) {
      const message = `Enter a playlist range using whole numbers from 1 to ${MAX_PLAYLIST_INDEX}, with the first value no larger than the second.`;
      if (playlistScopeError) playlistScopeError.textContent = message;
      showToast(message, { type: 'warning' });
      return null;
    }
    if (playlistScopeError) playlistScopeError.textContent = '';
    return { mode: 'range', start, end };
  }

  document.querySelectorAll<HTMLInputElement>('input[name="playlist-scope"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      syncPlaylistRangeVisibility();
      if (playlistScopeError) playlistScopeError.textContent = '';
    });
  });
  [playlistRangeStart, playlistRangeEnd].forEach((input) => {
    input?.addEventListener('input', () => {
      if (playlistScopeError) playlistScopeError.textContent = '';
    });
  });
  resetPlaylistScope();

  // ── Preview cache and debounce ──────────────────────────────────────────────
  // Declared ahead of the URL wiring because the first syncPrimaryActionState()
  // call happens during initialization.
  const PREVIEW_CACHE_MAX = 20;
  const PREVIEW_CACHE_TTL_MS = 10 * 60 * 1000;
  const PREVIEW_DEBOUNCE_MS = 450;
  const previewCache = new Map<string, { info: RosiVideoInfo; storedAt: number }>();
  let previewDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // URL whose auto-preview is scheduled, in flight, or already failed. Re-syncs
  // for the same URL (blur, download completion, ...) must not invalidate it.
  let previewTargetUrl: string | null = null;
  let previewRequestToken = 0;
  let activePreviewRequestToken: number | null = null;
  let pendingPreviewUrl: string | null = null;

  function readPreviewCache(url: string): RosiVideoInfo | null {
    const cached = previewCache.get(url);
    if (!cached) return null;
    if (Date.now() - cached.storedAt > PREVIEW_CACHE_TTL_MS) {
      previewCache.delete(url);
      return null;
    }
    return cached.info;
  }

  function writePreviewCache(url: string, info: RosiVideoInfo) {
    previewCache.set(url, { info, storedAt: Date.now() });
    while (previewCache.size > PREVIEW_CACHE_MAX) {
      const oldestKey = previewCache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      previewCache.delete(oldestKey);
    }
  }

  function looksLikePlaylistUrl(url: string) {
    try {
      const parsed = new URL(url);
      return parsed.searchParams.has('list') || /\/playlist(?:\/|$)/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  // Remembered because setButtonLoading(false) restores the button's original
  // markup, which would otherwise discard the label set during a request.
  let previewButtonLabel = 'Preview';

  function setPreviewButtonLabel(label: string) {
    previewButtonLabel = label;
    if (!previewBtn || previewBtn.classList.contains('loading')) return;
    const target = previewBtn.querySelector('.btn-label');
    if (target) target.textContent = label;
  }

  function restorePreviewButtonLabel() {
    setPreviewButtonLabel(previewButtonLabel);
  }

  function cancelScheduledPreview() {
    if (previewDebounceTimer) {
      clearTimeout(previewDebounceTimer);
      previewDebounceTimer = null;
    }
    previewTargetUrl = null;
    pendingPreviewUrl = null;
    previewRequestToken += 1;
    setPreviewButtonLabel('Preview');
  }

  function applyPreviewResult(url: string, info: RosiVideoInfo) {
    lastPreviewUrl = url;
    renderVideoPreview(info);
    if (info.isPlaylist) {
      showPlaylistScope(info.playlistCount);
    } else {
      resetPlaylistScope();
    }
    setPreviewButtonLabel('Refresh');
  }

  /** Auto-preview is best effort: failures stay silent until asked manually. */
  function schedulePreview(url: string) {
    if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
    previewTargetUrl = url;
    const cached = readPreviewCache(url);
    if (cached) {
      // Cache hits still bump the token so an older in-flight fetch cannot repaint.
      previewRequestToken += 1;
      applyPreviewResult(url, cached);
      return;
    }
    previewDebounceTimer = setTimeout(() => {
      previewDebounceTimer = null;
      void runVideoPreview(true);
    }, PREVIEW_DEBOUNCE_MS);
  }

  // ── Saved presets ───────────────────────────────────────────────────────────
  const MAX_PRESETS = 20;
  const downloadPresetSelect = byId<HTMLSelectElement>('downloadPresetSelect');
  const applyPresetBtn = byId<HTMLButtonElement>('applyPresetBtn');
  const presetNameInput = byId<HTMLInputElement>('presetNameInput');
  const savePresetBtn = byId<HTMLButtonElement>('savePresetBtn');
  const deletePresetBtn = byId<HTMLButtonElement>('deletePresetBtn');
  const presetStatus = byId<HTMLElement>('presetStatus');

  function getPresets(): RosiDownloadPreset[] {
    return Array.isArray(settings.downloadPresets) ? settings.downloadPresets : [];
  }

  function getSelectedPreset(): RosiDownloadPreset | null {
    const id = downloadPresetSelect?.value;
    if (!id) return null;
    return getPresets().find((preset) => preset.id === id) ?? null;
  }

  function setPresetStatus(message: string) {
    if (presetStatus) presetStatus.textContent = message;
  }

  function renderPresetOptions(selectedId = downloadPresetSelect?.value ?? '') {
    if (!downloadPresetSelect) return;
    const presets = getPresets();
    downloadPresetSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = presets.length === 0 ? 'No saved presets' : 'Use current settings';
    downloadPresetSelect.appendChild(placeholder);
    presets.forEach((preset) => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      downloadPresetSelect.appendChild(option);
    });
    downloadPresetSelect.value = presets.some((preset) => preset.id === selectedId)
      ? selectedId
      : '';
    downloadPresetSelect.disabled = presets.length === 0;
    if (applyPresetBtn) applyPresetBtn.disabled = !downloadPresetSelect.value;
    if (deletePresetBtn) deletePresetBtn.disabled = !downloadPresetSelect.value;
  }

  function createPresetId(name: string) {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const base = slug || 'preset';
    const existing = new Set(getPresets().map((preset) => preset.id));
    let candidate = base;
    let suffix = 2;
    while (existing.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  function readAdvancedFormatSelections(targetUrl?: string): {
    videoFormat?: string;
    audioFormat?: string;
  } {
    if (!settings.advancedOptions) return {};
    const url =
      targetUrl ?? (document.getElementById('url') as HTMLInputElement | null)?.value.trim();
    if (!url || formatSelectionsUrl !== url) return {};
    const videoSelect = document.getElementById('videoFormat') as HTMLSelectElement | null;
    const audioSelect = document.getElementById('audioFormat') as HTMLSelectElement | null;
    const videoFormat = videoSelect?.value.trim() || undefined;
    const audioFormat = audioSelect?.value.trim() || undefined;
    return { videoFormat, audioFormat };
  }

  function applyFormatIdToSelect(selectId: string, formatId: string | undefined) {
    if (!formatId) return;
    const select = document.getElementById(selectId) as HTMLSelectElement | null;
    if (!select) return;
    if (![...select.options].some((option) => option.value === formatId)) {
      const option = document.createElement('option');
      option.value = formatId;
      option.textContent = `ID: ${formatId}`;
      select.appendChild(option);
    }
    select.value = formatId;
  }

  /** Snapshot only the safe, user-visible download options. */
  function buildPresetFromCurrentSettings(id: string, name: string): RosiDownloadPreset {
    const formats = readAdvancedFormatSelections();
    const preset: RosiDownloadPreset = {
      id,
      name,
      profile: settings.downloadMode,
      bestQuality: settings.bestQuality,
      audioOnly: settings.audioOnly,
      audioFormat: settings.audioFormat,
      convertEnabled: settings.convertEnabled,
      convertFormat: settings.convertFormat,
      keepOriginalAfterConvert: settings.keepOriginalAfterConvert,
      gpuAcceleration: settings.gpuAcceleration,
      gpuType: settings.gpuType,
      writeSubtitles: settings.writeSubtitles,
      subtitleLangs: settings.subtitleLangs,
      embedThumbnail: settings.embedThumbnail,
      embedMetadata: settings.embedMetadata,
      sponsorblockRemove: settings.sponsorblockRemove,
    };
    if (formats.videoFormat) preset.videoFormat = formats.videoFormat;
    if (formats.audioFormat) preset.audioFormatId = formats.audioFormat;
    const playlist = resolvePlaylistSelection();
    if (playlist && playlist.mode !== 'current') preset.playlist = playlist;
    return preset;
  }

  function applyPlaylistSelectionToRadios(playlist: RosiPlaylistSelection | undefined) {
    const mode = playlist?.mode === 'all' || playlist?.mode === 'range' ? playlist.mode : 'current';
    const radio = document.querySelector<HTMLInputElement>(
      `input[name="playlist-scope"][value="${mode}"]`
    );
    if (radio) radio.checked = true;
    if (mode === 'range') {
      if (playlistRangeStart && typeof playlist?.start === 'number') {
        playlistRangeStart.value = String(playlist.start);
      }
      if (playlistRangeEnd && typeof playlist?.end === 'number') {
        playlistRangeEnd.value = String(playlist.end);
      }
    }
    // All/Range presets only work when the scope UI is visible; otherwise
    // resolvePlaylistSelection() invents "current" and stomps the preset.
    if (mode === 'all' || mode === 'range') {
      playlistScope?.classList.remove('hidden');
    }
    syncPlaylistRangeVisibility();
    if (playlistScopeError) playlistScopeError.textContent = '';
  }

  function isPlaylistScopeVisible() {
    return !!(playlistScope && !playlistScope.classList.contains('hidden'));
  }

  /** On-screen download options that must beat a selected preset's stored values. */
  function buildOnScreenPresetOverrides(formatSelections?: {
    videoFormat?: string;
    audioFormat?: string;
  }): Record<string, unknown> {
    const overrides: Record<string, unknown> = {
      profile: settings.downloadMode,
      bestQuality: settings.bestQuality,
      audioOnly: settings.audioOnly,
      advancedOptions: settings.advancedOptions,
      convertEnabled: settings.convertEnabled,
      convertFormat: settings.convertFormat,
      keepOriginal: settings.keepOriginalAfterConvert,
      gpuAcceleration: settings.gpuAcceleration,
      gpuType: settings.gpuType,
      writeSubtitles: settings.writeSubtitles,
      subtitleLangs: settings.subtitleLangs,
      embedThumbnail: settings.embedThumbnail,
      embedMetadata: settings.embedMetadata,
      sponsorblockRemove: settings.sponsorblockRemove,
      audioOutputFormat: settings.audioFormat,
    };
    const formats = formatSelections ?? readAdvancedFormatSelections();
    if (formats.videoFormat) overrides.videoFormat = formats.videoFormat;
    if (formats.audioFormat) overrides.audioFormat = formats.audioFormat;
    return overrides;
  }

  function applyPresetToSettings(preset: RosiDownloadPreset) {
    invalidateFormatRequest();
    clearAdvancedFormatSelections();
    applyDownloadProfile(preset.profile);
    if (typeof preset.bestQuality === 'boolean') settings.bestQuality = preset.bestQuality;
    if (typeof preset.audioOnly === 'boolean') settings.audioOnly = preset.audioOnly;
    if (preset.audioFormat) settings.audioFormat = preset.audioFormat;
    if (typeof preset.convertEnabled === 'boolean') settings.convertEnabled = preset.convertEnabled;
    if (preset.convertFormat) settings.convertFormat = preset.convertFormat;
    if (typeof preset.keepOriginalAfterConvert === 'boolean') {
      settings.keepOriginalAfterConvert = preset.keepOriginalAfterConvert;
    }
    if (typeof preset.gpuAcceleration === 'boolean') {
      settings.gpuAcceleration = preset.gpuAcceleration;
    }
    if (preset.gpuType) settings.gpuType = preset.gpuType;
    if (typeof preset.writeSubtitles === 'boolean') settings.writeSubtitles = preset.writeSubtitles;
    if (preset.subtitleLangs) settings.subtitleLangs = preset.subtitleLangs;
    if (typeof preset.embedThumbnail === 'boolean') settings.embedThumbnail = preset.embedThumbnail;
    if (typeof preset.embedMetadata === 'boolean') settings.embedMetadata = preset.embedMetadata;
    if (typeof preset.sponsorblockRemove === 'boolean') {
      settings.sponsorblockRemove = preset.sponsorblockRemove;
    }
    updateUIFromSettings();
    applyFormatIdToSelect('videoFormat', preset.videoFormat);
    applyFormatIdToSelect('audioFormat', preset.audioFormatId);
    if (preset.videoFormat || preset.audioFormatId) {
      formatSelectionsUrl =
        (document.getElementById('url') as HTMLInputElement | null)?.value.trim() || null;
    }
    applyPlaylistSelectionToRadios(preset.playlist);
  }

  /**
   * Per-job overrides sent with queue additions.
   * Returns `{ ok: false }` when the visible playlist range is invalid so nothing is queued.
   * When playlist radios are visible, their value (including Current) always wins over a
   * selected preset. When the scope UI is still hidden, playlist is omitted so a preset
   * saved as All/Range can apply. Other on-screen settings are always sent with a preset
   * so convert/GPU/profile toggles cannot be silently overwritten.
   */
  function buildQueueRequestOverrides(
    outputPath?: string,
    formatSelections?: { videoFormat?: string; audioFormat?: string }
  ): { ok: false } | { ok: true; overrides?: Record<string, unknown> } {
    const scopeVisible = isPlaylistScopeVisible();
    const playlist = resolvePlaylistSelection();
    if (scopeVisible && !playlist) return { ok: false };

    const overrides: Record<string, unknown> = {};
    if (outputPath) overrides.outputPath = outputPath;
    const formats = formatSelections ?? readAdvancedFormatSelections();
    if (formats.videoFormat) overrides.videoFormat = formats.videoFormat;
    if (formats.audioFormat) overrides.audioFormat = formats.audioFormat;
    const preset = getSelectedPreset();
    if (preset) {
      overrides.presetId = preset.id;
      overrides.presetName = preset.name;
      Object.assign(overrides, buildOnScreenPresetOverrides(formats));
      if (scopeVisible && playlist) overrides.playlist = playlist;
    } else if (scopeVisible && playlist && playlist.mode !== 'current') {
      overrides.playlist = playlist;
    }
    return {
      ok: true,
      overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    };
  }

  if (downloadPresetSelect) {
    downloadPresetSelect.addEventListener('change', () => {
      if (applyPresetBtn) applyPresetBtn.disabled = !downloadPresetSelect.value;
      if (deletePresetBtn) deletePresetBtn.disabled = !downloadPresetSelect.value;
      const preset = getSelectedPreset();
      setPresetStatus(preset ? `${preset.name} selected for the next download.` : '');
    });
  }
  if (applyPresetBtn) {
    applyPresetBtn.addEventListener('click', () => {
      const preset = getSelectedPreset();
      if (!preset) return;
      applyPresetToSettings(preset);
      void persistSettings(true, true);
      setPresetStatus(`Applied ${preset.name}.`);
    });
  }
  if (savePresetBtn) {
    savePresetBtn.addEventListener('click', async () => {
      const name = presetNameInput?.value.trim() ?? '';
      if (!name) {
        setPresetStatus('Enter a name before saving a preset.');
        presetNameInput?.focus();
        return;
      }
      const presets = getPresets();
      const existingIndex = presets.findIndex(
        (preset) => preset.name.toLowerCase() === name.toLowerCase()
      );
      if (existingIndex === -1 && presets.length >= MAX_PRESETS) {
        setPresetStatus(`Preset limit reached (${MAX_PRESETS}). Delete one first.`);
        return;
      }
      const id =
        existingIndex >= 0
          ? (presets[existingIndex] as RosiDownloadPreset).id
          : createPresetId(name);
      const preset = buildPresetFromCurrentSettings(id, name);
      const nextPresets = [...presets];
      if (existingIndex >= 0) {
        nextPresets[existingIndex] = preset;
      } else {
        nextPresets.push(preset);
      }
      settings.downloadPresets = nextPresets;
      const saved = await persistSettings(true, true);
      renderPresetOptions(saved ? id : downloadPresetSelect?.value);
      if (saved) {
        if (presetNameInput) presetNameInput.value = '';
        setPresetStatus(`Saved ${preset.name}.`);
      } else {
        setPresetStatus('Could not save the preset.');
      }
    });
  }
  if (deletePresetBtn) {
    deletePresetBtn.addEventListener('click', async () => {
      const preset = getSelectedPreset();
      if (!preset) return;
      settings.downloadPresets = getPresets().filter((candidate) => candidate.id !== preset.id);
      const saved = await persistSettings(true, true);
      renderPresetOptions('');
      setPresetStatus(saved ? `Deleted ${preset.name}.` : 'Could not delete the preset.');
    });
  }
  renderPresetOptions();

  const presetMenuBtn = byId<HTMLButtonElement>('presetMenuBtn');
  const presetPopover = byId<HTMLElement>('presetPopover');

  function isPresetPopoverOpen() {
    return !!presetPopover && !presetPopover.hidden;
  }

  function setPresetPopoverOpen(open: boolean, { restoreFocus = true } = {}) {
    if (!presetPopover || !presetMenuBtn) return;
    if (open === isPresetPopoverOpen()) return;
    presetPopover.hidden = !open;
    presetMenuBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      const first = presetPopover.querySelector<HTMLElement>(
        'select:not(:disabled), input, button:not(:disabled)'
      );
      first?.focus();
    } else if (restoreFocus) {
      presetMenuBtn.focus();
    }
  }

  if (presetMenuBtn && presetPopover) {
    presetMenuBtn.addEventListener('click', () => {
      setPresetPopoverOpen(!isPresetPopoverOpen());
    });
    presetPopover.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setPresetPopoverOpen(false);
    });
    // Close when focus or a click lands anywhere outside the trigger and popover.
    document.addEventListener('pointerdown', (event) => {
      const target = event.target;
      if (!isPresetPopoverOpen() || !(target instanceof Node)) return;
      if (presetPopover.contains(target) || presetMenuBtn.contains(target)) return;
      setPresetPopoverOpen(false, { restoreFocus: false });
    });
    document.addEventListener('focusin', (event) => {
      const target = event.target;
      if (!isPresetPopoverOpen() || !(target instanceof Node)) return;
      if (presetPopover.contains(target) || presetMenuBtn.contains(target)) return;
      setPresetPopoverOpen(false, { restoreFocus: false });
    });
  }

  // ── Settings search and per-section reset ───────────────────────────────────
  const settingsSearchInput = byId<HTMLInputElement>('settingsSearch');
  const settingsSearchStatus = byId<HTMLElement>('settingsSearchStatus');
  const settingsSections = Array.from(document.querySelectorAll<HTMLElement>('.settings-section'));
  let collapseStateBeforeSearch: boolean[] | null = null;

  function applySettingsSearch(rawQuery: string) {
    const query = rawQuery.trim().toLowerCase();
    if (!query) {
      settingsSections.forEach((section, index) => {
        section.classList.remove('search-hidden');
        section.querySelectorAll<HTMLElement>('.search-hidden').forEach((child) => {
          child.classList.remove('search-hidden');
        });
        // Restore the collapse state the user had before searching.
        if (collapseStateBeforeSearch) {
          const wasCollapsed = collapseStateBeforeSearch[index] === true;
          section.classList.toggle('collapsed', wasCollapsed);
          const header = section.querySelector<HTMLElement>('.settings-section-header');
          header?.setAttribute('aria-expanded', String(!wasCollapsed));
          const sectionBody = section.querySelector<HTMLElement>('.settings-section-body');
          if (sectionBody) sectionBody.inert = wasCollapsed;
        }
      });
      collapseStateBeforeSearch = null;
      if (settingsSearchStatus) settingsSearchStatus.textContent = '';
      return;
    }

    if (!collapseStateBeforeSearch) {
      collapseStateBeforeSearch = settingsSections.map((section) =>
        section.classList.contains('collapsed')
      );
    }

    let matches = 0;
    settingsSections.forEach((section) => {
      const controls = Array.from(
        section.querySelectorAll<HTMLElement>('.setting-row, .settings-btn')
      );
      let sectionMatches = false;
      controls.forEach((control) => {
        const isMatch = (control.textContent || '').toLowerCase().includes(query);
        control.classList.toggle('search-hidden', !isMatch);
        if (isMatch) sectionMatches = true;
      });
      const title = (
        section.querySelector('.settings-section-title')?.textContent || ''
      ).toLowerCase();
      if (title.includes(query)) {
        sectionMatches = true;
        controls.forEach((control) => control.classList.remove('search-hidden'));
      }
      section.classList.toggle('search-hidden', !sectionMatches);
      if (sectionMatches) {
        matches += 1;
        section.classList.remove('collapsed');
        const sectionBody = section.querySelector<HTMLElement>('.settings-section-body');
        if (sectionBody) sectionBody.inert = false;
        section
          .querySelector<HTMLElement>('.settings-section-header')
          ?.setAttribute('aria-expanded', 'true');
      }
    });

    if (settingsSearchStatus) {
      settingsSearchStatus.textContent =
        matches === 0
          ? 'No settings match your search.'
          : `${matches} ${matches === 1 ? 'section matches' : 'sections match'} your search.`;
    }
  }

  if (settingsSearchInput) {
    settingsSearchInput.addEventListener('input', () => {
      applySettingsSearch(settingsSearchInput.value);
    });

    // Clear a stale filter when the sidebar closes, so reopening Settings never
    // shows a partially hidden list the user has forgotten about.
    const sidebarEl = document.getElementById('sidebar');
    if (sidebarEl && typeof MutationObserver === 'function') {
      let sidebarWasOpen = sidebarEl.classList.contains('open');
      const sidebarObserver = new MutationObserver(() => {
        const isOpen = sidebarEl.classList.contains('open');
        if (sidebarWasOpen && !isOpen && settingsSearchInput.value) {
          settingsSearchInput.value = '';
          applySettingsSearch('');
        }
        sidebarWasOpen = isOpen;
      });
      sidebarObserver.observe(sidebarEl, { attributes: true, attributeFilter: ['class'] });
    }
    settingsSearchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !settingsSearchInput.value) return;
      event.stopPropagation();
      settingsSearchInput.value = '';
      applySettingsSearch('');
    });
  }

  const SECTION_RESET_KEYS: Record<string, Array<keyof RosiSettings>> = {
    download: [
      'convertEnabled',
      'convertFormat',
      'keepOriginalAfterConvert',
      'gpuAcceleration',
      'gpuType',
      'ffmpegPath',
    ],
    enhancements: [
      'embedMetadata',
      'embedThumbnail',
      'sponsorblockRemove',
      'writeSubtitles',
      'subtitleLangs',
    ],
    browser: ['hookBrowser', 'browserChoice'],
    interface: [
      'showConsoleOutput',
      'animateBackground',
      'theme',
      'flatUi',
      'notifications',
      'showTaskbarProgress',
    ],
    application: ['checkUpdatesOnStartup', 'updateChannel'],
  };

  let defaultSettingsCache: RosiSettings | null = null;
  async function loadDefaultSettings(): Promise<RosiSettings | null> {
    if (defaultSettingsCache) return defaultSettingsCache;
    if (typeof window.api.getDefaultSettings !== 'function') return null;
    try {
      const result = await window.api.getDefaultSettings();
      if (result && result.ok) {
        defaultSettingsCache = result.data as RosiSettings;
        return defaultSettingsCache;
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  document.querySelectorAll<HTMLButtonElement>('.settings-section-reset').forEach((button) => {
    button.addEventListener('click', async (event) => {
      // Keep the click from bubbling into the section collapse handler.
      event.stopPropagation();
      const sectionName = button.dataset.resetSection ?? '';
      const keys = SECTION_RESET_KEYS[sectionName];
      if (!keys) return;
      const defaults = await loadDefaultSettings();
      if (!defaults) {
        showToast('Could not load default settings.', { type: 'error' });
        return;
      }
      const settingsRecord = settings as unknown as Record<string, unknown>;
      const defaultsRecord = defaults as unknown as Record<string, unknown>;
      keys.forEach((key) => {
        settingsRecord[key] = defaultsRecord[key];
      });
      updateUIFromSettings();
      applyTheme(settings.theme ?? 'system');
      const saved = await persistSettings(true, true);
      showToast(saved ? 'Section restored to defaults.' : 'Could not save the restored section.', {
        type: saved ? 'success' : 'error',
      });
    });
  });

  // ── Activity replay ─────────────────────────────────────────────────────────
  async function replayActivityDownload(entry: RosiDownloadActivity) {
    if (isDownloading) {
      showToast('Wait for the current download to finish first.', { type: 'warning' });
      return;
    }
    const request = { ...(entry.request || {}) } as Record<string, unknown>;
    if (typeof request.url !== 'string' || !request.url.trim()) request.url = entry.url;
    const outputPath =
      typeof request.outputPath === 'string' && request.outputPath.trim()
        ? request.outputPath
        : settings.downloadFolder?.trim() || (await window.api.selectDownloadLocation());
    if (!outputPath) return;
    request.outputPath = outputPath;

    const operation = beginManualDownloadOperation();
    isDownloading = true;
    if (outputEl) outputEl.textContent = '';
    downloadAbort = () => {
      if (operation !== manualDownloadOperation) return;
      isDownloading = false;
      setButtonLoading(downloadBtn, false);
      syncPrimaryActionState();
    };
    setButtonLoading(downloadBtn, true, () => {
      window.api.cancelDownload();
      downloadAbort?.();
      hideProgressBar();
    });
    applyActiveDownloadProgressPhases(settings, 'Starting download...');
    try {
      prepareManualDownloadStart(operation);
      const result = await window.api.downloadVideo(request);
      if (operation !== manualDownloadOperation) return;
      if (!result || result.ok !== true) {
        failManualDownloadStart(operation);
        isDownloading = false;
        setButtonLoading(downloadBtn, false);
        syncPrimaryActionState();
        hideProgressBar();
        showToast(result?.error?.message || 'Could not start that download again.', {
          type: 'error',
        });
      } else {
        receiveManualDownloadStart(result.data, operation);
      }
    } catch (error) {
      if (operation !== manualDownloadOperation) return;
      failManualDownloadStart(operation);
      logError('Failed to replay download', error);
      isDownloading = false;
      setButtonLoading(downloadBtn, false);
      syncPrimaryActionState();
      hideProgressBar();
      showToast('Could not start that download again.', { type: 'error' });
    }
  }

  let hasUrlValidationIntent = false;
  let lastPreviewUrl: string | null = null;
  let lastFormatUrl: string | null = null;
  let pendingBatchUrls: string[] = [];

  function setDownloadButtonLabel(label: string) {
    if (!downloadBtn) return;
    const textSpan = downloadBtn.querySelector('span');
    if (textSpan) {
      textSpan.textContent = label;
    } else {
      downloadBtn.textContent = label;
    }
  }

  function syncPrimaryActionState() {
    const hasInput = !!urlInput;
    const hasPrimaryButton = !!downloadBtn;
    if (!hasInput || !hasPrimaryButton || !urlInput || !downloadBtn) return;
    const raw = urlInput.value || '';
    const trimmed = raw.trim();
    if (trimmed !== lastFormatUrl) {
      lastFormatUrl = trimmed;
      invalidateFormatRequest();
      clearAdvancedFormatSelections();
    }
    const hasValue = trimmed.length > 0;
    const extracted = extractHttpUrls(raw);
    pendingBatchUrls = extracted.urls.length > 1 ? extracted.urls : [];
    const isBatch = pendingBatchUrls.length > 1;
    const validUrl = hasValue && (isBatch || isValidUrl(trimmed));
    const showInvalid = hasUrlValidationIntent && hasValue && !validUrl;

    if (urlInputContainer) {
      urlInputContainer.classList.toggle('is-empty', !hasValue);
      urlInputContainer.classList.toggle('is-valid', validUrl);
      urlInputContainer.classList.toggle('is-invalid', showInvalid);
    }
    if (downloadCard) {
      downloadCard.classList.toggle('is-ready', validUrl);
      downloadCard.classList.toggle('is-batch', isBatch);
    }
    if (showInvalid) {
      urlInput.setAttribute('aria-invalid', 'true');
      if (urlValidationMessage) {
        urlValidationMessage.textContent = 'Enter a valid URL starting with http:// or https://';
      }
    } else {
      urlInput.removeAttribute('aria-invalid');
      if (urlValidationMessage) {
        urlValidationMessage.textContent = isBatch
          ? `${pendingBatchUrls.length} links detected. They will be added to the queue.`
          : '';
      }
    }

    const isLoading = downloadBtn.classList.contains('loading');
    if (!isLoading) {
      downloadBtn.disabled = !validUrl;
      downloadBtn.classList.toggle('is-disabled', !validUrl);
      setDownloadButtonLabel(isBatch ? `Add ${pendingBatchUrls.length} to Queue` : 'Download');
    }

    if (previewBtn && !previewBtn.classList.contains('loading')) {
      previewBtn.disabled = !validUrl || isBatch;
    }
    if (isBatch || (trimmed !== lastPreviewUrl && trimmed !== previewTargetUrl)) {
      // Invalidate in-flight preview for the previous URL before scheduling the next.
      cancelScheduledPreview();
      hideVideoPreview();
      lastPreviewUrl = null;
      resetPlaylistScope();
    }
    if (!isBatch && validUrl && trimmed !== previewTargetUrl) {
      schedulePreview(trimmed);
    } else if (isBatch) {
      cancelScheduledPreview();
    }
  }

  /**
   * With "Ask every time" enabled, prompt once for the whole batch rather than
   * per item, so a queue run is never interrupted by folder pickers.
   */
  async function resolveQueueDestination(): Promise<{ outputPath?: string; cancelled: boolean }> {
    if (!settings.askDownloadLocation) return { cancelled: false };
    try {
      const chosen = await window.api.selectDownloadLocation();
      if (!chosen) return { cancelled: true };
      return { outputPath: chosen, cancelled: false };
    } catch (error) {
      logError('Could not open the folder picker for the queue', error);
      return { cancelled: true };
    }
  }

  async function addUrlsToQueue(urls: string[], rejected = 0) {
    // Guard here as well as in the button handler: the folder prompt below is
    // awaited, and without the lock a second click could queue the batch twice.
    if (queueActionLocks > 0) return false;
    const endQueueAction = beginQueueAction();
    const currentUrl =
      (document.getElementById('url') as HTMLInputElement | null)?.value.trim() ?? '';
    const formatSelections =
      urls.length === 1 && urls[0]?.trim() === currentUrl
        ? readAdvancedFormatSelections(currentUrl)
        : {};
    try {
      const built = buildQueueRequestOverrides(undefined, formatSelections);
      if (!built.ok) {
        setQueueStatusMessage('Fix the playlist range before adding to the queue.');
        return false;
      }
      const destination = await resolveQueueDestination();
      if (destination.cancelled) {
        setQueueStatusMessage('Nothing was queued because no folder was chosen.');
        return false;
      }
      // Main snapshots from disk. Flush the 300ms settings debounce so convert,
      // GPU, and profile toggles made just before Queue are what get stored.
      const saved = await persistSettings(true, true);
      if (!saved) {
        const message = 'Could not save download settings. Please try again.';
        setQueueStatusMessage(message);
        showToast(message, { type: 'error' });
        return false;
      }
      if (destination.outputPath) {
        built.overrides = { ...built.overrides, outputPath: destination.outputPath };
      }
      // Omit the second argument entirely when there is nothing to override.
      const result = built.overrides
        ? await window.api.addToQueue(urls, built.overrides)
        : await window.api.addToQueue(urls);
      if (result && result.ok) {
        const parts = [
          queueMessageForCount(
            result.data.added,
            'Added 1 link to the queue.',
            'Added {count} links to the queue.'
          ),
        ];
        if (result.data.skipped > 0) parts.push(`${result.data.skipped} already queued.`);
        if (rejected > 0) parts.push(`${rejected} ignored as invalid.`);
        announceQueueAction(parts.join(' '));
        dockModule?.selectTab('queue');
        return true;
      }
      const message = result?.error?.message || 'Could not add links to the queue.';
      setQueueStatusMessage(message);
      showToast(message, { type: 'error' });
      return false;
    } catch {
      const message = 'Could not add links to the queue.';
      setQueueStatusMessage(message);
      showToast(message, { type: 'error' });
      return false;
    } finally {
      endQueueAction();
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
      // A new link means a new download, not the last one's result.
      clearDownloadResult();
      updateUrlButtons();
    });
    urlInput.addEventListener('blur', () => {
      hasUrlValidationIntent = true;
      syncPrimaryActionState();
    });
    urlInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (downloadBtn && !downloadBtn.disabled) {
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
          const { urls } = extractHttpUrls(text);
          // Single-line #url strips newlines; join with spaces so Add N still detects batches.
          urlInput.value = urls.length > 1 ? urls.join(' ') : (urls[0] ?? text.trim());
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
      const { urls } = extractHttpUrls(text);
      if (urls.length > 0 && urlInput) {
        urlInput.value = urls.length > 1 ? urls.join(' ') : (urls[0] as string);
        urlInput.dispatchEvent(new Event('input'));
        hasUrlValidationIntent = true;
        syncPrimaryActionState();
      } else if (text) {
        showToast('Dropped content did not contain a valid http or https link.', {
          type: 'warning',
        });
      }
    });
  }

  async function runVideoPreview(auto = false) {
    if (!urlInput || !previewBtn) return;
    const url = urlInput.value.trim();
    if (!url || !isValidUrl(url)) {
      if (!auto) showToast('Enter a valid URL first.', { type: 'warning' });
      return;
    }
    const cached = readPreviewCache(url);
    if (cached && auto) {
      applyPreviewResult(url, cached);
      return;
    }
    if (isFetchingPreview) {
      if (auto) {
        pendingPreviewUrl = url;
        return;
      }
      // Supersede the in-flight lookup so its cleanup cannot clear the loading
      // state we are about to set.
      pendingPreviewUrl = null;
      window.api.cancelVideoInfo();
      previewAbort?.();
    }
    // Stale in-flight replies are ignored via this generation token.
    previewRequestToken += 1;
    const requestToken = previewRequestToken;
    activePreviewRequestToken = requestToken;
    isFetchingPreview = true;

    const card = document.getElementById('preview-card');
    if (card) card.classList.add('visible', 'loading');

    let wasCancelled = false;
    previewAbort = () => {
      wasCancelled = true;
      if (activePreviewRequestToken !== requestToken) return;
      activePreviewRequestToken = null;
      isFetchingPreview = false;
      previewAbort = null;
      setButtonLoading(previewBtn, false);
    };
    setButtonLoading(
      previewBtn,
      true,
      () => {
        if (window.api.cancelVideoInfo) window.api.cancelVideoInfo();
        pendingPreviewUrl = null;
        previewAbort?.();
        hideVideoPreview();
      },
      'Cancel preview'
    );

    try {
      const result = await window.api.getVideoInfo(
        url,
        looksLikePlaylistUrl(url) ? 'all' : 'current'
      );
      if (wasCancelled || requestToken !== previewRequestToken) return;
      if (!result || result.ok !== true) {
        const message = result?.error?.message || 'Could not load preview.';
        if (typeof message === 'string' && message.toLowerCase().includes('cancel')) return;
        hideVideoPreview();
        if (auto) {
          setPreviewButtonLabel('Retry preview');
        } else {
          showToast(`Could not load preview. ${message}`, { type: 'error' });
        }
        return;
      }
      const info = result.data as RosiVideoInfo;
      writePreviewCache(url, info);
      applyPreviewResult(url, info);
    } catch (e) {
      if (!wasCancelled && requestToken === previewRequestToken) {
        hideVideoPreview();
        if (auto) {
          setPreviewButtonLabel('Retry preview');
        } else {
          showToast('Could not load preview.', { type: 'error' });
        }
        logError('Video preview failed', e);
      }
    } finally {
      if (activePreviewRequestToken === requestToken) {
        activePreviewRequestToken = null;
        isFetchingPreview = false;
        previewAbort = null;
        setButtonLoading(previewBtn, false);
        restorePreviewButtonLabel();
        const queuedUrl = pendingPreviewUrl;
        pendingPreviewUrl = null;
        if (queuedUrl && urlInput.value.trim() === queuedUrl) {
          void runVideoPreview(true);
        }
      }
    }
  }

  const runManualVideoPreview = () => {
    void runVideoPreview(false);
  };
  if (previewBtn) {
    previewBtn._originalClick = runManualVideoPreview;
    previewBtn.onclick = runManualVideoPreview;
  }
  if (previewCloseBtn) {
    previewCloseBtn.addEventListener('click', () => {
      if (window.api.cancelVideoInfo) window.api.cancelVideoInfo();
      cancelScheduledPreview();
      previewAbort?.();
      hideVideoPreview();
      lastPreviewUrl = null;
    });
  }

  renderActivity();

  document.querySelectorAll<HTMLButtonElement>('.activity-filter').forEach((button) => {
    button.addEventListener('click', () => {
      const filter = button.dataset.activityFilter;
      if (
        filter === 'all' ||
        filter === 'success' ||
        filter === 'failed' ||
        filter === 'cancelled'
      ) {
        setActivityFilter(filter);
      }
    });
  });

  activityReplayHandler = (entry) => {
    void replayActivityDownload(entry);
  };

  if (typeof window.api.getDownloadActivity === 'function') {
    window.api
      .getDownloadActivity()
      .then((result) => {
        if (result && result.ok) setActivityEntries(result.data);
      })
      .catch(() => {});
  }

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showModal({
        title: 'Clear Activity',
        message: 'Clear the recorded download activity?',
        buttons: [
          { label: 'Cancel' },
          {
            label: 'Clear',
            danger: true,
            action: () => {
              void clearActivity().then((cleared) => {
                if (cleared) showToast('Download activity cleared.', { type: 'info' });
              });
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

  profileButtons.forEach(([mode, button]) => {
    button?.addEventListener('click', () => {
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

  if (taskbarProgressToggle) {
    taskbarProgressToggle.addEventListener('change', (e) => {
      settings.showTaskbarProgress = (e.target as HTMLInputElement).checked;
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
      if (!isValidSubtitleLangs(raw)) {
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
      const previousChannel = settings.updateChannel ?? 'auto';
      settings.updateChannel = (e.target as HTMLSelectElement)
        .value as RosiSettings['updateChannel'];
      // Retire the old update identity before the async settings write can
      // complete; the updater holds that save before its target recheck.
      const save = persistSettings(false, true);
      if (window.api.getChannel() !== 'msstore') {
        window.api.notifyUpdaterChannelChanged?.(settings.updateChannel, save, previousChannel);
      }
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
            action: async () => {
              if (!(await persistSettings(false, true))) return;
              localStorage.removeItem('rosi-flat-ui');
              localStorage.removeItem('rosi-theme');
              try {
                await window.api.resetSettings();
              } catch (error) {
                localStorage.setItem('rosi-flat-ui', settings.flatUi ? 'true' : 'false');
                if (settings.theme) localStorage.setItem('rosi-theme', settings.theme);
                const detail = error instanceof Error ? error.message : String(error);
                showModal({
                  title: 'Reset Did Not Complete',
                  message: `ROSI could not confirm durable state and complete the reset. Your settings were not reset, and the app remains open.\n\n${detail}`,
                  buttons: [{ label: 'OK', primary: true }],
                  priority: true,
                });
              }
            },
          },
        ],
      });
    });

  if (exportSettingsBtn) {
    exportSettingsBtn.addEventListener('click', async () => {
      try {
        if (!(await persistSettings(false, true))) return;
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
                if (!(await persistSettings(false, true))) return;
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
          focusQueueItemId,
          retryQueueItem: async (id: string) => {
            if (typeof window.api.retryQueueItem !== 'function') return;
            focusQueueItemId = id;
            const endQueueAction = beginQueueAction();
            try {
              const result = await window.api.retryQueueItem(id);
              if (!result || !result.ok) {
                focusQueueItemId = null;
                const message = result?.error?.message || 'Could not retry the queue item.';
                setQueueStatusMessage(message);
                showToast(message, { type: 'error' });
              } else {
                // A running queue picks the item up on its own; otherwise the
                // user still has to start it.
                const queueIsRunning = currentQueue.some((item) => item.status === 'downloading');
                announceQueueAction(
                  queueIsRunning
                    ? 'Queued the item again. It will run after the current download.'
                    : 'Queued the item again. Start the queue to run it.'
                );
              }
            } catch {
              focusQueueItemId = null;
              const message = 'Could not retry the queue item.';
              setQueueStatusMessage(message);
              showToast(message, { type: 'error' });
            } finally {
              endQueueAction();
            }
          },
          reorderQueueItem: async (id: string, direction: 'up' | 'down') => {
            if (typeof window.api.reorderQueueItem !== 'function') return;
            focusQueueItemId = id;
            const endQueueAction = beginQueueAction();
            try {
              const result = await window.api.reorderQueueItem({ id, direction });
              if (!result || !result.ok) {
                focusQueueItemId = null;
                const message = result?.error?.message || 'Could not reorder the queue item.';
                setQueueStatusMessage(message);
              } else {
                setQueueStatusMessage(`Moved item ${direction} in the queue.`);
              }
            } catch {
              focusQueueItemId = null;
              setQueueStatusMessage('Could not reorder the queue item.');
            } finally {
              endQueueAction();
            }
          },
          copyDiagnostics: async (item: RosiQueueItem) => {
            const diagnostics = [
              `URL: ${item.url}`,
              `Status: ${item.status}`,
              item.filename ? `File: ${item.filename}` : '',
              item.error ? `Error: ${item.error}` : '',
            ]
              .filter(Boolean)
              .join('\n');
            try {
              await navigator.clipboard.writeText(diagnostics);
              setQueueStatusMessage('Copied diagnostics to the clipboard.');
            } catch {
              showToast('Could not copy diagnostics to the clipboard.', { type: 'warning' });
            }
          },
          openFileLocation: (filePath: string) => revealFileLocation(filePath),
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

  /**
   * Attach transient per-item progress to the matching queue row. Progress is
   * never persisted; a later queue-update broadcast replaces it wholesale.
   */
  function applyQueueItemProgress(event: RosiJobProgressEvent) {
    if (!event.queueItemId) return;
    const target = currentQueue.find((item) => item.id === event.queueItemId);
    if (!target) return;
    if (event.phase === 'idle') {
      delete target.progress;
    } else {
      target.progress = event;
    }
    // Patch the single active row; only fall back to a full render if the row
    // is missing, so frequent progress ticks cannot steal focus.
    const patched =
      queueModule && typeof queueModule.updateQueueItemProgress === 'function'
        ? queueModule.updateQueueItemProgress(target, { queueList, queueSection, queueCount })
        : false;
    if (!patched) renderQueue(currentQueue);
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
      const { urls } = extractHttpUrls(text);
      const dropped = urls.length > 0 ? urls.join('\n') : '';
      if (dropped) {
        const existing = queueUrlInput.value.trim();
        queueUrlInput.value = existing ? `${existing}\n${dropped}` : dropped;
        queueUrlInput.dispatchEvent(new Event('input'));
      } else if (text.trim()) {
        showToast('Dropped content did not contain a valid http or https link.', {
          type: 'warning',
        });
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
      const { urls, rejected } = extractHttpUrls(raw);
      if (urls.length === 0) {
        const message = 'No valid http or https links were found.';
        setQueueStatusMessage(message);
        showToast(message, { type: 'warning' });
        return;
      }
      const added = await addUrlsToQueue(urls, rejected);
      if (added) queueUrlInput.value = '';
    });
  }

  if (startQueueBtn) {
    startQueueBtn.addEventListener('click', async () => {
      if (queueActionLocks > 0) return;
      const endQueueAction = beginQueueAction();
      try {
        const result = await window.api.startQueue();
        if (result && result.ok) {
          applyActiveDownloadProgressPhases(settings, 'Queue download...');
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
      let operation = -1;
      try {
        if (isDownloading) return;

        operation = beginManualDownloadOperation();
        isDownloading = true;
        hasUrlValidationIntent = true;
        syncPrimaryActionState();

        const urlInput = document.getElementById('url') as HTMLInputElement | null;
        const url = urlInput ? urlInput.value : null;
        if (!url || url.trim() === '') {
          failManualDownloadStart(operation);
          isDownloading = false;
          syncPrimaryActionState();
          showToast('Please enter a video URL.', { type: 'warning' });
          return;
        }

        // Multiple links go to the queue instead of the single-download path.
        const batch = extractHttpUrls(url);
        if (batch.urls.length > 1) {
          failManualDownloadStart(operation);
          isDownloading = false;
          const added = await addUrlsToQueue(batch.urls, batch.rejected);
          if (added && urlInput) {
            urlInput.value = '';
            hasUrlValidationIntent = false;
            updateUrlButtons();
          }
          syncPrimaryActionState();
          return;
        }

        // Validate URL format
        if (!isValidUrl(url.trim())) {
          failManualDownloadStart(operation);
          isDownloading = false;
          syncPrimaryActionState();
          showToast('Please enter a valid URL starting with http:// or https://', {
            type: 'warning',
          });
          return;
        }

        const formatSelections = readAdvancedFormatSelections(url.trim());
        if (
          settings.advancedOptions &&
          (!formatSelections.videoFormat || !formatSelections.audioFormat)
        ) {
          failManualDownloadStart(operation);
          isDownloading = false;
          syncPrimaryActionState();
          showToast('Please check resolutions and select video/audio formats first.', {
            type: 'warning',
          });
          return;
        }

        // Capture URL-owned controls before a folder prompt or persistence wait.
        const scopeVisible = isPlaylistScopeVisible();
        const playlist = resolvePlaylistSelection();
        if (scopeVisible && !playlist) {
          failManualDownloadStart(operation);
          isDownloading = false;
          syncPrimaryActionState();
          return;
        }
        const activePreset = getSelectedPreset();
        const presetOverrides = activePreset
          ? {
              presetId: activePreset.id,
              presetName: activePreset.name,
              ...buildOnScreenPresetOverrides(formatSelections),
            }
          : {};
        const ffmpegPath = settings.ffmpegPath;
        const convertFormat = settings.convertEnabled
          ? convertFormatSelect?.value.trim() || undefined
          : undefined;
        const keepOriginal = settings.convertEnabled ? keepOriginalToggle?.checked : undefined;
        let savePath = settings.askDownloadLocation
          ? null
          : settings.downloadFolder?.trim() || null;
        if (!savePath) {
          try {
            savePath = await window.api.selectDownloadLocation();
          } catch (dialogError) {
            failManualDownloadStart(operation);
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
          failManualDownloadStart(operation);
          isDownloading = false;
          syncPrimaryActionState();
          if (outputEl) {
            outputEl.replaceChildren();
            appendConsoleOutput(outputEl, '⚠️ Download cancelled: No save location selected.');
          }
          return;
        }
        settings.downloadFolder = savePath;
        updateUIFromSettings();
        const saved = await persistSettings(true, true);
        if (!saved) {
          failManualDownloadStart(operation);
          isDownloading = false;
          syncPrimaryActionState();
          showToast('Could not save download settings. Please try again.', { type: 'error' });
          return;
        }
        if (outputEl) outputEl.textContent = '';
        downloadAbort = () => {
          if (operation !== manualDownloadOperation) return;
          isDownloading = false;
          setButtonLoading(downloadBtn, false);
          syncPrimaryActionState();
        };
        setButtonLoading(downloadBtn, true, () => {
          window.api.cancelDownload();
          downloadAbort?.();
          hideProgressBar();
        });

        const { videoFormat, audioFormat } = formatSelections;

        applyActiveDownloadProgressPhases(settings, 'Starting download...', {
          videoFormat,
          audioFormat,
        });

        prepareManualDownloadStart(operation);
        const startResult = await window.api.downloadVideo({
          url: url.trim(),
          videoFormat,
          audioFormat,
          outputPath: savePath,
          convertFormat,
          keepOriginal,
          ffmpegPath,
          // When radios are hidden, omit playlist so a selected preset's All/Range applies.
          ...(scopeVisible && playlist ? { playlist } : {}),
          ...presetOverrides,
        });
        if (operation !== manualDownloadOperation) return;
        if (!startResult || startResult.ok !== true) {
          failManualDownloadStart(operation);
          isDownloading = false;
          setButtonLoading(downloadBtn, false);
          syncPrimaryActionState();
          hideProgressBar();
          showToast(
            startResult?.error?.message || 'Download request was rejected before starting.',
            { type: 'error' }
          );
        } else {
          receiveManualDownloadStart(startResult.data, operation);
        }
      } catch (downloadError) {
        if (operation < 0 || operation !== manualDownloadOperation) return;
        failManualDownloadStart(operation);
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

  // After a download the button briefly offers the result ("Open File
  // Location" / "Download complete") with its own click handler.
  function beginManualDownloadOperation(): number {
    manualDownloadOperation += 1;
    manualDownloadSessionId = null;
    manualSessionIdentityReceived = false;
    manualDownloadStartPending = true;
    pendingManualCompletions.clear();
    if (downloadResultTimer !== null) clearTimeout(downloadResultTimer);
    if (progressHideTimer !== null) clearTimeout(progressHideTimer);
    downloadResultTimer = null;
    progressHideTimer = null;
    lastDownloadedFilePath = null;
    downloadAbort = null;
    if (downloadBtn) downloadBtn.onclick = downloadBtn._originalClick ?? null;
    return manualDownloadOperation;
  }

  function prepareManualDownloadStart(operation: number) {
    if (operation !== manualDownloadOperation) return;
    manualDownloadStartPending = true;
    manualSessionIdentityReceived = false;
  }

  function receiveManualDownloadStart(
    started: { started: boolean; sessionId?: number },
    operation: number
  ) {
    if (operation !== manualDownloadOperation) return;
    manualDownloadStartPending = false;
    manualSessionIdentityReceived = true;
    manualDownloadSessionId =
      typeof started.sessionId === 'number' && Number.isSafeInteger(started.sessionId)
        ? started.sessionId
        : null;
    const earlyCompletion =
      manualDownloadSessionId === null
        ? undefined
        : pendingManualCompletions.get(manualDownloadSessionId);
    pendingManualCompletions.clear();
    if (earlyCompletion) showManualDownloadCompletion(earlyCompletion, operation);
  }

  function failManualDownloadStart(operation: number) {
    if (operation !== manualDownloadOperation) return;
    manualDownloadStartPending = false;
    manualSessionIdentityReceived = true;
    manualDownloadSessionId = null;
    pendingManualCompletions.clear();
  }

  function showDownloadResult(ms: number, operation: number) {
    if (operation !== manualDownloadOperation) return;
    if (downloadResultTimer !== null) clearTimeout(downloadResultTimer);
    downloadResultTimer = setTimeout(() => clearDownloadResult(operation), ms);
  }

  function scheduleProgressHide(operation: number) {
    if (progressHideTimer !== null) clearTimeout(progressHideTimer);
    progressHideTimer = setTimeout(() => {
      if (operation !== manualDownloadOperation) return;
      progressHideTimer = null;
      hideProgressBar();
    }, 2000);
  }

  /** Put the Download button back, click handler included. */
  function clearDownloadResult(operation = manualDownloadOperation) {
    if (operation !== manualDownloadOperation || downloadResultTimer === null) return;
    clearTimeout(downloadResultTimer);
    downloadResultTimer = null;
    lastDownloadedFilePath = null;
    setButtonLoading(downloadBtn, false);
    syncPrimaryActionState();
  }

  function showManualDownloadCompletion(
    completion: Pick<
      RosiDownloadCompletion,
      'outcome' | 'statusMessage' | 'outputPath' | 'outputPaths'
    >,
    operation: number
  ) {
    if (operation !== manualDownloadOperation) return;
    if (!downloadBtn) return;
    isDownloading = false;
    manualDownloadStartPending = false;
    downloadAbort = null;
    setButtonLoading(downloadBtn, false);
    syncPrimaryActionState();

    const outputPaths = completion.outputPaths;
    const outputPath =
      completion.outputPath ??
      (outputPaths && outputPaths.length > 0 ? outputPaths[outputPaths.length - 1] : null) ??
      null;
    const isSuccess = completion.outcome === 'success';
    if (isSuccess) {
      lastDownloadedFilePath = outputPath;
      updateProgressBar(100, 'Complete!', '');
      showProgressComplete();
      if (settings.notifications) {
        void window.api.showNotification({
          title: 'Download Complete!',
          body: outputPath
            ? `Saved: ${outputPath.split(/[/\\]/).pop()}`
            : 'Your download has finished.',
          filePath: outputPath ?? undefined,
        });
      }

      if (outputPath) {
        setButtonIconLabel(downloadBtn, 'folder-open', 'Open File Location');
        downloadBtn.disabled = false;
        downloadBtn.onclick = () => {
          void window.api.openFileLocation(outputPath);
        };
        showDownloadResult(8000, operation);
      } else {
        setButtonIconLabel(downloadBtn, 'check', 'Download complete');
        downloadBtn.disabled = false;
        showDownloadResult(2500, operation);
      }
    } else {
      lastDownloadedFilePath = null;
      downloadBtn.onclick = downloadBtn._originalClick ?? null;
    }
    scheduleProgressHide(operation);
  }

  function handleManualDownloadCompletion(completion: RosiDownloadCompletion) {
    if (completion.owner !== 'manual') return;
    if (manualDownloadStartPending) {
      if (typeof completion.sessionId === 'number') {
        if (pendingManualCompletions.size >= 4) {
          const oldest = pendingManualCompletions.keys().next().value;
          if (typeof oldest === 'number') pendingManualCompletions.delete(oldest);
        }
        pendingManualCompletions.set(completion.sessionId, completion);
      }
      return;
    }
    if (!manualSessionIdentityReceived) return;
    if (
      manualDownloadSessionId !== null
        ? completion.sessionId !== manualDownloadSessionId
        : completion.sessionId !== undefined && completion.sessionId !== null
    ) {
      return;
    }
    showManualDownloadCompletion(completion, manualDownloadOperation);
  }

  function handleLegacyManualCompletion(statusMessage: string) {
    if (
      manualDownloadStartPending ||
      !manualSessionIdentityReceived ||
      manualDownloadSessionId !== null ||
      !isDownloading
    ) {
      return;
    }
    const normalizedStatus = String(statusMessage || '').toLowerCase();
    const isCancelled = normalizedStatus.includes('cancel');
    const isSuccess =
      !isCancelled && (statusMessage.includes('✅') || normalizedStatus.includes('complete'));
    showManualDownloadCompletion(
      {
        outcome: isSuccess ? 'success' : isCancelled ? 'cancelled' : 'failed',
        statusMessage,
        outputPath: isSuccess ? (lastDownloadedFilePath ?? undefined) : undefined,
      },
      manualDownloadOperation
    );
  }

  ipcCleanupFunctions.push(
    window.api.onProgress((message) => {
      if (!outputEl) return;
      appendConsoleOutput(outputEl, message);

      if (
        !manualDownloadStartPending &&
        manualSessionIdentityReceived &&
        manualDownloadSessionId === null &&
        isDownloading &&
        (message.includes('Identified file:') || message.includes('Successfully converted to'))
      ) {
        const fileMatch = message.match(/(?:Identified file:|Successfully converted to)\s*(.+)$/);
        if (fileMatch && fileMatch[1]) {
          lastDownloadedFilePath = fileMatch[1].trim();
        }
      }
    })
  );

  ipcCleanupFunctions.push(
    window.api.onJobProgress((event) => {
      if (
        !event.queueItemId &&
        (manualDownloadStartPending ||
          !manualSessionIdentityReceived ||
          (event.sessionId ?? null) !== manualDownloadSessionId)
      ) {
        return;
      }
      if (
        event.queueItemId &&
        isDownloading &&
        manualDownloadSessionId !== null &&
        event.sessionId !== manualDownloadSessionId
      ) {
        return;
      }
      const container = document.getElementById('progress-container');
      if (container && !container.classList.contains('visible') && event.phase !== 'idle') {
        showProgressBar(event.status);
      }
      applyQueueItemProgress(event);
      if (event.phase === 'idle') {
        return;
      }
      applyJobProgress(event);
    })
  );

  ipcCleanupFunctions.push(
    window.api.onMenuAction((action) => {
      if (action === 'check-for-updates') {
        void checkForUpdates();
        return;
      }
      if (action === 'open-settings') {
        const sidebar = document.getElementById('sidebar');
        if (sidebar && !sidebar.classList.contains('open')) {
          toggleSidebar();
        }
        return;
      }
      if (action === 'toggle-sidebar') {
        toggleSidebar();
        return;
      }
      if (action === 'show-licenses') {
        showLicenses();
      }
    })
  );

  ipcCleanupFunctions.push(
    window.api.onComplete((statusMessage) => {
      if (fetchFormatsBtn) setButtonLoading(fetchFormatsBtn, false);
      if (outputEl) appendConsoleOutput(outputEl, statusMessage);
      handleLegacyManualCompletion(statusMessage);
    })
  );

  ipcCleanupFunctions.push(
    window.api.onDownloadComplete((completion) => {
      handleManualDownloadCompletion(completion);
    })
  );

  if (typeof window.api.onDownloadActivityUpdate === 'function') {
    ipcCleanupFunctions.push(
      window.api.onDownloadActivityUpdate((activity) => {
        setActivityEntries(activity);
      })
    );
  }

  ipcCleanupFunctions.push(
    window.api.onQueueUpdate((queue) => {
      renderQueue(queue);
    })
  );

  ipcCleanupFunctions.push(
    window.api.onSettingsImported((importedSettings) => {
      const previousChannel = settings.updateChannel ?? 'auto';
      settingsRevision += 1;
      reconcileSettingsInPlace(importedSettings);
      if (window.api.getChannel() !== 'msstore') {
        window.api.notifyUpdaterChannelChanged?.(
          settings.updateChannel ?? 'auto',
          undefined,
          previousChannel
        );
      }
      try {
        updateUIFromSettings();
        syncDockFromSettings();
        renderPresetOptions();
        applyTheme(settings.theme ?? 'system');
        localStorage.setItem('rosi-flat-ui', settings.flatUi ? 'true' : 'false');
      } catch (e) {
        logError('Failed to refresh UI after settings import', e);
      }
    })
  );

  window.api
    .getQueue()
    .then((queue) => renderQueue(queue))
    .catch(() => {});

  window.addEventListener('beforeunload', () => {
    cancelScheduledPreview();
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
    launchSetupWizard(settings, applyTheme, persistSettings, (outcome) => {
      updateUIFromSettings();
      if (!outcome.denoReviewed) {
        void checkDenoInstallation(
          settings,
          () => persistSettings(),
          () => persistSettings(false, true)
        );
      }
      void checkUpdatesOnStartup();
    });
  } else {
    void checkDenoInstallation(
      settings,
      () => persistSettings(),
      () => persistSettings(false, true)
    );
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
      const topOverlayId = getTopActiveOverlayId();
      if (topOverlayId === 'app-modal') {
        const appModal = document.getElementById('app-modal');
        if (appModal) hideModal(appModal, null);
        return;
      }
      if (topOverlayId === 'licenses-overlay') {
        hideLicenses();
        return;
      }
      if (topOverlayId === 'setup-wizard') return;
      if (topOverlayId === 'sidebar') {
        closeSidebar();
        return;
      }
      if (isPresetPopoverOpen()) {
        setPresetPopoverOpen(false);
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
          { label: 'Restart', primary: true, action: () => void restartAfterSettingsFlush() },
        ],
      });
    }

    // Match the physical key: with Alt held, event.key can be a symbol on macOS.
    const dockTabKeys: Record<string, string> = {
      Digit1: 'queue',
      Digit2: 'activity',
      Digit3: 'console',
    };
    const dockTab = dockTabKeys[event.code];
    const sidebarOpen = document.getElementById('sidebar')?.classList.contains('open');
    // On macOS Option+digit types a character, so leave text fields alone there.
    const typingOnMac =
      isMac() &&
      event.target instanceof HTMLElement &&
      event.target.matches('input, textarea, select, [contenteditable="true"]');
    if (
      event.altKey &&
      !modifierPressed &&
      !event.shiftKey &&
      dockTab &&
      !sidebarOpen &&
      !typingOnMac
    ) {
      event.preventDefault();
      dockModule?.selectTab(dockTab, { focus: true });
    }

    if (modifierPressed && event.key === 'f') {
      event.preventDefault();
      const urlInput = document.getElementById('url') as HTMLInputElement | null;
      if (urlInput) {
        urlInput.focus();
        urlInput.select();
      }
    }

    // With Shift held, event.key is '<' on most layouts; match the physical key.
    const commaKey = event.code === 'Comma' || event.key === ',';
    if (modifierPressed && event.shiftKey && commaKey) {
      event.preventDefault();
      toggleSidebar();
    } else if (modifierPressed && commaKey && !isMac()) {
      // macOS handles Cmd+, through the native Settings menu item.
      event.preventDefault();
      const sidebar = document.getElementById('sidebar');
      if (sidebar && !sidebar.classList.contains('open')) toggleSidebar();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  void initializeRenderer()
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      logError('Renderer startup failed', error);
      setPrepareForCloseHandler(async () => {
        showModal({
          title: 'ROSI Could Not Close Safely',
          message: `ROSI could not finish startup and will remain open.\n\n${detail}`,
          buttons: [{ label: 'OK', primary: true }],
          priority: true,
        });
      });
    })
    .finally(resolveRendererStartupReady);
});
