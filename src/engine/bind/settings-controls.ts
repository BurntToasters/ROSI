// Startup bindings for settings controls.
import { RosiSettings, isValidSubtitleLangs, isValidUrl } from '../core';
import {
  configureEffectiveOptionsRequestBuilder,
  refreshEffectiveOptionsSummary,
} from '../messages';
import type { EffectiveOptionsReadiness } from '../messages';
import { showModal } from '../overlays';
import { isPlaylistScopeVisible, resolvePlaylistSelection } from '../playlist';
import {
  buildOnScreenPresetOverrides,
  getSelectedPreset,
  readAdvancedFormatSelections,
} from '../presets';
import { formatBytes, formatRelativeTime } from '../progress';
import { refs } from '../refs';
import { flushBeforeRestart, persistSettings, settingsStore } from '../settings-store';
import { applyDownloadProfile, bindExternalLink, updateUIFromSettings } from '../settings-view';
import { applyTheme, updateBackgroundAnimation } from '../theme';
import { showToast, updateConsoleVisibility } from '../ui-helpers';

function buildEffectiveOptionsReadiness(): EffectiveOptionsReadiness {
  const url = refs.urlInput?.value.trim() ?? '';
  const profile = settingsStore.settings?.downloadMode ?? 'compatible';
  if (!url) {
    return { state: 'profile-preview', profile, audioFormat: settingsStore.settings?.audioFormat };
  }
  if (!isValidUrl(url)) return { state: 'invalid-url' };

  const settings = settingsStore.settings;
  if (
    settingsStore.persistDebounceTimer ||
    settingsStore.settingsSaveInFlight ||
    settingsStore.settingsSaveWaiters.length > 0
  ) {
    return { state: 'settings-saving' };
  }
  if (settingsStore.settingsSavedRevision !== settingsStore.settingsRevision) {
    return { state: 'settings-unsaved' };
  }
  const outputPath = settings.askDownloadLocation ? '' : (settings.downloadFolder?.trim() ?? '');
  if (!outputPath) return { state: 'destination' };

  const formatSelections = readAdvancedFormatSelections(url);
  if (settings.advancedOptions && !formatSelections.videoFormat && !formatSelections.audioFormat) {
    return { state: 'formats' };
  }

  const playlist = resolvePlaylistSelection();
  const playlistVisible = isPlaylistScopeVisible();
  if (playlistVisible && !playlist) return { state: 'playlist' };

  const selectedPreset = getSelectedPreset();
  const convertEnabled = settings.convertEnabled && !settings.audioOnly;
  const request = {
    url,
    outputPath,
    videoFormat: formatSelections.videoFormat,
    audioFormat: formatSelections.audioFormat,
    convertFormat: convertEnabled ? refs.convertFormatSelect?.value.trim() || undefined : undefined,
    keepOriginal: convertEnabled ? refs.keepOriginalToggle?.checked : undefined,
    ...(playlistVisible && playlist ? { playlist } : {}),
    ...(selectedPreset
      ? {
          presetId: selectedPreset.id,
          presetName: selectedPreset.name,
          ...buildOnScreenPresetOverrides(formatSelections),
        }
      : {}),
  };
  return { state: 'ready', request };
}

function bindEffectiveOptionsSummary() {
  configureEffectiveOptionsRequestBuilder(buildEffectiveOptionsReadiness);
  const watchedElements = [
    refs.urlInput,
    refs.profileAudioFormatSelect,
    refs.downloadPresetSelect,
    refs.convertToggle,
    refs.convertFormatSelect,
    refs.keepOriginalToggle,
    refs.gpuAccelerationToggle,
    refs.gpuTypeSelect,
    refs.writeSubtitlesToggle,
    refs.subtitleLangsInput,
    refs.embedMetadataToggle,
    refs.embedThumbnailToggle,
    refs.sponsorblockToggle,
    refs.askDownloadLocationToggle,
    refs.playlistRangeStart,
    refs.playlistRangeEnd,
  ].filter((element): element is NonNullable<typeof element> => element !== null);
  watchedElements.forEach((element) => {
    if (element === refs.urlInput) {
      element.addEventListener('input', () => refreshEffectiveOptionsSummary());
    }
    element.addEventListener('change', () => refreshEffectiveOptionsSummary());
  });
  document
    .getElementById('downloadProfilesComposer')
    ?.addEventListener('click', () => refreshEffectiveOptionsSummary());
  document
    .getElementById('playlistScope')
    ?.addEventListener('change', () => refreshEffectiveOptionsSummary());
  document
    .getElementById('changeDownloadFolderBtn')
    ?.addEventListener('click', () => window.setTimeout(refreshEffectiveOptionsSummary, 0));
}

/** Windows-only browser cookie choices. */
export function bindWindowsBrowserChoice() {
  const { browserChoiceSelect } = refs;
  const isWindows = navigator.userAgent.includes('Windows');
  if (isWindows && browserChoiceSelect) {
    Array.from(browserChoiceSelect.options).forEach((opt) => {
      if (opt.value !== 'firefox') {
        browserChoiceSelect.removeChild(opt);
      }
    });
    browserChoiceSelect.value = 'firefox';
    if (settingsStore.settings.browserChoice?.toLowerCase() !== 'firefox') {
      settingsStore.settings.browserChoice = 'firefox';
      void persistSettings();
    }
    const browserWindowsHint = document.getElementById('browserWindowsHint');
    if (browserWindowsHint) browserWindowsHint.classList.remove('hidden');
  }
}

/** Settings toggles, selects, and inputs that save on change. */
export function bindSettingsControls() {
  bindEffectiveOptionsSummary();
  const {
    animateBackgroundToggle,
    askDownloadLocationToggle,
    browserChoiceContainer,
    browserChoiceSelect,
    changeDownloadFolderBtn,
    checkUpdatesOnStartupToggle,
    consoleToggle,
    convertFormatContainer,
    convertFormatSelect,
    convertToggle,
    embedMetadataToggle,
    embedThumbnailToggle,
    ffmpegPathInput,
    flatUiToggle,
    gpuAccelerationLabel,
    gpuAccelerationToggle,
    gpuTypeContainer,
    gpuTypeSelect,
    hookBrowserToggle,
    keepOriginalLabel,
    keepOriginalToggle,
    notificationsToggle,
    profileAudioFormatSelect,
    profileButtons,
    sponsorblockHelp,
    sponsorblockToggle,
    subtitleLangsContainer,
    subtitleLangsInput,
    taskbarProgressToggle,
    themeSelect,
    upstreamProxyInput,
    writeSubtitlesToggle,
  } = refs;
  if (consoleToggle)
    consoleToggle.addEventListener('change', (e) => {
      settingsStore.settings.showConsoleOutput = (e.target as HTMLInputElement).checked;
      void persistSettings();
      updateConsoleVisibility(settingsStore.settings.showConsoleOutput);
    });

  profileButtons.forEach(([mode, button]) => {
    button?.addEventListener('click', () => {
      applyDownloadProfile(mode);
      updateUIFromSettings();
      void persistSettings(true, true);
    });
  });
  if (profileAudioFormatSelect) {
    profileAudioFormatSelect.addEventListener('change', (e) => {
      settingsStore.settings.audioFormat = (e.target as HTMLSelectElement).value;
      updateUIFromSettings();
      void persistSettings(true, true);
    });
  }
  if (askDownloadLocationToggle) {
    askDownloadLocationToggle.addEventListener('change', (e) => {
      settingsStore.settings.askDownloadLocation = (e.target as HTMLInputElement).checked;
      void persistSettings();
    });
  }
  if (changeDownloadFolderBtn) {
    changeDownloadFolderBtn.addEventListener('click', async () => {
      const savePath = await window.api.selectDownloadLocation();
      if (!savePath) return;
      settingsStore.settings.downloadFolder = savePath;
      updateUIFromSettings();
      void persistSettings(true, true);
    });
  }
  if (keepOriginalToggle)
    keepOriginalToggle.addEventListener('change', (e) => {
      if (!(e.target as HTMLInputElement).disabled) {
        settingsStore.settings.keepOriginalAfterConvert = (e.target as HTMLInputElement).checked;
        void persistSettings();
      } else {
        e.preventDefault();
      }
    });
  if (hookBrowserToggle)
    hookBrowserToggle.addEventListener('change', (e) => {
      settingsStore.settings.hookBrowser = (e.target as HTMLInputElement).checked;
      if (browserChoiceContainer) {
        if ((e.target as HTMLInputElement).checked) {
          browserChoiceContainer.classList.add('visible');
        } else {
          browserChoiceContainer.classList.remove('visible');
        }
      }
      void persistSettings();
    });
  if (browserChoiceSelect)
    browserChoiceSelect.addEventListener('change', (e) => {
      settingsStore.settings.browserChoice = (
        e.target as HTMLInputElement | HTMLSelectElement
      ).value;
      void persistSettings();
    });
  if (convertToggle)
    convertToggle.addEventListener('change', (e) => {
      settingsStore.settings.convertEnabled = (e.target as HTMLInputElement).checked;
      if ((e.target as HTMLInputElement).checked) {
        convertFormatContainer?.classList.add('visible');
        keepOriginalLabel?.classList.add('visible');
        if (gpuAccelerationLabel) gpuAccelerationLabel.classList.add('visible');
      } else {
        convertFormatContainer?.classList.remove('visible');
        keepOriginalLabel?.classList.remove('visible');
        if (gpuAccelerationLabel) gpuAccelerationLabel.classList.remove('visible');
        if (gpuTypeContainer) gpuTypeContainer.classList.remove('visible');
      }
      if (!(e.target as HTMLInputElement).checked) {
        settingsStore.settings.keepOriginalAfterConvert = true;
        if (keepOriginalToggle) keepOriginalToggle.checked = true;
      }
      void persistSettings();
    });
  if (convertFormatSelect)
    convertFormatSelect.addEventListener('change', (e) => {
      settingsStore.settings.convertFormat = (
        e.target as HTMLInputElement | HTMLSelectElement
      ).value;
      void persistSettings();
    });
  if (ffmpegPathInput) {
    ffmpegPathInput.addEventListener('input', (e) => {
      settingsStore.settings.ffmpegPath = (e.target as HTMLInputElement | HTMLSelectElement).value;
    });
    ffmpegPathInput.addEventListener('change', (e) => {
      settingsStore.settings.ffmpegPath = (e.target as HTMLInputElement | HTMLSelectElement).value;
      void persistSettings();
    });
  }
  if (upstreamProxyInput) {
    upstreamProxyInput.addEventListener('input', (e) => {
      settingsStore.settings.upstreamProxy = (e.target as HTMLInputElement).value;
    });
    upstreamProxyInput.addEventListener('change', (e) => {
      settingsStore.settings.upstreamProxy = (e.target as HTMLInputElement).value;
      void persistSettings();
    });
  }
  // GPU acceleration toggle
  if (gpuAccelerationToggle) {
    gpuAccelerationToggle.addEventListener('change', (e) => {
      settingsStore.settings.gpuAcceleration = (e.target as HTMLInputElement).checked;
      if (gpuTypeContainer) {
        if ((e.target as HTMLInputElement).checked) {
          gpuTypeContainer.classList.add('visible');
        } else {
          gpuTypeContainer.classList.remove('visible');
        }
      }
      void persistSettings();
    });
  }
  if (gpuTypeSelect) {
    gpuTypeSelect.addEventListener('change', (e) => {
      settingsStore.settings.gpuType = (e.target as HTMLSelectElement)
        .value as RosiSettings['gpuType'];
      void persistSettings();
    });
  }
  // Animate Background toggle
  if (animateBackgroundToggle) {
    animateBackgroundToggle.addEventListener('change', (e) => {
      settingsStore.settings.animateBackground = (e.target as HTMLInputElement).checked;
      updateBackgroundAnimation((e.target as HTMLInputElement).checked);
      void persistSettings();
    });
  }
  if (themeSelect) {
    themeSelect.addEventListener('change', (e) => {
      settingsStore.settings.theme = (e.target as HTMLSelectElement).value as RosiSettings['theme'];
      applyTheme(settingsStore.settings.theme);
      void persistSettings();
    });
  }
  if (flatUiToggle) {
    flatUiToggle.addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      settingsStore.settings.flatUi = checked;
      if (checked) {
        document.documentElement.dataset.flatUi = 'true';
        localStorage.setItem('rosi-flat-ui', 'true');
      } else {
        delete document.documentElement.dataset.flatUi;
        localStorage.setItem('rosi-flat-ui', 'false');
      }
      void persistSettings();
    });
  }

  // Notifications toggle
  if (notificationsToggle) {
    notificationsToggle.addEventListener('change', (e) => {
      settingsStore.settings.notifications = (e.target as HTMLInputElement).checked;
      void persistSettings();
    });
  }

  if (taskbarProgressToggle) {
    taskbarProgressToggle.addEventListener('change', (e) => {
      settingsStore.settings.showTaskbarProgress = (e.target as HTMLInputElement).checked;
      void persistSettings();
    });
  }

  if (embedMetadataToggle) {
    embedMetadataToggle.addEventListener('change', (e) => {
      settingsStore.settings.embedMetadata = (e.target as HTMLInputElement).checked;
      void persistSettings();
    });
  }

  if (embedThumbnailToggle) {
    embedThumbnailToggle.addEventListener('change', (e) => {
      settingsStore.settings.embedThumbnail = (e.target as HTMLInputElement).checked;
      void persistSettings();
    });
  }

  if (sponsorblockToggle) {
    sponsorblockToggle.addEventListener('change', (e) => {
      settingsStore.settings.sponsorblockRemove = (e.target as HTMLInputElement).checked;
      void persistSettings();
    });
  }

  bindExternalLink(sponsorblockHelp, 'https://sponsor.ajay.app/');

  if (writeSubtitlesToggle) {
    writeSubtitlesToggle.addEventListener('change', (e) => {
      settingsStore.settings.writeSubtitles = (e.target as HTMLInputElement).checked;
      if (subtitleLangsContainer) {
        subtitleLangsContainer.classList.toggle('visible', (e.target as HTMLInputElement).checked);
      }
      void persistSettings();
    });
  }

  const subtitleLangsError = document.getElementById('subtitleLangsError');
  if (subtitleLangsInput) {
    const showSubtitleLangsError = (message: string) => {
      subtitleLangsInput.setAttribute('aria-invalid', 'true');
      if (subtitleLangsError) {
        subtitleLangsError.textContent = message;
      } else {
        showToast(message, { type: 'warning' });
      }
    };
    const clearSubtitleLangsError = () => {
      subtitleLangsInput.removeAttribute('aria-invalid');
      if (subtitleLangsError) subtitleLangsError.textContent = '';
    };
    const commitSubtitleLangs = () => {
      const raw = subtitleLangsInput.value.trim();
      if (!isValidSubtitleLangs(raw)) {
        showSubtitleLangsError(
          'Enter comma-separated language codes (for example en,es) or use all.'
        );
        return;
      }
      clearSubtitleLangsError();
      settingsStore.settings.subtitleLangs = raw;
      void persistSettings();
    };
    subtitleLangsInput.addEventListener('change', commitSubtitleLangs);
    subtitleLangsInput.addEventListener('blur', commitSubtitleLangs);
    subtitleLangsInput.addEventListener('input', () => {
      if (subtitleLangsInput.hasAttribute('aria-invalid')) {
        clearSubtitleLangsError();
      }
    });
  }

  // Check updates on startup
  if (checkUpdatesOnStartupToggle) {
    checkUpdatesOnStartupToggle.addEventListener('change', (e) => {
      settingsStore.settings.checkUpdatesOnStartup = (e.target as HTMLInputElement).checked;
      void persistSettings();
    });
  }
}

/** Update channel, reset, export, import, and statistics. */
export function bindSettingsActions() {
  const retrySettingsSave = document.getElementById('retrySettingsSave');
  retrySettingsSave?.addEventListener('click', () => {
    void persistSettings(false, true);
  });
  const {
    exportSettingsBtn,
    importSettingsBtn,
    resetSettingsBtn,
    showUpdateChannelBtn,
    updateChannelContainer,
    updateChannelSelect,
    viewStatsBtn,
  } = refs;
  if (showUpdateChannelBtn && updateChannelContainer) {
    const syncUpdateChannelAria = () => {
      const isVisible = updateChannelContainer.classList.contains('visible');
      updateChannelContainer.setAttribute('aria-hidden', String(!isVisible));
      showUpdateChannelBtn.setAttribute('aria-expanded', String(isVisible));
    };
    syncUpdateChannelAria();
    showUpdateChannelBtn.addEventListener('click', () => {
      const isVisible = updateChannelContainer.classList.contains('visible');
      updateChannelContainer.classList.toggle('visible', !isVisible);
      syncUpdateChannelAria();
      showUpdateChannelBtn.textContent = isVisible
        ? '▸ Update channel settings'
        : '▾ Hide update channel';
    });
  }

  if (updateChannelSelect) {
    updateChannelSelect.addEventListener('change', (e) => {
      const previousChannel = settingsStore.settings.updateChannel ?? 'auto';
      settingsStore.settings.updateChannel = (e.target as HTMLSelectElement)
        .value as RosiSettings['updateChannel'];
      // Retire the old update identity before the async settings write can
      // complete; the updater holds that save before its target recheck.
      const save = persistSettings(false, true);
      if (window.api.getChannel() !== 'msstore') {
        window.api.notifyUpdaterChannelChanged?.(
          settingsStore.settings.updateChannel,
          save,
          previousChannel
        );
      }
    });
  }

  if (resetSettingsBtn)
    resetSettingsBtn.addEventListener('click', () => {
      showModal({
        title: 'Confirm Reset',
        message: 'Are you sure you want to reset all settings to default? Rosi will restart.',
        buttons: [
          { label: 'Cancel' },
          {
            label: '⟳ Reset & Restart',
            danger: true,
            action: async () => {
              if (!(await flushBeforeRestart('Resetting settings'))) return;
              localStorage.removeItem('rosi-flat-ui');
              localStorage.removeItem('rosi-theme');
              try {
                await window.api.resetSettings();
              } catch (error) {
                localStorage.setItem(
                  'rosi-flat-ui',
                  settingsStore.settings.flatUi ? 'true' : 'false'
                );
                if (settingsStore.settings.theme)
                  localStorage.setItem('rosi-theme', settingsStore.settings.theme);
                const detail = error instanceof Error ? error.message : String(error);
                showModal({
                  title: 'Reset Did Not Complete',
                  message: `ROSI could not confirm durable state and complete the reset. Your settings were not reset, and the app remains open.\n\n${detail}`,
                  buttons: [{ label: 'OK', primary: true }],
                  priority: true,
                });
              }
            },
          },
        ],
      });
    });

  if (exportSettingsBtn) {
    exportSettingsBtn.addEventListener('click', async () => {
      try {
        if (!(await persistSettings(false, true))) return;
        const result = await window.api.exportSettings();
        if (result && result.ok) {
          showToast('Settings exported successfully.', { type: 'success' });
        } else if (result && !result.ok) {
          showToast(result.error?.message || 'Export failed.', { type: 'error' });
        }
      } catch {
        showToast('An unexpected error occurred during export.', { type: 'error' });
      }
    });
  }

  if (importSettingsBtn) {
    importSettingsBtn.addEventListener('click', async () => {
      showModal({
        title: 'Import Settings',
        message: 'Importing settings will overwrite your current settings. Continue?',
        buttons: [
          { label: 'Cancel' },
          {
            label: 'Import',
            primary: true,
            action: async () => {
              try {
                if (!(await persistSettings(false, true))) return;
                const result = await window.api.importSettings();
                if (result && result.ok) {
                  showToast('Settings imported successfully.', { type: 'success' });
                } else {
                  showToast(result?.error?.message || 'Import failed or was cancelled.', {
                    type: 'error',
                  });
                }
              } catch {
                showToast('An unexpected error occurred during import.', { type: 'error' });
              }
            },
          },
        ],
      });
    });
  }

  if (viewStatsBtn) {
    viewStatsBtn.addEventListener('click', async () => {
      try {
        const stats = await window.api.getStats();
        const formatList = Object.entries(stats.formatCounts || {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([fmt, count]) => `${fmt}: ${count}`)
          .join(', ');
        showModal({
          title: 'Download Statistics',
          message: [
            `Total downloads: ${stats.totalDownloads}`,
            `Successful: ${stats.successfulDownloads}`,
            `Failed: ${stats.failedDownloads}`,
            `Cancelled: ${stats.cancelledDownloads}`,
            `Total downloaded: ${formatBytes(stats.totalBytesDownloaded)}`,
            formatList ? `Top formats: ${formatList}` : '',
            stats.lastDownloadAt
              ? `Last download: ${formatRelativeTime(stats.lastDownloadAt)}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
          buttons: [
            {
              label: 'Reset Stats',
              action: async () => {
                try {
                  const result = await window.api.resetStats();
                  if (!result.ok) {
                    showToast('Could not reset statistics. Please try again.', { type: 'error' });
                    return;
                  }
                  showToast('Statistics reset.', { type: 'info' });
                } catch {
                  showToast('Could not reset statistics. Please try again.', { type: 'error' });
                }
              },
            },
            { label: 'Close', primary: true },
          ],
        });
      } catch {
        showToast('Could not load statistics.', { type: 'error' });
      }
    });
  }
}
