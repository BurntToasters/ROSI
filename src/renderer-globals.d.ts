// Ambient global declarations for the renderer. The window.api and
// window.rosiModules contracts are declared here so the IIFE renderer modules
// can use them without imports. IPC payload shapes come from
// src/generated/ipc-types.ts, and command names from src/commands.ts.

type RosiIpcError = import('./generated/ipc-types').IpcError;
type RosiIpcResult<T = void> = { ok: true; data: T } | { ok: false; error: RosiIpcError };

interface RosiUpdaterStatusEvent {
  status: 'checking' | 'available' | 'not-available' | 'error' | 'cancelled' | 'downloaded';
  kind?: 'feed' | 'download' | 'install';
  candidateId?: number;
  version?: string;
  releaseNotes?: unknown;
  isBeta?: boolean;
  manualInstall?: boolean;
  message?: string;
}
interface RosiUpdaterProgressEvent {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}
// IPC shapes come from the Rust types (src/generated/ipc-types.ts).
type RosiJobProgressEvent = import('./generated/ipc-types').JobProgressEvent;
type RosiDownloadStats = import('./generated/ipc-types').DownloadStats;
type RosiDownloadCompletion = import('./generated/ipc-types').DownloadCompletion;
type RosiDownloadRequestOptions = import('./generated/ipc-types').DownloadRequestOptions;
type RosiSettings = import('./generated/ipc-types').Settings;
type RosiDownloadActivity = RosiDownloadCompletion;

interface RosiRendererApi {
  restartApp: () => Promise<void>;
  getChannel: () => 'github' | 'msstore';
  getFormats: (url: string) => Promise<RosiIpcResult<string>>;
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
  cancelDownload: () => void;
  cancelFormats: () => void;
  getAppVersion: () => Promise<string>;
  getAppPlatform: () => Promise<NodeJS.Platform>;
  checkDenoInstalled: () => Promise<boolean>;
  installDeno: () => Promise<import('./generated/ipc-types').InstallResult>;
  detectGpu: () => Promise<{ nvidia: boolean; amd: boolean; intel: boolean }>;
  isPackaged: () => Promise<boolean>;
  checkForUpdates: () => Promise<{ error: string; message?: string } | null>;
  notifyUpdaterChannelChanged?: (
    channel: 'auto' | 'stable' | 'beta',
    save?: Promise<boolean>,
    previousChannel?: 'auto' | 'stable' | 'beta'
  ) => void;
  downloadUpdate: (candidateId?: number) => Promise<{
    success?: boolean;
    cancelled?: boolean;
    error?: string;
  }>;
  cancelUpdateDownload: () => void;
  installUpdate: (candidateId?: number) => Promise<void>;
  onUpdaterStatus: (callback: (data: RosiUpdaterStatusEvent) => void) => () => void;
  onUpdaterProgress: (callback: (data: RosiUpdaterProgressEvent) => void) => () => void;
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
  onQueueUpdate: (callback: (queue: RosiQueueItem[]) => void) => () => void;
  onSettingsImported: (callback: (settings: RosiSettings) => void) => () => void;
}

interface RosiUiModule {
  appendConsoleOutput: (outputEl: HTMLElement | null, text: string) => void;
  closeSidebar: () => void;
  getModifierKey: () => 'metaKey' | 'ctrlKey';
  getModifierKeyName: () => 'Cmd' | 'Ctrl';
  isMac: () => boolean;
  isValidUrl: (value: string) => boolean;
  setButtonLoading: (
    button: HTMLButtonElement | null,
    isLoading: boolean,
    onCancel?: (() => void) | null,
    cancelLabel?: string
  ) => void;
  showToast: (
    message: unknown,
    options?: { type?: 'warning' | 'error' | 'success' | 'info'; duration?: number }
  ) => void;
  toggleAdvancedUI: (show: boolean) => void;
  toggleSidebar: () => void;
  updateConsoleVisibility: (show: boolean) => void;
}

interface RosiParsedProgress {
  percent: number;
  totalSize: string;
  speed: string | null;
  eta: string | null;
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

interface RosiDownloadsModule {
  formatBytes: (bytes: number) => string;
  parseYtdlpProgress: (message: string) => RosiParsedProgress | null;
}

interface RosiActivityModule {
  initActivityPanel: (deps: RosiActivityPanelDeps) => RosiActivityPanel;
}

// `progress` is attached by the renderer, not sent by the backend.
type RosiQueueItem = import('./generated/ipc-types').QueueItem & {
  progress?: RosiJobProgressEvent;
};

interface RosiQueueModule {
  renderQueue: (
    queue: RosiQueueItem[],
    elements: {
      queueList: HTMLElement | null;
      queueSection: HTMLElement | null;
      queueCount: HTMLElement | null;
    },
    deps: {
      removeFromQueue: (id: string) => Promise<unknown> | unknown;
      retryQueueItem: (id: string) => Promise<unknown> | unknown;
      reorderQueueItem: (id: string, direction: 'up' | 'down') => Promise<unknown> | unknown;
      copyDiagnostics: (item: RosiQueueItem) => Promise<unknown> | unknown;
      openFileLocation?: (filePath: string) => Promise<unknown> | unknown;
      focusQueueItemId?: string | null;
    }
  ) => void;
  updateQueueItemProgress: (
    item: RosiQueueItem,
    elements: {
      queueList: HTMLElement | null;
      queueSection: HTMLElement | null;
      queueCount: HTMLElement | null;
    }
  ) => boolean;
  resolveQueueSectionElement: (root?: Document) => HTMLElement | null;
}

interface RosiSettingsModule {
  bindExternalLink: (
    element: HTMLElement | null,
    url: string,
    openExternal: (url: string) => unknown
  ) => void;
}

interface RosiUpdatesModule {
  formatUpdateProgressInfo: (
    data: { bytesPerSecond: number; transferred: number; total: number; percent: number },
    formatBytes: (bytes: number) => string
  ) => string;
  isPrereleaseVersion: (version: string) => boolean;
}

type RosiDockTab = 'queue' | 'activity' | 'console';

interface RosiDockModule {
  initDock: (options?: {
    initialTab?: string;
    collapsed?: boolean;
    onChange?: (state: { tab: RosiDockTab; collapsed: boolean }) => void;
  }) => void;
  selectTab: (tab: string, options?: { focus?: boolean }) => void;
  markUnseen: (tab: string) => void;
  setTabAvailable: (tab: string, available: boolean) => void;
  setCollapsed: (collapsed: boolean) => void;
  getState: () => { tab: RosiDockTab; collapsed: boolean };
}

interface RosiIconsModule {
  icon: (name: string, size?: number, className?: string) => SVGSVGElement | null;
  initializeIcons: (root?: ParentNode) => void;
  parseStatus: (text: string) => {
    icon: string | null;
    tone: 'danger' | 'success' | 'warning' | null;
    text: string;
  };
  renderStatus: (target: HTMLElement, text: string) => void;
}

interface RosiModules {
  icons?: RosiIconsModule;
  ui?: RosiUiModule;
  dock?: RosiDockModule;
  downloads?: RosiDownloadsModule;
  activity?: RosiActivityModule;
  queue?: RosiQueueModule;
  settings?: RosiSettingsModule;
  updates?: RosiUpdatesModule;
}

interface Window {
  __ROSI_RENDERER_STARTUP_READY__: Promise<void>;
  api: RosiRendererApi;
  rosiModules?: RosiModules;
}

interface HTMLButtonElement {
  _originalClick?: HTMLButtonElement['onclick'];
}
