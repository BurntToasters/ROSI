// Ambient global declarations for the renderer (rosiEngine.ts).
// rosiEngine runs as a plain browser script (no ES module import/export),
// so the window.api / window.rosiModules contracts are declared here rather
// than imported. The authoritative RendererApi shape lives in src/types.ts and
// is guarded by src/tests/preload.test.ts.

interface RosiIpcError {
  code: string;
  message: string;
  details?: string;
}
type RosiIpcResult<T = void> = { ok: true; data: T } | { ok: false; error: RosiIpcError };

interface RosiUpdaterStatusEvent {
  status: 'checking' | 'available' | 'not-available' | 'error' | 'cancelled' | 'downloaded';
  kind?: 'feed' | 'download' | 'install';
  candidateId?: number;
  version?: string;
  releaseNotes?: unknown;
  isBeta?: boolean;
  message?: string;
}
interface RosiUpdaterProgressEvent {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}
interface RosiJobProgressEvent {
  sessionId?: number;
  phase: 'download' | 'merge' | 'convert' | 'idle';
  phasePercent: number | null;
  itemOverallPercent: number;
  overallPercent: number;
  queueItemId?: string;
  status: string;
  details?: string;
  indeterminate?: boolean;
  downloadedBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
}
interface RosiDownloadStats {
  totalDownloads: number;
  successfulDownloads: number;
  failedDownloads: number;
  cancelledDownloads: number;
  totalBytesDownloaded: number;
  formatCounts: Record<string, number>;
  firstDownloadAt: number | null;
  lastDownloadAt: number | null;
}
interface RosiDownloadCompletion {
  id: string;
  sessionId?: number;
  owner: 'manual' | 'queue';
  queueItemId?: string;
  outcome: 'success' | 'failed' | 'cancelled';
  statusMessage: string;
  url: string;
  profile?: 'compatible' | 'best-video' | 'audio' | 'custom';
  presetId?: string;
  presetName?: string;
  request: Record<string, unknown>;
  filename?: string;
  outputPath?: string;
  outputPaths?: string[];
  failedPaths?: string[];
  sizeBytes?: number;
  format?: string;
  error?: string;
  startedAt: number;
  completedAt: number;
}
type RosiDownloadActivity = RosiDownloadCompletion;

interface RosiRendererApi {
  restartApp: () => Promise<void>;
  getChannel: () => 'github' | 'msstore';
  getFormats: (url: string) => Promise<RosiIpcResult<string>>;
  getVideoInfo: (url: string, playlistMode?: 'current' | 'all') => Promise<RosiIpcResult<unknown>>;
  cancelVideoInfo: () => void;
  selectDownloadLocation: () => Promise<string | null>;
  getSettings: () => Promise<unknown>;
  getDefaultSettings: () => Promise<RosiIpcResult<unknown>>;
  saveSettings: (settings: Record<string, unknown>) => Promise<RosiIpcResult<unknown>>;
  resetSettings: () => Promise<void>;
  openExternal: (url: string) => Promise<RosiIpcResult<{ opened: boolean }>>;
  downloadVideo: (
    options: Record<string, unknown>
  ) => Promise<RosiIpcResult<{ started: boolean; sessionId?: number }>>;
  cancelDownload: () => void;
  cancelFormats: () => void;
  getAppVersion: () => Promise<string>;
  getAppPlatform: () => Promise<NodeJS.Platform>;
  checkDenoInstalled: () => Promise<boolean>;
  installDeno: () => Promise<{
    success?: boolean;
    cancelled?: boolean;
    output?: string;
    error?: string;
  }>;
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
    options?: Record<string, unknown>
  ) => Promise<RosiIpcResult<{ added: number; skipped: number }>>;
  removeFromQueue: (id: string) => Promise<RosiIpcResult<void>>;
  retryQueueItem: (id: string) => Promise<RosiIpcResult<void>>;
  reorderQueueItem: (request: {
    id: string;
    direction: 'up' | 'down';
  }) => Promise<RosiIpcResult<void>>;
  clearQueue: () => Promise<RosiIpcResult<void>>;
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

interface RosiQueueItem {
  id: string;
  status: 'pending' | 'downloading' | 'completed' | 'failed' | 'cancelled';
  url: string;
  addedAt?: number;
  startedAt?: number;
  completedAt?: number;
  request?: Record<string, unknown>;
  progress?: RosiJobProgressEvent;
  filename?: string;
  outputPath?: string;
  sizeBytes?: number;
  error?: string;
}

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
