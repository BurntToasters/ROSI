// Startup bindings for format fetching and the download button.
import { applyActiveDownloadProgressPhases, extractHttpUrls, isValidUrl, logError } from '../core';
import { fetchFormats } from '../formats';
import {
  beginManualDownloadOperation,
  failManualDownloadStart,
  manualDownload,
  prepareManualDownloadStart,
  receiveManualDownloadStart,
} from '../manual-download';
import { isPlaylistScopeVisible, resolvePlaylistSelection } from '../playlist';
import {
  buildOnScreenPresetOverrides,
  getSelectedPreset,
  readAdvancedFormatSelections,
} from '../presets';
import { downloadState, hideProgressBar } from '../progress';
import { addUrlsToQueue } from '../queue-controller';
import { refs } from '../refs';
import { persistSettings, settingsStore } from '../settings-store';
import { updateUIFromSettings } from '../settings-view';
import { appendConsoleOutput, setButtonLoading, showToast } from '../ui-helpers';
import { checkForUpdates } from '../updater-ui';
import { syncPrimaryActionState, updateUrlButtons, urlActionState } from '../url-actions';

/** Format fetching, the download button, and manual update checks. */
export function bindDownloadControls() {
  const {
    checkUpdateBtn,
    convertFormatSelect,
    downloadBtn,
    fetchFormatsBtn,
    keepOriginalToggle,
    outputEl,
  } = refs;
  if (fetchFormatsBtn) {
    fetchFormatsBtn.onclick = fetchFormats;
  }

  // download button
  if (downloadBtn) {
    downloadBtn._originalClick = async function () {
      let operation = -1;
      try {
        if (downloadState.isDownloading) return;

        operation = beginManualDownloadOperation();
        downloadState.isDownloading = true;
        urlActionState.hasUrlValidationIntent = true;
        syncPrimaryActionState();

        const urlInput = document.getElementById('url') as HTMLInputElement | null;
        const url = urlInput ? urlInput.value : null;
        if (!url || url.trim() === '') {
          failManualDownloadStart(operation);
          downloadState.isDownloading = false;
          syncPrimaryActionState();
          showToast('Please enter a video URL.', { type: 'warning' });
          return;
        }

        // Multiple links go to the queue instead of the single-download path.
        const batch = extractHttpUrls(url);
        if (batch.urls.length > 1) {
          failManualDownloadStart(operation);
          downloadState.isDownloading = false;
          const added = await addUrlsToQueue(batch.urls, batch.rejected);
          if (added && urlInput) {
            urlInput.value = '';
            urlActionState.hasUrlValidationIntent = false;
            updateUrlButtons();
          }
          syncPrimaryActionState();
          return;
        }

        // Validate URL format
        if (!isValidUrl(url.trim())) {
          failManualDownloadStart(operation);
          downloadState.isDownloading = false;
          syncPrimaryActionState();
          showToast('Please enter a valid URL starting with http:// or https://', {
            type: 'warning',
          });
          return;
        }

        const formatSelections = readAdvancedFormatSelections(url.trim());
        if (
          settingsStore.settings.advancedOptions &&
          !formatSelections.videoFormat &&
          !formatSelections.audioFormat
        ) {
          failManualDownloadStart(operation);
          downloadState.isDownloading = false;
          syncPrimaryActionState();
          showToast('Check resolutions and select a video or audio format first.', {
            type: 'warning',
          });
          return;
        }

        // Capture URL-owned controls before a folder prompt or persistence wait.
        const scopeVisible = isPlaylistScopeVisible();
        const playlist = resolvePlaylistSelection();
        if (scopeVisible && !playlist) {
          failManualDownloadStart(operation);
          downloadState.isDownloading = false;
          syncPrimaryActionState();
          return;
        }
        const activePreset = getSelectedPreset();
        const presetOverrides = activePreset
          ? {
              presetId: activePreset.id,
              presetName: activePreset.name,
              ...buildOnScreenPresetOverrides(formatSelections),
            }
          : {};
        const ffmpegPath = settingsStore.settings.ffmpegPath;
        const convertFormat = settingsStore.settings.convertEnabled
          ? convertFormatSelect?.value.trim() || undefined
          : undefined;
        const keepOriginal = settingsStore.settings.convertEnabled
          ? keepOriginalToggle?.checked
          : undefined;
        let savePath = settingsStore.settings.askDownloadLocation
          ? null
          : settingsStore.settings.downloadFolder?.trim() || null;
        if (!savePath) {
          try {
            savePath = await window.api.selectDownloadLocation();
          } catch (dialogError) {
            failManualDownloadStart(operation);
            logError('Error opening save dialog', dialogError);
            downloadState.isDownloading = false;
            syncPrimaryActionState();
            showToast('Could not open the save location dialog. Please try again.', {
              type: 'error',
            });
            return;
          }
        }

        if (!savePath) {
          failManualDownloadStart(operation);
          downloadState.isDownloading = false;
          syncPrimaryActionState();
          if (outputEl) {
            outputEl.replaceChildren();
            appendConsoleOutput(outputEl, '⚠️ Download cancelled: No save location selected.');
          }
          return;
        }
        settingsStore.settings.downloadFolder = savePath;
        updateUIFromSettings();
        const saved = await persistSettings(true, true);
        if (!saved) {
          failManualDownloadStart(operation);
          downloadState.isDownloading = false;
          syncPrimaryActionState();
          showToast('Could not save download settings. Please try again.', { type: 'error' });
          return;
        }
        if (outputEl) outputEl.textContent = '';
        downloadState.downloadAbort = () => {
          if (operation !== manualDownload.manualDownloadOperation) return;
          downloadState.isDownloading = false;
          setButtonLoading(downloadBtn, false);
          syncPrimaryActionState();
        };
        setButtonLoading(downloadBtn, true, () => {
          window.api.cancelDownload();
          downloadState.downloadAbort?.();
          hideProgressBar();
        });

        const { videoFormat, audioFormat } = formatSelections;

        applyActiveDownloadProgressPhases(settingsStore.settings, 'Starting download...', {
          videoFormat,
          audioFormat,
        });

        prepareManualDownloadStart(operation);
        const startResult = await window.api.downloadVideo({
          url: url.trim(),
          videoFormat,
          audioFormat,
          outputPath: savePath,
          convertFormat,
          keepOriginal,
          ffmpegPath,
          // When radios are hidden, omit playlist so a selected preset's All/Range applies.
          ...(scopeVisible && playlist ? { playlist } : {}),
          ...presetOverrides,
        });
        if (operation !== manualDownload.manualDownloadOperation) return;
        if (!startResult || startResult.ok !== true) {
          failManualDownloadStart(operation);
          downloadState.isDownloading = false;
          setButtonLoading(downloadBtn, false);
          syncPrimaryActionState();
          hideProgressBar();
          showToast(
            startResult?.error?.message || 'Download request was rejected before starting.',
            { type: 'error' }
          );
        } else {
          receiveManualDownloadStart(startResult.data, operation);
        }
      } catch (downloadError) {
        if (operation < 0 || operation !== manualDownload.manualDownloadOperation) return;
        failManualDownloadStart(operation);
        logError('Unexpected error starting download', downloadError);
        downloadState.isDownloading = false;
        setButtonLoading(downloadBtn, false);
        syncPrimaryActionState();
        hideProgressBar();
        showToast('An unexpected error occurred while starting the download. Please try again.', {
          type: 'error',
        });
      }
    };
    downloadBtn.onclick = downloadBtn._originalClick;
  }

  if (checkUpdateBtn) {
    checkUpdateBtn.onclick = checkForUpdates;
  }
}
