// Startup bindings for settings search, reset, and collapsible sections.
import { RosiSettings } from '../core';
import { byId, refs } from '../refs';
import { loadDefaultSettings, persistSettings, settingsStore } from '../settings-store';
import {
  applySettingsSearch,
  setSettingsSectionCollapsed,
  updateUIFromSettings,
} from '../settings-view';
import { applyTheme } from '../theme';
import { showToast } from '../ui-helpers';

/** Settings search and per-section reset. */
export function initSettingsSearch() {
  // ── Settings search and per-section reset ───────────────────────────────────
  const settingsSearchInput = byId<HTMLInputElement>('settingsSearch');
  refs.settingsSearchStatus = byId<HTMLElement>('settingsSearchStatus');
  refs.settingsSections = Array.from(document.querySelectorAll<HTMLElement>('.settings-section'));

  if (settingsSearchInput) {
    settingsSearchInput.addEventListener('input', () => {
      applySettingsSearch(settingsSearchInput.value);
    });

    // Clear a stale filter when the sidebar closes, so reopening Settings never
    // shows a partially hidden list the user has forgotten about.
    const sidebarEl = document.getElementById('sidebar');
    if (sidebarEl && typeof MutationObserver === 'function') {
      let sidebarWasOpen = sidebarEl.classList.contains('open');
      const sidebarObserver = new MutationObserver(() => {
        const isOpen = sidebarEl.classList.contains('open');
        if (sidebarWasOpen && !isOpen && settingsSearchInput.value) {
          settingsSearchInput.value = '';
          applySettingsSearch('');
        }
        sidebarWasOpen = isOpen;
      });
      sidebarObserver.observe(sidebarEl, { attributes: true, attributeFilter: ['class'] });
    }
    settingsSearchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !settingsSearchInput.value) return;
      event.stopPropagation();
      settingsSearchInput.value = '';
      applySettingsSearch('');
    });
  }

  const SECTION_RESET_KEYS: Record<string, Array<keyof RosiSettings>> = {
    download: [
      'convertEnabled',
      'convertFormat',
      'keepOriginalAfterConvert',
      'gpuAcceleration',
      'gpuType',
      'ffmpegPath',
      'upstreamProxy',
    ],
    enhancements: [
      'embedMetadata',
      'embedThumbnail',
      'sponsorblockRemove',
      'writeSubtitles',
      'subtitleLangs',
    ],
    browser: ['hookBrowser', 'browserChoice'],
    interface: [
      'showConsoleOutput',
      'animateBackground',
      'theme',
      'flatUi',
      'notifications',
      'showTaskbarProgress',
    ],
    application: ['checkUpdatesOnStartup', 'updateChannel'],
  };

  document.querySelectorAll<HTMLButtonElement>('.settings-section-reset').forEach((button) => {
    button.addEventListener('click', async (event) => {
      // Keep the click from bubbling into the section collapse handler.
      event.stopPropagation();
      const sectionName = button.dataset.resetSection ?? '';
      const keys = SECTION_RESET_KEYS[sectionName];
      if (!keys) return;
      const defaults = await loadDefaultSettings();
      if (!defaults) {
        showToast('Could not load default settings.', { type: 'error' });
        return;
      }
      const settingsRecord = settingsStore.settings as unknown as Record<string, unknown>;
      const defaultsRecord = defaults as unknown as Record<string, unknown>;
      keys.forEach((key) => {
        settingsRecord[key] = defaultsRecord[key];
      });
      updateUIFromSettings();
      applyTheme(settingsStore.settings.theme ?? 'system');
      const saved = await persistSettings(true, true);
      showToast(saved ? 'Section restored to defaults.' : 'Could not save the restored section.', {
        type: saved ? 'success' : 'error',
      });
    });
  });
}

/** Collapsible settings sections. */
export function initSettingsSections() {
  const settingsHeaders = Array.from(
    document.querySelectorAll<HTMLElement>('.settings-section-header')
  ).filter((header) => header instanceof HTMLElement);

  settingsHeaders.forEach((header, index) => {
    const section = header.closest('.settings-section');
    if (!(section instanceof HTMLElement)) return;

    const controlledId = header.getAttribute('aria-controls');
    const sectionBody =
      (controlledId ? document.getElementById(controlledId) : null) ||
      section.querySelector('.settings-section-body');
    if (sectionBody instanceof HTMLElement) {
      if (!sectionBody.id) {
        sectionBody.id = `settingsSectionBodyAuto${index + 1}`;
      }
      if (!header.getAttribute('aria-controls')) {
        header.setAttribute('aria-controls', sectionBody.id);
      }
      if (!header.id) {
        header.id = `settingsSectionHeaderAuto${index + 1}`;
      }
      if (!sectionBody.getAttribute('aria-labelledby')) {
        sectionBody.setAttribute('aria-labelledby', header.id);
      }
    }

    setSettingsSectionCollapsed(header, section.classList.contains('collapsed'));

    header.addEventListener('click', () => {
      const isCollapsed = section.classList.contains('collapsed');
      setSettingsSectionCollapsed(header, !isCollapsed);
    });
    header.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setSettingsSectionCollapsed(header, true);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setSettingsSectionCollapsed(header, false);
        return;
      }

      const currentIndex = settingsHeaders.indexOf(header);
      if (currentIndex === -1) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIndex = (currentIndex + 1) % settingsHeaders.length;
        settingsHeaders[nextIndex]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const nextIndex = (currentIndex - 1 + settingsHeaders.length) % settingsHeaders.length;
        settingsHeaders[nextIndex]?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        settingsHeaders[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        settingsHeaders[settingsHeaders.length - 1]?.focus();
      }
    });
  });
}
