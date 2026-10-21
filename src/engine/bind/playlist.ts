// Startup bindings for playlist scope controls.
import { resetPlaylistScope, syncPlaylistRangeVisibility } from '../playlist';
import { RosiVideoInfo } from '../preview';
import { byId, refs } from '../refs';

/** Playlist scope radios and range inputs. */
export function initPlaylistScope() {
  // ── Playlist scope ──────────────────────────────────────────────────────────
  refs.playlistScope = byId<HTMLElement>('playlistScope');
  refs.playlistRangeFields = byId<HTMLElement>('playlistRangeFields');
  const playlistRangeStart = (refs.playlistRangeStart =
    byId<HTMLInputElement>('playlistRangeStart'));
  const playlistRangeEnd = (refs.playlistRangeEnd = byId<HTMLInputElement>('playlistRangeEnd'));
  const playlistScopeError = (refs.playlistScopeError = byId<HTMLElement>('playlistScopeError'));

  document.querySelectorAll<HTMLInputElement>('input[name="playlist-scope"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      syncPlaylistRangeVisibility();
      if (playlistScopeError) playlistScopeError.textContent = '';
    });
  });
  [playlistRangeStart, playlistRangeEnd].forEach((input) => {
    input?.addEventListener('input', () => {
      if (playlistScopeError) playlistScopeError.textContent = '';
    });
  });
  resetPlaylistScope();
  refs.previewCache = new Map<string, { info: RosiVideoInfo; storedAt: number }>();
}
