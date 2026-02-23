export interface Settings {
  settingsVersion: number;
  showConsoleOutput: boolean;
  consoleCollapsed: boolean;
  advancedOptions: boolean;
  audioOnly: boolean;
  convertEnabled: boolean;
  convertFormat: string;
  keepOriginalAfterConvert: boolean;
  firstLaunch: boolean;
  hookBrowser: boolean;
  browserChoice: string;
  animateBackground: boolean;
  notifications: boolean;
  denoReminderDismissed: boolean;
  gpuAcceleration: boolean;
  gpuType: 'auto' | 'nvidia' | 'amd' | 'intel';
  bestQuality: boolean;
  ffmpegPath: string;
  hideSupportModal: boolean;
  checkUpdatesOnStartup: boolean;
  updateChannel: UpdateChannel;
}

export type UpdateChannel = 'auto' | 'stable' | 'beta';

export type DistributionChannel = 'github' | 'msstore';

export type IpcErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_URL'
  | 'INVALID_PATH'
  | 'NOT_SUPPORTED'
  | 'NOT_AVAILABLE'
  | 'INTERNAL_ERROR';

export interface IpcErrorPayload {
  code: IpcErrorCode;
  message: string;
  details?: string;
}

export type IpcResult<T = void> = { ok: true; data: T } | { ok: false; error: IpcErrorPayload };

export interface DownloadLifecycleState {
  cancelled: boolean;
  completed: boolean;
}

export interface DownloadSession {
  id: number;
  sender: Electron.WebContents;
  lifecycle: DownloadLifecycleState;
  ytdlpProcess: import('child_process').ChildProcess | null;
  ffmpegProcess: import('child_process').ChildProcess | null;
}

export interface DownloadRequestOptions {
  url: string;
  outputPath: string;
  ffmpegPath?: string;
  convertFormat?: string;
  keepOriginal?: boolean;
  videoFormat?: string;
  audioFormat?: string;
}

export interface GpuDetectionResult {
  nvidia: boolean;
  amd: boolean;
  intel: boolean;
}

export interface FormatsProcess {
  proc: import('child_process').ChildProcess;
  cancelled: boolean;
}

export interface NotificationRequest {
  title?: string;
  body?: string;
  filePath?: string;
}

export type UpdaterStatusEvent =
  | { status: 'checking' }
  | {
      status: 'available';
      version: string;
      releaseNotes: string | null | import('builder-util-runtime').ReleaseNoteInfo[];
      isBeta: boolean;
    }
  | { status: 'not-available'; version: string; isBeta: boolean }
  | { status: 'error'; message: string }
  | { status: 'cancelled' }
  | { status: 'downloaded'; version: string };

export interface UpdaterProgressEvent {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export type UpdateCheckResponse = unknown | { error: string; message?: string };

export interface UpdateDownloadResult {
  success?: boolean;
  cancelled?: boolean;
  error?: string;
}

export interface RendererApi {
  restartApp: () => Promise<void>;
  getChannel: () => DistributionChannel;
  getFormats: (url: string) => Promise<string>;
  selectDownloadLocation: () => Promise<string | null>;
  getSettings: () => Promise<Settings>;
  saveSettings: (settings: Partial<Settings>) => Promise<IpcResult<Settings>>;
  resetSettings: () => void;
  openExternal: (url: string) => Promise<IpcResult<{ opened: boolean }>>;
  downloadVideo: (options: DownloadRequestOptions) => Promise<IpcResult<{ started: boolean }>>;
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
  detectGpu: () => Promise<GpuDetectionResult>;
  isPackaged: () => Promise<boolean>;
  checkForUpdates: () => Promise<UpdateCheckResponse>;
  downloadUpdate: () => Promise<UpdateDownloadResult>;
  cancelUpdateDownload: () => void;
  installUpdate: () => void;
  onUpdaterStatus: (callback: (data: UpdaterStatusEvent) => void) => () => void;
  onUpdaterProgress: (callback: (data: UpdaterProgressEvent) => void) => () => void;
  onDownloadProgress: (callback: (data: Record<string, unknown>) => void) => () => void;
  onProgress: (callback: (message: string) => void) => () => void;
  onComplete: (callback: (message: string) => void) => () => void;
  openFileLocation: (filePath: string) => Promise<IpcResult<{ opened: boolean }>>;
  showNotification: (options: NotificationRequest) => Promise<IpcResult<{ shown: boolean }>>;
}
