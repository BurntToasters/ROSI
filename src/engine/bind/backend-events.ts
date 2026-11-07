// Startup bindings for backend events.
import { logError } from '../core';
import { handleManualDownloadCompletion, manualDownload } from '../manual-download';
import { showLicenses } from '../overlays';
import { renderPresetOptions } from '../presets';
import { applyJobProgress, downloadState, showProgressBar } from '../progress';
import { applyQueueItemProgress, renderQueue } from '../queue-controller';
import { refs } from '../refs';
import { reconcileSettingsInPlace, settingsStore } from '../settings-store';
import { syncDockFromSettings, updateUIFromSettings } from '../settings-view';
import { applyTheme } from '../theme';
import { appendConsoleOutput, toggleSidebar } from '../ui-helpers';
import { checkForUpdates } from '../updater-ui';

/** Backend events: progress, completion, queue, activity, and menu actions. */
export function bindBackendEvents() {
  const { activityPanel, ipcCleanupFunctions, outputEl } = refs;
  // Newest queue revision rendered so far. Snapshots older than it are dropped.
  let latestQueueRevision = 0;
  // Queue snapshots received so far. The startup read carries no revision, so
  // it is applied only if no snapshot arrived while it was in flight.
  let queueSnapshotsSeen = 0;
  ipcCleanupFunctions.push(
    window.api.onProgress((message) => {
      if (!outputEl) return;
      appendConsoleOutput(outputEl, message);
    })
  );

  ipcCleanupFunctions.push(
    window.api.onJobProgress((event) => {
      if (
        !event.queueItemId &&
        (manualDownload.manualDownloadStartPending ||
          !manualDownload.manualSessionIdentityReceived ||
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
      const container = document.getElementById('progress-container');
      if (container && !container.classList.contains('visible') && event.phase !== 'idle') {
        showProgressBar(event.status);
      }
      applyQueueItemProgress(event);
      if (event.phase === 'idle') {
        return;
      }
      applyJobProgress(event);
    })
  );

  ipcCleanupFunctions.push(
    window.api.onMenuAction((action) => {
      if (action === 'check-for-updates') {
        void checkForUpdates();
        return;
      }
      if (action === 'open-settings') {
        const sidebar = document.getElementById('sidebar');
        if (sidebar && !sidebar.classList.contains('open')) {
          toggleSidebar();
        }
        return;
      }
      if (action === 'toggle-sidebar') {
        toggleSidebar();
        return;
      }
      if (action === 'show-licenses') {
        showLicenses();
      }
    })
  );

  ipcCleanupFunctions.push(
    window.api.onComplete((statusMessage) => {
      if (outputEl) appendConsoleOutput(outputEl, statusMessage);
    })
  );

  ipcCleanupFunctions.push(
    window.api.onDownloadComplete((completion) => {
      handleManualDownloadCompletion(completion);
    })
  );

  if (typeof window.api.onDownloadActivityUpdate === 'function') {
    ipcCleanupFunctions.push(
      window.api.onDownloadActivityUpdate((activity) => {
        activityPanel?.setEntries(activity);
      })
    );
  }

  ipcCleanupFunctions.push(
    window.api.onQueueUpdate((payload) => {
      // Older payloads are bare arrays without a revision; they are always applied.
      const snapshot = Array.isArray(payload) ? { revision: null, items: payload } : payload;
      if (snapshot.revision !== null) {
        if (snapshot.revision < latestQueueRevision) return;
        latestQueueRevision = snapshot.revision;
      }
      queueSnapshotsSeen += 1;
      renderQueue(snapshot.items);
    })
  );

  ipcCleanupFunctions.push(
    window.api.onSettingsImported((importedSettings) => {
      const previousChannel = settingsStore.settings.updateChannel ?? 'auto';
      settingsStore.settingsRevision += 1;
      reconcileSettingsInPlace(importedSettings);
      if (window.api.getChannel() !== 'msstore') {
        window.api.notifyUpdaterChannelChanged?.(
          settingsStore.settings.updateChannel ?? 'auto',
          undefined,
          previousChannel
        );
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
  window.api
    .getQueue()
    .then((queue) => {
      if (queueSnapshotsSeen === snapshotsBeforeRead) renderQueue(queue);
    })
    .catch(() => {});
}
