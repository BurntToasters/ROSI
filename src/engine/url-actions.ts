// URL field state, primary action buttons, and activity replay.
import { applyActiveDownloadProgressPhases, extractHttpUrls, isValidUrl, logError } from './core';
import { clearAdvancedFormatSelections, invalidateFormatRequest } from './formats';
import {
  beginManualDownloadOperation,
  failManualDownloadStart,
  manualDownload,
  prepareManualDownloadStart,
  receiveManualDownloadStart,
} from './manual-download';
import { resetPlaylistScope } from './playlist';
import { hideVideoPreview } from './preview';
import { cancelScheduledPreview, previewController, schedulePreview } from './preview-controller';
import { downloadState, hideProgressBar } from './progress';
import { refs } from './refs';
import { settingsStore } from './settings-store';
import { setButtonLoading, showToast } from './ui-helpers';

// ── Activity replay ─────────────────────────────────────────────────────────
export async function replayActivityDownload(entry: RosiDownloadActivity) {
  if (downloadState.isDownloading) {
    showToast('Wait for the current download to finish first.', { type: 'warning' });
    return;
  }
  const request = { ...(entry.request || {}) } as Record<string, unknown>;
  if (typeof request.url !== 'string' || !request.url.trim()) request.url = entry.url;
  const outputPath =
    typeof request.outputPath === 'string' && request.outputPath.trim()
      ? request.outputPath
      : settingsStore.settings.downloadFolder?.trim() ||
        (await window.api.selectDownloadLocation());
  if (!outputPath) return;
  request.outputPath = outputPath;

  const operation = beginManualDownloadOperation();
  downloadState.isDownloading = true;
  if (refs.outputEl) refs.outputEl.textContent = '';
  downloadState.downloadAbort = () => {
    if (operation !== manualDownload.manualDownloadOperation) return;
    downloadState.isDownloading = false;
    setButtonLoading(refs.downloadBtn, false);
    syncPrimaryActionState();
  };
  setButtonLoading(refs.downloadBtn, true, () => {
    window.api.cancelDownload();
    downloadState.downloadAbort?.();
    hideProgressBar();
  });
  applyActiveDownloadProgressPhases(settingsStore.settings, 'Starting download...');
  try {
    prepareManualDownloadStart(operation);
    const result = await window.api.downloadVideo(request);
    if (operation !== manualDownload.manualDownloadOperation) return;
    if (!result || result.ok !== true) {
      failManualDownloadStart(operation);
      downloadState.isDownloading = false;
      setButtonLoading(refs.downloadBtn, false);
      syncPrimaryActionState();
      hideProgressBar();
      showToast(result?.error?.message || 'Could not start that download again.', {
        type: 'error',
      });
    } else {
      receiveManualDownloadStart(result.data, operation);
    }
  } catch (error) {
    if (operation !== manualDownload.manualDownloadOperation) return;
    failManualDownloadStart(operation);
    logError('Failed to replay download', error);
    downloadState.isDownloading = false;
    setButtonLoading(refs.downloadBtn, false);
    syncPrimaryActionState();
    hideProgressBar();
    showToast('Could not start that download again.', { type: 'error' });
  }
}

export function setDownloadButtonLabel(label: string) {
  if (!refs.downloadBtn) return;
  const textSpan = refs.downloadBtn.querySelector('span');
  if (textSpan) {
    textSpan.textContent = label;
  } else {
    refs.downloadBtn.textContent = label;
  }
}

export function syncPrimaryActionState() {
  const hasInput = !!refs.urlInput;
  const hasPrimaryButton = !!refs.downloadBtn;
  if (!hasInput || !hasPrimaryButton || !refs.urlInput || !refs.downloadBtn) return;
  const raw = refs.urlInput.value || '';
  const trimmed = raw.trim();
  if (trimmed !== urlActionState.lastFormatUrl) {
    urlActionState.lastFormatUrl = trimmed;
    invalidateFormatRequest();
    clearAdvancedFormatSelections();
  }
  const hasValue = trimmed.length > 0;
  const extracted = extractHttpUrls(raw);
  urlActionState.pendingBatchUrls = extracted.urls.length > 1 ? extracted.urls : [];
  const isBatch = urlActionState.pendingBatchUrls.length > 1;
  const validUrl = hasValue && (isBatch || isValidUrl(trimmed));
  const showInvalid = urlActionState.hasUrlValidationIntent && hasValue && !validUrl;

  if (refs.urlInputContainer) {
    refs.urlInputContainer.classList.toggle('is-empty', !hasValue);
    refs.urlInputContainer.classList.toggle('is-valid', validUrl);
    refs.urlInputContainer.classList.toggle('is-invalid', showInvalid);
  }
  if (refs.downloadCard) {
    refs.downloadCard.classList.toggle('is-ready', validUrl);
    refs.downloadCard.classList.toggle('is-batch', isBatch);
  }
  if (showInvalid) {
    refs.urlInput.setAttribute('aria-invalid', 'true');
    if (refs.urlValidationMessage) {
      refs.urlValidationMessage.textContent = 'Enter a valid URL starting with http:// or https://';
    }
  } else {
    refs.urlInput.removeAttribute('aria-invalid');
    if (refs.urlValidationMessage) {
      refs.urlValidationMessage.textContent = isBatch
        ? `${urlActionState.pendingBatchUrls.length} links detected. They will be added to the queue.`
        : '';
    }
  }

  const isLoading = refs.downloadBtn.classList.contains('loading');
  if (!isLoading) {
    refs.downloadBtn.disabled = !validUrl;
    refs.downloadBtn.classList.toggle('is-disabled', !validUrl);
    setDownloadButtonLabel(
      isBatch ? `Add ${urlActionState.pendingBatchUrls.length} to Queue` : 'Download'
    );
  }

  if (refs.previewBtn && !refs.previewBtn.classList.contains('loading')) {
    refs.previewBtn.disabled = !validUrl || isBatch;
  }
  if (
    isBatch ||
    (trimmed !== previewController.lastPreviewUrl && trimmed !== previewController.previewTargetUrl)
  ) {
    // Invalidate in-flight preview for the previous URL before scheduling the next.
    cancelScheduledPreview();
    hideVideoPreview();
    previewController.lastPreviewUrl = null;
    resetPlaylistScope();
  }
  if (!isBatch && validUrl && trimmed !== previewController.previewTargetUrl) {
    schedulePreview(trimmed);
  } else if (isBatch) {
    cancelScheduledPreview();
  }
}

export function updateUrlButtons() {
  const hasValue = !!(refs.urlInput && refs.urlInput.value.length > 0);
  if (refs.clearUrlBtn) refs.clearUrlBtn.classList.toggle('hidden', !hasValue);
  if (refs.pasteUrlBtn) refs.pasteUrlBtn.classList.toggle('hidden', hasValue);
  syncPrimaryActionState();
}

// Owned by the renderer controller; set during startup and updated while it runs.
export const urlActionState: {
  hasUrlValidationIntent: boolean;
  lastFormatUrl: string | null;
  pendingBatchUrls: string[];
} = {
  hasUrlValidationIntent: false,
  lastFormatUrl: null,
  pendingBatchUrls: [],
};
