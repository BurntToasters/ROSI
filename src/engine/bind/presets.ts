// Startup bindings for the preset menu.
import { RosiDownloadPreset } from '../core';
import {
  applyPresetToSettings,
  buildPresetFromCurrentSettings,
  createPresetId,
  getSelectedPreset,
  isPresetPopoverOpen,
  renderPresetOptions,
  setPresetPopoverOpen,
  setPresetStatus,
} from '../presets';
import { byId, refs } from '../refs';
import { getPresets, persistSettings, settingsStore } from '../settings-store';

/** Preset menu: apply, save, delete, and the popover. */
export function initPresets() {
  // ── Saved presets ───────────────────────────────────────────────────────────
  const MAX_PRESETS = 20;
  const downloadPresetSelect = (refs.downloadPresetSelect =
    byId<HTMLSelectElement>('downloadPresetSelect'));
  const applyPresetBtn = (refs.applyPresetBtn = byId<HTMLButtonElement>('applyPresetBtn'));
  const presetNameInput = byId<HTMLInputElement>('presetNameInput');
  const savePresetBtn = byId<HTMLButtonElement>('savePresetBtn');
  const deletePresetBtn = (refs.deletePresetBtn = byId<HTMLButtonElement>('deletePresetBtn'));
  refs.presetStatus = byId<HTMLElement>('presetStatus');

  if (downloadPresetSelect) {
    downloadPresetSelect.addEventListener('change', () => {
      if (applyPresetBtn) applyPresetBtn.disabled = !downloadPresetSelect.value;
      if (deletePresetBtn) deletePresetBtn.disabled = !downloadPresetSelect.value;
      const preset = getSelectedPreset();
      setPresetStatus(preset ? `${preset.name} selected for the next download.` : '');
    });
  }
  if (applyPresetBtn) {
    applyPresetBtn.addEventListener('click', () => {
      const preset = getSelectedPreset();
      if (!preset) return;
      applyPresetToSettings(preset);
      void persistSettings(true, true);
      setPresetStatus(`Applied ${preset.name}.`);
    });
  }
  if (savePresetBtn) {
    savePresetBtn.addEventListener('click', async () => {
      const name = presetNameInput?.value.trim() ?? '';
      if (!name) {
        setPresetStatus('Enter a name before saving a preset.');
        presetNameInput?.focus();
        return;
      }
      const presets = getPresets();
      const existingIndex = presets.findIndex(
        (preset) => preset.name.toLowerCase() === name.toLowerCase()
      );
      if (existingIndex === -1 && presets.length >= MAX_PRESETS) {
        setPresetStatus(`Preset limit reached (${MAX_PRESETS}). Delete one first.`);
        return;
      }
      const id =
        existingIndex >= 0
          ? (presets[existingIndex] as RosiDownloadPreset).id
          : createPresetId(name);
      const preset = buildPresetFromCurrentSettings(id, name);
      const nextPresets = [...presets];
      if (existingIndex >= 0) {
        nextPresets[existingIndex] = preset;
      } else {
        nextPresets.push(preset);
      }
      settingsStore.settings.downloadPresets = nextPresets;
      const saved = await persistSettings(true, true);
      renderPresetOptions(saved ? id : downloadPresetSelect?.value);
      if (saved) {
        if (presetNameInput) presetNameInput.value = '';
        setPresetStatus(`Saved ${preset.name}.`);
      } else {
        setPresetStatus('Could not save the preset.');
      }
    });
  }
  if (deletePresetBtn) {
    deletePresetBtn.addEventListener('click', async () => {
      const preset = getSelectedPreset();
      if (!preset) return;
      settingsStore.settings.downloadPresets = getPresets().filter(
        (candidate) => candidate.id !== preset.id
      );
      const saved = await persistSettings(true, true);
      renderPresetOptions('');
      setPresetStatus(saved ? `Deleted ${preset.name}.` : 'Could not delete the preset.');
    });
  }
  renderPresetOptions();

  const presetMenuBtn = (refs.presetMenuBtn = byId<HTMLButtonElement>('presetMenuBtn'));
  const presetPopover = (refs.presetPopover = byId<HTMLElement>('presetPopover'));

  if (presetMenuBtn && presetPopover) {
    presetMenuBtn.addEventListener('click', () => {
      setPresetPopoverOpen(!isPresetPopoverOpen());
    });
    presetPopover.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setPresetPopoverOpen(false);
    });
    // Close when focus or a click lands anywhere outside the trigger and popover.
    document.addEventListener('pointerdown', (event) => {
      const target = event.target;
      if (!isPresetPopoverOpen() || !(target instanceof Node)) return;
      if (presetPopover.contains(target) || presetMenuBtn.contains(target)) return;
      setPresetPopoverOpen(false, { restoreFocus: false });
    });
    document.addEventListener('focusin', (event) => {
      const target = event.target;
      if (!isPresetPopoverOpen() || !(target instanceof Node)) return;
      if (presetPopover.contains(target) || presetMenuBtn.contains(target)) return;
      setPresetPopoverOpen(false, { restoreFocus: false });
    });
  }
}
