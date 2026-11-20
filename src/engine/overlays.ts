// Modal queue, focus trapping, overlay accessibility, and the licenses overlay.
import { getModifierKeyName, logError, setButtonIconLabel } from './core';
import { appliedTheme, syncLicensesTheme } from './theme';

export function setMainContentInert(isInert: boolean) {
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

export function getTopActiveOverlayId(): string | null {
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

export function syncModalAccessibility() {
  const topOverlayId = getTopActiveOverlayId();
  for (const id of ['app-modal', 'licenses-overlay', 'setup-wizard']) {
    const overlay = document.getElementById(id);
    if (overlay) overlay.setAttribute('aria-modal', String(topOverlayId === id));
  }
}

export function focusTopOverlayOr(target: Element | null) {
  const topOverlayId = getTopActiveOverlayId();
  if (topOverlayId) {
    const overlay = document.getElementById(topOverlayId);
    // The control that opened the prompt may live inside the overlay underneath
    // it (the reset buttons sit in the open settings sidebar). Return there first.
    if (target instanceof HTMLElement && overlay?.contains(target)) {
      target.focus();
      if (document.activeElement === target) return;
    }
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

// Modal queue system
export interface ModalButton {
  label: string;
  icon?: string;
  action?: () => unknown;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}
export interface ModalData {
  title: string;
  message: unknown;
  key?: string;
  buttons?: ModalButton[];
  priority?: boolean;
  busy?: boolean;
  extra?: (() => Node | null) | Node | null;
  // Runs when the prompt is dismissed without a button (Escape). Never runs for
  // a busy prompt, which cannot be dismissed.
  onDismiss?: () => unknown;
}

export const modalQueue: ModalData[] = [];
export let isModalActive = false;
export let currentModalData: ModalData | null = null;
export let previousFocus: Element | null = null;
export let modalTrapHandler: ((e: KeyboardEvent) => void) | null = null;
export let modalFocusinHandler: ((e: FocusEvent) => void) | null = null;
export let licensesFocusinHandler: ((e: FocusEvent) => void) | null = null;
export let modalHideTimer: ReturnType<typeof setTimeout> | null = null;
export let modalHideGeneration = 0;
export let modalHidingData: ModalData | null = null;

export function detachModalFocusHandlers(modal: HTMLElement | null) {
  if (modal && modalTrapHandler) modal.removeEventListener('keydown', modalTrapHandler);
  if (modalFocusinHandler) document.removeEventListener('focusin', modalFocusinHandler, true);
  modalTrapHandler = null;
  modalFocusinHandler = null;
}

export function cancelModalHide() {
  modalHideGeneration += 1;
  if (modalHideTimer !== null) clearTimeout(modalHideTimer);
  modalHideTimer = null;
  modalHidingData = null;
}

// An iframe is a tab stop in its own right; the licenses frame must be in the
// trap order so keyboard users can reach its text.
const FOCUSABLE_SELECTOR =
  'button, input, select, textarea, a[href], iframe, [tabindex]:not([tabindex="-1"])';

// The licenses frame's real tab stops also include each <details>' <summary>,
// the control that opens it.
const FRAME_TAB_STOP_SELECTOR = `${FOCUSABLE_SELECTOR}, summary`;

// True when the element is rendered and focusable, not merely laid out. offsetParent
// alone is not enough: WebKit and Chromium keep a layout box for a link inside a
// closed <details>, but focus() is refused there. checkVisibility() answers this
// directly where it exists (macOS 15 WebKit, WebView2). The fallback, for WebKitGTK
// builds without it, excludes anything inside a closed <details> except that
// details' own direct <summary>.
function isRenderedTabStop(element: HTMLElement, strict = false): boolean {
  if (typeof element.checkVisibility === 'function') {
    // Strict also treats visibility:hidden as unfocusable.
    return strict
      ? element.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })
      : element.checkVisibility();
  }
  return !isInsideClosedDetails(element);
}

function isInsideClosedDetails(element: HTMLElement): boolean {
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.tagName !== 'DETAILS' || ancestor.hasAttribute('open')) continue;
    const ownSummary = Array.from(ancestor.children).find((child) => child.tagName === 'SUMMARY');
    if (element !== ownSummary) return true;
  }
  return false;
}

// The one focusable list for every parent-document trap (modal, licenses, sidebar).
// It drops elements that cannot take focus: disabled, aria-hidden, inert (itself or
// an ancestor, such as a collapsed settings section), hidden, or in a closed details.
export function getFocusableElements(container: unknown): HTMLElement[] {
  if (!(container instanceof HTMLElement)) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hasAttribute('disabled') &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.tabIndex !== -1 &&
      element.offsetParent !== null &&
      element.closest('[inert]') === null &&
      isRenderedTabStop(element, true)
  );
}

function getFrameTabStops(frameDoc: Document): HTMLElement[] {
  return Array.from(frameDoc.querySelectorAll<HTMLElement>(FRAME_TAB_STOP_SELECTOR)).filter(
    (element) =>
      !element.hasAttribute('disabled') &&
      element.tabIndex !== -1 &&
      element.offsetParent !== null &&
      // A summary is a tab stop only as the toggle of its own details.
      (element.tagName !== 'SUMMARY' || element.parentElement?.tagName === 'DETAILS') &&
      isRenderedTabStop(element)
  );
}

export function focusFirstElement(container: unknown) {
  const focusable = getFocusableElements(container);
  const first = focusable[0];
  if (first && typeof first.focus === 'function') {
    first.focus();
    return true;
  }
  return false;
}

export function showModal({
  title,
  message,
  key,
  buttons = [],
  priority = false,
  busy = false,
  extra = null,
  onDismiss,
}: ModalData) {
  const modalData: ModalData = {
    title,
    message,
    key,
    buttons,
    priority,
    busy,
    extra,
    onDismiss,
  };
  // A prompt that a priority modal pushes aside is shown again afterwards, keyed
  // or not, so a promise waiting on it still settles. A busy prompt has no
  // buttons or dismissal to wait on, so it is not kept.
  let displaced: ModalData | null = null;
  if (priority && isModalActive) {
    if (currentModalData && !currentModalData.busy) displaced = currentModalData;
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
    if (displaced) modalQueue.splice(1, 0, displaced);
  } else {
    modalQueue.push(modalData);
  }
  if (!isModalActive) {
    displayNextModal();
  }
}

// Runs a button action or dismissal callback. A throw or a rejected promise is
// logged and never escapes, so the modal teardown stays on its normal path.
function runModalCallback(callback: (() => unknown) | null | undefined) {
  if (typeof callback !== 'function') return;
  try {
    const result = callback();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).then(undefined, (error: unknown) => {
        logError('Modal action failed', error);
      });
    }
  } catch (error) {
    logError('Modal action failed', error);
  }
}

export function displayNextModal() {
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
    // Nothing to show it in. Settle whoever waits on it, then move on.
    runModalCallback(displayedModalData.onDismiss);
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
      try {
        const extraNode = typeof extra === 'function' ? extra() : extra;
        if (extraNode && extraNode.nodeType) {
          extraEl.appendChild(extraNode as Node);
        }
      } catch (error) {
        logError('Modal extra content failed', error);
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
      dismissActiveModal();
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

  // Focus moves into the prompt now, not on the next frame. A page that runs no
  // frames (a hidden window) would otherwise keep focus on BODY, outside the
  // prompt's keydown trap, and keys pressed before the frame would miss it.
  if (getTopActiveOverlayId() === 'app-modal') {
    if (!focusFirstElement(modal) && typeof modal.focus === 'function') {
      modal.focus();
    }
  }
  requestAnimationFrame(() => {
    if (currentModalData !== displayedModalData || getTopActiveOverlayId() !== 'app-modal') {
      return;
    }
    // Fallback only: never move focus the user has already placed in the prompt.
    if (modal.contains(document.activeElement)) return;
    if (!focusFirstElement(modal) && typeof modal.focus === 'function') {
      modal.focus();
    }
  });
}

/** Dismisses the visible prompt without a button (Escape). Busy prompts stay open. */
export function dismissActiveModal(): boolean {
  const modal = document.getElementById('app-modal');
  const data = currentModalData;
  if (!modal || !data || data.busy) return false;
  hideModal(modal, data.onDismiss);
  return true;
}

// The action runs when the button is pressed, not when the fade ends. A priority
// modal that arrives during the fade cancels the teardown, so an action deferred
// to the teardown would be dropped.
export function hideModal(modal: HTMLElement, action: (() => unknown) | null | undefined) {
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
    if (!isModalActive && modalQueue.length > 0) displayNextModal();
    if (!isModalActive && modalQueue.length === 0) {
      setMainContentInert(false);
      focusTopOverlayOr(previousFocus);
      previousFocus = null;
    }
  }, 200);
  runModalCallback(action);
}

export function retireModal(key: string) {
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

export function showKeyboardShortcuts() {
  const modKey = getModifierKeyName();
  showModal({
    title: 'Keyboard Shortcuts',
    message: `${modKey}+D - Restart application\n${modKey}+F - Focus URL input field\n${modKey}+, - Open settings\n${modKey}+Shift+, - Toggle settings sidebar\n${modKey}+Enter - Submit queue URLs (when focused)\nAlt+↑ / Alt+↓ - Move a pending queue item (when focused)
Alt+1 / Alt+2 / Alt+3 - Show Queue, Activity, or Console`,
    buttons: [{ label: 'OK', primary: true }],
  });
}

export let licensesPreviousFocus: Element | null = null;
export let licensesTrapHandler: ((e: KeyboardEvent) => void) | null = null;
let licensesCleanupTimer: ReturnType<typeof setTimeout> | null = null;

function cancelLicensesCleanup() {
  if (licensesCleanupTimer !== null) clearTimeout(licensesCleanupTimer);
  licensesCleanupTimer = null;
}

// The licenses text lives in a same-origin frame. A key pressed inside the frame
// reaches the frame's own document, not the overlay listener, so it is forwarded
// here: Tab past the last link returns to the close button, Escape closes.
function forwardLicensesFrameKey(event: KeyboardEvent) {
  if (getTopActiveOverlayId() !== 'licenses-overlay') return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    hideLicenses();
    return;
  }
  if (event.key !== 'Tab') return;
  const frameDoc = event.currentTarget as Document;
  const frameFocusables = getFrameTabStops(frameDoc);
  const first = frameFocusables[0];
  const last = frameFocusables[frameFocusables.length - 1];
  const active = frameDoc.activeElement;
  const closeBtn = document.getElementById('close-licenses');
  // The close button comes before the frame in the trap order, so leaving the
  // frame in either direction lands there.
  if (
    (!event.shiftKey && last && active === last) ||
    (event.shiftKey && first && active === first)
  ) {
    event.preventDefault();
    closeBtn?.focus();
  }
}

function attachLicensesFrameKeys() {
  const frame = document.getElementById('licenses-frame');
  if (!(frame instanceof HTMLIFrameElement)) return;
  // A new document after a load has no listener. The same function reference
  // is added at most once per target, so repeated calls are harmless.
  frame.addEventListener('load', attachLicensesFrameKeys);
  frame.contentDocument?.addEventListener('keydown', forwardLicensesFrameKey);
}

export function showLicenses() {
  const licensesOverlay = document.getElementById('licenses-overlay');
  if (licensesOverlay) {
    // Already open (for example, the menu item pressed again). Opening again would
    // take the close button as the focus to restore and add a second trap.
    if (licensesOverlay.classList.contains('active')) {
      licensesOverlay.querySelector<HTMLElement>('#close-licenses')?.focus();
      return;
    }
    // A pending close cleanup would unlock scrolling under the reopened view.
    cancelLicensesCleanup();
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
    attachLicensesFrameKeys();
  }
}

export function hideLicenses() {
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
    cancelLicensesCleanup();
    licensesCleanupTimer = setTimeout(() => {
      licensesCleanupTimer = null;
      if (licensesOverlay.classList.contains('active')) return;
      document.body.style.overflow = '';
      document.body.classList.remove('licenses-open');
    }, 300);
    focusTopOverlayOr(focusToRestore);
  }
}
