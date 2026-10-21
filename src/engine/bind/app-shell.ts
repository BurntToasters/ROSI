// Startup bindings for the sidebar, help links, and licenses.
import { hideLicenses, showKeyboardShortcuts, showLicenses } from '../overlays';
import { refs } from '../refs';
import { bindExternalLink } from '../settings-view';
import { appliedTheme, syncLicensesTheme } from '../theme';
import { closeSidebar, toggleSidebar } from '../ui-helpers';

/** Sidebar, help links, and the licenses entry point. */
export function bindAppShell() {
  const {
    browserCookiesHelp,
    closeSidebarBtn,
    helpLink,
    licensesFrame,
    licensesLink,
    settingsBtn,
    shortcutsBtn,
    sidebarOverlay,
    supportLink,
    supportProjectLink,
    websiteLink,
  } = refs;
  // Sidebar controls
  if (settingsBtn) settingsBtn.addEventListener('click', toggleSidebar);
  if (closeSidebarBtn) closeSidebarBtn.addEventListener('click', closeSidebar);
  if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);
  if (shortcutsBtn) shortcutsBtn.addEventListener('click', showKeyboardShortcuts);

  bindExternalLink(browserCookiesHelp, 'https://help.rosie.run/rosi/en-us/about-browser-cookies');
  bindExternalLink(helpLink, 'https://help.rosie.run/rosi/en-us/faq');
  bindExternalLink(supportLink, 'https://rosie.run/support');
  bindExternalLink(websiteLink, 'https://rosie.run');
  bindExternalLink(supportProjectLink, 'https://rosie.run/support');

  if (licensesLink) {
    licensesLink.addEventListener('click', (event) => {
      event.preventDefault();
      showLicenses();
    });
  }
  if (licensesFrame) {
    licensesFrame.addEventListener('load', () => {
      syncLicensesTheme(appliedTheme);
    });
  }
}

/** Licenses overlay dismissal. */
export function bindLicensesOverlay() {
  const licensesOverlayEl = document.getElementById('licenses-overlay');
  if (licensesOverlayEl) {
    licensesOverlayEl.addEventListener('click', (event) => {
      if (event.target === licensesOverlayEl) {
        hideLicenses();
      }
    });
  }

  const closeBtn = document.getElementById('close-licenses');
  if (closeBtn) {
    closeBtn.addEventListener('click', hideLicenses);
  }
}
