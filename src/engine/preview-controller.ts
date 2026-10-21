// Preview scheduling, caching, and request lifecycle.
import { PREVIEW_CACHE_MAX, PREVIEW_CACHE_TTL_MS, PREVIEW_DEBOUNCE_MS } from './constants';
import { isValidUrl, logError } from './core';
import { looksLikePlaylistUrl, resetPlaylistScope, showPlaylistScope } from './playlist';
import { RosiVideoInfo, hideVideoPreview, previewState, renderVideoPreview } from './preview';
import { refs } from './refs';
import { setButtonLoading, showToast } from './ui-helpers';

export function readPreviewCache(url: string): RosiVideoInfo | null {
  const cached = refs.previewCache.get(url);
  if (!cached) return null;
  if (Date.now() - cached.storedAt > PREVIEW_CACHE_TTL_MS) {
    refs.previewCache.delete(url);
    return null;
  }
  return cached.info;
}

export function writePreviewCache(url: string, info: RosiVideoInfo) {
  refs.previewCache.set(url, { info, storedAt: Date.now() });
  while (refs.previewCache.size > PREVIEW_CACHE_MAX) {
    const oldestKey = refs.previewCache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    refs.previewCache.delete(oldestKey);
  }
}

export function setPreviewButtonLabel(label: string) {
  previewController.previewButtonLabel = label;
  if (!refs.previewBtn || refs.previewBtn.classList.contains('loading')) return;
  const target = refs.previewBtn.querySelector('.btn-label');
  if (target) target.textContent = label;
}

export function restorePreviewButtonLabel() {
  setPreviewButtonLabel(previewController.previewButtonLabel);
}

export function cancelScheduledPreview() {
  if (previewController.previewDebounceTimer) {
    clearTimeout(previewController.previewDebounceTimer);
    previewController.previewDebounceTimer = null;
  }
  previewController.previewTargetUrl = null;
  previewController.pendingPreviewUrl = null;
  previewController.previewRequestToken += 1;
  setPreviewButtonLabel('Preview');
}

export function applyPreviewResult(url: string, info: RosiVideoInfo) {
  previewController.lastPreviewUrl = url;
  renderVideoPreview(info);
  if (info.isPlaylist) {
    showPlaylistScope(info.playlistCount);
  } else {
    resetPlaylistScope();
  }
  setPreviewButtonLabel('Refresh');
}

/** Auto-preview is best effort: failures stay silent until asked manually. */
export function schedulePreview(url: string) {
  if (previewController.previewDebounceTimer) clearTimeout(previewController.previewDebounceTimer);
  previewController.previewTargetUrl = url;
  const cached = readPreviewCache(url);
  if (cached) {
    // Cache hits still bump the token so an older in-flight fetch cannot repaint.
    previewController.previewRequestToken += 1;
    applyPreviewResult(url, cached);
    return;
  }
  previewController.previewDebounceTimer = setTimeout(() => {
    previewController.previewDebounceTimer = null;
    void runVideoPreview(true);
  }, PREVIEW_DEBOUNCE_MS);
}

export async function runVideoPreview(auto = false) {
  if (!refs.urlInput || !refs.previewBtn) return;
  const url = refs.urlInput.value.trim();
  if (!url || !isValidUrl(url)) {
    if (!auto) showToast('Enter a valid URL first.', { type: 'warning' });
    return;
  }
  const cached = readPreviewCache(url);
  if (cached && auto) {
    applyPreviewResult(url, cached);
    return;
  }
  if (previewState.isFetchingPreview) {
    if (auto) {
      previewController.pendingPreviewUrl = url;
      return;
    }
    // Supersede the in-flight lookup so its cleanup cannot clear the loading
    // state we are about to set.
    previewController.pendingPreviewUrl = null;
    window.api.cancelVideoInfo();
    previewState.previewAbort?.();
  }
  // Stale in-flight replies are ignored via this generation token.
  previewController.previewRequestToken += 1;
  const requestToken = previewController.previewRequestToken;
  previewController.activePreviewRequestToken = requestToken;
  previewState.isFetchingPreview = true;

  const card = document.getElementById('preview-card');
  if (card) card.classList.add('visible', 'loading');

  let wasCancelled = false;
  previewState.previewAbort = () => {
    wasCancelled = true;
    if (previewController.activePreviewRequestToken !== requestToken) return;
    previewController.activePreviewRequestToken = null;
    previewState.isFetchingPreview = false;
    previewState.previewAbort = null;
    setButtonLoading(refs.previewBtn, false);
  };
  setButtonLoading(
    refs.previewBtn,
    true,
    () => {
      if (window.api.cancelVideoInfo) window.api.cancelVideoInfo();
      previewController.pendingPreviewUrl = null;
      previewState.previewAbort?.();
      hideVideoPreview();
    },
    'Cancel preview'
  );

  try {
    const result = await window.api.getVideoInfo(
      url,
      looksLikePlaylistUrl(url) ? 'all' : 'current'
    );
    if (wasCancelled || requestToken !== previewController.previewRequestToken) return;
    if (!result || result.ok !== true) {
      const message = result?.error?.message || 'Could not load preview.';
      if (typeof message === 'string' && message.toLowerCase().includes('cancel')) return;
      hideVideoPreview();
      if (auto) {
        setPreviewButtonLabel('Retry preview');
      } else {
        showToast(`Could not load preview. ${message}`, { type: 'error' });
      }
      return;
    }
    const info = result.data as RosiVideoInfo;
    writePreviewCache(url, info);
    applyPreviewResult(url, info);
  } catch (e) {
    if (!wasCancelled && requestToken === previewController.previewRequestToken) {
      hideVideoPreview();
      if (auto) {
        setPreviewButtonLabel('Retry preview');
      } else {
        showToast('Could not load preview.', { type: 'error' });
      }
      logError('Video preview failed', e);
    }
  } finally {
    if (previewController.activePreviewRequestToken === requestToken) {
      previewController.activePreviewRequestToken = null;
      previewState.isFetchingPreview = false;
      previewState.previewAbort = null;
      setButtonLoading(refs.previewBtn, false);
      restorePreviewButtonLabel();
      const queuedUrl = previewController.pendingPreviewUrl;
      previewController.pendingPreviewUrl = null;
      if (queuedUrl && refs.urlInput.value.trim() === queuedUrl) {
        void runVideoPreview(true);
      }
    }
  }
}

export const runManualVideoPreview = () => {
  void runVideoPreview(false);
};

// Owned by the renderer controller; set during startup and updated while it runs.
export const previewController: {
  previewDebounceTimer: ReturnType<typeof setTimeout> | null;
  previewTargetUrl: string | null;
  previewRequestToken: number;
  activePreviewRequestToken: number | null;
  pendingPreviewUrl: string | null;
  previewButtonLabel: string;
  lastPreviewUrl: string | null;
} = {
  previewDebounceTimer: null,
  previewTargetUrl: null,
  previewRequestToken: 0,
  activePreviewRequestToken: null,
  pendingPreviewUrl: null,
  previewButtonLabel: 'Preview',
  lastPreviewUrl: null,
};
