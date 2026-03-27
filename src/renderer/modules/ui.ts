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
      onCancel?: (() => void) | null
    ) => void;
    showToast: (message: unknown, options?: ToastOptions) => void;
    toggleAdvancedUI: (show: boolean) => void;
    toggleSidebar: () => void;
    updateConsoleVisibility: (show: boolean) => void;
  }

  type UiModules = {
    ui?: UiModule;
  };

  type RosiWindow = Window & typeof globalThis & { rosiModules?: UiModules };

  type UiButtonElement = HTMLButtonElement & {
    _originalClick?: ((this: GlobalEventHandlers, ev: MouseEvent) => unknown) | null;
  };

  const TOAST_ICONS: Record<ToastType, string> = {
    warning:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    error:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    success:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };

  const OUTPUT_MAX_CHARS = 200000;

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
    } catch (_) {
      return false;
    }
  }

  function updateConsoleVisibility(show: boolean) {
    const consoleSection = document.getElementById('console-section');
    if (consoleSection) {
      if (show) {
        consoleSection.classList.add('visible');
      } else {
        consoleSection.classList.remove('visible');
      }
    }
    document.body.classList.toggle('console-visible', !!show);
  }

  function showToast(message: unknown, options: ToastOptions = {}) {
    const { type = 'info', duration = 4000 } = options;
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.innerHTML = TOAST_ICONS[type] || TOAST_ICONS.info;

    const msg = document.createElement('span');
    msg.className = 'toast-message';
    msg.textContent =
      typeof message === 'string' ? message : message == null ? '' : String(message);

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'toast-dismiss';
    dismissBtn.setAttribute('aria-label', 'Dismiss');
    dismissBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

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

  function appendConsoleOutput(outputEl: HTMLElement | null, text: string) {
    if (!outputEl) return;
    const nextText = outputEl.textContent + text + '\n';
    if (nextText.length <= OUTPUT_MAX_CHARS) {
      outputEl.textContent = nextText;
    } else {
      outputEl.textContent = nextText.slice(-OUTPUT_MAX_CHARS);
    }
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  function setButtonLoading(
    button: UiButtonElement | null,
    isLoading: boolean,
    onCancel?: (() => void) | null
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
      button.onclick = typeof onCancel === 'function' ? onCancel : null;
    } else {
      button.classList.remove('loading');
      button.innerHTML = button.dataset.defaultHtml || button.dataset.defaultText || 'Action';
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.onclick = button._originalClick ?? null;
    }
  }

  let sidebarTrapHandler: ((event: KeyboardEvent) => void) | null = null;
  let sidebarFocusinHandler: ((event: FocusEvent) => void) | null = null;
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
    if ('inert' in mainContent) {
      (mainContent as HTMLElement & { inert: boolean }).inert = isInert;
    }
    if (isInert) {
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
    if (previousSidebarFocus && typeof previousSidebarFocus.focus === 'function') {
      previousSidebarFocus.focus();
    } else {
      const settingsBtn = document.getElementById('settingsBtn');
      if (settingsBtn instanceof HTMLElement) {
        settingsBtn.setAttribute('aria-expanded', 'false');
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
      if (!sidebar.classList.contains('open')) return;
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
