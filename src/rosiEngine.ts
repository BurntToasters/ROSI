import { bindActivityControls } from './engine/bind/activity';
import { bindAppShell, bindLicensesOverlay } from './engine/bind/app-shell';
import { bindBackendEvents } from './engine/bind/backend-events';
import { bindDownloadControls } from './engine/bind/download';
import { initPlaylistScope } from './engine/bind/playlist';
import { initPresets } from './engine/bind/presets';
import { bindQueueControls } from './engine/bind/queue';
import {
  bindSettingsActions,
  bindSettingsControls,
  bindWindowsBrowserChoice,
} from './engine/bind/settings-controls';
import { initSettingsSearch, initSettingsSections } from './engine/bind/settings-sections';
import { bindKeyboardShortcuts } from './engine/bind/shortcuts';
import { bindUrlInput } from './engine/bind/url-input';
import { cancelScheduledPreview } from './engine/preview-controller';
import { byId, refs } from './engine/refs';
import {
  checkUpdatesOnStartup,
  flushBeforeRestart,
  persistSettings,
  settingsStore,
  trackSettings,
} from './engine/settings-store';
import {
  maybeShowSupportModal,
  syncDockFromSettings,
  updateUIFromSettings,
} from './engine/settings-view';
import { replayActivityDownload } from './engine/url-actions';
import {
  RosiSettings,
  activityModule,
  dockModule,
  iconsModule,
  logError,
  queueModule,
  renderStatusText,
  updatesModule,
} from './engine/core';
import { checkDenoInstallation } from './engine/deno';
import { fetchFormats } from './engine/formats';
import { showModal } from './engine/overlays';
import { formatRelativeTime, revealFileLocation } from './engine/progress';
import { applyTheme } from './engine/theme';
import { showToast } from './engine/ui-helpers';
import { cleanupUpdaterListeners, setupAutoUpdater } from './engine/updater-ui';
import { launchSetupWizard } from './engine/wizard';

type PrepareForCloseHandler = (generation: number) => Promise<void>;

let resolveRendererStartupReady!: () => void;
const rendererStartupReady = new Promise<void>((resolve) => {
  resolveRendererStartupReady = resolve;
});
window.__ROSI_RENDERER_STARTUP_READY__ = rendererStartupReady;

let resolvePrepareForCloseHandler!: (handler: PrepareForCloseHandler) => void;
let prepareForCloseHandlerIsSet = false;
const prepareForCloseHandlerReady = new Promise<PrepareForCloseHandler>((resolve) => {
  resolvePrepareForCloseHandler = resolve;
});

function setPrepareForCloseHandler(handler: PrepareForCloseHandler) {
  if (prepareForCloseHandlerIsSet) return;
  prepareForCloseHandlerIsSet = true;
  resolvePrepareForCloseHandler(handler);
}

async function initializeRenderer() {
  const ipcCleanupFunctions: Array<() => void> = (refs.ipcCleanupFunctions = []);
  ipcCleanupFunctions.push(
    window.api.onPrepareForClose(async (generation) => {
      try {
        const handler = await prepareForCloseHandlerReady;
        await handler(generation);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        showModal({
          title: 'ROSI Could Not Close Safely',
          message: `ROSI could not confirm that settings and the download queue were saved. The app will remain open so you can retry.\n\n${detail}`,
          buttons: [{ label: 'OK', primary: true }],
          priority: true,
        });
      }
    })
  );
  refs.pendingManualCompletions = new Map<number, RosiDownloadCompletion>();
  try {
    settingsStore.settings = (await window.api.getSettings()) as RosiSettings;
  } catch (error) {
    logError('Failed to load settings', error);
    settingsStore.settings = {
      settingsVersion: 7,
      theme: 'system',
      showConsoleOutput: false,
      dockTab: 'queue',
      dockCollapsed: false,
      downloadMode: 'compatible',
      downloadPresets: [],
      askDownloadLocation: false,
      advancedOptions: false,
      audioFormat: 'mp3',
      convertEnabled: false,
      convertFormat: 'mp4',
      keepOriginalAfterConvert: true,
      firstLaunch: true,
      hookBrowser: false,
      browserChoice: 'chrome',
      animateBackground: true,
      flatUi: localStorage.getItem('rosi-flat-ui') === 'true',
      notifications: true,
      denoReminderDismissed: false,
      gpuAcceleration: false,
      gpuType: 'auto',
      bestQuality: false,
      ffmpegPath: '',
      upstreamProxy: '',
      downloadFolder: '',
      hideSupportModal: false,
      checkUpdatesOnStartup: true,
      updateChannel: 'auto',
      audioOnly: false,
      writeSubtitles: false,
      subtitleLangs: 'en',
      embedThumbnail: false,
      embedMetadata: false,
      sponsorblockRemove: false,
      showTaskbarProgress: true,
    };
    showModal({
      title: 'Settings Error',
      message: 'Could not load settings. Using defaults.',
      buttons: [{ label: 'OK', primary: true }],
    });
  }
  settingsStore.settings = trackSettings(settingsStore.settings);
  applyTheme(settingsStore.settings.theme ?? 'system');

  try {
    const version = await window.api.getAppVersion();
    const versionLink = document.getElementById('versionLink');
    const betaBadge = document.getElementById('betaBadge');
    if (versionLink && version) {
      versionLink.textContent = `v${version}`;
      versionLink.setAttribute(
        'aria-label',
        `View release notes for v${version} (opens externally)`
      );
      versionLink.addEventListener('click', (event) => {
        event.preventDefault();
        void window.api.openExternal(
          `https://github.com/BurntToasters/ROSI/releases/tag/v${version}`
        );
      });
      const isBeta =
        updatesModule && typeof updatesModule.isPrereleaseVersion === 'function'
          ? updatesModule.isPrereleaseVersion(version)
          : /-(beta|alpha|rc)/i.test(version);
      if (isBeta) {
        versionLink.classList.add('beta-version');
        if (betaBadge) betaBadge.classList.remove('hidden');
      }
    }
  } catch (e) {
    logError('Could not get app version', e);
    const versionLink = document.getElementById('versionLink');
    if (versionLink) {
      versionLink.textContent = 'Version unknown';
      versionLink.setAttribute('aria-label', 'View release notes (opens externally)');
    }
  }

  try {
    const platform = await window.api.getAppPlatform();
    const taskbarSetting = document.getElementById('taskbarProgressSetting');
    const taskbarLinuxNote = document.getElementById('taskbarProgressLinuxNote');
    if (platform === 'linux') {
      taskbarSetting?.setAttribute('hidden', '');
      taskbarLinuxNote?.classList.remove('hidden');
    }
    if (platform === 'darwin') {
      // macOS always uses VideoToolbox; the vendor choice does not apply.
      document.getElementById('gpuTypeContainer')?.classList.add('hidden');
    }
  } catch (e) {
    logError('Could not resolve app platform for settings UI', e);
  }
  try {
    settingsStore.isFlatpakBuild = (await window.api.isFlatpak?.()) === true;
  } catch (e) {
    logError('Could not detect the Flatpak build', e);
  }
  if (settingsStore.isFlatpakBuild) {
    // The sandbox cannot read browser profiles, so cookies cannot work here.
    const cookieToggle = document.getElementById('hookBrowserToggle') as HTMLInputElement | null;
    if (cookieToggle) {
      cookieToggle.checked = false;
      cookieToggle.disabled = true;
      cookieToggle.closest('.toggle-switch')?.classList.add('disabled');
    }
    document.getElementById('browserChoiceContainer')?.classList.add('hidden');
    document.getElementById('browserFlatpakHint')?.classList.remove('hidden');
  }

  if (window.api.getChannel() !== 'msstore') {
    try {
      setupAutoUpdater(() => flushBeforeRestart('Installing the update'));
    } catch (e) {
      logError('Failed to setup auto-updater', e);
    }
  }

  setPrepareForCloseHandler(async (generation) => {
    try {
      const saved = await persistSettings(false, true);
      // A settings file from a newer ROSI is preserved on purpose; it must not
      // keep the app from closing.
      if (!saved && settingsStore.lastSettingsSaveErrorCode !== 'NEWER_VERSION') return;
      await window.api.notifySettingsFlushed(generation);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      showModal({
        title: 'ROSI Could Not Close Safely',
        message: `ROSI could not confirm that settings and the download queue were saved. The app will remain open so you can retry.\n\n${detail}`,
        buttons: [{ label: 'OK', primary: true }],
        priority: true,
      });
    }
  });

  refs.consoleToggle = byId<HTMLInputElement>('consoleToggle');
  refs.keepOriginalToggle = byId<HTMLInputElement>('keepOriginalToggle');
  refs.hookBrowserToggle = byId<HTMLInputElement>('hookBrowserToggle');
  refs.browserChoiceContainer = byId('browserChoiceContainer');
  refs.browserChoiceSelect = byId<HTMLSelectElement>('browserChoice');
  refs.convertToggle = byId<HTMLInputElement>('convertToggle');
  refs.convertFormatContainer = byId('convertFormatContainer');
  refs.convertFormatSelect = byId<HTMLSelectElement>('convertFormat');
  refs.keepOriginalLabel = byId('keepOriginalLabel');
  refs.gpuAccelerationToggle = byId<HTMLInputElement>('gpuAccelerationToggle');
  refs.gpuAccelerationLabel = byId('gpuAccelerationLabel');
  refs.gpuTypeContainer = byId('gpuTypeContainer');
  refs.gpuTypeSelect = byId<HTMLSelectElement>('gpuType');
  refs.ffmpegPathInput = byId<HTMLInputElement>('ffmpegPathInput');
  refs.upstreamProxyInput = byId<HTMLInputElement>('upstreamProxyInput');
  refs.outputEl = byId('output');
  refs.resetSettingsBtn = byId<HTMLButtonElement>('resetSettings');
  const fetchFormatsBtn = (refs.fetchFormatsBtn = byId<HTMLButtonElement>('fetchFormatsBtn'));
  const downloadBtn = (refs.downloadBtn = byId<HTMLButtonElement>('downloadBtn'));
  refs.checkUpdateBtn = byId<HTMLButtonElement>('checkUpdateBtn');
  refs.animateBackgroundToggle = byId<HTMLInputElement>('animateBackgroundToggle');
  refs.themeSelect = byId<HTMLSelectElement>('themeSelect');
  refs.flatUiToggle = byId<HTMLInputElement>('flatUiToggle');
  const profileCompatibleBtn = byId<HTMLButtonElement>('profileCompatibleBtn');
  const profileBestVideoBtn = byId<HTMLButtonElement>('profileBestVideoBtn');
  const profileAudioBtn = byId<HTMLButtonElement>('profileAudioBtn');
  const profileCustomBtn = byId<HTMLButtonElement>('profileCustomBtn');
  refs.profileAudioFormatContainer = byId('profileAudioFormatContainer');
  refs.profileAudioFormatSelect = byId<HTMLSelectElement>('profileAudioFormatSelect');
  refs.downloadFolderSummary = byId('downloadFolderSummary');
  refs.changeDownloadFolderBtn = byId<HTMLButtonElement>('changeDownloadFolderBtn');
  refs.askDownloadLocationToggle = byId<HTMLInputElement>('askDownloadLocationToggle');
  refs.downloadOutputSummary = byId('downloadOutputSummary');
  refs.notificationsToggle = byId<HTMLInputElement>('notificationsToggle');
  refs.taskbarProgressToggle = byId<HTMLInputElement>('taskbarProgressToggle');
  refs.checkUpdatesOnStartupToggle = byId<HTMLInputElement>('checkUpdatesOnStartupToggle');
  refs.checkUpdatesOnStartupLabel = byId('checkUpdatesOnStartupLabel');
  refs.updateChannelSelect = byId<HTMLSelectElement>('updateChannelSelect');
  refs.updateChannelContainer = byId('updateChannelContainer');
  refs.showUpdateChannelBtn = byId<HTMLButtonElement>('showUpdateChannelBtn');

  refs.settingsBtn = byId('settingsBtn');
  refs.closeSidebarBtn = byId('closeSidebar');
  refs.sidebarOverlay = byId('sidebar-overlay');
  refs.shortcutsBtn = byId('shortcutsBtn');
  refs.clearUrlBtn = byId<HTMLButtonElement>('clearUrl');
  refs.pasteUrlBtn = byId<HTMLButtonElement>('pasteUrl');
  refs.clearConsoleBtn = byId<HTMLButtonElement>('clearConsole');
  refs.urlInput = byId<HTMLInputElement>('url');
  refs.urlValidationMessage = byId('urlValidationMessage');
  refs.urlInputContainer = document.querySelector<HTMLElement>('.url-input-container');
  refs.downloadCard = document.querySelector<HTMLElement>('.download-card');
  refs.previewBtn = byId<HTMLButtonElement>('previewBtn');
  refs.previewCloseBtn = byId<HTMLButtonElement>('previewClose');
  refs.clearHistoryBtn = byId<HTMLButtonElement>('clearHistory');
  refs.browserCookiesHelp = byId('browserCookiesHelp');
  refs.helpLink = byId('helpLink');
  refs.supportLink = byId('supportLink');
  refs.websiteLink = byId('websiteLink');
  refs.supportProjectLink = byId('supportProjectLink');
  refs.licensesLink = byId('licensesLink');
  refs.licensesFrame = byId('licenses-frame');
  refs.exportSettingsBtn = byId<HTMLButtonElement>('exportSettingsBtn');
  refs.importSettingsBtn = byId<HTMLButtonElement>('importSettingsBtn');
  refs.viewStatsBtn = byId<HTMLButtonElement>('viewStatsBtn');
  refs.embedMetadataToggle = byId<HTMLInputElement>('embedMetadataToggle');
  refs.embedThumbnailToggle = byId<HTMLInputElement>('embedThumbnailToggle');
  refs.sponsorblockToggle = byId<HTMLInputElement>('sponsorblockToggle');
  refs.sponsorblockHelp = byId('sponsorblockHelp');
  refs.writeSubtitlesToggle = byId<HTMLInputElement>('writeSubtitlesToggle');
  refs.subtitleLangsContainer = byId('subtitleLangsContainer');
  refs.subtitleLangsInput = byId<HTMLInputElement>('subtitleLangsInput');
  refs.queueUrlInput = byId<HTMLTextAreaElement>('queueUrlInput');
  refs.addToQueueBtn = byId<HTMLButtonElement>('addToQueueBtn');
  refs.startQueueBtn = byId<HTMLButtonElement>('startQueueBtn');
  refs.clearQueueBtn = byId<HTMLButtonElement>('clearQueueBtn');
  refs.clearFinishedQueueBtn = byId<HTMLButtonElement>('clearFinishedQueueBtn');
  refs.cancelQueueBtn = byId<HTMLButtonElement>('cancelQueueBtn');
  const queueStatusMessage = (refs.queueStatusMessage = byId('queueStatusMessage'));
  refs.queueList = byId('queueList');
  refs.queueCount = byId('queueCount');
  refs.queueSection =
    (queueModule && typeof queueModule.resolveQueueSectionElement === 'function'
      ? queueModule.resolveQueueSectionElement(document)
      : null) || byId('queueSection');

  if (queueStatusMessage) {
    queueStatusMessage.setAttribute('role', 'status');
    queueStatusMessage.setAttribute('aria-live', 'polite');
    queueStatusMessage.setAttribute('aria-atomic', 'true');
  }

  if (fetchFormatsBtn) fetchFormatsBtn._originalClick = fetchFormats;
  if (downloadBtn) downloadBtn._originalClick = null;

  bindWindowsBrowserChoice();

  refs.profileButtons = [
    ['compatible', profileCompatibleBtn],
    ['best-video', profileBestVideoBtn],
    ['audio', profileAudioBtn],
    ['custom', profileCustomBtn],
  ] as const;

  try {
    updateUIFromSettings();
  } catch (e) {
    logError('Failed to update UI from settings', e);
  }
  settingsStore.refreshSettingsControls = () => {
    try {
      updateUIFromSettings();
    } catch (e) {
      logError('Failed to refresh settings controls', e);
    }
  };
  syncDockFromSettings();

  // Sidebar controls
  bindAppShell();

  // ── Playlist scope ──────────────────────────────────────────────────────────
  initPlaylistScope();

  // ── Saved presets ───────────────────────────────────────────────────────────
  initPresets();

  // ── Settings search and per-section reset ───────────────────────────────────
  initSettingsSearch();

  bindUrlInput();

  // Renders the empty or legacy state and binds the activity filter buttons.
  refs.activityPanel =
    activityModule?.initActivityPanel({
      showToast,
      renderStatusText,
      formatRelativeTime,
      revealFileLocation,
      icon: (name, size) => iconsModule?.icon(name, size) ?? null,
      markUnseen: (tab) => dockModule?.markUnseen(tab),
      onReplay: (entry) => {
        void replayActivityDownload(entry);
      },
    }) ?? null;

  bindActivityControls();

  initSettingsSections();

  bindSettingsControls();

  bindSettingsActions();

  bindQueueControls();

  bindDownloadControls();

  bindBackendEvents();

  window.addEventListener('beforeunload', () => {
    cancelScheduledPreview();
    ipcCleanupFunctions.forEach((cleanup) => {
      if (typeof cleanup === 'function') {
        try {
          cleanup();
        } catch {}
      }
    });
    cleanupUpdaterListeners();
  });

  if (settingsStore.settings.firstLaunch) {
    launchSetupWizard(
      settingsStore.settings,
      applyTheme,
      persistSettings,
      (outcome) => {
        updateUIFromSettings();
        if (!outcome.denoReviewed) {
          void checkDenoInstallation(
            settingsStore.settings,
            () => persistSettings(),
            () => flushBeforeRestart('Restarting ROSI'),
            settingsStore.isFlatpakBuild
          );
        }
        void checkUpdatesOnStartup();
      },
      settingsStore.isFlatpakBuild
    );
  } else {
    void checkDenoInstallation(
      settingsStore.settings,
      () => persistSettings(),
      () => flushBeforeRestart('Restarting ROSI'),
      settingsStore.isFlatpakBuild
    );
    void checkUpdatesOnStartup();
    setTimeout(maybeShowSupportModal, 1500);
  }

  bindLicensesOverlay();

  bindKeyboardShortcuts();
}

document.addEventListener('DOMContentLoaded', () => {
  void initializeRenderer()
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      logError('Renderer startup failed', error);
      setPrepareForCloseHandler(async () => {
        showModal({
          title: 'ROSI Could Not Close Safely',
          message: `ROSI could not finish startup and will remain open.\n\n${detail}`,
          buttons: [{ label: 'OK', primary: true }],
          priority: true,
        });
      });
    })
    .finally(resolveRendererStartupReady);
});
