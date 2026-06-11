(function initRosiSettingsModule(global: Window & typeof globalThis) {
  interface SettingsModule {
    bindExternalLink: (
      element: HTMLElement | null,
      url: string,
      openExternal: (url: string) => unknown
    ) => void;
  }

  type SettingsModules = {
    settings?: SettingsModule;
  };

  type RosiWindow = Window & typeof globalThis & { rosiModules?: SettingsModules };

  function bindExternalLink(
    element: HTMLElement | null,
    url: string,
    openExternal: (url: string) => unknown
  ) {
    if (!element || typeof openExternal !== 'function') return;
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openExternal(url);
    });
  }

  const windowRef = global as RosiWindow;
  const moduleTarget = (windowRef.rosiModules ?? {}) as SettingsModules;
  moduleTarget.settings = {
    bindExternalLink,
  };
  windowRef.rosiModules = moduleTarget;
})(window);
