'use strict';
(function initRosiUpdatesModule(global) {
  function isPrereleaseVersion(version) {
    return /-(beta|alpha|rc)/i.test(version);
  }
  function formatUpdateProgressInfo(data, formatBytes) {
    const speed = formatBytes(data.bytesPerSecond) + '/s';
    const downloaded = formatBytes(data.transferred);
    const total = formatBytes(data.total);
    return `${downloaded} / ${total} (${speed}) — ${Math.round(data.percent)}%`;
  }
  const windowRef = global;
  const moduleTarget = windowRef.rosiModules ?? {};
  moduleTarget.updates = {
    formatUpdateProgressInfo,
    isPrereleaseVersion,
  };
  windowRef.rosiModules = moduleTarget;
})(window);
