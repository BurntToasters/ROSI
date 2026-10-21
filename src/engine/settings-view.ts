// Settings controls: rendering from settings, search, and section collapse.
import { RosiSettings, dockModule, renderFolderSummary, settingsModule } from './core';
import { isModalActive, modalQueue, showModal } from './overlays';
import { refs } from './refs';
import { persistSettings, settingsStore } from './settings-store';
import { applyTheme, updateBackgroundAnimation } from './theme';
import { toggleAdvancedUI, updateConsoleVisibility } from './ui-helpers';

// update UI from settings
export const updateUIFromSettings = () => {
  if (
    !refs.consoleToggle ||
    !refs.keepOriginalToggle ||
    !refs.hookBrowserToggle ||
    !refs.browserChoiceContainer ||
    !refs.browserChoiceSelect ||
    !refs.convertToggle ||
    !refs.convertFormatContainer ||
    !refs.convertFormatSelect ||
    !refs.keepOriginalLabel
  )
    return;
  refs.consoleToggle.checked = settingsStore.settings.showConsoleOutput ?? false;
  refs.keepOriginalToggle.checked = settingsStore.settings.keepOriginalAfterConvert ?? true;
  refs.hookBrowserToggle.checked = settingsStore.settings.hookBrowser ?? false;
  // Settings store yt-dlp's lowercase names; older builds sent TitleCase.
  refs.browserChoiceSelect.value = (settingsStore.settings.browserChoice ?? 'chrome').toLowerCase();
  refs.convertToggle.checked = settingsStore.settings.convertEnabled ?? false;
  refs.convertFormatSelect.value = settingsStore.settings.convertFormat ?? 'mp4';
  refs.keepOriginalToggle.checked = settingsStore.settings.keepOriginalAfterConvert ?? true;

  if (refs.convertToggle.checked) {
    refs.convertFormatContainer.classList.add('visible');
    refs.keepOriginalLabel.classList.add('visible');
    if (refs.gpuAccelerationLabel) refs.gpuAccelerationLabel.classList.add('visible');
  } else {
    refs.convertFormatContainer.classList.remove('visible');
    refs.keepOriginalLabel.classList.remove('visible');
    if (refs.gpuAccelerationLabel) refs.gpuAccelerationLabel.classList.remove('visible');
  }

  // GPU acceleration settings
  if (refs.gpuAccelerationToggle) {
    refs.gpuAccelerationToggle.checked = settingsStore.settings.gpuAcceleration ?? false;
  }
  if (refs.gpuTypeSelect) {
    refs.gpuTypeSelect.value = settingsStore.settings.gpuType ?? 'auto';
  }
  if (refs.gpuTypeContainer) {
    if (settingsStore.settings.gpuAcceleration) {
      refs.gpuTypeContainer.classList.add('visible');
    } else {
      refs.gpuTypeContainer.classList.remove('visible');
    }
  }

  if (refs.ffmpegPathInput) {
    refs.ffmpegPathInput.value = settingsStore.settings.ffmpegPath ?? '';
  }

  if (refs.upstreamProxyInput) {
    refs.upstreamProxyInput.value = settingsStore.settings.upstreamProxy ?? '';
  }

  if (settingsStore.settings.hookBrowser) {
    refs.browserChoiceContainer.classList.add('visible');
  } else {
    refs.browserChoiceContainer.classList.remove('visible');
  }

  updateConsoleVisibility(settingsStore.settings.showConsoleOutput);

  toggleAdvancedUI(settingsStore.settings.downloadMode === 'custom');

  // Update additional options
  if (refs.animateBackgroundToggle) {
    refs.animateBackgroundToggle.checked = settingsStore.settings.animateBackground ?? true;
    updateBackgroundAnimation(settingsStore.settings.animateBackground ?? true);
  }
  if (refs.flatUiToggle) {
    const isFlat =
      typeof settingsStore.settings.flatUi === 'boolean'
        ? settingsStore.settings.flatUi
        : localStorage.getItem('rosi-flat-ui') === 'true';
    settingsStore.settings.flatUi = isFlat;
    refs.flatUiToggle.checked = isFlat;
    if (isFlat) {
      document.documentElement.dataset.flatUi = 'true';
      localStorage.setItem('rosi-flat-ui', 'true');
    } else {
      delete document.documentElement.dataset.flatUi;
      localStorage.setItem('rosi-flat-ui', 'false');
    }
  }
  if (refs.themeSelect) {
    const nextTheme =
      settingsStore.settings.theme === 'light' ||
      settingsStore.settings.theme === 'dark' ||
      settingsStore.settings.theme === 'purple' ||
      settingsStore.settings.theme === 'system'
        ? settingsStore.settings.theme
        : 'system';
    refs.themeSelect.value = nextTheme;
    applyTheme(nextTheme);
  }
  refs.profileButtons.forEach(([mode, button]) => {
    if (!button) return;
    const isSelected = settingsStore.settings.downloadMode === mode;
    button.classList.toggle('selected', isSelected);
    button.setAttribute('aria-pressed', String(isSelected));
  });
  if (refs.profileAudioFormatSelect) {
    refs.profileAudioFormatSelect.value = settingsStore.settings.audioFormat ?? 'mp3';
  }
  if (refs.profileAudioFormatContainer) {
    refs.profileAudioFormatContainer.classList.toggle(
      'hidden',
      settingsStore.settings.downloadMode !== 'audio'
    );
  }
  if (refs.askDownloadLocationToggle) {
    refs.askDownloadLocationToggle.checked = !!settingsStore.settings.askDownloadLocation;
  }
  if (refs.downloadFolderSummary) {
    renderFolderSummary(refs.downloadFolderSummary, settingsStore.settings.downloadFolder);
  }
  if (refs.downloadOutputSummary) {
    if (settingsStore.settings.downloadMode === 'best-video') {
      refs.downloadOutputSummary.textContent =
        'Highest available video and audio quality, merged into one file';
    } else if (settingsStore.settings.downloadMode === 'audio') {
      refs.downloadOutputSummary.textContent = `Audio only, saved as ${(settingsStore.settings.audioFormat || 'mp3').toUpperCase()}`;
    } else if (settingsStore.settings.downloadMode === 'custom') {
      refs.downloadOutputSummary.textContent = 'Pick exact video and audio formats below';
    } else {
      refs.downloadOutputSummary.textContent =
        'Prefer MP4 when available; otherwise use the best available format. Often low resolution';
    }
  }
  // disable convert when audio-only is enabled
  if (refs.convertToggle) {
    refs.convertToggle.disabled = settingsStore.settings.audioOnly ?? false;
    if (settingsStore.settings.audioOnly) {
      refs.convertToggle.parentElement!.classList.add('disabled');
      refs.convertToggle.parentElement!.title = 'Disabled when Audio-only mode is enabled';
    } else {
      refs.convertToggle.parentElement!.classList.remove('disabled');
      refs.convertToggle.parentElement!.title = '';
    }
  }
  if (refs.notificationsToggle) {
    refs.notificationsToggle.checked = settingsStore.settings.notifications ?? true;
  }
  if (refs.taskbarProgressToggle) {
    refs.taskbarProgressToggle.checked = settingsStore.settings.showTaskbarProgress ?? true;
  }

  if (refs.embedMetadataToggle) {
    refs.embedMetadataToggle.checked = settingsStore.settings.embedMetadata ?? false;
  }
  if (refs.embedThumbnailToggle) {
    refs.embedThumbnailToggle.checked = settingsStore.settings.embedThumbnail ?? false;
  }
  if (refs.sponsorblockToggle) {
    refs.sponsorblockToggle.checked = settingsStore.settings.sponsorblockRemove ?? false;
  }
  if (refs.writeSubtitlesToggle) {
    refs.writeSubtitlesToggle.checked = settingsStore.settings.writeSubtitles ?? false;
  }
  if (refs.subtitleLangsInput) {
    refs.subtitleLangsInput.value = settingsStore.settings.subtitleLangs ?? 'en';
  }
  if (refs.subtitleLangsContainer) {
    refs.subtitleLangsContainer.classList.toggle(
      'visible',
      !!settingsStore.settings.writeSubtitles
    );
  }

  const channel = window.api.getChannel();
  if (refs.checkUpdatesOnStartupToggle) {
    refs.checkUpdatesOnStartupToggle.checked = settingsStore.settings.checkUpdatesOnStartup ?? true;
    if (channel === 'msstore' && refs.checkUpdatesOnStartupLabel) {
      refs.checkUpdatesOnStartupLabel.classList.add('hidden');
    }
  }

  if (refs.updateChannelSelect) {
    refs.updateChannelSelect.value = settingsStore.settings.updateChannel ?? 'auto';
    if (channel === 'msstore') {
      if (refs.updateChannelContainer) refs.updateChannelContainer.classList.add('hidden');
      if (refs.showUpdateChannelBtn) refs.showUpdateChannelBtn.classList.add('hidden');
    }
  }
};

export const applyDownloadProfile = (mode: RosiSettings['downloadMode']) => {
  settingsStore.settings.downloadMode = mode;
  settingsStore.settings.bestQuality = mode === 'best-video';
  settingsStore.settings.audioOnly = mode === 'audio';
  settingsStore.settings.advancedOptions = mode === 'custom';
  if (mode === 'audio') settingsStore.settings.convertEnabled = false;
};

// Runs after a settings pass, so the Console tab is already offered or not.
export function syncDockFromSettings() {
  dockModule?.initDock({
    initialTab: settingsStore.settings.dockTab,
    collapsed: settingsStore.settings.dockCollapsed,
    onChange: ({ tab, collapsed }) => {
      settingsStore.settings.dockTab = tab;
      settingsStore.settings.dockCollapsed = collapsed;
      void persistSettings();
    },
  });
}

export function maybeShowSupportModal() {
  if (settingsStore.settings.hideSupportModal || settingsStore.settings.firstLaunch) return;
  if (isModalActive || modalQueue.length > 0) {
    setTimeout(maybeShowSupportModal, 1500);
    return;
  }
  showModal({
    title: 'Support This Project?',
    message:
      'Would you like to support the development of ROSI?\nYour help keeps this project alive!',
    buttons: [
      {
        label: 'Yes Support!',
        icon: 'heart',
        primary: true,
        action: () => {
          void window.api.openExternal('https://rosie.run/support');
          settingsStore.settings.hideSupportModal = true;
          void persistSettings();
        },
      },
      {
        label: 'No thanks',
        action: () => {
          settingsStore.settings.hideSupportModal = true;
          void persistSettings();
        },
      },
    ],
  });
}

export const bindExternalLink = (element: HTMLElement | null, url: string) => {
  if (settingsModule && typeof settingsModule.bindExternalLink === 'function') {
    // Look the bridge up per click so it is never a stale reference.
    settingsModule.bindExternalLink(element, url, (target) => window.api.openExternal(target));
    return;
  }
  if (element) {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void window.api.openExternal(url);
    });
  }
};

export function applySettingsSearch(rawQuery: string) {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    refs.settingsSections.forEach((section, index) => {
      section.classList.remove('search-hidden');
      section.querySelectorAll<HTMLElement>('.search-hidden').forEach((child) => {
        child.classList.remove('search-hidden');
      });
      // Restore the collapse state the user had before searching.
      if (settingsViewState.collapseStateBeforeSearch) {
        const wasCollapsed = settingsViewState.collapseStateBeforeSearch[index] === true;
        section.classList.toggle('collapsed', wasCollapsed);
        const header = section.querySelector<HTMLElement>('.settings-section-header');
        header?.setAttribute('aria-expanded', String(!wasCollapsed));
        const sectionBody = section.querySelector<HTMLElement>('.settings-section-body');
        if (sectionBody) sectionBody.inert = wasCollapsed;
      }
    });
    settingsViewState.collapseStateBeforeSearch = null;
    if (refs.settingsSearchStatus) refs.settingsSearchStatus.textContent = '';
    return;
  }

  if (!settingsViewState.collapseStateBeforeSearch) {
    settingsViewState.collapseStateBeforeSearch = refs.settingsSections.map((section) =>
      section.classList.contains('collapsed')
    );
  }

  let matches = 0;
  refs.settingsSections.forEach((section) => {
    const controls = Array.from(
      section.querySelectorAll<HTMLElement>('.setting-row, .settings-btn')
    );
    let sectionMatches = false;
    controls.forEach((control) => {
      const isMatch = (control.textContent || '').toLowerCase().includes(query);
      control.classList.toggle('search-hidden', !isMatch);
      if (isMatch) sectionMatches = true;
    });
    const title = (
      section.querySelector('.settings-section-title')?.textContent || ''
    ).toLowerCase();
    if (title.includes(query)) {
      sectionMatches = true;
      controls.forEach((control) => control.classList.remove('search-hidden'));
    }
    section.classList.toggle('search-hidden', !sectionMatches);
    if (sectionMatches) {
      matches += 1;
      section.classList.remove('collapsed');
      const sectionBody = section.querySelector<HTMLElement>('.settings-section-body');
      if (sectionBody) sectionBody.inert = false;
      section
        .querySelector<HTMLElement>('.settings-section-header')
        ?.setAttribute('aria-expanded', 'true');
    }
  });

  if (refs.settingsSearchStatus) {
    refs.settingsSearchStatus.textContent =
      matches === 0
        ? 'No settings match your search.'
        : `${matches} ${matches === 1 ? 'section matches' : 'sections match'} your search.`;
  }
}

export const setSettingsSectionCollapsed = (header: HTMLElement, collapsed: boolean) => {
  if (!(header instanceof HTMLElement)) return false;
  const section = header.closest('.settings-section');
  if (!(section instanceof HTMLElement)) return false;
  section.classList.toggle('collapsed', !!collapsed);
  const isCollapsed = section.classList.contains('collapsed');
  header.setAttribute('aria-expanded', String(!isCollapsed));
  const controlledId = header.getAttribute('aria-controls');
  const sectionBody =
    (controlledId ? document.getElementById(controlledId) : null) ||
    section.querySelector('.settings-section-body');
  if (sectionBody) {
    sectionBody.setAttribute('aria-hidden', String(isCollapsed));
    if (sectionBody instanceof HTMLElement) {
      sectionBody.inert = isCollapsed;
    }
    if (!controlledId && sectionBody.id) {
      header.setAttribute('aria-controls', sectionBody.id);
    }
  }
  return isCollapsed;
};

// Owned by the renderer controller; set during startup and updated while it runs.
export const settingsViewState: {
  collapseStateBeforeSearch: boolean[] | null;
} = {
  collapseStateBeforeSearch: null,
};
