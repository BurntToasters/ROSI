// Manual download lifecycle and completion handling.
import { setButtonIconLabel } from './core';
import {
  downloadState,
  hideProgressBar,
  showProgressComplete,
  updateProgressBar,
} from './progress';
import { refs } from './refs';
import { settingsStore } from './settings-store';
import { setButtonLoading } from './ui-helpers';
import { syncPrimaryActionState } from './url-actions';

// After a download the button briefly offers the result ("Open File
// Location" / "Download complete") with its own click handler.
export function beginManualDownloadOperation(): number {
  manualDownload.manualDownloadOperation += 1;
  manualDownload.manualDownloadSessionId = null;
  manualDownload.manualSessionIdentityReceived = false;
  manualDownload.manualDownloadStartPending = true;
  refs.pendingManualCompletions.clear();
  if (manualDownload.downloadResultTimer !== null) clearTimeout(manualDownload.downloadResultTimer);
  if (manualDownload.progressHideTimer !== null) clearTimeout(manualDownload.progressHideTimer);
  manualDownload.downloadResultTimer = null;
  manualDownload.progressHideTimer = null;
  downloadState.lastDownloadedFilePath = null;
  downloadState.downloadAbort = null;
  if (refs.downloadBtn) refs.downloadBtn.onclick = refs.downloadBtn._originalClick ?? null;
  return manualDownload.manualDownloadOperation;
}

export function prepareManualDownloadStart(operation: number) {
  if (operation !== manualDownload.manualDownloadOperation) return;
  manualDownload.manualDownloadStartPending = true;
  manualDownload.manualSessionIdentityReceived = false;
}

export function receiveManualDownloadStart(
  started: { started: boolean; sessionId?: number },
  operation: number
) {
  if (operation !== manualDownload.manualDownloadOperation) return;
  manualDownload.manualDownloadStartPending = false;
  manualDownload.manualSessionIdentityReceived = true;
  manualDownload.manualDownloadSessionId =
    typeof started.sessionId === 'number' && Number.isSafeInteger(started.sessionId)
      ? started.sessionId
      : null;
  const earlyCompletion =
    manualDownload.manualDownloadSessionId === null
      ? undefined
      : refs.pendingManualCompletions.get(manualDownload.manualDownloadSessionId);
  refs.pendingManualCompletions.clear();
  if (earlyCompletion) showManualDownloadCompletion(earlyCompletion, operation);
}

export function failManualDownloadStart(operation: number) {
  if (operation !== manualDownload.manualDownloadOperation) return;
  manualDownload.manualDownloadStartPending = false;
  manualDownload.manualSessionIdentityReceived = true;
  manualDownload.manualDownloadSessionId = null;
  refs.pendingManualCompletions.clear();
}

export function showDownloadResult(ms: number, operation: number) {
  if (operation !== manualDownload.manualDownloadOperation) return;
  if (manualDownload.downloadResultTimer !== null) clearTimeout(manualDownload.downloadResultTimer);
  manualDownload.downloadResultTimer = setTimeout(() => clearDownloadResult(operation), ms);
}

export function scheduleProgressHide(operation: number) {
  if (manualDownload.progressHideTimer !== null) clearTimeout(manualDownload.progressHideTimer);
  manualDownload.progressHideTimer = setTimeout(() => {
    if (operation !== manualDownload.manualDownloadOperation) return;
    manualDownload.progressHideTimer = null;
    hideProgressBar();
  }, 2000);
}

/** Put the Download button back, click handler included. */
export function clearDownloadResult(operation = manualDownload.manualDownloadOperation) {
  if (
    operation !== manualDownload.manualDownloadOperation ||
    manualDownload.downloadResultTimer === null
  )
    return;
  clearTimeout(manualDownload.downloadResultTimer);
  manualDownload.downloadResultTimer = null;
  downloadState.lastDownloadedFilePath = null;
  setButtonLoading(refs.downloadBtn, false);
  syncPrimaryActionState();
}

export function showManualDownloadCompletion(
  completion: Pick<
    RosiDownloadCompletion,
    'outcome' | 'statusMessage' | 'outputPath' | 'outputPaths'
  >,
  operation: number
) {
  if (operation !== manualDownload.manualDownloadOperation) return;
  if (!refs.downloadBtn) return;
  downloadState.isDownloading = false;
  manualDownload.manualDownloadStartPending = false;
  downloadState.downloadAbort = null;
  setButtonLoading(refs.downloadBtn, false);
  syncPrimaryActionState();

  const outputPaths = completion.outputPaths;
  const outputPath =
    completion.outputPath ??
    (outputPaths && outputPaths.length > 0 ? outputPaths[outputPaths.length - 1] : null) ??
    null;
  const isSuccess = completion.outcome === 'success';
  if (isSuccess) {
    downloadState.lastDownloadedFilePath = outputPath;
    updateProgressBar(100, 'Complete!', '');
    showProgressComplete();
    if (settingsStore.settings.notifications) {
      void window.api.showNotification({
        title: 'Download Complete!',
        body: outputPath
          ? `Saved: ${outputPath.split(/[/\\]/).pop()}`
          : 'Your download has finished.',
        filePath: outputPath ?? undefined,
      });
    }

    if (outputPath) {
      setButtonIconLabel(refs.downloadBtn, 'folder-open', 'Open File Location');
      refs.downloadBtn.disabled = false;
      refs.downloadBtn.onclick = () => {
        void window.api.openFileLocation(outputPath);
      };
      showDownloadResult(8000, operation);
    } else {
      setButtonIconLabel(refs.downloadBtn, 'check', 'Download complete');
      refs.downloadBtn.disabled = false;
      showDownloadResult(2500, operation);
    }
  } else {
    downloadState.lastDownloadedFilePath = null;
    refs.downloadBtn.onclick = refs.downloadBtn._originalClick ?? null;
  }
  scheduleProgressHide(operation);
}

export function handleManualDownloadCompletion(completion: RosiDownloadCompletion) {
  if (completion.owner !== 'manual') return;
  if (manualDownload.manualDownloadStartPending) {
    if (typeof completion.sessionId === 'number') {
      if (refs.pendingManualCompletions.size >= 4) {
        const oldest = refs.pendingManualCompletions.keys().next().value;
        if (typeof oldest === 'number') refs.pendingManualCompletions.delete(oldest);
      }
      refs.pendingManualCompletions.set(completion.sessionId, completion);
    }
    return;
  }
  if (!manualDownload.manualSessionIdentityReceived) return;
  if (
    manualDownload.manualDownloadSessionId !== null
      ? completion.sessionId !== manualDownload.manualDownloadSessionId
      : completion.sessionId !== undefined && completion.sessionId !== null
  ) {
    return;
  }
  showManualDownloadCompletion(completion, manualDownload.manualDownloadOperation);
}

export function handleLegacyManualCompletion(statusMessage: string) {
  if (
    manualDownload.manualDownloadStartPending ||
    !manualDownload.manualSessionIdentityReceived ||
    manualDownload.manualDownloadSessionId !== null ||
    !downloadState.isDownloading
  ) {
    return;
  }
  const normalizedStatus = String(statusMessage || '').toLowerCase();
  const isCancelled = normalizedStatus.includes('cancel');
  const isSuccess =
    !isCancelled && (statusMessage.includes('✅') || normalizedStatus.includes('complete'));
  showManualDownloadCompletion(
    {
      outcome: isSuccess ? 'success' : isCancelled ? 'cancelled' : 'failed',
      statusMessage,
      outputPath: isSuccess ? (downloadState.lastDownloadedFilePath ?? undefined) : undefined,
    },
    manualDownload.manualDownloadOperation
  );
}

// Owned by the renderer controller; set during startup and updated while it runs.
export const manualDownload: {
  manualDownloadOperation: number;
  manualDownloadSessionId: number | null;
  manualSessionIdentityReceived: boolean;
  manualDownloadStartPending: boolean;
  downloadResultTimer: ReturnType<typeof setTimeout> | null;
  progressHideTimer: ReturnType<typeof setTimeout> | null;
} = {
  manualDownloadOperation: 0,
  manualDownloadSessionId: null,
  manualSessionIdentityReceived: false,
  manualDownloadStartPending: false,
  downloadResultTimer: null,
  progressHideTimer: null,
};
