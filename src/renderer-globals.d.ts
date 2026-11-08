// Ambient global declarations for the renderer. IPC payload shapes come from
// src/generated/ipc-types.ts, and command names from src/commands.ts. The API
// object is in src/api.ts.

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
}

interface HTMLButtonElement {
  _originalClick?: HTMLButtonElement['onclick'];
}
