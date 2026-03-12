'use strict';
(function initRosiSettingsModule(global) {
  function bindExternalLink(element, url, openExternal) {
    if (!element || typeof openExternal !== 'function') return;
    element.addEventListener('click', (event) => {
      event.preventDefault();
      openExternal(url);
    });
  }
  const windowRef = global;
  const moduleTarget = windowRef.rosiModules ?? {};
  moduleTarget.settings = {
    bindExternalLink,
  };
  windowRef.rosiModules = moduleTarget;
})(window);
