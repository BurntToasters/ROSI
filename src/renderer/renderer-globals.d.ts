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
  phase: 'download' | 'merge' | 'convert' | 'idle';
  phasePercent: number;
  overallPercent: number;
  status: string;
  details?: string;
  indeterminate?: boolean;
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

interface RosiRendererApi {
  restartApp: () => Promise<void>;
  getChannel: () => 'github' | 'msstore';
  getFormats: (url: string) => Promise<RosiIpcResult<string>>;
  getVideoInfo: (url: string) => Promise<RosiIpcResult<unknown>>;
  cancelVideoInfo: () => void;
  selectDownloadLocation: () => Promise<string | null>;
  getSettings: () => Promise<unknown>;
  saveSettings: (settings: Record<string, unknown>) => Promise<RosiIpcResult<unknown>>;
  resetSettings: () => void;
  openExternal: (url: string) => Promise<RosiIpcResult<{ opened: boolean }>>;
  downloadVideo: (options: Record<string, unknown>) => Promise<RosiIpcResult<{ started: boolean }>>;
  cancelDownload: () => void;
  cancelFormats: () => void;
  getAppVersion: () => Promise<string>;
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
  downloadUpdate: () => Promise<{ success?: boolean; cancelled?: boolean; error?: string }>;
  cancelUpdateDownload: () => void;
  installUpdate: () => void;
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
  logError: (message: string) => void;
  notifySettingsFlushed: () => void;
  addToQueue: (urls: string[]) => Promise<RosiIpcResult<{ added: number }>>;
  removeFromQueue: (id: string) => Promise<RosiIpcResult<void>>;
  clearQueue: () => Promise<RosiIpcResult<void>>;
  getQueue: () => Promise<RosiQueueItem[]>;
  startQueue: () => Promise<RosiIpcResult<{ started: boolean }>>;
  cancelQueue: () => Promise<RosiIpcResult<void>>;
  onPrepareForClose: (callback: () => void | Promise<void>) => () => void;
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

interface RosiDownloadsModule {
  formatBytes: (bytes: number) => string;
  parseYtdlpProgress: (message: string) => RosiParsedProgress | null;
}

interface RosiQueueItem {
  id: string;
  status: 'pending' | 'downloading' | 'completed' | 'failed' | 'cancelled';
  url: string;
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
      escapeHtml: (value: string) => string;
      removeFromQueue: (id: string) => Promise<unknown> | unknown;
      focusQueueItemId?: string | null;
    }
  ) => void;
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

interface RosiModules {
  ui?: RosiUiModule;
  downloads?: RosiDownloadsModule;
  queue?: RosiQueueModule;
  settings?: RosiSettingsModule;
  updates?: RosiUpdatesModule;
}

interface Window {
  api: RosiRendererApi;
  rosiModules?: RosiModules;
}

interface HTMLButtonElement {
  _originalClick?: HTMLButtonElement['onclick'];
}
