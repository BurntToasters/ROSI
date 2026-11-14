// Manual download lifecycle and completion handling.
import { setButtonIconLabel } from './core';
import {
  downloadState,
  hideProgressBar,
  revealFileLocation,
  showProgressComplete,
  updateProgressBar,
} from './progress';
import { refs } from './refs';
import { settingsStore } from './settings-store';
import { setButtonLoading } from './ui-helpers';
import { syncPrimaryActionState } from './url-actions';
import { api } from '../api';

/**
 * What the Download button shows after a download. Label, icon, and click
 * handler live in one value so they always change together. A null handler
 * leaves the button disabled.
 */
export interface DownloadResultState {
  label: string;
  icon: string;
  onActivate: (() => void) | null;
}

// After a download the button briefly offers the result ("Open File
// Location" / "Download complete") until clearDownloadResult puts Download back.
export function beginManualDownloadOperation(): number {
  manualDownload.manualDownloadOperation += 1;
  manualDownload.manualDownloadSessionId = null;
  manualDownload.manualSessionIdentityReceived = false;
  manualDownload.manualDownloadStartPending = true;
  refs.pendingManualCompletions.clear();
  if (manualDownload.progressHideTimer !== null) clearTimeout(manualDownload.progressHideTimer);
  manualDownload.progressHideTimer = null;
  const hadResult = manualDownload.downloadResult !== null;
  dropDownloadResult();
  downloadState.lastDownloadedFilePath = null;
  downloadState.downloadAbort = null;
  if (hadResult && refs.downloadBtn) {
    // The result button is still on screen. Put the idle Download button back
    // before the new operation touches it.
    setButtonLoading(refs.downloadBtn, false);
    syncPrimaryActionState();
  }
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

/** Forget the result state and its timer. The button itself is not touched. */
function dropDownloadResult() {
  if (manualDownload.downloadResultTimer !== null) clearTimeout(manualDownload.downloadResultTimer);
  manualDownload.downloadResultTimer = null;
  manualDownload.downloadResult = null;
}

function applyDownloadResult(result: DownloadResultState) {
  const button = refs.downloadBtn;
  if (!button) return;
  setButtonIconLabel(button, result.icon, result.label);
  button.disabled = result.onActivate === null;
  button.classList.toggle('is-disabled', result.onActivate === null);
  button.onclick = result.onActivate;
}

function showDownloadResult(result: DownloadResultState, ms: number, operation: number) {
  if (operation !== manualDownload.manualDownloadOperation) return;
  dropDownloadResult();
  manualDownload.downloadResult = result;
  manualDownload.downloadResultTimer = setTimeout(() => clearDownloadResult(operation), ms);
  applyDownloadResult(result);
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
    manualDownload.downloadResult === null
  )
    return;
  dropDownloadResult();
  downloadState.lastDownloadedFilePath = null;
  setButtonLoading(refs.downloadBtn, false);
  syncPrimaryActionState();
}

export function showManualDownloadCompletion(
  completion: Pick<
    RosiDownloadCompletion,
    'outcome' | 'statusMessage' | 'error' | 'outputPath' | 'outputPaths'
  >,
  operation: number
) {
  if (operation !== manualDownload.manualDownloadOperation) return;
  if (!refs.downloadBtn) return;
  downloadState.isDownloading = false;
  manualDownload.manualDownloadStartPending = false;
  downloadState.downloadAbort = null;
  dropDownloadResult();
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
      void api.showNotification({
        title: 'Download Complete!',
        body: outputPath
          ? `Saved: ${outputPath.split(/[/\\]/).pop()}`
          : 'Your download has finished.',
        filePath: outputPath ?? undefined,
      });
    }

    if (outputPath) {
      showDownloadResult(
        {
          label: 'Open File Location',
          icon: 'folder-open',
          onActivate: () => {
            void revealFileLocation(outputPath);
          },
        },
        8000,
        operation
      );
    } else {
      // No path to open, so this result only reports the outcome.
      showDownloadResult(
        { label: 'Download complete', icon: 'check', onActivate: null },
        2500,
        operation
      );
    }
  } else {
    downloadState.lastDownloadedFilePath = null;
    refs.downloadBtn.onclick = refs.downloadBtn._originalClick ?? null;
    // A user cancel is not a failure, so only a failed outcome notifies.
    if (completion.outcome === 'failed' && settingsStore.settings.notifications) {
      void api.showNotification({
        title: 'Download Failed',
        body: failureNotificationBody(completion.error || completion.statusMessage),
      });
    }
  }
  scheduleProgressHide(operation);
}

const FAILURE_BODY_MAX = 160;

/** One line of the reason, shortened so the OS notification stays readable. */
function failureNotificationBody(reason: string | null | undefined) {
  const firstLine =
    (reason ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? '';
  if (!firstLine) return 'The download could not be completed.';
  return firstLine.length > FAILURE_BODY_MAX
    ? `${firstLine.slice(0, FAILURE_BODY_MAX - 1).trimEnd()}…`
    : firstLine;
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

// Owned by the renderer controller; set during startup and updated while it runs.
export const manualDownload: {
  manualDownloadOperation: number;
  manualDownloadSessionId: number | null;
  manualSessionIdentityReceived: boolean;
  manualDownloadStartPending: boolean;
  downloadResult: DownloadResultState | null;
  downloadResultTimer: ReturnType<typeof setTimeout> | null;
  progressHideTimer: ReturnType<typeof setTimeout> | null;
} = {
  manualDownloadOperation: 0,
  manualDownloadSessionId: null,
  manualSessionIdentityReceived: false,
  manualDownloadStartPending: false,
  downloadResult: null,
  downloadResultTimer: null,
  progressHideTimer: null,
};
