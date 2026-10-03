(function initRosiDockModule(global: Window & typeof globalThis) {
  type DockTab = 'queue' | 'activity' | 'console';

  interface DockState {
    tab: DockTab;
    collapsed: boolean;
  }

  interface DockInitOptions {
    initialTab?: string;
    collapsed?: boolean;
    onChange?: (state: DockState) => void;
  }

  interface DockModule {
    initDock: (options?: DockInitOptions) => void;
    selectTab: (tab: string, options?: { focus?: boolean }) => void;
    markUnseen: (tab: string) => void;
    setTabAvailable: (tab: string, available: boolean) => void;
    setCollapsed: (collapsed: boolean) => void;
    getState: () => DockState;
  }

  type DockModules = {
    dock?: DockModule;
  };

  type RosiWindow = Window & typeof globalThis & { rosiModules?: DockModules };

  const TABS: DockTab[] = ['queue', 'activity', 'console'];

  let state: DockState = { tab: 'queue', collapsed: false };
  let onChange: ((next: DockState) => void) | null = null;
  let bound = false;

  function isDockTab(value: unknown): value is DockTab {
    return typeof value === 'string' && (TABS as string[]).includes(value);
  }

  function getDock() {
    return document.getElementById('dock');
  }

  function getTabButton(tab: DockTab) {
    return getDock()?.querySelector<HTMLButtonElement>(`[data-dock-tab="${tab}"]`) ?? null;
  }

  function getPanel(button: HTMLElement | null) {
    const id = button?.getAttribute('aria-controls');
    return id ? document.getElementById(id) : null;
  }

  function isAvailable(tab: DockTab) {
    const button = getTabButton(tab);
    return !!button && !button.hidden;
  }

  function availableTabs() {
    return TABS.filter(isAvailable);
  }

  /** A panel is empty when its list holds nothing or only its empty message. */
  function isPanelEmpty(panel: HTMLElement | null) {
    const scroll = panel?.querySelector<HTMLElement>('.dock-scroll');
    if (!scroll) return false;
    const first = scroll.firstElementChild;
    if (!first) return !scroll.hasChildNodes();
    return scroll.childElementCount === 1 && first.matches('.queue-empty-message, .history-empty');
  }

  /** Let an empty panel hug its message instead of stretching the dock. */
  function syncEmpty() {
    const panel = getPanel(getTabButton(state.tab));
    getDock()?.classList.toggle('is-empty', isPanelEmpty(panel));
  }

  function notify() {
    onChange?.({ ...state });
  }

  /** Render the current state without reporting it as a user change. */
  function render() {
    TABS.forEach((tab) => {
      const button = getTabButton(tab);
      if (!button) return;
      const selected = tab === state.tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected) button.classList.remove('has-unseen');
      const panel = getPanel(button);
      if (panel) panel.hidden = !selected;
    });
    const dock = getDock();
    dock?.classList.toggle('collapsed', state.collapsed);
    const collapseBtn = document.getElementById('dockCollapseBtn');
    if (collapseBtn) {
      const label = state.collapsed ? 'Expand panel' : 'Collapse panel';
      collapseBtn.setAttribute('aria-expanded', String(!state.collapsed));
      collapseBtn.setAttribute('aria-label', label);
      collapseBtn.title = label;
    }
    syncEmpty();
  }

  function applyTab(tab: DockTab) {
    state.tab = isAvailable(tab) ? tab : 'queue';
  }

  function selectTab(tab: string, options: { focus?: boolean } = {}) {
    if (!isDockTab(tab) || !isAvailable(tab)) return;
    const changed = state.tab !== tab || state.collapsed;
    state.tab = tab;
    // Choosing a tab is a request to see it.
    state.collapsed = false;
    render();
    if (options.focus) getTabButton(tab)?.focus();
    if (changed) notify();
  }

  function setCollapsed(collapsed: boolean) {
    if (state.collapsed === collapsed) return;
    state.collapsed = collapsed;
    render();
    notify();
  }

  function markUnseen(tab: string) {
    if (!isDockTab(tab)) return;
    if (tab === state.tab && !state.collapsed) return;
    getTabButton(tab)?.classList.add('has-unseen');
  }

  function setTabAvailable(tab: string, available: boolean) {
    if (!isDockTab(tab)) return;
    const button = getTabButton(tab);
    if (!button) return;
    button.hidden = !available;
    if (!available && state.tab === tab) {
      // Falling back is not a user choice, so the saved tab is left alone.
      state.tab = 'queue';
      render();
    }
  }

  function handleTabKeydown(event: KeyboardEvent) {
    const current = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-dock-tab]');
    const currentTab = current?.dataset.dockTab;
    if (!isDockTab(currentTab)) return;
    const tabs = availableTabs();
    const index = tabs.indexOf(currentTab);
    let next: DockTab | undefined;
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === 'Home') next = tabs[0];
    else if (event.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    event.preventDefault();
    selectTab(next, { focus: true });
  }

  function initDock(options: DockInitOptions = {}) {
    onChange = options.onChange ?? null;
    state = {
      tab: isDockTab(options.initialTab) ? options.initialTab : 'queue',
      collapsed: !!options.collapsed,
    };
    applyTab(state.tab);
    render();
    if (bound) return;
    bound = true;
    TABS.forEach((tab) => {
      const button = getTabButton(tab);
      if (!button) return;
      button.addEventListener('click', () => selectTab(tab));
      button.addEventListener('keydown', handleTabKeydown);
    });
    document.getElementById('dockCollapseBtn')?.addEventListener('click', () => {
      setCollapsed(!state.collapsed);
    });
    // Lists re-render by replacing their children, so childList is enough.
    const observer = new MutationObserver(syncEmpty);
    getDock()
      ?.querySelectorAll('.dock-scroll')
      .forEach((scroll) => observer.observe(scroll, { childList: true }));
  }

  const windowRef = global as RosiWindow;
  const moduleTarget = (windowRef.rosiModules ?? {}) as DockModules;
  moduleTarget.dock = {
    initDock,
    selectTab,
    markUnseen,
    setTabAvailable,
    setCollapsed,
    getState: () => ({ ...state }),
  };
  windowRef.rosiModules = moduleTarget;
})(window);
