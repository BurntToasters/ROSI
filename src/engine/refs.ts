// DOM element lookup and the startup-time element registry.
import type { RosiVideoInfo } from './preview';
export const byId = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T | null;

// Startup-time DOM elements and values that the feature modules read.
export const refs = {} as {
  settingsBtn: HTMLElement | null;
  closeSidebarBtn: HTMLElement | null;
  sidebarOverlay: HTMLElement | null;
  shortcutsBtn: HTMLElement | null;
  browserCookiesHelp: HTMLElement | null;
  helpLink: HTMLElement | null;
  supportLink: HTMLElement | null;
  websiteLink: HTMLElement | null;
  supportProjectLink: HTMLElement | null;
  licensesLink: HTMLElement | null;
  licensesFrame: HTMLElement | null;
  previewCloseBtn: HTMLButtonElement | null;
  activityPanel: RosiActivityPanel | null;
  clearHistoryBtn: HTMLButtonElement | null;
  clearConsoleBtn: HTMLButtonElement | null;
  changeDownloadFolderBtn: HTMLButtonElement | null;
  sponsorblockHelp: HTMLElement | null;
  resetSettingsBtn: HTMLButtonElement | null;
  exportSettingsBtn: HTMLButtonElement | null;
  importSettingsBtn: HTMLButtonElement | null;
  viewStatsBtn: HTMLButtonElement | null;
  fetchFormatsBtn: HTMLButtonElement | null;
  checkUpdateBtn: HTMLButtonElement | null;
  ipcCleanupFunctions: Array<() => void>;
  addToQueueBtn: HTMLButtonElement | null;
  animateBackgroundToggle: HTMLInputElement | null;
  applyPresetBtn: HTMLButtonElement | null;
  askDownloadLocationToggle: HTMLInputElement | null;
  browserChoiceContainer: HTMLElement | null;
  browserChoiceSelect: HTMLSelectElement | null;
  cancelQueueBtn: HTMLButtonElement | null;
  checkUpdatesOnStartupLabel: HTMLElement | null;
  checkUpdatesOnStartupToggle: HTMLInputElement | null;
  clearFinishedQueueBtn: HTMLButtonElement | null;
  clearQueueBtn: HTMLButtonElement | null;
  clearUrlBtn: HTMLButtonElement | null;
  consoleToggle: HTMLInputElement | null;
  convertFormatContainer: HTMLElement | null;
  convertFormatSelect: HTMLSelectElement | null;
  convertToggle: HTMLInputElement | null;
  deletePresetBtn: HTMLButtonElement | null;
  downloadBtn: HTMLButtonElement | null;
  downloadCard: HTMLElement | null;
  downloadFolderSummary: HTMLElement | null;
  downloadOutputSummary: HTMLElement | null;
  downloadPresetSelect: HTMLSelectElement | null;
  embedMetadataToggle: HTMLInputElement | null;
  embedThumbnailToggle: HTMLInputElement | null;
  ffmpegPathInput: HTMLInputElement | null;
  flatUiToggle: HTMLInputElement | null;
  gpuAccelerationLabel: HTMLElement | null;
  gpuAccelerationToggle: HTMLInputElement | null;
  gpuTypeContainer: HTMLElement | null;
  gpuTypeSelect: HTMLSelectElement | null;
  hookBrowserToggle: HTMLInputElement | null;
  keepOriginalLabel: HTMLElement | null;
  keepOriginalToggle: HTMLInputElement | null;
  notificationsToggle: HTMLInputElement | null;
  outputEl: HTMLElement | null;
  pasteUrlBtn: HTMLButtonElement | null;
  pendingManualCompletions: Map<number, RosiDownloadCompletion>;
  playlistRangeEnd: HTMLInputElement | null;
  playlistRangeFields: HTMLElement | null;
  playlistRangeStart: HTMLInputElement | null;
  playlistScope: HTMLElement | null;
  playlistScopeError: HTMLElement | null;
  presetMenuBtn: HTMLButtonElement | null;
  presetPopover: HTMLElement | null;
  presetStatus: HTMLElement | null;
  previewBtn: HTMLButtonElement | null;
  previewCache: Map<string, { info: RosiVideoInfo; storedAt: number }>;
  profileAudioFormatContainer: HTMLElement | null;
  profileAudioFormatSelect: HTMLSelectElement | null;
  profileButtons: readonly [
    readonly ['compatible', HTMLButtonElement | null],
    readonly ['best-video', HTMLButtonElement | null],
    readonly ['audio', HTMLButtonElement | null],
    readonly ['custom', HTMLButtonElement | null],
  ];
  queueActionButtons: HTMLButtonElement[];
  queueCount: HTMLElement | null;
  queueList: HTMLElement | null;
  queueSection: HTMLElement | null;
  queueStatusMessage: HTMLElement | null;
  queueUrlInput: HTMLTextAreaElement | null;
  settingsSearchStatus: HTMLElement | null;
  settingsSections: HTMLElement[];
  showUpdateChannelBtn: HTMLButtonElement | null;
  sponsorblockToggle: HTMLInputElement | null;
  startQueueBtn: HTMLButtonElement | null;
  subtitleLangsContainer: HTMLElement | null;
  subtitleLangsInput: HTMLInputElement | null;
  taskbarProgressToggle: HTMLInputElement | null;
  themeSelect: HTMLSelectElement | null;
  updateChannelContainer: HTMLElement | null;
  updateChannelSelect: HTMLSelectElement | null;
  upstreamProxyInput: HTMLInputElement | null;
  urlInput: HTMLInputElement | null;
  urlInputContainer: HTMLElement | null;
  urlValidationMessage: HTMLElement | null;
  writeSubtitlesToggle: HTMLInputElement | null;
};
