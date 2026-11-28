// Startup bindings for backend events.
import { noteActivityUpdate } from './activity';
import { logError } from '../core';
import {
  handleManualDownloadCompletion,
  isManualDownloadCancelled,
  manualDownload,
} from '../manual-download';
import { currentModalData, showLicenses } from '../overlays';
import { renderPresetOptions } from '../presets';
import { applyJobProgress, downloadState, hideProgressBar, showProgressBar } from '../progress';
import { applyQueueItemProgress, queueController, renderQueue } from '../queue-controller';
import { refs } from '../refs';
import { reconcileSettingsInPlace, settingsStore } from '../settings-store';
import { syncDockFromSettings, updateUIFromSettings } from '../settings-view';
import { applyTheme } from '../theme';
import { appendConsoleOutput, toggleSidebar } from '../ui-helpers';
import { checkForUpdates, notifyUpdateChannelChanged } from '../updater-ui';
import { api } from '../../api';

// Delay before a finished queue run hides the shared progress bar.
const QUEUE_PROGRESS_HIDE_MS = 2000;

// A visible prompt or the setup wizard must stay on top: menu actions cannot open
// the settings sidebar over them.
function isSidebarOpenBlocked(): boolean {
  return (
    currentModalData !== null ||
    document.getElementById('setup-wizard')?.classList.contains('active') === true
  );
}

/** Backend events: progress, completion, queue, activity, and menu actions. */
export function bindBackendEvents() {
  const { activityPanel, ipcCleanupFunctions, outputEl } = refs;
  // Newest queue revision rendered so far. Snapshots older than it are dropped.
  let latestQueueRevision = 0;
  // Queue snapshots received so far. The startup read carries no revision, so
  // it is applied only if no snapshot arrived while it was in flight.
  let queueSnapshotsSeen = 0;
  // Pending hide of the progress bar after a queue run's idle event.
  let queueProgressHideTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelQueueProgressHide = () => {
    if (queueProgressHideTimer !== null) clearTimeout(queueProgressHideTimer);
    queueProgressHideTimer = null;
  };
  // Re-checks at hide time: a queue item still downloading or a manual
  // download in progress keeps the bar visible.
  const scheduleQueueProgressHide = () => {
    cancelQueueProgressHide();
    queueProgressHideTimer = setTimeout(() => {
      queueProgressHideTimer = null;
      const queueBusy = queueController.currentQueue.some((item) => item.status === 'downloading');
      const manualBusy =
        Boolean(downloadState.isDownloading) || manualDownload.manualDownloadStartPending;
      if (queueBusy || manualBusy) return;
      hideProgressBar();
    }, QUEUE_PROGRESS_HIDE_MS);
  };
  ipcCleanupFunctions.push(
    api.onProgress((message) => {
      if (!outputEl) return;
      appendConsoleOutput(outputEl, message);
    })
  );

  ipcCleanupFunctions.push(
    api.onJobProgress((event) => {
      // Manual events count only for the live session the user has not cancelled.
      if (
        !event.queueItemId &&
        (isManualDownloadCancelled() ||
          manualDownload.manualDownloadStartPending ||
          !manualDownload.manualSessionIdentityReceived ||
          manualDownload.manualDownloadSessionId === null ||
          (event.sessionId ?? null) !== manualDownload.manualDownloadSessionId)
      ) {
        return;
      }
      if (
        event.queueItemId &&
        downloadState.isDownloading &&
        manualDownload.manualDownloadSessionId !== null &&
        event.sessionId !== manualDownload.manualDownloadSessionId
      ) {
        return;
      }
      if (event.queueItemId && event.phase !== 'idle') cancelQueueProgressHide();
      const container = document.getElementById('progress-container');
      if (container && !container.classList.contains('visible') && event.phase !== 'idle') {
        showProgressBar(event.status);
      }
      applyQueueItemProgress(event);
      if (event.phase === 'idle') {
        if (event.queueItemId) scheduleQueueProgressHide();
        return;
      }
      applyJobProgress(event);
    })
  );

  ipcCleanupFunctions.push(
    api.onMenuAction((action) => {
      if (action === 'check-for-updates') {
        void checkForUpdates();
        return;
      }
      if (action === 'open-settings') {
        const sidebar = document.getElementById('sidebar');
        if (sidebar && !sidebar.classList.contains('open') && !isSidebarOpenBlocked()) {
          toggleSidebar();
        }
        return;
      }
      if (action === 'toggle-sidebar') {
        // Closing an open sidebar is always allowed; only opening waits for the
        // prompt or setup wizard to be dismissed.
        const sidebar = document.getElementById('sidebar');
        if (sidebar?.classList.contains('open') || !isSidebarOpenBlocked()) {
          toggleSidebar();
        }
        return;
      }
      if (action === 'show-licenses') {
        showLicenses();
      }
    })
  );

  ipcCleanupFunctions.push(
    api.onComplete((statusMessage) => {
      if (outputEl) appendConsoleOutput(outputEl, statusMessage);
    })
  );

  ipcCleanupFunctions.push(
    api.onDownloadComplete((completion) => {
      handleManualDownloadCompletion(completion);
    })
  );

  ipcCleanupFunctions.push(
    api.onDownloadActivityUpdate((activity) => {
      noteActivityUpdate();
      activityPanel?.setEntries(activity);
    })
  );

  ipcCleanupFunctions.push(
    api.onQueueUpdate((snapshot) => {
      // The coordinator always publishes a revisioned snapshot.
      if (snapshot.revision < latestQueueRevision) return;
      latestQueueRevision = snapshot.revision;
      queueSnapshotsSeen += 1;
      renderQueue(snapshot.items);
    })
  );

  ipcCleanupFunctions.push(
    api.onSettingsImported((importedSettings) => {
      settingsStore.settingsRevision += 1;
      reconcileSettingsInPlace(importedSettings);
      // The backend saved the imported settings itself, so they are the saved state.
      settingsStore.settingsSavedRevision = settingsStore.settingsRevision;
      if (api.getChannel() !== 'msstore') {
        notifyUpdateChannelChanged(settingsStore.settings.updateChannel ?? 'auto');
      }
      try {
        updateUIFromSettings();
        syncDockFromSettings();
        renderPresetOptions();
        applyTheme(settingsStore.settings.theme ?? 'system');
        localStorage.setItem('rosi-flat-ui', settingsStore.settings.flatUi ? 'true' : 'false');
      } catch (e) {
        logError('Failed to refresh UI after settings import', e);
      }
    })
  );

  const snapshotsBeforeRead = queueSnapshotsSeen;
  api
    .getQueue()
    .then((queue) => {
      if (queueSnapshotsSeen === snapshotsBeforeRead) renderQueue(queue);
    })
    .catch(() => {});
}
