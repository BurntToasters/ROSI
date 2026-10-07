(function initRosiUiModule(global: Window & typeof globalThis) {
  type ToastType = 'warning' | 'error' | 'success' | 'info';

  interface ToastOptions {
    type?: ToastType;
    duration?: number;
  }

  interface UiModule {
    appendConsoleOutput: (outputEl: HTMLElement | null, text: string) => void;
    closeSidebar: () => void;
    getModifierKey: () => 'metaKey' | 'ctrlKey';
    getModifierKeyName: () => 'Cmd' | 'Ctrl';
    isMac: () => boolean;
    isValidUrl: (value: string) => boolean;
    setButtonLoading: (
      button: UiButtonElement | null,
      isLoading: boolean,
      onCancel?: (() => void) | null,
      cancelLabel?: string
    ) => void;
    showToast: (message: unknown, options?: ToastOptions) => void;
    toggleAdvancedUI: (show: boolean) => void;
    toggleSidebar: () => void;
    updateConsoleVisibility: (show: boolean) => void;
  }

  type UiModules = {
    ui?: UiModule;
    dock?: RosiDockModule;
  };

  type RosiWindow = Window & typeof globalThis & { rosiModules?: UiModules };

  type UiButtonElement = HTMLButtonElement & {
    _originalClick?: HTMLButtonElement['onclick'];
  };

  const TOAST_ICONS: Record<ToastType, string> = {
    warning: 'triangle-alert',
    error: 'circle-x',
    success: 'circle-check',
    info: 'info',
  };

  function lucide(name: string, size: number) {
    return global.rosiModules?.icons?.icon(name, size) ?? null;
  }

  const OUTPUT_MAX_LINES = 4000;

  function isMac() {
    return navigator.platform.toLowerCase().includes('mac');
  }

  function getModifierKey(): 'metaKey' | 'ctrlKey' {
    return isMac() ? 'metaKey' : 'ctrlKey';
  }

  function getModifierKeyName(): 'Cmd' | 'Ctrl' {
    return isMac() ? 'Cmd' : 'Ctrl';
  }

  function isValidUrl(value: string) {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /** The console lives in the dock; showing it means offering its tab. */
  function updateConsoleVisibility(show: boolean) {
    const consoleSection = document.getElementById('console-section');
    if (consoleSection) {
      consoleSection.classList.toggle('visible', !!show);
    }
    const dock = (global as RosiWindow).rosiModules?.dock;
    if (dock) {
      dock.setTabAvailable('console', !!show);
    } else {
      const consoleTab = document.getElementById('dockTabConsole');
      if (consoleTab) consoleTab.hidden = !show;
    }
    document.body.classList.toggle('console-visible', !!show);
  }

  function getToastContainer(type: ToastType) {
    if (type === 'error' || type === 'warning') {
      return (
        document.getElementById('toast-container-assertive') ||
        document.getElementById('toast-container')
      );
    }
    return document.getElementById('toast-container');
  }

  function showToast(message: unknown, options: ToastOptions = {}) {
    const { type = 'info', duration = 4000 } = options;
    const container = getToastContainer(type);
    if (!container) return;

    // Cap visible toasts to prevent screen flooding during rapid errors.
    const MAX_VISIBLE_TOASTS = 5;
    const existing = container.querySelectorAll('.toast');
    if (existing.length >= MAX_VISIBLE_TOASTS) {
      existing[0]?.remove();
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    if (type === 'error' || type === 'warning') {
      toast.setAttribute('role', 'alert');
      toast.setAttribute('aria-live', 'assertive');
    }

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    const toastIcon = lucide(TOAST_ICONS[type] || TOAST_ICONS.info, 20);
    if (toastIcon) icon.appendChild(toastIcon);

    const msg = document.createElement('span');
    msg.className = 'toast-message';
    msg.textContent =
      typeof message === 'string' ? message : message == null ? '' : String(message);

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'toast-dismiss btn btn--ghost btn--xs btn--icon';
    dismissBtn.setAttribute('aria-label', 'Dismiss');
    const dismissIcon = lucide('x', 14);
    if (dismissIcon) dismissBtn.appendChild(dismissIcon);

    toast.appendChild(icon);
    toast.appendChild(msg);
    toast.appendChild(dismissBtn);

    container.appendChild(toast);

    const dismiss = () => {
      toast.classList.remove('visible');
      toast.classList.add('hiding');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
      setTimeout(() => toast.remove(), 500);
    };

    dismissBtn.addEventListener('click', dismiss);
    dismissBtn.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        dismiss();
      }
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toast.classList.add('visible');
      });
    });

    if (duration > 0) {
      setTimeout(dismiss, duration);
    }
  }

  /**
   * One span per line, each followed by a newline so copied text keeps its
   * line breaks. Status emoji render as Lucide icons.
   */
  function appendConsoleOutput(outputEl: HTMLElement | null, text: string) {
    if (!outputEl) return;
    const icons = global.rosiModules?.icons;
    const lines = String(text).split('\n');
    for (const line of lines) {
      const lineEl = document.createElement('span');
      lineEl.className = 'console-line';
      if (icons) icons.renderStatus(lineEl, line);
      else lineEl.textContent = line;
      outputEl.append(lineEl, '\n');
    }
    while (outputEl.childElementCount > OUTPUT_MAX_LINES) {
      outputEl.firstChild?.remove();
      if (outputEl.firstChild?.nodeType === Node.TEXT_NODE) outputEl.firstChild.remove();
    }
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  function setButtonLoading(
    button: UiButtonElement | null,
    isLoading: boolean,
    onCancel?: (() => void) | null,
    cancelLabel = 'Cancel download'
  ) {
    if (!button) return;
    if (!button.dataset.defaultHtml) {
      button.dataset.defaultHtml = button.innerHTML;
    }
    if (!button.dataset.defaultText) {
      button.dataset.defaultText = button.textContent?.trim() ?? '';
    }
    if (isLoading) {
      if (button._originalClick === undefined) {
        button._originalClick = button.onclick;
      }
      button.classList.add('loading');
      button.innerHTML = '<img src="loader.svg" class="loader-icon" alt="Loading...">';
      button.disabled = false;
      button.setAttribute('aria-busy', 'true');
      if (typeof onCancel === 'function') {
        button.setAttribute('aria-label', cancelLabel);
      } else {
        button.removeAttribute('aria-label');
      }
      button.onclick = typeof onCancel === 'function' ? onCancel : null;
    } else {
      button.classList.remove('loading');
      // eslint-disable-next-line no-unsanitized/property -- restores the button's own markup captured earlier from button.innerHTML; trusted app content, no user input.
      button.innerHTML = button.dataset.defaultHtml || button.dataset.defaultText || 'Action';
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.removeAttribute('aria-label');
      button.onclick = button._originalClick ?? null;
    }
  }

  let sidebarTrapHandler: ((event: KeyboardEvent) => void) | null = null;
  let sidebarFocusinHandler: ((event: FocusEvent) => void) | null = null;

  function getTopActiveOverlayId() {
    for (const id of ['app-modal', 'licenses-overlay', 'setup-wizard', 'sidebar']) {
      const overlay = document.getElementById(id);
      const active =
        id === 'sidebar'
          ? overlay?.classList.contains('open')
          : overlay?.classList.contains('active');
      if (active) return id;
    }
    return null;
  }
  let previousSidebarFocus: HTMLElement | null = null;

  function getSidebarFocusableElements(sidebar: HTMLElement): HTMLElement[] {
    return Array.from(
      sidebar.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter(
      (element) =>
        !element.hasAttribute('disabled') &&
        element.getAttribute('aria-hidden') !== 'true' &&
        element.tabIndex !== -1 &&
        element.offsetParent !== null
    );
  }

  function focusFirstSidebarElement(sidebar: HTMLElement): boolean {
    const focusable = getSidebarFocusableElements(sidebar);
    const first = focusable[0];
    if (first) {
      first.focus();
      return true;
    }
    const closeBtn = sidebar.querySelector<HTMLElement>('#closeSidebar');
    if (closeBtn) {
      closeBtn.focus();
      return true;
    }
    return false;
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

  function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar instanceof HTMLElement) {
      sidebar.classList.remove('open');
      sidebar.setAttribute('aria-hidden', 'true');
      if (sidebarTrapHandler) {
        sidebar.removeEventListener('keydown', sidebarTrapHandler);
      }
      sidebarTrapHandler = null;
      if (sidebarFocusinHandler) {
        document.removeEventListener('focusin', sidebarFocusinHandler, true);
      }
      sidebarFocusinHandler = null;
    }
    if (overlay) overlay.classList.remove('active');
    document.body.classList.remove('sidebar-open');
    setMainContentInert(false);
    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn instanceof HTMLElement) settingsBtn.setAttribute('aria-expanded', 'false');
    if (!getTopActiveOverlayId()) {
      if (previousSidebarFocus && typeof previousSidebarFocus.focus === 'function') {
        previousSidebarFocus.focus();
      } else if (settingsBtn instanceof HTMLElement) {
        settingsBtn.focus();
      }
    }
    previousSidebarFocus = null;
  }

  function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (!(sidebar instanceof HTMLElement)) return;

    if (sidebar.classList.contains('open')) {
      closeSidebar();
      return;
    }

    previousSidebarFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sidebar.classList.add('open');
    sidebar.setAttribute('aria-hidden', 'false');
    if (overlay) overlay.classList.add('active');
    document.body.classList.add('sidebar-open');
    setMainContentInert(true);
    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn instanceof HTMLElement) {
      settingsBtn.setAttribute('aria-expanded', 'true');
    }

    const closeBtn = document.getElementById('closeSidebar');
    if (closeBtn instanceof HTMLElement) {
      closeBtn.focus();
    } else {
      focusFirstSidebarElement(sidebar);
    }

    sidebarTrapHandler = (event: KeyboardEvent) => {
      if (getTopActiveOverlayId() !== 'sidebar') return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSidebar();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = getSidebarFocusableElements(sidebar);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (!active || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!active || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    sidebar.addEventListener('keydown', sidebarTrapHandler);

    sidebarFocusinHandler = (event: FocusEvent) => {
      if (!sidebar.classList.contains('open') || getTopActiveOverlayId() !== 'sidebar') return;
      const target = event.target;
      if (target instanceof Node && sidebar.contains(target)) return;
      focusFirstSidebarElement(sidebar);
    };
    document.addEventListener('focusin', sidebarFocusinHandler, true);
  }

  function toggleAdvancedUI(show: boolean) {
    const formatSection = document.getElementById('formatOptions');
    if (formatSection) {
      if (show) {
        formatSection.classList.add('visible');
      } else {
        formatSection.classList.remove('visible');
      }
    }
  }

  const windowRef = global as RosiWindow;
  const moduleTarget = (windowRef.rosiModules ?? {}) as UiModules;
  moduleTarget.ui = {
    appendConsoleOutput,
    closeSidebar,
    getModifierKey,
    getModifierKeyName,
    isMac,
    isValidUrl,
    setButtonLoading,
    showToast,
    toggleAdvancedUI,
    toggleSidebar,
    updateConsoleVisibility,
  };
  windowRef.rosiModules = moduleTarget;
})(window);
