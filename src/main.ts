// Main window entry. Order matters: the bridge must define window.api before
// the renderer modules and engine evaluate.
import './tauri-bridge';
import './modules/ui';
import './modules/downloads';
import './modules/queue';
import './modules/settings';
import './modules/updates';
import './rosiEngine';
import { invoke } from '@tauri-apps/api/core';
import { installE2eHookIfEnabled } from './e2e-hook';

function hideStoreManagedUpdateControls(): void {
  if (window.api.getChannel() !== 'msstore') return;
  for (const id of ['checkUpdateBtn', 'checkUpdatesOnStartupLabel']) {
    const element = document.getElementById(id);
    if (element) element.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', hideStoreManagedUpdateControls);

window.addEventListener('load', () => {
  void installE2eHookIfEnabled()
    .catch((error: unknown) => {
      console.error('[rosi] E2E hook failed', error);
    })
    .finally(() => {
      invoke('mark_main_window_ready').catch((error: unknown) => {
        console.error('[rosi] mark_main_window_ready failed', error);
      });
    });
});
