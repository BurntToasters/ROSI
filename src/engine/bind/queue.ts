// Startup bindings for queue input and actions.
import { applyActiveDownloadProgressPhases, extractHttpUrls, isMac } from '../core';
import { showModal } from '../overlays';
import {
  addUrlsToQueue,
  announceQueueAction,
  beginQueueAction,
  queueController,
  queueMessageForCount,
  setQueueStatusMessage,
  syncQueueActionBusyState,
} from '../queue-controller';
import { refs } from '../refs';
import { settingsStore } from '../settings-store';
import { showToast } from '../ui-helpers';

/** Queue input and queue action buttons. */
export function bindQueueControls() {
  const {
    addToQueueBtn,
    cancelQueueBtn,
    clearFinishedQueueBtn,
    clearQueueBtn,
    queueUrlInput,
    startQueueBtn,
  } = refs;
  refs.queueActionButtons = [
    addToQueueBtn,
    startQueueBtn,
    clearQueueBtn,
    clearFinishedQueueBtn,
    cancelQueueBtn,
  ].filter((button) => button instanceof HTMLButtonElement);
  syncQueueActionBusyState();

  if (addToQueueBtn && queueUrlInput) {
    // Allow Ctrl/Cmd+Enter to submit from the textarea (standard multi-line UX).
    queueUrlInput.addEventListener('keydown', (e) => {
      const modKey = isMac() ? e.metaKey : e.ctrlKey;
      if (modKey && e.key === 'Enter') {
        e.preventDefault();
        addToQueueBtn.click();
      }
    });

    // Accept drag-and-drop of URLs into the queue textarea.
    queueUrlInput.addEventListener('dragover', (e) => {
      e.preventDefault();
      queueUrlInput.classList.add('drag-over');
    });
    queueUrlInput.addEventListener('dragleave', () => {
      queueUrlInput.classList.remove('drag-over');
    });
    queueUrlInput.addEventListener('drop', (e) => {
      const dragEvent = e as DragEvent;
      dragEvent.preventDefault();
      queueUrlInput.classList.remove('drag-over');
      const dt = dragEvent.dataTransfer;
      const text = dt ? dt.getData('text/uri-list') || dt.getData('text/plain') : '';
      const { urls } = extractHttpUrls(text);
      const dropped = urls.length > 0 ? urls.join('\n') : '';
      if (dropped) {
        const existing = queueUrlInput.value.trim();
        queueUrlInput.value = existing ? `${existing}\n${dropped}` : dropped;
        queueUrlInput.dispatchEvent(new Event('input'));
      } else if (text.trim()) {
        showToast('Dropped content did not contain a valid http or https link.', {
          type: 'warning',
        });
      }
    });

    addToQueueBtn.addEventListener('click', async () => {
      if (queueController.queueActionLocks > 0) return;
      const raw = queueUrlInput.value.trim();
      if (!raw) {
        const message = 'Enter one or more URLs, one per line.';
        setQueueStatusMessage(message);
        showToast(message, { type: 'warning' });
        return;
      }
      const { urls, rejected } = extractHttpUrls(raw);
      if (urls.length === 0) {
        const message = 'No valid http or https links were found.';
        setQueueStatusMessage(message);
        showToast(message, { type: 'warning' });
        return;
      }
      const added = await addUrlsToQueue(urls, rejected);
      if (added) queueUrlInput.value = '';
    });
  }

  if (startQueueBtn) {
    startQueueBtn.addEventListener('click', async () => {
      if (queueController.queueActionLocks > 0) return;
      const endQueueAction = beginQueueAction();
      try {
        const result = await window.api.startQueue();
        if (result && result.ok) {
          applyActiveDownloadProgressPhases(settingsStore.settings, 'Queue download...');
          announceQueueAction('Queue started processing.');
        } else {
          const message = result?.error?.message || 'Could not start the queue.';
          setQueueStatusMessage(message);
          showToast(message, { type: 'warning' });
        }
      } catch {
        const message = 'Could not start the queue.';
        setQueueStatusMessage(message);
        showToast(message, { type: 'warning' });
      } finally {
        endQueueAction();
      }
    });
  }

  if (clearQueueBtn) {
    clearQueueBtn.addEventListener('click', () => {
      if (queueController.queueActionLocks > 0) return;
      showModal({
        title: 'Clear Queue',
        message: 'Remove all queued and completed items?',
        buttons: [
          { label: 'Cancel' },
          {
            label: 'Clear',
            danger: true,
            action: async () => {
              const endQueueAction = beginQueueAction();
              try {
                const result = await window.api.clearQueue();
                if (result && result.ok) {
                  announceQueueAction('Queue cleared.');
                } else {
                  const message = result?.error?.message || 'Could not clear the queue.';
                  setQueueStatusMessage(message);
                  showToast(message, { type: 'error' });
                }
              } catch {
                const message = 'Could not clear the queue.';
                setQueueStatusMessage(message);
                showToast(message, { type: 'error' });
              } finally {
                endQueueAction();
              }
            },
          },
        ],
      });
    });
  }

  if (clearFinishedQueueBtn) {
    clearFinishedQueueBtn.addEventListener('click', async () => {
      if (queueController.queueActionLocks > 0) return;
      const endQueueAction = beginQueueAction();
      try {
        const result = await window.api.clearFinishedQueue();
        if (result && result.ok) {
          announceQueueAction(
            queueMessageForCount(
              result.data.removed,
              'Removed 1 finished item.',
              'Removed {count} finished items.'
            )
          );
        } else {
          const message = result?.error?.message || 'Could not remove finished items.';
          setQueueStatusMessage(message);
          showToast(message, { type: 'error' });
        }
      } catch {
        const message = 'Could not remove finished items.';
        setQueueStatusMessage(message);
        showToast(message, { type: 'error' });
      } finally {
        endQueueAction();
      }
    });
  }

  if (cancelQueueBtn) {
    cancelQueueBtn.addEventListener('click', () => {
      if (queueController.queueActionLocks > 0) return;
      showModal({
        title: 'Cancel Queue',
        message: 'Stop processing the active download queue?',
        buttons: [
          { label: 'Keep Running' },
          {
            label: 'Cancel Queue',
            danger: true,
            action: async () => {
              const endQueueAction = beginQueueAction();
              try {
                const result = await window.api.cancelQueue();
                if (result && result.ok) {
                  announceQueueAction('Queue cancelled.');
                } else {
                  const message = result?.error?.message || 'Could not cancel the queue.';
                  setQueueStatusMessage(message);
                  showToast(message, { type: 'error' });
                }
              } catch {
                const message = 'Could not cancel the queue.';
                setQueueStatusMessage(message);
                showToast(message, { type: 'error' });
              } finally {
                endQueueAction();
              }
            },
          },
        ],
      });
    });
  }
}
