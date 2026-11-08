// Startup bindings for format fetching and the download button.
import { applyActiveDownloadProgressPhases, isValidUrl, logError } from '../core';
import { fetchFormats } from '../formats';
import {
  beginManualDownloadOperation,
  failManualDownloadStart,
  manualDownload,
  prepareManualDownloadStart,
  receiveManualDownloadStart,
} from '../manual-download';
import { isPlaylistScopeVisible, resolvePlaylistSelection } from '../playlist';
import { buildRequestOverrides, readAdvancedFormatSelections } from '../presets';
import { downloadState, hideProgressBar } from '../progress';
import { addUrlsToQueue, extractQueueLinks } from '../queue-controller';
import { refs } from '../refs';
import { persistSettings, settingsStore } from '../settings-store';
import { updateUIFromSettings } from '../settings-view';
import { appendConsoleOutput, setButtonLoading, showToast } from '../ui-helpers';
import { checkForUpdates } from '../updater-ui';
import { syncPrimaryActionState, updateUrlButtons, urlActionState } from '../url-actions';
import { api } from '../../api';

/** Format fetching, the download button, and manual update checks. */
export function bindDownloadControls() {
  const { checkUpdateBtn, downloadBtn, fetchFormatsBtn, outputEl } = refs;
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
        const extracted = await extractQueueLinks(url);
        const batch = extracted.ok ? extracted.data : { urls: [], rejectedCount: 0 };
        if (batch.urls.length > 1) {
          failManualDownloadStart(operation);
          downloadState.isDownloading = false;
          const added = await addUrlsToQueue(batch.urls, batch.rejectedCount);
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
        const requestOverrides = buildRequestOverrides({
          formats: formatSelections,
          playlist: scopeVisible ? (playlist ?? undefined) : undefined,
        });
        const ffmpegPath = settingsStore.settings.ffmpegPath;
        let savePath = settingsStore.settings.askDownloadLocation
          ? null
          : settingsStore.settings.downloadFolder?.trim() || null;
        // "Ask every time" off with no folder is not a blocker: the backend saves to
        // the Downloads folder when outputPath is omitted (same as the queue path).
        const usesDefaultFolder = !settingsStore.settings.askDownloadLocation && !savePath;
        if (!savePath && !usesDefaultFolder) {
          try {
            savePath = await api.selectDownloadLocation();
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

        if (!savePath && !usesDefaultFolder) {
          failManualDownloadStart(operation);
          downloadState.isDownloading = false;
          syncPrimaryActionState();
          if (outputEl) {
            outputEl.replaceChildren();
            appendConsoleOutput(outputEl, '⚠️ Download cancelled: No save location selected.');
          }
          return;
        }
        if (savePath) {
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
        }
        if (outputEl) outputEl.textContent = '';
        downloadState.downloadAbort = () => {
          if (operation !== manualDownload.manualDownloadOperation) return;
          downloadState.isDownloading = false;
          setButtonLoading(downloadBtn, false);
          syncPrimaryActionState();
        };
        setButtonLoading(downloadBtn, true, () => {
          api.cancelDownload();
          downloadState.downloadAbort?.();
          hideProgressBar();
        });

        const { videoFormat, audioFormat } = formatSelections;

        applyActiveDownloadProgressPhases(settingsStore.settings, 'Starting download...', {
          videoFormat,
          audioFormat,
        });

        prepareManualDownloadStart(operation);
        const startResult = await api.downloadVideo({
          url: url.trim(),
          ...(savePath ? { outputPath: savePath } : {}),
          ffmpegPath,
          ...requestOverrides,
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
