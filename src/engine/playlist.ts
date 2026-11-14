// Playlist scope controls and selection.
import { MAX_PLAYLIST_INDEX } from './constants';
import { RosiPlaylistSelection } from './core';
import { refs } from './refs';
import { showToast } from './ui-helpers';

export function getPlaylistMode(): 'current' | 'all' | 'range' {
  const selected = document.querySelector<HTMLInputElement>('input[name="playlist-scope"]:checked');
  const value = selected?.value;
  return value === 'all' || value === 'range' ? value : 'current';
}

export function syncPlaylistRangeVisibility() {
  refs.playlistRangeFields?.classList.toggle('hidden', getPlaylistMode() !== 'range');
}

export function resetPlaylistScope() {
  refs.playlistScope?.classList.add('hidden');
  if (refs.playlistScopeError) refs.playlistScopeError.textContent = '';
  const currentRadio = document.querySelector<HTMLInputElement>(
    'input[name="playlist-scope"][value="current"]'
  );
  if (currentRadio) currentRadio.checked = true;
  syncPlaylistRangeVisibility();
}

export function showPlaylistScope(itemCount: number | null) {
  const wasHidden = !refs.playlistScope || refs.playlistScope.classList.contains('hidden');
  refs.playlistScope?.classList.remove('hidden');
  // Only seed the range on first reveal so a typed value is never clobbered
  // by a repeated preview of the same URL.
  if (wasHidden && refs.playlistRangeEnd && itemCount && itemCount > 0) {
    refs.playlistRangeEnd.value = String(Math.min(itemCount, MAX_PLAYLIST_INDEX));
  }
  syncPlaylistRangeVisibility();
}

/**
 * Validates the playlist scope. Updates the inline error text but never shows a
 * toast, so passive refreshes (the options summary) can call it freely.
 */
export function validatePlaylistSelection():
  { ok: true; selection: RosiPlaylistSelection } | { ok: false; message: string } {
  if (!refs.playlistScope || refs.playlistScope.classList.contains('hidden')) {
    return { ok: true, selection: { mode: 'current' } };
  }
  const mode = getPlaylistMode();
  if (mode !== 'range') {
    if (refs.playlistScopeError) refs.playlistScopeError.textContent = '';
    return { ok: true, selection: { mode } };
  }
  const start = Number(refs.playlistRangeStart?.value);
  const end = Number(refs.playlistRangeEnd?.value);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    end > MAX_PLAYLIST_INDEX
  ) {
    const message = `Enter a playlist range using whole numbers from 1 to ${MAX_PLAYLIST_INDEX}, with the first value no larger than the second.`;
    if (refs.playlistScopeError) refs.playlistScopeError.textContent = message;
    return { ok: false, message };
  }
  if (refs.playlistScopeError) refs.playlistScopeError.textContent = '';
  return { ok: true, selection: { mode: 'range', start, end } };
}

/** Same result as resolvePlaylistSelection, with no toast. For passive refreshes. */
export function readPlaylistSelectionSilently(): RosiPlaylistSelection | null {
  const result = validatePlaylistSelection();
  return result.ok ? result.selection : null;
}

/**
 * Returns a validated typed selection, or null when the range is invalid. An
 * invalid range also shows a warning toast; only user actions (Download, Add to
 * queue, preset save) should call this.
 */
export function resolvePlaylistSelection(): RosiPlaylistSelection | null {
  const result = validatePlaylistSelection();
  if (!result.ok) {
    showToast(result.message, { type: 'warning' });
    return null;
  }
  return result.selection;
}

export function looksLikePlaylistUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.has('list') || /\/playlist(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function applyPlaylistSelectionToRadios(playlist: RosiPlaylistSelection | null | undefined) {
  const mode = playlist?.mode === 'all' || playlist?.mode === 'range' ? playlist.mode : 'current';
  const radio = document.querySelector<HTMLInputElement>(
    `input[name="playlist-scope"][value="${mode}"]`
  );
  if (radio) radio.checked = true;
  if (mode === 'range') {
    if (refs.playlistRangeStart && typeof playlist?.start === 'number') {
      refs.playlistRangeStart.value = String(playlist.start);
    }
    if (refs.playlistRangeEnd && typeof playlist?.end === 'number') {
      refs.playlistRangeEnd.value = String(playlist.end);
    }
  }
  // All/Range presets only work when the scope UI is visible; otherwise
  // resolvePlaylistSelection() invents "current" and stomps the preset.
  if (mode === 'all' || mode === 'range') {
    refs.playlistScope?.classList.remove('hidden');
  }
  syncPlaylistRangeVisibility();
  if (refs.playlistScopeError) refs.playlistScopeError.textContent = '';
}

export function isPlaylistScopeVisible() {
  return !!(refs.playlistScope && !refs.playlistScope.classList.contains('hidden'));
}
