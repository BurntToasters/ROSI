// URL field state, primary action buttons, and activity replay.
import { applyActiveDownloadProgressPhases, isValidUrl, logError } from './core';
import { clearAdvancedFormatSelections, invalidateFormatRequest } from './formats';
import {
  beginManualDownloadOperation,
  failManualDownloadStart,
  manualDownload,
  prepareManualDownloadStart,
  receiveManualDownloadStart,
} from './manual-download';
import { refreshEffectiveOptionsSummary } from './messages';
import { resetPlaylistScope } from './playlist';
import { hideVideoPreview } from './preview';
import { cancelScheduledPreview, previewController, schedulePreview } from './preview-controller';
import { downloadState, hideProgressBar } from './progress';
import { queueController } from './queue-controller';
import { refs } from './refs';
import { persistSettings, settingsStore } from './settings-store';
import { setButtonLoading, showToast } from './ui-helpers';
import { api } from '../api';

// ── Queue ownership of the download slot ────────────────────────────────────
const QUEUE_RUNNING_REASON =
  'A queue download is running. Download this link after the queue finishes.';
let queueReasonTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Refuses a manual download while a queue item downloads. Returns true when
 * refused. The reason goes to #downloadReadiness only, so callers must return
 * before they touch the console or progress bar.
 */
export function refuseDuringQueueRun(): boolean {
  if (!queueController.currentQueue.some((item) => item.status === 'downloading')) return false;
  const hint = document.getElementById('downloadReadiness');
  if (hint instanceof HTMLElement) {
    hint.textContent = QUEUE_RUNNING_REASON;
    hint.dataset.tone = 'blocked';
    hint.hidden = false;
    if (queueReasonTimer !== null) clearTimeout(queueReasonTimer);
    queueReasonTimer = setTimeout(() => {
      queueReasonTimer = null;
      // Rebuild the readiness hint only if the reason is still the one showing.
      if (hint.textContent === QUEUE_RUNNING_REASON) refreshEffectiveOptionsSummary(true);
    }, 8000);
  }
  return true;
}

/** True when Enter or a click may start the idle Download action. */
export function isDownloadButtonIdle(): boolean {
  const button = refs.downloadBtn;
  return (
    !!button && !button.classList.contains('loading') && manualDownload.downloadResult === null
  );
}

// ── Activity replay ─────────────────────────────────────────────────────────
// True while a replay waits on the folder dialog or the settings flush.
let replayPending = false;

function replayBlocked(): boolean {
  if (downloadState.isDownloading || manualDownload.manualDownloadStartPending) {
    showToast('Wait for the current download to finish first.', { type: 'warning' });
    return true;
  }
  return refuseDuringQueueRun();
}

export async function replayActivityDownload(entry: RosiDownloadActivity) {
  if (replayPending || replayBlocked()) return;
  const request = { ...(entry.request || {}) } as Record<string, unknown>;
  if (typeof request.url !== 'string' || !request.url.trim()) request.url = entry.url;
  replayPending = true;
  try {
    // Same rule as the Download button: ask when the setting says so, else use
    // the saved folder, else let the backend pick its default.
    let outputPath: string | null = null;
    if (settingsStore.settings.askDownloadLocation) {
      try {
        outputPath = (await api.selectDownloadLocation()) || null;
      } catch (error) {
        logError('Error opening save dialog', error);
        showToast('Could not open the save location dialog. Please try again.', {
          type: 'error',
        });
        return;
      }
      if (!outputPath) return;
    } else {
      const stored = typeof request.outputPath === 'string' ? request.outputPath.trim() : '';
      outputPath = stored || settingsStore.settings.downloadFolder?.trim() || null;
    }
    if (outputPath) request.outputPath = outputPath;
    else delete request.outputPath;

    // The backend reads settings from disk when a download starts.
    if (!(await persistSettings({ immediate: true }))) {
      showToast('Could not save download settings. Please try again.', { type: 'error' });
      return;
    }
    // A download may have started while the dialog or the save was open.
    if (replayBlocked()) return;
  } finally {
    replayPending = false;
  }

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
    api.cancelDownload();
    downloadState.downloadAbort?.();
    hideProgressBar();
  });
  // The Cancel control must be clickable; a stale idle-state disabled class would hide it.
  refs.downloadBtn?.classList.remove('is-disabled');
  applyActiveDownloadProgressPhases(settingsStore.settings, 'Starting download...');
  try {
    prepareManualDownloadStart(operation);
    const result = await api.downloadVideo(request);
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

/**
 * Links to count while typing. Only `isValidUrl` decides here, so the hint may
 * show a link the backend refuses. The add path uses the backend result.
 */
function batchHintUrls(raw: string): string[] {
  const seen = new Set<string>();
  raw.split(/\r?\n/).forEach((line) => {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) return;
    trimmedLine.split(/\s+/).forEach((token) => {
      if (isValidUrl(token)) seen.add(token);
    });
  });
  return [...seen];
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
  const hintUrls = batchHintUrls(raw);
  urlActionState.pendingBatchUrls = hintUrls.length > 1 ? hintUrls : [];
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

  // The result state (Open File Location / Download complete) owns the button
  // until clearDownloadResult runs, so a sync must not relabel it.
  const isLoading = refs.downloadBtn.classList.contains('loading');
  if (!isLoading && manualDownload.downloadResult === null) {
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
