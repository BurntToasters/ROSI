// Main window entry. Order matters: the bridge must define window.api before
// the engine evaluates. Icons swap the markup placeholders when they load, so
// they are imported before the engine.
import { waitForPrepareForCloseListener } from './tauri-bridge';
import './modules/icons';
import './rosiEngine';
import { call } from './commands';
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
  void (async () => {
    await window.__ROSI_RENDERER_STARTUP_READY__;
    await waitForPrepareForCloseListener();
    try {
      await installE2eHookIfEnabled();
    } catch (error) {
      console.error('[rosi] E2E hook failed', error);
    }
    await call('mark_main_window_ready');
  })().catch((error: unknown) => {
    console.error('[rosi] main renderer readiness failed', error);
  });
});
