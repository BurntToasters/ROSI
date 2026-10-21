// Startup bindings for the URL field and preview.
import { extractHttpUrls, getModifierKeyName } from '../core';
import { clearDownloadResult } from '../manual-download';
import { hideVideoPreview, previewState } from '../preview';
import {
  cancelScheduledPreview,
  previewController,
  runManualVideoPreview,
} from '../preview-controller';
import { refs } from '../refs';
import { showToast } from '../ui-helpers';
import { syncPrimaryActionState, updateUrlButtons, urlActionState } from '../url-actions';

/** URL field: clear, paste, drop, and preview buttons. */
export function bindUrlInput() {
  const {
    clearUrlBtn,
    downloadBtn,
    downloadCard,
    pasteUrlBtn,
    previewBtn,
    previewCloseBtn,
    urlInput,
  } = refs;
  if (clearUrlBtn && urlInput) {
    clearUrlBtn.addEventListener('click', () => {
      urlInput.value = '';
      urlInput.focus();
      urlActionState.hasUrlValidationIntent = false;
      updateUrlButtons();
    });
    urlInput.addEventListener('input', () => {
      urlActionState.hasUrlValidationIntent = true;
      // A new link means a new download, not the last one's result.
      clearDownloadResult();
      updateUrlButtons();
    });
    urlInput.addEventListener('blur', () => {
      urlActionState.hasUrlValidationIntent = true;
      syncPrimaryActionState();
    });
    urlInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (downloadBtn && !downloadBtn.disabled) {
        downloadBtn.click();
      } else {
        urlActionState.hasUrlValidationIntent = true;
        syncPrimaryActionState();
      }
    });
    updateUrlButtons();
  }

  if (pasteUrlBtn && urlInput) {
    pasteUrlBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          const { urls } = extractHttpUrls(text);
          // Single-line #url strips newlines; join with spaces so Add N still detects batches.
          urlInput.value = urls.length > 1 ? urls.join(' ') : (urls[0] ?? text.trim());
          urlInput.dispatchEvent(new Event('input'));
          urlInput.focus();
          urlActionState.hasUrlValidationIntent = true;
          syncPrimaryActionState();
        }
      } catch {
        showToast(`Unable to read clipboard. Try pasting with ${getModifierKeyName()}+V.`, {
          type: 'info',
        });
      }
    });
  }

  if (downloadCard && urlInput) {
    downloadCard.addEventListener('dragover', (e) => {
      e.preventDefault();
      downloadCard.classList.add('drag-over');
    });
    downloadCard.addEventListener('dragleave', () => {
      downloadCard.classList.remove('drag-over');
    });
    downloadCard.addEventListener('drop', (e) => {
      const dragEvent = e as DragEvent;
      dragEvent.preventDefault();
      downloadCard.classList.remove('drag-over');
      const dt = dragEvent.dataTransfer;
      const text = dt ? dt.getData('text/uri-list') || dt.getData('text/plain') : '';
      const { urls } = extractHttpUrls(text);
      if (urls.length > 0 && urlInput) {
        urlInput.value = urls.length > 1 ? urls.join(' ') : (urls[0] as string);
        urlInput.dispatchEvent(new Event('input'));
        urlActionState.hasUrlValidationIntent = true;
        syncPrimaryActionState();
      } else if (text) {
        showToast('Dropped content did not contain a valid http or https link.', {
          type: 'warning',
        });
      }
    });
  }
  if (previewBtn) {
    previewBtn._originalClick = runManualVideoPreview;
    previewBtn.onclick = runManualVideoPreview;
  }
  if (previewCloseBtn) {
    previewCloseBtn.addEventListener('click', () => {
      if (window.api.cancelVideoInfo) window.api.cancelVideoInfo();
      cancelScheduledPreview();
      previewState.previewAbort?.();
      hideVideoPreview();
      previewController.lastPreviewUrl = null;
    });
  }
}
