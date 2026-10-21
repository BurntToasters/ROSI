// Shared renderer types, module handles, and small helpers used across the engine.
import type {
  DownloadPreset,
  JobProgressEvent,
  PlaylistSelection,
  Settings,
} from '../generated/ipc-types';
import { configureProgressPhases, showProgressBar } from './progress';

export function logError(context: string, error?: unknown) {
  const msg = error instanceof Error ? error.message : String(error || '');
  const text = msg ? `${context}: ${msg}` : context;
  if (window.api && typeof window.api.logError === 'function') {
    window.api.logError(text);
  }
}

// IPC shapes come from the Rust types (src/generated/ipc-types.ts).
export type RosiPlaylistSelection = PlaylistSelection;
export type RosiDownloadPreset = DownloadPreset;
export type RosiSettings = Settings;
export type RosiJobProgressEvent = JobProgressEvent;

export function resolveProgressPhaseFlags(
  activeSettings: RosiSettings,
  advancedFormats?: { videoFormat?: string; audioFormat?: string }
) {
  if (activeSettings.audioOnly || activeSettings.downloadMode === 'audio') {
    return { needsMerge: false, needsConvert: activeSettings.convertEnabled };
  }
  const baseMerge = activeSettings.bestQuality || activeSettings.advancedOptions;
  const needsMerge =
    Boolean(advancedFormats?.videoFormat && advancedFormats?.audioFormat) || baseMerge;
  return {
    needsMerge,
    needsConvert: activeSettings.convertEnabled,
  };
}

export function applyActiveDownloadProgressPhases(
  activeSettings: RosiSettings,
  status = 'Downloading...',
  advancedFormats?: { videoFormat?: string; audioFormat?: string }
) {
  const { needsMerge, needsConvert } = resolveProgressPhaseFlags(activeSettings, advancedFormats);
  configureProgressPhases(needsMerge, needsConvert);
  showProgressBar(status);
}

export const rosiModules = window.rosiModules || {};
export const uiModule = rosiModules.ui || null;
export const downloadsModule = rosiModules.downloads || null;
export const activityModule = rosiModules.activity || null;
export const queueModule = rosiModules.queue || null;
export const settingsModule = rosiModules.settings || null;
export const updatesModule = rosiModules.updates || null;
export const dockModule = rosiModules.dock || null;
export const iconsModule = rosiModules.icons || null;

/** Write a status line, showing a leading Rust status emoji as an icon. */
export function renderStatusText(target: HTMLElement, text: string) {
  if (iconsModule) iconsModule.renderStatus(target, text);
  else target.textContent = text;
}

/** Replace a button's content with a Lucide icon and a text label. */
export function setButtonIconLabel(
  button: HTMLElement,
  iconName: string,
  label: string,
  size = 18
) {
  const svg = iconsModule?.icon(iconName, size) ?? null;
  const text = document.createElement('span');
  text.textContent = label;
  button.replaceChildren(...(svg ? [svg] : []), text);
}

export function isMac() {
  if (uiModule && typeof uiModule.isMac === 'function') {
    return uiModule.isMac();
  }
  return navigator.platform.toLowerCase().includes('mac');
}

export function getModifierKeyName() {
  if (uiModule && typeof uiModule.getModifierKeyName === 'function') {
    return uiModule.getModifierKeyName();
  }
  return isMac() ? 'Cmd' : 'Ctrl';
}

export function isValidUrl(string: string) {
  if (uiModule && typeof uiModule.isValidUrl === 'function') {
    return uiModule.isValidUrl(string);
  }
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface ExtractedUrlSet {
  urls: string[];
  rejected: number;
}

export function normalizeHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!isValidUrl(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function extractHttpUrls(rawValue: string): ExtractedUrlSet {
  const candidates: string[] = [];
  rawValue.split(/\r?\n/).forEach((line) => {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) return;
    candidates.push(...trimmedLine.split(/\s+/).filter(Boolean));
  });

  const urls: string[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  candidates.forEach((candidate) => {
    const normalized = normalizeHttpUrl(candidate);
    if (!normalized) {
      rejected += 1;
      return;
    }
    if (seen.has(normalized)) return;
    seen.add(normalized);
    urls.push(normalized);
  });
  return { urls, rejected };
}

/**
 * Show the save folder with its last segment pinned, so a long path loses its
 * middle to the ellipsis and the folder name stays readable.
 */
export function renderFolderSummary(target: HTMLElement, folderSetting: string | undefined) {
  const folder = folderSetting?.trim() ?? '';
  target.title = folder || 'Choose a folder before downloading';
  if (!folder) {
    target.textContent = 'Choose a folder';
    return;
  }
  const [, parents, name] = /^(.*[\\/])([^\\/]+)[\\/]?$/.exec(folder) ?? [];
  const head = document.createElement('span');
  head.className = 'download-destination-head';
  head.textContent = parents ?? folder;
  const parts: HTMLElement[] = [head];
  if (name) {
    const tail = document.createElement('span');
    tail.className = 'download-destination-tail';
    tail.textContent = name;
    parts.push(tail);
  }
  target.replaceChildren(...parts);
}

export const SUBTITLE_LANGS_RE = /^[A-Za-z0-9.*-]+(,[A-Za-z0-9.*-]+)*$/;

export function isValidSubtitleLangs(raw: string) {
  return raw.length > 0 && raw.length <= 256 && SUBTITLE_LANGS_RE.test(raw);
}
