// Modal queue, focus trapping, overlay accessibility, and the licenses overlay.
import { getModifierKeyName, setButtonIconLabel } from './core';
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
  action?: () => void;
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

export function getFocusableElements(container: unknown): HTMLElement[] {
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
}: ModalData) {
  const modalData: ModalData = { title, message, key, buttons, priority, busy, extra };
  // A keyed prompt (for example an available update) that a priority modal
  // pushes aside is shown again afterwards instead of being lost.
  let displaced: ModalData | null = null;
  if (priority && isModalActive) {
    if (currentModalData?.key && !currentModalData.busy) displaced = currentModalData;
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

export function hideModal(modal: HTMLElement, action: (() => void) | null | undefined) {
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

export function showLicenses() {
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
    setTimeout(() => {
      document.body.style.overflow = '';
      document.body.classList.remove('licenses-open');
    }, 300);
    focusTopOverlayOr(focusToRestore);
  }
}
