(function initRosiDownloadsModule(global: Window & typeof globalThis) {
  interface ParsedYtdlpProgress {
    percent: number;
    totalSize: string;
    speed: string | null;
    eta: string | null;
  }

  interface DownloadsModule {
    formatBytes: (bytes: number) => string;
    parseYtdlpProgress: (message: string) => ParsedYtdlpProgress | null;
  }

  type DownloadsModules = {
    downloads?: DownloadsModule;
  };

  type RosiWindow = Window & typeof globalThis & { rosiModules?: DownloadsModules };

  function parseYtdlpProgress(message: string): ParsedYtdlpProgress | null {
    const progressMatch = message.match(
      /\[download\]\s+(\d+\.?\d*)%\s+of\s+~?(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/
    );
    if (progressMatch?.[1] && progressMatch[2] && progressMatch[3] && progressMatch[4]) {
      return {
        percent: parseFloat(progressMatch[1]),
        totalSize: progressMatch[2],
        speed: progressMatch[3],
        eta: progressMatch[4],
      };
    }

    const simpleMatch = message.match(/\[download\]\s+(\d+\.?\d*)%\s+of\s+~?(\S+)/);
    if (simpleMatch?.[1] && simpleMatch[2]) {
      return {
        percent: parseFloat(simpleMatch[1]),
        totalSize: simpleMatch[2],
        speed: null,
        eta: null,
      };
    }

    return null;
  }

  function formatBytes(bytes: number) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  const windowRef = global as RosiWindow;
  const moduleTarget = (windowRef.rosiModules ?? {}) as DownloadsModules;
  moduleTarget.downloads = {
    formatBytes,
    parseYtdlpProgress,
  };
  windowRef.rosiModules = moduleTarget;
})(window);
