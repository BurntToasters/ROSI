// Custom-profile format listing and its request state.
import { isValidUrl, logError } from './core';
import { showModal } from './overlays';
import { setButtonLoading } from './ui-helpers';

export let isFetchingFormats = false;
export let fetchFormatsAbort: (() => void) | null = null;

export let formatRequestGeneration = 0;
export let formatRequestUrl: string | null = null;

function setSelectMessage(select: HTMLSelectElement | null, message: string) {
  if (!select) return;
  const option = document.createElement('option');
  option.value = '';
  option.textContent = message;
  select.replaceChildren(option);
}

function setPickerMessage(message: string) {
  setSelectMessage(document.getElementById('videoFormat') as HTMLSelectElement | null, message);
  setSelectMessage(document.getElementById('audioFormat') as HTMLSelectElement | null, message);
}

function appendFormatOption(select: HTMLSelectElement | null, format: RosiFormatEntry) {
  if (!select) return;
  const option = document.createElement('option');
  option.value = format.formatId;
  option.textContent = format.displayLabel;
  select.appendChild(option);
}

export function clearAdvancedFormatSelections() {
  setSelectMessage(
    document.getElementById('videoFormat') as HTMLSelectElement | null,
    'Select Video Format'
  );
  setSelectMessage(
    document.getElementById('audioFormat') as HTMLSelectElement | null,
    'Select Audio Format'
  );
  formatState.formatSelectionsUrl = null;
}

export function invalidateFormatRequest() {
  if (formatRequestUrl === null) return;
  formatRequestGeneration += 1;
  formatRequestUrl = null;
  isFetchingFormats = false;
  fetchFormatsAbort = null;
  window.api.cancelFormats?.();
  const btn = document.getElementById('fetchFormatsBtn') as HTMLButtonElement | null;
  if (btn) setButtonLoading(btn, false);
}

export async function fetchFormats() {
  const btn = document.getElementById('fetchFormatsBtn') as HTMLButtonElement | null;
  const urlInput = document.getElementById('url') as HTMLInputElement | null;
  const videoSelect = document.getElementById('videoFormat') as HTMLSelectElement | null;
  const audioSelect = document.getElementById('audioFormat') as HTMLSelectElement | null;
  const videoUrl = urlInput?.value.trim() || null;

  try {
    if (!btn || !videoUrl) {
      showModal({
        title: 'Input Error',
        message: 'Please enter a video URL first.',
        buttons: [{ label: 'OK', primary: true }],
      });
      return;
    }

    if (!isValidUrl(videoUrl)) {
      clearAdvancedFormatSelections();
      setPickerMessage('Invalid URL');
      showModal({
        title: 'Invalid URL',
        message: 'Please enter a valid URL starting with http:// or https://',
        buttons: [{ label: 'OK', primary: true }],
      });
      return;
    }

    if (isFetchingFormats) return;
    isFetchingFormats = true;
    const requestGeneration = ++formatRequestGeneration;
    formatRequestUrl = videoUrl;
    formatState.formatSelectionsUrl = null;
    const isCurrentRequest = () =>
      requestGeneration === formatRequestGeneration && formatRequestUrl === videoUrl;
    let wasCancelled = false;
    fetchFormatsAbort = () => {
      if (!isCurrentRequest()) return;
      wasCancelled = true;
      formatRequestGeneration += 1;
      formatRequestUrl = null;
      formatState.formatSelectionsUrl = null;
      isFetchingFormats = false;
      fetchFormatsAbort = null;
      setPickerMessage('Format check cancelled');
      setButtonLoading(btn, false);
    };
    setButtonLoading(
      btn,
      true,
      () => {
        window.api.cancelFormats();
        fetchFormatsAbort?.();
      },
      'Cancel format check'
    );
    setSelectMessage(videoSelect, 'Loading...');
    setSelectMessage(audioSelect, 'Loading...');

    try {
      const formatResult = await window.api.getFormats(videoUrl);
      if (wasCancelled || !isCurrentRequest()) return;
      if (!formatResult || formatResult.ok !== true) {
        if (formatResult?.error?.code === 'NOT_AVAILABLE') {
          formatState.formatSelectionsUrl = null;
          setPickerMessage('Format check cancelled');
          return;
        }
        const errorMessage = formatResult?.error?.message || 'Unknown error';
        setPickerMessage('Error loading formats');
        showModal({
          title: 'Format Fetch Failed',
          message: `Could not retrieve formats.\nError: ${errorMessage}`,
          buttons: [{ label: 'OK', primary: true }],
        });
        return;
      }

      const formats = formatResult.data.formats;
      if (!Array.isArray(formats)) throw new Error('Format metadata did not contain a list.');
      const videoFormats = formats.filter((format) => format.streamKind !== 'audio');
      const audioFormats = formats.filter((format) => format.streamKind === 'audio');
      setSelectMessage(videoSelect, 'Select Video Format');
      setSelectMessage(audioSelect, 'Select Audio Format');
      videoFormats.forEach((format) => appendFormatOption(videoSelect, format));
      audioFormats.forEach((format) => appendFormatOption(audioSelect, format));
      if (videoFormats.length === 0) setSelectMessage(videoSelect, 'No video formats found');
      if (audioFormats.length === 0) setSelectMessage(audioSelect, 'No audio formats found');
      formatState.formatSelectionsUrl = formats.length > 0 ? videoUrl : null;
    } catch (e) {
      if (!isCurrentRequest()) return;
      const errorMessage = typeof e === 'string' ? e : (e as Error)?.message || 'Unknown error';
      setPickerMessage('Error loading formats');
      showModal({
        title: 'Format Fetch Failed',
        message: `Could not retrieve formats.\nError: ${errorMessage}`,
        buttons: [{ label: 'OK', primary: true }],
      });
    } finally {
      if (isCurrentRequest()) {
        isFetchingFormats = false;
        formatRequestUrl = null;
        fetchFormatsAbort = null;
        setButtonLoading(btn, false);
      }
    }
  } catch (outerError) {
    logError('Unexpected error in fetchFormats', outerError);
    isFetchingFormats = false;
    if (btn) setButtonLoading(btn, false);
    setPickerMessage('Error loading formats');
    showModal({
      title: 'Unexpected Error',
      message: 'An unexpected error occurred while fetching formats. Please try again.',
      buttons: [{ label: 'OK', primary: true }],
    });
  }
}

// Shared with the renderer controller, which updates these while it runs.
export const formatState: {
  formatSelectionsUrl: string | null;
} = {
  formatSelectionsUrl: null,
};
