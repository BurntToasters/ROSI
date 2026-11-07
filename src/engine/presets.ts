// Download presets: listing, building, and applying.
import { RosiDownloadPreset, RosiPlaylistSelection } from './core';
import { clearAdvancedFormatSelections, formatState, invalidateFormatRequest } from './formats';
import {
  applyPlaylistSelectionToRadios,
  isPlaylistScopeVisible,
  resolvePlaylistSelection,
} from './playlist';
import { refs } from './refs';
import { getPresets, persistSettings, settingsStore } from './settings-store';
import { updateUIFromSettings } from './settings-view';

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
  if (appliedPreset && !presets.some((preset) => preset.id === appliedPreset?.id)) {
    appliedPreset = null;
  }
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

/**
 * Request fields the on-screen controls set. A group moves together, so one
 * changed field cannot pair with a stale sibling.
 */
const PROFILE_GROUP = ['profile', 'bestQuality', 'audioOnly', 'advancedOptions'] as const;
const CONVERT_GROUP = ['convertEnabled', 'convertFormat', 'keepOriginal'] as const;
const OPTION_KEYS = [
  ...PROFILE_GROUP,
  ...CONVERT_GROUP,
  'gpuAcceleration',
  'gpuType',
  'writeSubtitles',
  'subtitleLangs',
  'embedThumbnail',
  'embedMetadata',
  'sponsorblockRemove',
  'audioOutputFormat',
  'videoFormat',
  'audioFormat',
  'playlist',
] as const;

const FORMAT_KEYS = ['videoFormat', 'audioFormat'] as const;

type OptionKey = (typeof OPTION_KEYS)[number];
type OptionValues = Partial<Record<OptionKey, unknown>>;

/** Rust's resolved request fields, mapped to the settings keys the controls read. */
const SETTINGS_KEY_FOR_REQUEST_FIELD: Record<string, string> = {
  profile: 'downloadMode',
  bestQuality: 'bestQuality',
  audioOnly: 'audioOnly',
  advancedOptions: 'advancedOptions',
  convertEnabled: 'convertEnabled',
  convertFormat: 'convertFormat',
  keepOriginal: 'keepOriginalAfterConvert',
  gpuAcceleration: 'gpuAcceleration',
  gpuType: 'gpuType',
  writeSubtitles: 'writeSubtitles',
  subtitleLangs: 'subtitleLangs',
  embedThumbnail: 'embedThumbnail',
  embedMetadata: 'embedMetadata',
  sponsorblockRemove: 'sponsorblockRemove',
  audioOutputFormat: 'audioFormat',
};

/**
 * Placeholder for the URL that `resolve_download_options` requires. Resolution
 * only reads settings and the preset, and never fetches this address.
 */
const RESOLVE_ONLY_URL = 'https://example.com/';

/**
 * Values Apply copied into the controls, read back right after the copy. A
 * control still holding one of these values is not sent with the next request,
 * so the stored preset decides it. Cleared when the selection or the saved
 * presets change.
 */
let appliedPreset: { id: string; values: OptionValues } | null = null;

export function clearAppliedPreset() {
  appliedPreset = null;
}

function readOnScreenValues(
  formats: { videoFormat?: string; audioFormat?: string },
  playlist: RosiPlaylistSelection | undefined
): OptionValues {
  const settings = settingsStore.settings;
  const convertOn = settings.convertEnabled;
  return {
    profile: settings.downloadMode,
    bestQuality: settings.bestQuality,
    audioOnly: settings.audioOnly,
    advancedOptions: settings.advancedOptions,
    convertEnabled: convertOn,
    convertFormat: convertOn ? refs.convertFormatSelect?.value.trim() || undefined : undefined,
    keepOriginal: convertOn ? refs.keepOriginalToggle?.checked : undefined,
    gpuAcceleration: settings.gpuAcceleration,
    gpuType: settings.gpuType,
    writeSubtitles: settings.writeSubtitles,
    subtitleLangs: settings.subtitleLangs,
    embedThumbnail: settings.embedThumbnail,
    embedMetadata: settings.embedMetadata,
    sponsorblockRemove: settings.sponsorblockRemove,
    audioOutputFormat: settings.audioFormat,
    videoFormat: formats.videoFormat,
    audioFormat: formats.audioFormat,
    playlist,
  };
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Keys to send. Without an applied preset, every on-screen value is sent. */
function explicitOptionKeys(current: OptionValues, copied: OptionValues | null): OptionKey[] {
  if (!copied) return OPTION_KEYS.filter((key) => current[key] !== undefined);
  const changed = new Set<OptionKey>(
    OPTION_KEYS.filter((key) => !sameValue(current[key], copied[key]))
  );
  for (const group of [PROFILE_GROUP, CONVERT_GROUP] as const) {
    if (group.some((key) => changed.has(key))) group.forEach((key) => changed.add(key));
  }
  // Format dropdowns hold URL-specific choices, so whatever they show for this URL is sent.
  for (const key of FORMAT_KEYS) {
    if (current[key] !== undefined) changed.add(key);
  }
  return OPTION_KEYS.filter((key) => changed.has(key) && current[key] !== undefined);
}

/**
 * The request fields sent with a download, queue add, or effective-options
 * check: the selected preset id plus the on-screen values that must win over
 * it. Settings and preset values are not included; Rust resolves those through
 * `resolve_download_options`.
 */
export function buildRequestOverrides(input: {
  formats: { videoFormat?: string; audioFormat?: string };
  playlist: RosiPlaylistSelection | undefined;
}): Partial<RosiDownloadRequestOptions> {
  const selected = getSelectedPreset();
  const current = readOnScreenValues(input.formats, input.playlist);
  const overrides: Record<string, unknown> = {};
  if (!selected) {
    // Settings are saved before every request, so Rust reads them from disk.
    // Only the per-download choices are sent.
    for (const key of ['videoFormat', 'audioFormat', 'playlist'] as const) {
      if (current[key] !== undefined) overrides[key] = current[key];
    }
    return overrides as Partial<RosiDownloadRequestOptions>;
  }
  overrides.presetId = selected.id;
  const copied = appliedPreset?.id === selected.id ? appliedPreset.values : null;
  for (const key of explicitOptionKeys(current, copied)) {
    overrides[key] = current[key];
  }
  return overrides as Partial<RosiDownloadRequestOptions>;
}

/**
 * Apply a preset. Rust resolves it over the saved settings, and the controls
 * show that result. Returns false, changing nothing, when the save or the
 * resolution fails.
 */
export async function applyPresetToControls(preset: RosiDownloadPreset): Promise<boolean> {
  // Flush first so the resolution reads the controls' current settings from disk.
  if (!(await persistSettings(true, true))) return false;
  let resolved: Awaited<ReturnType<typeof window.api.resolveDownloadOptions>>;
  try {
    resolved = await window.api.resolveDownloadOptions({
      url: RESOLVE_ONLY_URL,
      presetId: preset.id,
    });
  } catch {
    return false;
  }
  if (!resolved || resolved.ok !== true) return false;

  const data = resolved.data as unknown as Record<string, unknown>;
  const settings = settingsStore.settings as unknown as Record<string, unknown>;
  for (const [field, key] of Object.entries(SETTINGS_KEY_FOR_REQUEST_FIELD)) {
    if (data[field] !== undefined && data[field] !== null) settings[key] = data[field];
  }
  invalidateFormatRequest();
  clearAdvancedFormatSelections();
  updateUIFromSettings();
  const videoFormat = typeof data.videoFormat === 'string' ? data.videoFormat : undefined;
  const audioFormat = typeof data.audioFormat === 'string' ? data.audioFormat : undefined;
  applyFormatIdToSelect('videoFormat', videoFormat);
  applyFormatIdToSelect('audioFormat', audioFormat);
  if (videoFormat || audioFormat) {
    formatState.formatSelectionsUrl =
      (document.getElementById('url') as HTMLInputElement | null)?.value.trim() || null;
  }
  applyPlaylistSelectionToRadios(data.playlist as RosiPlaylistSelection | undefined);

  appliedPreset = {
    id: preset.id,
    values: readOnScreenValues(
      readAdvancedFormatSelections(),
      isPlaylistScopeVisible() ? (resolvePlaylistSelection() ?? undefined) : undefined
    ),
  };
  void persistSettings(true, true);
  return true;
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
