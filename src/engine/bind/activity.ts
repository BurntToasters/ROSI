// Startup bindings for download activity and the console.
import { logError } from '../core';
import { showModal } from '../overlays';
import { refs } from '../refs';
import { showToast } from '../ui-helpers';
import { api } from '../../api';

// Activity events received so far. The startup read carries no revision, so it
// is applied only if no event arrived while it was in flight.
let activityUpdatesSeen = 0;

/** Called for every activity event, so a slower startup read cannot overwrite it. */
export function noteActivityUpdate() {
  activityUpdatesSeen += 1;
}

/** Activity loading, history clearing, and the console clear button. */
export function bindActivityControls() {
  const { activityPanel, clearConsoleBtn, clearHistoryBtn, outputEl } = refs;
  const updatesBeforeRead = activityUpdatesSeen;
  // A failed startup read is non-blocking: the panel stays usable and the next
  // activity event still fills it in. No toast once an event has already filled it.
  const reportLoadFailure = () => {
    activityPanel?.markLoadFailed();
    if (activityUpdatesSeen !== updatesBeforeRead) return;
    showToast('Could not load download activity. It will update after the next download.', {
      type: 'warning',
    });
  };
  api
    .getDownloadActivity()
    .then((result) => {
      if (!result || !result.ok) {
        logError('Could not load download activity', result?.error?.message);
        reportLoadFailure();
        return;
      }
      if (activityUpdatesSeen === updatesBeforeRead) activityPanel?.setEntries(result.data);
    })
    .catch((error: unknown) => {
      logError('Could not load download activity', error);
      reportLoadFailure();
    });

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showModal({
        title: 'Clear Activity',
        message: 'Clear the recorded download activity?',
        buttons: [
          { label: 'Cancel' },
          {
            label: 'Clear',
            danger: true,
            action: () => {
              void activityPanel?.clear().then((cleared) => {
                if (cleared) showToast('Download activity cleared.', { type: 'info' });
              });
            },
          },
        ],
      });
    });
  }

  if (clearConsoleBtn && outputEl) {
    clearConsoleBtn.addEventListener('click', () => {
      outputEl.textContent = '';
    });
  }
}
