// Startup binding for global keyboard shortcuts.
import { dockModule, isMac } from '../core';
import {
  getTopActiveOverlayId,
  hideLicenses,
  hideModal,
  isModalActive,
  showModal,
} from '../overlays';
import { isPresetPopoverOpen, setPresetPopoverOpen } from '../presets';
import { restartAfterSettingsFlush } from '../settings-store';
import { closeSidebar, toggleSidebar } from '../ui-helpers';

/** Global keyboard shortcuts. */
export function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (event) => {
    const modifierPressed = isMac() ? event.metaKey : event.ctrlKey;
    const wizardOverlay = document.getElementById('setup-wizard');
    const wizardActive = wizardOverlay?.classList.contains('active');
    const licensesOverlay = document.getElementById('licenses-overlay');
    const licensesActive = licensesOverlay?.classList.contains('active');

    if (event.key === 'Escape') {
      const topOverlayId = getTopActiveOverlayId();
      if (topOverlayId === 'app-modal') {
        const appModal = document.getElementById('app-modal');
        if (appModal) hideModal(appModal, null);
        return;
      }
      if (topOverlayId === 'licenses-overlay') {
        hideLicenses();
        return;
      }
      if (topOverlayId === 'setup-wizard') return;
      if (topOverlayId === 'sidebar') {
        closeSidebar();
        return;
      }
      if (isPresetPopoverOpen()) {
        setPresetPopoverOpen(false);
        return;
      }
    }

    if (wizardActive || isModalActive || licensesActive) {
      return;
    }

    if (modifierPressed && event.key === 'd') {
      event.preventDefault();
      showModal({
        title: 'Restart Application',
        message: 'Are you sure you want to restart ROSI?',
        buttons: [
          { label: 'Cancel' },
          { label: 'Restart', primary: true, action: () => void restartAfterSettingsFlush() },
        ],
      });
    }

    // Match the physical key: with Alt held, event.key can be a symbol on macOS.
    const dockTabKeys: Record<string, string> = {
      Digit1: 'queue',
      Digit2: 'activity',
      Digit3: 'console',
    };
    const dockTab = dockTabKeys[event.code];
    const sidebarOpen = document.getElementById('sidebar')?.classList.contains('open');
    // On macOS Option+digit types a character, so leave text fields alone there.
    const typingOnMac =
      isMac() &&
      event.target instanceof HTMLElement &&
      event.target.matches('input, textarea, select, [contenteditable="true"]');
    if (
      event.altKey &&
      !modifierPressed &&
      !event.shiftKey &&
      dockTab &&
      !sidebarOpen &&
      !typingOnMac
    ) {
      event.preventDefault();
      dockModule?.selectTab(dockTab, { focus: true });
    }

    if (modifierPressed && event.key === 'f') {
      event.preventDefault();
      const urlInput = document.getElementById('url') as HTMLInputElement | null;
      if (urlInput) {
        urlInput.focus();
        urlInput.select();
      }
    }

    // With Shift held, event.key is '<' on most layouts; match the physical key.
    const commaKey = event.code === 'Comma' || event.key === ',';
    if (modifierPressed && event.shiftKey && commaKey) {
      event.preventDefault();
      toggleSidebar();
    } else if (modifierPressed && commaKey && !isMac()) {
      // macOS handles Cmd+, through the native Settings menu item.
      event.preventDefault();
      const sidebar = document.getElementById('sidebar');
      if (sidebar && !sidebar.classList.contains('open')) toggleSidebar();
    }
  });
}
