export interface Settings {
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
  ffmpegPath: string;
  hideSupportModal: boolean;
  checkUpdatesOnStartup: boolean;
}

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
