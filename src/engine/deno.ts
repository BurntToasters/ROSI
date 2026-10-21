// Deno detection, reminder, and install flow.
import { RosiSettings, logError } from './core';
import { showModal } from './overlays';
import { showRestartFailure } from './updater-ui';

// Automatic Deno install uses winget (Windows) or Homebrew (macOS) only.
export function isLinuxPlatform() {
  return /linux/i.test(navigator.userAgent) && !/android/i.test(navigator.userAgent);
}

export const DENO_INSTALL_DOCS = 'https://docs.deno.com/runtime/getting_started/installation/';

// check for Deno
export async function checkDenoInstallation(
  settings: RosiSettings,
  persist: () => Promise<boolean>,
  flushBeforeRestart: () => Promise<boolean>,
  isFlatpak = false
) {
  // The Flatpak sandbox cannot run a Deno installed on the host, so the
  // reminder would ask for something that cannot help.
  if (settings.denoReminderDismissed || isFlatpak) {
    return;
  }

  try {
    const isInstalled = await window.api.checkDenoInstalled();

    if (!isInstalled && isLinuxPlatform()) {
      showModal({
        title: 'Deno Required for Full YouTube Functionality',
        message:
          'Recent updates to yt-dlp require Deno for full YouTube functionality.\n\nInstall Deno with the official instructions (or your package manager), then restart ROSI.',
        buttons: [
          {
            label: 'Open Deno Instructions',
            primary: true,
            action: () => window.api.openExternal(DENO_INSTALL_DOCS),
          },
          { label: 'Later' },
          {
            label: "No, don't remind me",
            action: () => {
              settings.denoReminderDismissed = true;
              void persist();
            },
          },
        ],
      });
    } else if (!isInstalled) {
      showModal({
        title: 'Deno Required for Full YouTube Functionality',
        message:
          'Recent updates to yt-dlp require Deno for full YouTube functionality.\n\nWould you like to install Deno now?\n\nDeno is the default JS interpreter for yt-dlp and is recommended due to its lightweight nature.',
        buttons: [
          {
            label: 'Install',
            primary: true,
            action: async () => {
              showModal({
                title: 'Installing Deno...',
                message: 'Please wait while Deno is being installed. This may take a moment.',
                buttons: [{ label: 'Installing...', primary: true, disabled: true }],
                priority: true,
                busy: true,
              });

              try {
                const result = await window.api.installDeno();
                if (result && result.cancelled) {
                  showModal({
                    title: 'Installation Cancelled',
                    message: 'Deno installation was cancelled.',
                    buttons: [{ label: 'OK', primary: true }],
                    priority: true,
                  });
                  return;
                }
                if (result?.success !== true) {
                  throw new Error(
                    result?.error || 'Deno installation did not complete successfully.'
                  );
                }
                showModal({
                  title: 'Installation Complete',
                  message:
                    'Deno has been successfully installed!\nRestarting the app can help pick up the updated environment.',
                  buttons: [
                    {
                      label: 'Restart Now',
                      primary: true,
                      action: async () => {
                        if (!(await flushBeforeRestart())) return;
                        try {
                          await window.api.restartApp();
                        } catch (error) {
                          showRestartFailure(error);
                        }
                      },
                    },
                    { label: 'Later' },
                  ],
                  priority: true,
                });
              } catch (error) {
                const errMsg =
                  (error as { error?: string })?.error ||
                  (error instanceof Error ? error.message : 'Unknown error');
                showModal({
                  title: 'Installation Failed',
                  message: `Failed to install Deno automatically.\n\nUse the official Deno installation instructions.\n\nError: ${errMsg}`,
                  buttons: [
                    {
                      label: 'Open Deno Website',
                      primary: true,
                      action: () => window.api.openExternal('https://deno.land'),
                    },
                    { label: 'OK' },
                  ],
                  priority: true,
                });
              }
            },
          },
          { label: 'Later' },
          {
            label: "No, don't remind me",
            action: () => {
              settings.denoReminderDismissed = true;
              void persist();
            },
          },
        ],
      });
    }
  } catch (error) {
    logError('Error checking Deno installation', error);
  }
}
