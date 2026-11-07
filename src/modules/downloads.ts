(function initRosiDownloadsModule(global: Window & typeof globalThis) {
  interface DownloadsModule {
    formatBytes: (bytes: number) => string;
    formatFormatEntry: (format: RosiFormatEntry) => string;
  }

  type DownloadsModules = {
    downloads?: DownloadsModule;
  };

  type RosiWindow = Window & typeof globalThis & { rosiModules?: DownloadsModules };

  function formatBytes(bytes: number) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function formatFormatEntry(format: RosiFormatEntry) {
    let label = `ID: ${format.formatId}`;
    if (format.resolution) label += ` ${format.resolution}`;
    if (typeof format.fps === 'number' && Number.isFinite(format.fps)) {
      const fps = Number.isInteger(format.fps)
        ? String(format.fps)
        : String(Number(format.fps.toFixed(2)));
      label += ` ${fps}fps`;
    }
    const codecs = [format.vcodec, format.acodec].filter(
      (codec): codec is string => typeof codec === 'string' && codec.length > 0
    );
    if (codecs.length > 0) label += ` (${codecs.join(' + ')})`;
    if (format.streamKind === 'audioVideo') label += ' (video + audio)';
    if (typeof format.fileSizeBytes === 'number') {
      label += ` ${formatBytes(format.fileSizeBytes)}`;
    } else if (typeof format.estimatedSizeBytes === 'number') {
      label += ` ~${formatBytes(format.estimatedSizeBytes)}`;
    }
    return label;
  }

  const windowRef = global as RosiWindow;
  const moduleTarget = (windowRef.rosiModules ?? {}) as DownloadsModules;
  moduleTarget.downloads = {
    formatBytes,
    formatFormatEntry,
  };
  windowRef.rosiModules = moduleTarget;
})(window);

// Imported for its side effect of attaching to window.rosiModules.
export {};
