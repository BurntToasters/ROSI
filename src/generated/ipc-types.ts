// Generated from src-tauri/src/types.rs by the ts_bindings test. Do not edit.

export type Theme = "system" | "light" | "dark" | "purple";

export type DockTab = "queue" | "activity" | "console";

export type DownloadProfile = "compatible" | "best-video" | "audio" | "custom";

export type GpuType = "auto" | "nvidia" | "amd" | "intel";

export type UpdateChannel = "auto" | "stable" | "beta";

export type PlaylistSelection = { mode: "current" | "all" | "range", start?: number | null, end?: number | null, };

export type DownloadPreset = { id: string, name: string, profile: DownloadProfile, bestQuality?: boolean | null, audioOnly?: boolean | null, audioFormat?: string | null, videoFormat?: string | null, audioFormatId?: string | null, convertEnabled?: boolean | null, convertFormat?: string | null, keepOriginalAfterConvert?: boolean | null, gpuAcceleration?: boolean | null, gpuType?: GpuType | null, writeSubtitles?: boolean | null, subtitleLangs?: string | null, embedThumbnail?: boolean | null, embedMetadata?: boolean | null, sponsorblockRemove?: boolean | null, playlist?: PlaylistSelection | null, };

export type Settings = { settingsVersion: number, theme: Theme, showConsoleOutput: boolean, dockTab: DockTab, dockCollapsed: boolean, downloadMode: DownloadProfile, downloadPresets: Array<DownloadPreset>, askDownloadLocation: boolean, advancedOptions: boolean, audioOnly: boolean, audioFormat: string, convertEnabled: boolean, convertFormat: string, keepOriginalAfterConvert: boolean, firstLaunch: boolean, hookBrowser: boolean, browserChoice: string, animateBackground: boolean, flatUi: boolean, notifications: boolean, denoReminderDismissed: boolean, gpuAcceleration: boolean, gpuType: GpuType, bestQuality: boolean, ffmpegPath: string, upstreamProxy: string, downloadFolder: string, hideSupportModal: boolean, checkUpdatesOnStartup: boolean, updateChannel: UpdateChannel, writeSubtitles: boolean, subtitleLangs: string, embedThumbnail: boolean, embedMetadata: boolean, sponsorblockRemove: boolean, showTaskbarProgress: boolean, };

export type DownloadRequestOptions = { url: string, outputPath: string, ffmpegPath?: string | null, convertEnabled?: boolean | null, convertFormat?: string | null, keepOriginal?: boolean | null, videoFormat?: string | null, 
/**
 * A selected yt-dlp audio format ID.
 */
audioFormat?: string | null, playlist?: PlaylistSelection | null, profile?: DownloadProfile | null, presetId?: string | null, presetName?: string | null, bestQuality?: boolean | null, advancedOptions?: boolean | null, audioOnly?: boolean | null, 
/**
 * Audio extraction format, separate from the yt-dlp audio format ID.
 */
audioOutputFormat?: string | null, hookBrowser?: boolean | null, browserChoice?: string | null, gpuAcceleration?: boolean | null, gpuType?: GpuType | null, writeSubtitles?: boolean | null, subtitleLangs?: string | null, embedThumbnail?: boolean | null, embedMetadata?: boolean | null, sponsorblockRemove?: boolean | null, };

export type Owner = "manual" | "queue";

export type Outcome = "success" | "failed" | "cancelled";

export type DownloadCompletion = { id: string, sessionId?: number | null, owner: Owner, queueItemId?: string | null, outcome: Outcome, statusMessage: string, url: string, profile?: DownloadProfile | null, presetId?: string | null, presetName?: string | null, request: DownloadRequestOptions, filename?: string | null, outputPath?: string | null, outputPaths?: Array<string> | null, failedPaths?: Array<string> | null, sizeBytes?: number | null, format?: string | null, error?: string | null, startedAt: number, completedAt: number, };

export type Phase = "download" | "merge" | "convert" | "idle";

export type JobProgressEvent = { phase: Phase, sessionId?: number | null, 
/**
 * `null` when the phase has no determinate percentage.
 */
phasePercent?: number | null, 
/**
 * Progress for only the active item, before queue weighting.
 */
itemOverallPercent: number, 
/**
 * Queue-weighted progress for queue downloads, otherwise itemOverallPercent.
 */
overallPercent: number, queueItemId?: string | null, status: string, details?: string | null, indeterminate: boolean, downloadedBytes?: number | null, totalBytes?: number | null, speedBytesPerSecond?: number | null, etaSeconds?: number | null, };

export type QueueStatus = "pending" | "downloading" | "completed" | "failed" | "cancelled";

export type QueueItem = { id: string, url: string, status: QueueStatus, addedAt: number, startedAt?: number | null, completedAt?: number | null, request?: DownloadRequestOptions | null, filename?: string | null, outputPath?: string | null, sizeBytes?: number | null, error?: string | null, };

export type VideoInfo = { title: string, uploader?: string | null, durationSeconds?: number | null, thumbnail?: string | null, ext?: string | null, viewCount?: number | null, isPlaylist: boolean, playlistCount?: number | null, webpageUrl?: string | null, };

export type DownloadStats = { totalDownloads: number, successfulDownloads: number, failedDownloads: number, cancelledDownloads: number, totalBytesDownloaded: number, formatCounts: { [key in string]: number }, firstDownloadAt?: number | null, lastDownloadAt?: number | null, };

export type GpuDetectionResult = { nvidia: boolean, amd: boolean, intel: boolean, };

export type IpcError = { code: "VALIDATION_ERROR" | "INVALID_URL" | "INVALID_PATH" | "NOT_AVAILABLE" | "INTERNAL_ERROR" | "NEWER_VERSION", message: string, details?: string | null, };

export type DownloadStarted = { started: boolean, sessionId: number, };

export type QueueStarted = { started: boolean, };

export type AddResult = { added: number, skipped: number, };

export type RemovedCount = { removed: number, };

export type Opened = { opened: boolean, };

export type Shown = { shown: boolean, };

export type Exported = { exported: boolean, };

export type Imported = { imported: boolean, };

export type InstallResult = { success?: boolean | null, cancelled?: boolean | null, output?: string | null, error?: string | null, };
