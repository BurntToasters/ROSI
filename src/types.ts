export type AudioFormat = 'mp3' | 'flac' | 'ogg' | 'wav' | 'm4a' | 'opus';
export type DownloadProfile = 'best-video' | 'audio' | 'custom';

export interface PlaylistSelection {
  mode: 'current' | 'all' | 'range';
  start?: number;
  end?: number;
}

export interface DownloadPreset {
  id: string;
  name: string;
  profile: DownloadProfile;
  bestQuality?: boolean;
  audioOnly?: boolean;
  audioFormat?: AudioFormat;
  videoFormat?: string;
  audioFormatId?: string;
  convertEnabled?: boolean;
  convertFormat?: string;
  keepOriginalAfterConvert?: boolean;
  gpuAcceleration?: boolean;
  gpuType?: 'auto' | 'nvidia' | 'amd' | 'intel';
  writeSubtitles?: boolean;
  subtitleLangs?: string;
  embedThumbnail?: boolean;
  embedMetadata?: boolean;
  sponsorblockRemove?: boolean;
  playlist?: PlaylistSelection;
}

export interface Settings {
  settingsVersion: number;
  theme: ThemePreference;
  showConsoleOutput: boolean;
  consoleCollapsed: boolean;
  queueCollapsed: boolean;
  downloadProfilesEnabled: boolean;
  downloadMode: DownloadProfile;
  downloadPresets: DownloadPreset[];
  askDownloadLocation: boolean;
  advancedOptions: boolean;
  audioOnly: boolean;
  audioFormat: AudioFormat;
  convertEnabled: boolean;
  convertFormat: string;
  keepOriginalAfterConvert: boolean;
  firstLaunch: boolean;
  hookBrowser: boolean;
  browserChoice: string;
  animateBackground: boolean;
  flatUi: boolean;
  notifications: boolean;
  denoReminderDismissed: boolean;
  gpuAcceleration: boolean;
  gpuType: 'auto' | 'nvidia' | 'amd' | 'intel';
  bestQuality: boolean;
  ffmpegPath: string;
  downloadFolder: string;
  hideSupportModal: boolean;
  checkUpdatesOnStartup: boolean;
  updateChannel: UpdateChannel;
  writeSubtitles: boolean;
  subtitleLangs: string;
  embedThumbnail: boolean;
  embedMetadata: boolean;
  sponsorblockRemove: boolean;
  showTaskbarProgress: boolean;
}

export type DownloadJobPhase = 'download' | 'merge' | 'convert' | 'idle';

export interface JobProgressEvent {
  phase: DownloadJobPhase;
  phasePercent: number;
  /** Progress for only the active item, before queue weighting. */
  itemOverallPercent: number;
  /** Queue-weighted progress for queue downloads, otherwise itemOverallPercent. */
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

export type MenuAction = 'check-for-updates' | 'open-settings' | 'show-licenses' | 'toggle-sidebar';

export interface QueueDownloadProgress {
  completedItems: number;
  queueTotal: number;
  queueItemId?: string;
}

export type UpdateChannel = 'auto' | 'stable' | 'beta';
export type ThemePreference = 'system' | 'light' | 'dark' | 'purple';

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

export type DownloadOutcome = 'success' | 'failed' | 'cancelled';

export type DownloadSessionOwner = 'manual' | 'queue';

export interface DownloadRequestOptions {
  url: string;
  outputPath: string;
  ffmpegPath?: string;
  convertEnabled?: boolean;
  convertFormat?: string;
  keepOriginal?: boolean;
  videoFormat?: string;
  /** A selected yt-dlp audio format ID. */
  audioFormat?: string;
  playlist?: PlaylistSelection;
  profileEnabled?: boolean;
  profile?: DownloadProfile;
  presetId?: string;
  presetName?: string;
  bestQuality?: boolean;
  advancedOptions?: boolean;
  audioOnly?: boolean;
  /** Audio extraction format, separate from the yt-dlp audio format ID above. */
  audioOutputFormat?: AudioFormat;
  hookBrowser?: boolean;
  browserChoice?: string;
  gpuAcceleration?: boolean;
  gpuType?: 'auto' | 'nvidia' | 'amd' | 'intel';
  writeSubtitles?: boolean;
  subtitleLangs?: string;
  embedThumbnail?: boolean;
  embedMetadata?: boolean;
  sponsorblockRemove?: boolean;
}

export type QueueRequestOverrides = Partial<Omit<DownloadRequestOptions, 'url'>>;

export interface DownloadCompletion {
  id: string;
  sessionId?: number;
  owner: DownloadSessionOwner;
  queueItemId?: string;
  outcome: DownloadOutcome;
  statusMessage: string;
  url: string;
  profile?: DownloadProfile;
  presetId?: string;
  presetName?: string;
  request: DownloadRequestOptions;
  filename?: string;
  outputPath?: string;
  sizeBytes?: number;
  format?: string;
  error?: string;
  startedAt: number;
  completedAt: number;
}

export interface DownloadSession {
  id: number;
  completionId: string;
  startedAt: number;
  request: DownloadRequestOptions;
  sender: Electron.WebContents;
  owner: DownloadSessionOwner;
  lifecycle: DownloadLifecycleState;
  ytdlpProcess: import('child_process').ChildProcess | null;
  ffmpegProcess: import('child_process').ChildProcess | null;
  onComplete?: (statusMessage: string, outcome: DownloadOutcome) => void;
  onDownloadComplete?: (completion: DownloadCompletion) => void;
  queueProgress: QueueDownloadProgress | null;
  jobPhase: DownloadJobPhase;
  ytdlpPostprocess: boolean;
  ytdlpDownloadFinished: boolean;
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

export interface VideoInfo {
  title: string;
  uploader: string | null;
  durationSeconds: number | null;
  thumbnail: string | null;
  ext: string | null;
  viewCount: number | null;
  isPlaylist: boolean;
  playlistCount: number | null;
  webpageUrl: string | null;
}

export interface NotificationRequest {
  title?: string;
  body?: string;
  filePath?: string;
}

export interface DownloadStats {
  totalDownloads: number;
  successfulDownloads: number;
  failedDownloads: number;
  cancelledDownloads: number;
  totalBytesDownloaded: number;
  formatCounts: Record<string, number>;
  firstDownloadAt: number | null;
  lastDownloadAt: number | null;
}

export interface QueueItem {
  id: string;
  url: string;
  status: 'pending' | 'downloading' | 'completed' | 'failed' | 'cancelled';
  addedAt: number;
  startedAt?: number;
  completedAt?: number;
  request?: DownloadRequestOptions;
  progress?: JobProgressEvent;
  filename?: string;
  outputPath?: string;
  sizeBytes?: number;
  error?: string;
}

export type QueueReorderDirection = 'up' | 'down';

export interface QueueReorderRequest {
  id: string;
  direction: QueueReorderDirection;
}

/** A persisted download outcome. Structurally identical to a completion event. */
export type DownloadActivity = DownloadCompletion;

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

export type UpdateCheckResponse = { error: string; message?: string } | null;

export interface UpdateDownloadResult {
  success?: boolean;
  cancelled?: boolean;
  error?: string;
}

export interface RendererApi {
  restartApp: () => Promise<void>;
  getChannel: () => DistributionChannel;
  getFormats: (url: string) => Promise<IpcResult<string>>;
  getVideoInfo: (url: string, playlistMode?: 'current' | 'all') => Promise<IpcResult<VideoInfo>>;
  cancelVideoInfo: () => void;
  selectDownloadLocation: () => Promise<string | null>;
  getSettings: () => Promise<Settings>;
  getDefaultSettings: () => Promise<IpcResult<Settings>>;
  saveSettings: (settings: Partial<Settings>) => Promise<IpcResult<Settings>>;
  resetSettings: () => void;
  openExternal: (url: string) => Promise<IpcResult<{ opened: boolean }>>;
  downloadVideo: (options: DownloadRequestOptions) => Promise<IpcResult<{ started: boolean }>>;
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
  detectGpu: () => Promise<GpuDetectionResult>;
  isPackaged: () => Promise<boolean>;
  checkForUpdates: () => Promise<UpdateCheckResponse>;
  downloadUpdate: () => Promise<UpdateDownloadResult>;
  cancelUpdateDownload: () => void;
  installUpdate: () => void;
  onUpdaterStatus: (callback: (data: UpdaterStatusEvent) => void) => () => void;
  onUpdaterProgress: (callback: (data: UpdaterProgressEvent) => void) => () => void;
  onProgress: (callback: (message: string) => void) => () => void;
  onJobProgress: (callback: (data: JobProgressEvent) => void) => () => void;
  onMenuAction: (callback: (action: MenuAction) => void) => () => void;
  onComplete: (callback: (message: string) => void) => () => void;
  onDownloadComplete: (callback: (completion: DownloadCompletion) => void) => () => void;
  openFileLocation: (filePath: string) => Promise<IpcResult<{ opened: boolean }>>;
  showNotification: (options: NotificationRequest) => Promise<IpcResult<{ shown: boolean }>>;
  exportSettings: () => Promise<IpcResult<{ exported: boolean }>>;
  importSettings: () => Promise<IpcResult<{ imported: boolean }>>;
  getStats: () => Promise<DownloadStats>;
  resetStats: () => Promise<IpcResult<void>>;
  getDownloadActivity: () => Promise<IpcResult<DownloadActivity[]>>;
  clearDownloadActivity: () => Promise<IpcResult<void>>;
  onDownloadActivityUpdate: (callback: (activity: DownloadActivity[]) => void) => () => void;
  logError: (message: string) => void;
  notifySettingsFlushed: () => void;
  addToQueue: (
    urls: string[],
    options?: QueueRequestOverrides
  ) => Promise<IpcResult<{ added: number; skipped: number }>>;
  removeFromQueue: (id: string) => Promise<IpcResult<void>>;
  retryQueueItem: (id: string) => Promise<IpcResult<void>>;
  reorderQueueItem: (request: QueueReorderRequest) => Promise<IpcResult<void>>;
  clearQueue: () => Promise<IpcResult<void>>;
  getQueue: () => Promise<QueueItem[]>;
  startQueue: () => Promise<IpcResult<{ started: boolean }>>;
  cancelQueue: () => Promise<IpcResult<void>>;
  onPrepareForClose: (callback: () => void | Promise<void>) => () => void;
  onQueueUpdate: (callback: (queue: QueueItem[]) => void) => () => void;
  onSettingsImported: (callback: (settings: Settings) => void) => () => void;
}
