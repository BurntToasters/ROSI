// Startup bindings for download activity and the console.
import { showModal } from '../overlays';
import { refs } from '../refs';
import { showToast } from '../ui-helpers';
import { api } from '../../api';

/** Activity loading, history clearing, and the console clear button. */
export function bindActivityControls() {
  const { activityPanel, clearConsoleBtn, clearHistoryBtn, outputEl } = refs;
  if (typeof api.getDownloadActivity === 'function') {
    api
      .getDownloadActivity()
      .then((result) => {
        if (result && result.ok) activityPanel?.setEntries(result.data);
      })
      .catch(() => {});
  }

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
