// Queue rendering, actions, and status messages.
import { RosiJobProgressEvent, logError } from './core';
import { copyText } from '../modules/clipboard';
import { selectTab as selectDockTab } from '../modules/dock';
import {
  renderQueue as renderQueueRows,
  setQueueItemError,
  updateQueueItemProgress,
} from '../modules/queue';
import { isPlaylistScopeVisible, resolvePlaylistSelection } from './playlist';
import { buildRequestOverrides, readAdvancedFormatSelections } from './presets';
import { refs } from './refs';
import { persistSettings, settingsStore } from './settings-store';
import { ToastType, showToast } from './ui-helpers';
import { api } from '../api';

/**
 * Per-job overrides sent with queue additions, built by the same builder as
 * manual downloads. Returns `{ ok: false }` when the visible playlist range is
 * invalid so nothing is queued. Playlist is omitted while its radios are hidden,
 * so a preset saved as All/Range can apply. The visible range belongs to the main
 * URL only, so it is read only when `usesMainPlaylist` is true.
 */
export function buildQueueRequestOverrides(
  outputPath?: string,
  formatSelections?: { videoFormat?: string; audioFormat?: string },
  usesMainPlaylist = false
): { ok: false } | { ok: true; overrides?: Record<string, unknown> } {
  const scopeVisible = usesMainPlaylist && isPlaylistScopeVisible();
  const playlist = usesMainPlaylist ? resolvePlaylistSelection() : null;
  if (scopeVisible && !playlist) return { ok: false };

  const overrides: Record<string, unknown> = {
    ...buildRequestOverrides({
      formats: formatSelections ?? readAdvancedFormatSelections(),
      playlist: scopeVisible ? (playlist ?? undefined) : undefined,
    }),
  };
  if (outputPath) overrides.outputPath = outputPath;
  return {
    ok: true,
    overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
  };
}

/**
 * With "Ask every time" enabled, prompt once for the whole batch rather than
 * per item, so a queue run is never interrupted by folder pickers.
 */
export async function resolveQueueDestination(): Promise<{
  outputPath?: string;
  cancelled: boolean;
}> {
  if (!settingsStore.settings.askDownloadLocation) return { cancelled: false };
  try {
    const chosen = await api.selectDownloadLocation();
    if (!chosen) return { cancelled: true };
    return { outputPath: chosen, cancelled: false };
  } catch (error) {
    logError('Could not open the folder picker for the queue', error);
    return { cancelled: true };
  }
}

export async function addUrlsToQueue(urls: string[], rejected = 0) {
  // Guard here as well as in the button handler: the folder prompt below is
  // awaited, and without the lock a second click could queue the batch twice.
  if (queueController.queueActionLocks > 0) return false;
  const endQueueAction = beginQueueAction();
  const currentUrl =
    (document.getElementById('url') as HTMLInputElement | null)?.value.trim() ?? '';
  // Format and playlist settings belong to the main URL, so they apply only when
  // the queue holds that one link and nothing else.
  const isMainUrl = urls.length === 1 && urls[0]?.trim() === currentUrl;
  const formatSelections = isMainUrl ? readAdvancedFormatSelections(currentUrl) : {};
  try {
    const built = buildQueueRequestOverrides(undefined, formatSelections, isMainUrl);
    if (!built.ok) {
      setQueueStatusMessage('Fix the playlist range before adding to the queue.');
      return false;
    }
    const destination = await resolveQueueDestination();
    if (destination.cancelled) {
      setQueueStatusMessage('Nothing was queued because no folder was chosen.');
      return false;
    }
    // Main snapshots from disk. Flush the 300ms settings debounce so convert,
    // GPU, and profile toggles made just before Queue are what get stored.
    const saved = await persistSettings({ immediate: true });
    if (!saved) {
      const message = 'Could not save download settings. Please try again.';
      setQueueStatusMessage(message);
      showToast(message, { type: 'error' });
      return false;
    }
    if (destination.outputPath) {
      built.overrides = { ...built.overrides, outputPath: destination.outputPath };
    }
    // Omit the second argument entirely when there is nothing to override.
    const result = built.overrides
      ? await api.addToQueue(urls, built.overrides)
      : await api.addToQueue(urls);
    if (result && result.ok) {
      const parts = [
        queueMessageForCount(
          result.data.added,
          'Added 1 link to the queue.',
          'Added {count} links to the queue.'
        ),
      ];
      if (result.data.skipped > 0) parts.push(`${result.data.skipped} already queued.`);
      if (rejected > 0) parts.push(`${rejected} ignored as invalid.`);
      announceQueueAction(parts.join(' '));
      selectDockTab('queue');
      return true;
    }
    const message = result?.error?.message || 'Could not add links to the queue.';
    setQueueStatusMessage(message);
    showToast(message, { type: 'error' });
    return false;
  } catch {
    const message = 'Could not add links to the queue.';
    setQueueStatusMessage(message);
    showToast(message, { type: 'error' });
    return false;
  } finally {
    endQueueAction();
  }
}

/** Splits pasted or dropped text into queue links with the backend's URL rules. */
export async function extractQueueLinks(
  text: string
): Promise<RosiIpcResult<RosiExtractedQueueUrls>> {
  try {
    return await api.extractQueueUrls(text);
  } catch {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Could not read the links.' } };
  }
}

export function updateQueueButtonStates(queue: RosiQueueItem[]) {
  const hasPending = queue.some((item) => item.status === 'pending');
  const isRunning = queue.some((item) => item.status === 'downloading');
  if (refs.startQueueBtn) {
    // Starting while an item downloads would only queue a second runner.
    refs.startQueueBtn.disabled = queueController.queueActionLocks > 0 || !hasPending || isRunning;
  }
  if (refs.cancelQueueBtn) {
    refs.cancelQueueBtn.disabled = queueController.queueActionLocks > 0 || !isRunning;
  }
  if (refs.clearFinishedQueueBtn) {
    refs.clearFinishedQueueBtn.disabled =
      queueController.queueActionLocks > 0 ||
      !queue.some((item) => ['completed', 'failed', 'cancelled'].includes(item.status));
  }
}

/** A row's inline action error. It applies only while the item keeps the status it had. */
interface QueueRowError {
  status: RosiQueueItem['status'];
  message: string;
}

function rowErrorFor(item: RosiQueueItem): string | null {
  const entry = queueController.rowErrors.get(item.id);
  return entry && entry.status === item.status ? entry.message : null;
}

function reportQueueRowError(id: string, message: string) {
  const item = queueController.currentQueue.find((candidate) => candidate.id === id);
  if (!item) return;
  queueController.rowErrors.set(id, { status: item.status, message });
  if (refs.queueList) setQueueItemError(refs.queueList, id, message);
}

function clearQueueRowError(id: string) {
  if (!queueController.rowErrors.delete(id)) return;
  if (refs.queueList) setQueueItemError(refs.queueList, id, null);
}

/**
 * Called by the queue controls when the user confirms Cancel queue or Clear.
 * Only a run that is still active is marked, so the drain that follows stays
 * silent. The marker is dropped when the run ends, so it cannot leak into
 * the next run.
 */
export function noteQueueStoppedByUser() {
  if (queueController.queueRun.phase === 'running') queueController.queueRun.phase = 'stopping';
}

/**
 * Tracks a queue run from the snapshots alone and sends one notification when
 * it drains on its own: a downloading item was seen, then nothing is
 * downloading and nothing is pending. Runs the user stopped end silently.
 */
function observeQueueRun(queue: RosiQueueItem[]) {
  const run = queueController.queueRun;
  const isDownloading = queue.some((item) => item.status === 'downloading');
  const hasPending = queue.some((item) => item.status === 'pending');
  if (isDownloading && run.phase === 'idle') {
    run.phase = 'running';
    run.outcomes.clear();
  }

  // Outcomes count only items whose status changed to completed or failed
  // while a run is in progress, so items finished by earlier runs are not counted.
  const previous = run.lastStatus;
  if (run.phase !== 'idle') {
    for (const item of queue) {
      if (
        (item.status === 'completed' || item.status === 'failed') &&
        previous.get(item.id) !== item.status
      ) {
        run.outcomes.set(item.id, item.status);
      }
    }
  }
  run.lastStatus = new Map(queue.map((item) => [item.id, item.status]));

  if (run.phase === 'idle' || isDownloading) return;
  // Between two items of a running queue nothing downloads for a moment.
  if (run.phase === 'running' && hasPending) return;

  const notify = run.phase === 'running';
  run.phase = 'idle';
  const outcomes = Array.from(run.outcomes.values());
  run.outcomes.clear();
  if (!notify || !settingsStore.settings.notifications) return;
  const completed = outcomes.filter((status) => status === 'completed').length;
  const failed = outcomes.length - completed;
  void api.showNotification({
    title: 'Queue Complete',
    body: `${completed} completed, ${failed} failed.`,
  });
}

export function renderQueue(queue: RosiQueueItem[]) {
  queueController.currentQueue = queue;
  observeQueueRun(queue);
  // Forget errors for items that have left the queue.
  for (const id of queueController.rowErrors.keys()) {
    if (!queue.some((item) => item.id === id)) queueController.rowErrors.delete(id);
  }
  updateQueueButtonStates(queue);
  // The panel input is disabled while an action holds the lock, so its focus waits
  // for the unlock in syncQueueActionBusyState.
  const panelFocusWanted = queueController.focusPanelOnRender;
  const panelLocked = queueController.queueActionLocks > 0;
  renderQueueRows(
    queue,
    { queueList: refs.queueList, queueSection: refs.queueSection, queueCount: refs.queueCount },
    {
      focusQueueItemId: queueController.focusQueueItemId,
      focusQueueAction: queueController.focusQueueAction,
      focusPanelRequested: panelFocusWanted && !panelLocked,
      focusPanelControl: refs.queueUrlInput,
      retryQueueItem: async (id: string) => {
        queueController.focusQueueItemId = id;
        const endQueueAction = beginQueueAction();
        try {
          const result = await api.retryQueueItem(id);
          if (!result || !result.ok) {
            queueController.focusQueueItemId = null;
            const message = result?.error?.message || 'Could not retry the queue item.';
            setQueueStatusMessage(message);
            showToast(message, { type: 'error' });
            reportQueueRowError(id, message);
          } else {
            clearQueueRowError(id);
            // A running queue picks the item up on its own; otherwise the
            // user still has to start it.
            const queueIsRunning = queueController.currentQueue.some(
              (item) => item.status === 'downloading'
            );
            announceQueueAction(
              queueIsRunning
                ? 'Queued the item again. It will run after the current download.'
                : 'Queued the item again. Start the queue to run it.'
            );
          }
        } catch {
          queueController.focusQueueItemId = null;
          const message = 'Could not retry the queue item.';
          setQueueStatusMessage(message);
          showToast(message, { type: 'error' });
          reportQueueRowError(id, message);
        } finally {
          endQueueAction();
        }
      },
      reorderQueueItem: async (id: string, direction: 'up' | 'down') => {
        queueController.focusQueueItemId = id;
        const endQueueAction = beginQueueAction();
        try {
          const result = await api.reorderQueueItem({ id, direction });
          if (!result || !result.ok) {
            queueController.focusQueueItemId = null;
            const message = result?.error?.message || 'Could not reorder the queue item.';
            setQueueStatusMessage(message);
            reportQueueRowError(id, message);
          } else {
            clearQueueRowError(id);
            setQueueStatusMessage(`Moved item ${direction} in the queue.`);
          }
        } catch {
          queueController.focusQueueItemId = null;
          setQueueStatusMessage('Could not reorder the queue item.');
          reportQueueRowError(id, 'Could not reorder the queue item.');
        } finally {
          endQueueAction();
        }
      },
      copyDiagnostics: async (item: RosiQueueItem) => {
        const diagnostics = [
          `URL: ${item.url}`,
          `Status: ${item.status}`,
          item.filename ? `File: ${item.filename}` : '',
          item.error ? `Error: ${item.error}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        if (await copyText(diagnostics)) {
          setQueueStatusMessage('Copied diagnostics to the clipboard.');
        } else {
          showToast('Could not copy diagnostics to the clipboard.', { type: 'warning' });
        }
      },
      openFileLocation: async (filePath: string, id: string) => {
        const message = 'Could not open that file location.';
        try {
          const result = await api.openFileLocation(filePath);
          if (!result || !result.ok) {
            const failure = result?.error?.message || message;
            showToast(failure, { type: 'warning' });
            reportQueueRowError(id, failure);
          } else {
            clearQueueRowError(id);
          }
        } catch {
          showToast(message, { type: 'warning' });
          reportQueueRowError(id, message);
        }
      },
      rowErrorFor,
      removeFromQueue: async (id: string) => {
        // Focus moves to the Remove control of the next row, else the previous
        // row, else the queue panel's URL input. Downloading rows have no Remove.
        const queue = queueController.currentQueue;
        const removeIndex = queue.findIndex((item) => item.id === id);
        const hasRemove = (item: RosiQueueItem) => item.status !== 'downloading';
        const neighbour =
          removeIndex >= 0
            ? (queue.slice(removeIndex + 1).find(hasRemove) ??
              queue.slice(0, removeIndex).reverse().find(hasRemove) ??
              null)
            : null;
        queueController.focusQueueItemId = neighbour?.id ?? null;
        queueController.focusQueueAction = neighbour ? 'queue-item-remove' : null;
        queueController.focusPanelOnRender = neighbour === null;
        const endQueueAction = beginQueueAction();
        try {
          const result = await api.removeFromQueue(id);
          if (!result || !result.ok) {
            clearRemoveFocus();
            const message = result?.error?.message || 'Could not remove the queue item.';
            setQueueStatusMessage(message);
            showToast(message, { type: 'error' });
            reportQueueRowError(id, message);
          } else {
            setQueueStatusMessage('Removed item from the queue.');
          }
        } catch {
          clearRemoveFocus();
          const message = 'Could not remove the queue item.';
          setQueueStatusMessage(message);
          showToast(message, { type: 'error' });
          reportQueueRowError(id, message);
        } finally {
          endQueueAction();
        }
      },
    }
  );
  queueController.focusQueueItemId = null;
  queueController.focusQueueAction = null;
  queueController.focusPanelOnRender = false;
  if (panelFocusWanted && panelLocked) queueController.panelFocusPending = true;
}

/** Drops a pending focus move after a removal failed, so it cannot apply later. */
function clearRemoveFocus() {
  queueController.focusQueueItemId = null;
  queueController.focusQueueAction = null;
  queueController.focusPanelOnRender = false;
  queueController.panelFocusPending = false;
}

/**
 * Attach transient per-item progress to the matching queue row. Progress is
 * never persisted; a later queue-update broadcast replaces it wholesale.
 */
export function applyQueueItemProgress(event: RosiJobProgressEvent) {
  if (!event.queueItemId) return;
  const target = queueController.currentQueue.find((item) => item.id === event.queueItemId);
  if (!target) return;
  if (event.phase === 'idle') {
    delete target.progress;
  } else {
    target.progress = event;
  }
  // Patch the single active row; only fall back to a full render if the row
  // is missing, so frequent progress ticks cannot steal focus.
  const patched = updateQueueItemProgress(target, {
    queueList: refs.queueList,
    queueSection: refs.queueSection,
    queueCount: refs.queueCount,
  });
  if (!patched) renderQueue(queueController.currentQueue);
}

export function setQueueStatusMessage(message: unknown) {
  const statusEl = refs.queueStatusMessage;
  if (!statusEl) return;
  if (queueController.queueStatusTimer) {
    clearTimeout(queueController.queueStatusTimer);
    queueController.queueStatusTimer = null;
  }

  const nextMessage =
    typeof message === 'string' ? message.trim() : message == null ? '' : String(message).trim();
  statusEl.textContent = '';

  if (!nextMessage) return;

  queueController.queueStatusTimer = setTimeout(() => {
    statusEl.textContent = nextMessage;
    queueController.queueStatusTimer = null;
  }, 0);
}

export function queueMessageForCount(count: number, singular: string, plural: string) {
  return count === 1 ? singular : plural.replace('{count}', String(count));
}

export function announceQueueAction(message: string, toastType?: ToastType) {
  setQueueStatusMessage(message);
  if (toastType === 'error' || toastType === 'warning') {
    showToast(message, { type: toastType });
  }
}

export function syncQueueActionBusyState() {
  const isBusy = queueController.queueActionLocks > 0;
  refs.queueActionButtons.forEach((button) => {
    button.setAttribute('aria-busy', String(isBusy));
  });
  if (refs.addToQueueBtn) refs.addToQueueBtn.disabled = isBusy;
  if (refs.clearQueueBtn) refs.clearQueueBtn.disabled = isBusy;
  updateQueueButtonStates(queueController.currentQueue);
  if (refs.queueUrlInput) {
    refs.queueUrlInput.disabled = isBusy;
  }
  if (refs.queueSection) {
    refs.queueSection.setAttribute('aria-busy', String(isBusy));
  }
  // Focus can land on the input only once it is enabled, so apply a deferred move now.
  if (!isBusy && queueController.panelFocusPending) {
    queueController.panelFocusPending = false;
    refs.queueUrlInput?.focus();
  }
}

export function beginQueueAction() {
  queueController.queueActionLocks += 1;
  syncQueueActionBusyState();
  return () => {
    queueController.queueActionLocks = Math.max(0, queueController.queueActionLocks - 1);
    syncQueueActionBusyState();
  };
}

// Owned by the renderer controller; set during startup and updated while it runs.
export const queueController: {
  focusQueueItemId: string | null;
  // The action to focus in the focused row; null takes the first enabled control.
  focusQueueAction: string | null;
  // Set when a removal left no row to focus, so the queue panel control takes focus.
  focusPanelOnRender: boolean;
  // A panel focus that was due while the action lock disabled the input. Applied on unlock.
  panelFocusPending: boolean;
  currentQueue: RosiQueueItem[];
  queueStatusTimer: ReturnType<typeof setTimeout> | null;
  queueActionLocks: number;
  rowErrors: Map<string, QueueRowError>;
  // Run tracking for the drain notification. See observeQueueRun.
  queueRun: {
    phase: 'idle' | 'running' | 'stopping';
    outcomes: Map<string, 'completed' | 'failed'>;
    lastStatus: Map<string, RosiQueueItem['status']>;
  };
} = {
  focusQueueItemId: null,
  focusQueueAction: null,
  focusPanelOnRender: false,
  panelFocusPending: false,
  currentQueue: [],
  queueStatusTimer: null,
  queueActionLocks: 0,
  rowErrors: new Map(),
  queueRun: { phase: 'idle', outcomes: new Map(), lastStatus: new Map() },
};
