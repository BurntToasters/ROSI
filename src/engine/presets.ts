// Download presets: listing, building, and applying.
import { RosiDownloadPreset } from './core';
import { clearAdvancedFormatSelections, formatState, invalidateFormatRequest } from './formats';
import { applyPlaylistSelectionToRadios, resolvePlaylistSelection } from './playlist';
import { refs } from './refs';
import { getPresets, settingsStore } from './settings-store';
import { applyDownloadProfile, updateUIFromSettings } from './settings-view';

export function getSelectedPreset(): RosiDownloadPreset | null {
  const id = refs.downloadPresetSelect?.value;
  if (!id) return null;
  return getPresets().find((preset) => preset.id === id) ?? null;
}

export function setPresetStatus(message: string) {
  if (refs.presetStatus) refs.presetStatus.textContent = message;
}

export function renderPresetOptions(selectedId = refs.downloadPresetSelect?.value ?? '') {
  const select = refs.downloadPresetSelect;
  if (!select) return;
  const presets = getPresets();
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = presets.length === 0 ? 'No saved presets' : 'Use current settings';
  select.appendChild(placeholder);
  presets.forEach((preset) => {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name;
    select.appendChild(option);
  });
  select.value = presets.some((preset) => preset.id === selectedId) ? selectedId : '';
  select.disabled = presets.length === 0;
  if (refs.applyPresetBtn) refs.applyPresetBtn.disabled = !select.value;
  if (refs.deletePresetBtn) refs.deletePresetBtn.disabled = !select.value;
}

export function createPresetId(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const base = slug || 'preset';
  const existing = new Set(getPresets().map((preset) => preset.id));
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function readAdvancedFormatSelections(targetUrl?: string): {
  videoFormat?: string;
  audioFormat?: string;
} {
  if (!settingsStore.settings.advancedOptions) return {};
  const url =
    targetUrl ?? (document.getElementById('url') as HTMLInputElement | null)?.value.trim();
  if (!url || formatState.formatSelectionsUrl !== url) return {};
  const videoSelect = document.getElementById('videoFormat') as HTMLSelectElement | null;
  const audioSelect = document.getElementById('audioFormat') as HTMLSelectElement | null;
  const videoFormat = videoSelect?.value.trim() || undefined;
  const audioFormat = audioSelect?.value.trim() || undefined;
  return { videoFormat, audioFormat };
}

export function applyFormatIdToSelect(selectId: string, formatId: string | null | undefined) {
  if (!formatId) return;
  const select = document.getElementById(selectId) as HTMLSelectElement | null;
  if (!select) return;
  if (![...select.options].some((option) => option.value === formatId)) {
    const option = document.createElement('option');
    option.value = formatId;
    option.textContent = `ID: ${formatId}`;
    select.appendChild(option);
  }
  select.value = formatId;
}

/** Snapshot only the safe, user-visible download options. */
export function buildPresetFromCurrentSettings(id: string, name: string): RosiDownloadPreset {
  const formats = readAdvancedFormatSelections();
  const preset: RosiDownloadPreset = {
    id,
    name,
    profile: settingsStore.settings.downloadMode,
    bestQuality: settingsStore.settings.bestQuality,
    audioOnly: settingsStore.settings.audioOnly,
    audioFormat: settingsStore.settings.audioFormat,
    convertEnabled: settingsStore.settings.convertEnabled,
    convertFormat: settingsStore.settings.convertFormat,
    keepOriginalAfterConvert: settingsStore.settings.keepOriginalAfterConvert,
    gpuAcceleration: settingsStore.settings.gpuAcceleration,
    gpuType: settingsStore.settings.gpuType,
    writeSubtitles: settingsStore.settings.writeSubtitles,
    subtitleLangs: settingsStore.settings.subtitleLangs,
    embedThumbnail: settingsStore.settings.embedThumbnail,
    embedMetadata: settingsStore.settings.embedMetadata,
    sponsorblockRemove: settingsStore.settings.sponsorblockRemove,
  };
  if (formats.videoFormat) preset.videoFormat = formats.videoFormat;
  if (formats.audioFormat) preset.audioFormatId = formats.audioFormat;
  const playlist = resolvePlaylistSelection();
  if (playlist && playlist.mode !== 'current') preset.playlist = playlist;
  return preset;
}

/** On-screen download options that must beat a selected preset's stored values. */
export function buildOnScreenPresetOverrides(formatSelections?: {
  videoFormat?: string;
  audioFormat?: string;
}): Record<string, unknown> {
  const overrides: Record<string, unknown> = {
    profile: settingsStore.settings.downloadMode,
    bestQuality: settingsStore.settings.bestQuality,
    audioOnly: settingsStore.settings.audioOnly,
    advancedOptions: settingsStore.settings.advancedOptions,
    convertEnabled: settingsStore.settings.convertEnabled,
    convertFormat: settingsStore.settings.convertFormat,
    keepOriginal: settingsStore.settings.keepOriginalAfterConvert,
    gpuAcceleration: settingsStore.settings.gpuAcceleration,
    gpuType: settingsStore.settings.gpuType,
    writeSubtitles: settingsStore.settings.writeSubtitles,
    subtitleLangs: settingsStore.settings.subtitleLangs,
    embedThumbnail: settingsStore.settings.embedThumbnail,
    embedMetadata: settingsStore.settings.embedMetadata,
    sponsorblockRemove: settingsStore.settings.sponsorblockRemove,
    audioOutputFormat: settingsStore.settings.audioFormat,
  };
  const formats = formatSelections ?? readAdvancedFormatSelections();
  if (formats.videoFormat) overrides.videoFormat = formats.videoFormat;
  if (formats.audioFormat) overrides.audioFormat = formats.audioFormat;
  return overrides;
}

export function applyPresetToSettings(preset: RosiDownloadPreset) {
  invalidateFormatRequest();
  clearAdvancedFormatSelections();
  applyDownloadProfile(preset.profile);
  if (typeof preset.bestQuality === 'boolean')
    settingsStore.settings.bestQuality = preset.bestQuality;
  if (typeof preset.audioOnly === 'boolean') settingsStore.settings.audioOnly = preset.audioOnly;
  if (preset.audioFormat) settingsStore.settings.audioFormat = preset.audioFormat;
  if (typeof preset.convertEnabled === 'boolean')
    settingsStore.settings.convertEnabled = preset.convertEnabled;
  if (preset.convertFormat) settingsStore.settings.convertFormat = preset.convertFormat;
  if (typeof preset.keepOriginalAfterConvert === 'boolean') {
    settingsStore.settings.keepOriginalAfterConvert = preset.keepOriginalAfterConvert;
  }
  if (typeof preset.gpuAcceleration === 'boolean') {
    settingsStore.settings.gpuAcceleration = preset.gpuAcceleration;
  }
  if (preset.gpuType) settingsStore.settings.gpuType = preset.gpuType;
  if (typeof preset.writeSubtitles === 'boolean')
    settingsStore.settings.writeSubtitles = preset.writeSubtitles;
  if (preset.subtitleLangs) settingsStore.settings.subtitleLangs = preset.subtitleLangs;
  if (typeof preset.embedThumbnail === 'boolean')
    settingsStore.settings.embedThumbnail = preset.embedThumbnail;
  if (typeof preset.embedMetadata === 'boolean')
    settingsStore.settings.embedMetadata = preset.embedMetadata;
  if (typeof preset.sponsorblockRemove === 'boolean') {
    settingsStore.settings.sponsorblockRemove = preset.sponsorblockRemove;
  }
  updateUIFromSettings();
  applyFormatIdToSelect('videoFormat', preset.videoFormat);
  applyFormatIdToSelect('audioFormat', preset.audioFormatId);
  if (preset.videoFormat || preset.audioFormatId) {
    formatState.formatSelectionsUrl =
      (document.getElementById('url') as HTMLInputElement | null)?.value.trim() || null;
  }
  applyPlaylistSelectionToRadios(preset.playlist);
}

export function isPresetPopoverOpen() {
  return !!refs.presetPopover && !refs.presetPopover.hidden;
}

export function setPresetPopoverOpen(open: boolean, { restoreFocus = true } = {}) {
  if (!refs.presetPopover || !refs.presetMenuBtn) return;
  if (open === isPresetPopoverOpen()) return;
  refs.presetPopover.hidden = !open;
  refs.presetMenuBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    const first = refs.presetPopover.querySelector<HTMLElement>(
      'select:not(:disabled), input, button:not(:disabled)'
    );
    first?.focus();
  } else if (restoreFocus) {
    refs.presetMenuBtn.focus();
  }
}
