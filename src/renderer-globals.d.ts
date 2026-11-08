// Ambient global declarations for the renderer. The window.api contract is
// declared here. IPC payload shapes come from src/generated/ipc-types.ts, and
// command names from src/commands.ts.

type RosiIpcError = import('./generated/ipc-types').IpcError;
type RosiIpcResult<T = void> = { ok: true; data: T } | { ok: false; error: RosiIpcError };

// IPC shapes come from the Rust types (src/generated/ipc-types.ts).
type RosiJobProgressEvent = import('./generated/ipc-types').JobProgressEvent;
type RosiDownloadStats = import('./generated/ipc-types').DownloadStats;
type RosiFormatEntry = import('./generated/ipc-types').FormatEntry;
type RosiDownloadCompletion = import('./generated/ipc-types').DownloadCompletion;
type RosiDownloadRequestOptions = import('./generated/ipc-types').DownloadRequestOptions;
type RosiSettings = import('./generated/ipc-types').Settings;
type RosiExtractedQueueUrls = import('./generated/ipc-types').ExtractedQueueUrls;
type RosiDownloadActivity = RosiDownloadCompletion;

interface RosiRendererApi {
  restartApp: () => Promise<void>;
  getChannel: () => 'github' | 'msstore';
  getFormats: (url: string) => Promise<RosiIpcResult<import('./generated/ipc-types').FormatList>>;
  getVideoInfo: (
    url: string,
    playlistMode?: 'current' | 'all'
  ) => Promise<RosiIpcResult<import('./generated/ipc-types').VideoInfo>>;
  cancelVideoInfo: () => void;
  selectDownloadLocation: () => Promise<string | null>;
  getSettings: () => Promise<RosiSettings>;
  getDefaultSettings: () => Promise<RosiIpcResult<RosiSettings>>;
  saveSettings: (settings: Partial<RosiSettings>) => Promise<RosiIpcResult<RosiSettings>>;
  resetSettings: () => Promise<void>;
  openExternal: (url: string) => Promise<RosiIpcResult<{ opened: boolean }>>;
  downloadVideo: (
    options: Partial<RosiDownloadRequestOptions>
  ) => Promise<RosiIpcResult<import('./generated/ipc-types').DownloadStarted>>;
  resolveDownloadOptions: (
    options: Partial<RosiDownloadRequestOptions>
  ) => Promise<RosiIpcResult<RosiDownloadRequestOptions>>;
  resolvePresetOptions: (presetId: string) => Promise<RosiIpcResult<RosiDownloadRequestOptions>>;
  extractQueueUrls: (text: string) => Promise<RosiIpcResult<RosiExtractedQueueUrls>>;
  cancelDownload: () => void;
  cancelFormats: () => void;
  getAppVersion: () => Promise<string>;
  getAppPlatform: () => Promise<NodeJS.Platform>;
  checkDenoInstalled: () => Promise<boolean>;
  installDeno: () => Promise<import('./generated/ipc-types').InstallResult>;
  detectGpu: () => Promise<{ nvidia: boolean; amd: boolean; intel: boolean }>;
  isPackaged: () => Promise<boolean>;
  onProgress: (callback: (message: string) => void) => () => void;
  onJobProgress: (callback: (data: RosiJobProgressEvent) => void) => () => void;
  onMenuAction: (
    callback: (
      action: 'check-for-updates' | 'open-settings' | 'show-licenses' | 'toggle-sidebar'
    ) => void
  ) => () => void;
  onComplete: (callback: (message: string) => void) => () => void;
  onDownloadComplete: (callback: (completion: RosiDownloadCompletion) => void) => () => void;
  openFileLocation: (filePath: string) => Promise<RosiIpcResult<{ opened: boolean }>>;
  showNotification: (options: {
    title?: string;
    body?: string;
    filePath?: string;
  }) => Promise<RosiIpcResult<{ shown: boolean }>>;
  exportSettings: () => Promise<RosiIpcResult<{ exported: boolean }>>;
  importSettings: () => Promise<RosiIpcResult<{ imported: boolean }>>;
  getStats: () => Promise<RosiDownloadStats>;
  resetStats: () => Promise<RosiIpcResult<void>>;
  getDownloadActivity: () => Promise<RosiIpcResult<RosiDownloadActivity[]>>;
  clearDownloadActivity: () => Promise<RosiIpcResult<void>>;
  onDownloadActivityUpdate: (callback: (activity: RosiDownloadActivity[]) => void) => () => void;
  logError: (message: string) => void;
  setWindowTheme: (theme: 'light' | 'dark') => void;
  notifySettingsFlushed: (generation: number) => Promise<void>;
  addToQueue: (
    urls: string[],
    options?: Partial<RosiDownloadRequestOptions>
  ) => Promise<RosiIpcResult<import('./generated/ipc-types').AddResult>>;
  removeFromQueue: (id: string) => Promise<RosiIpcResult<void>>;
  retryQueueItem: (id: string) => Promise<RosiIpcResult<void>>;
  reorderQueueItem: (request: {
    id: string;
    direction: 'up' | 'down';
  }) => Promise<RosiIpcResult<void>>;
  clearQueue: () => Promise<RosiIpcResult<void>>;
  clearFinishedQueue: () => Promise<RosiIpcResult<{ removed: number }>>;
  isFlatpak: () => Promise<boolean>;
  getQueue: () => Promise<RosiQueueItem[]>;
  startQueue: () => Promise<RosiIpcResult<{ started: boolean }>>;
  cancelQueue: () => Promise<RosiIpcResult<void>>;
  onPrepareForClose: (callback: (generation: number) => void | Promise<void>) => () => void;
  onQueueUpdate: (callback: (snapshot: RosiQueueSnapshot | RosiQueueItem[]) => void) => () => void;
  onSettingsImported: (callback: (settings: RosiSettings) => void) => () => void;
}

interface RosiActivityPanelDeps {
  showToast: (
    message: unknown,
    options?: { type?: 'warning' | 'error' | 'success' | 'info' }
  ) => void;
  renderStatusText: (target: HTMLElement, text: string) => void;
  formatRelativeTime: (timestamp: number) => string;
  revealFileLocation: (filePath: string) => Promise<void>;
  icon: (name: string, size: number) => SVGSVGElement | null;
  markUnseen: (tab: string) => void;
  onReplay: (entry: RosiDownloadActivity) => void;
}

interface RosiActivityPanel {
  setEntries: (entries: RosiDownloadActivity[]) => void;
  clear: () => Promise<boolean>;
}

// `progress` is attached by the renderer, not sent by the backend.
type RosiQueueItem = import('./generated/ipc-types').QueueItem & {
  progress?: RosiJobProgressEvent;
};

// `queue-update` payload. A bare array is accepted for payloads without a revision.
type RosiQueueSnapshot = import('./generated/ipc-types').QueueSnapshot;

interface Window {
  __ROSI_RENDERER_STARTUP_READY__: Promise<void>;
  api: RosiRendererApi;
}

interface HTMLButtonElement {
  _originalClick?: HTMLButtonElement['onclick'];
}
