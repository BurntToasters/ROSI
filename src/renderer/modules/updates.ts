(function initRosiUpdatesModule(global: Window & typeof globalThis) {
  interface UpdateProgressData {
    bytesPerSecond: number;
    percent: number;
    total: number;
    transferred: number;
  }

  interface UpdatesModule {
    formatUpdateProgressInfo: (
      data: UpdateProgressData,
      formatBytes: (bytes: number) => string
    ) => string;
    isPrereleaseVersion: (version: string) => boolean;
  }

  type UpdatesModules = {
    updates?: UpdatesModule;
  };

  type RosiWindow = Window & typeof globalThis & { rosiModules?: UpdatesModules };

  function isPrereleaseVersion(version: string) {
    return /-(beta|alpha|rc)/i.test(version);
  }

  function formatUpdateProgressInfo(
    data: UpdateProgressData,
    formatBytes: (bytes: number) => string
  ) {
    const speed = formatBytes(data.bytesPerSecond) + '/s';
    const downloaded = formatBytes(data.transferred);
    const total = formatBytes(data.total);
    return `${downloaded} / ${total} (${speed}) — ${Math.round(data.percent)}%`;
  }

  const windowRef = global as RosiWindow;
  const moduleTarget = (windowRef.rosiModules ?? {}) as UpdatesModules;
  moduleTarget.updates = {
    formatUpdateProgressInfo,
    isPrereleaseVersion,
  };
  windowRef.rosiModules = moduleTarget;
})(window);
