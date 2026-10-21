// Custom-profile format listing and its request state.
import { isValidUrl, logError } from './core';
import { showModal } from './overlays';
import { setButtonLoading } from './ui-helpers';

export let isFetchingFormats = false;
export let fetchFormatsAbort: (() => void) | null = null;

export let formatRequestGeneration = 0;
export let formatRequestUrl: string | null = null;

export function clearAdvancedFormatSelections() {
  const videoSelect = document.getElementById('videoFormat') as HTMLSelectElement | null;
  const audioSelect = document.getElementById('audioFormat') as HTMLSelectElement | null;
  if (videoSelect) videoSelect.innerHTML = '<option value="">Select Video Format</option>';
  if (audioSelect) audioSelect.innerHTML = '<option value="">Select Audio Format</option>';
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

    // Validate URL format
    if (!isValidUrl(videoUrl)) {
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
      clearAdvancedFormatSelections();
      setButtonLoading(btn, false);
    };
    setButtonLoading(
      btn,
      true,
      () => {
        if (window.api.cancelFormats) {
          window.api.cancelFormats();
        }
        fetchFormatsAbort?.();
      },
      'Cancel format check'
    );
    const videoSelect = document.getElementById('videoFormat') as HTMLSelectElement | null;
    const audioSelect = document.getElementById('audioFormat') as HTMLSelectElement | null;
    if (videoSelect) videoSelect.innerHTML = '<option value="">Loading...</option>';
    if (audioSelect) audioSelect.innerHTML = '<option value="">Loading...</option>';
    try {
      const formatResult = await window.api.getFormats(videoUrl);
      if (wasCancelled || !isCurrentRequest()) return;
      if (!formatResult || formatResult.ok !== true) {
        const errorMessage = formatResult?.error?.message || 'Unknown error';
        const cancelled =
          wasCancelled ||
          (typeof errorMessage === 'string' && errorMessage.toLowerCase().includes('cancel'));
        if (cancelled) return;
        if (videoSelect) videoSelect.innerHTML = '<option value="">Error loading formats</option>';
        if (audioSelect) audioSelect.innerHTML = '<option value="">Error loading formats</option>';
        showModal({
          title: 'Format Fetch Failed',
          message: `Could not retrieve formats.\nError: ${errorMessage}`,
          buttons: [{ label: 'OK', primary: true }],
        });
        return;
      }

      const lines = formatResult.data.split('\n');
      if (videoSelect) videoSelect.innerHTML = '<option value="">Select Video Format</option>';
      if (audioSelect) audioSelect.innerHTML = '<option value="">Select Audio Format</option>';
      let videoFormatsFound = 0,
        audioFormatsFound = 0;
      const FORMAT_ID = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+\S/;
      lines.forEach((line) => {
        const trimmed = line.trim();
        const idMatch = trimmed.match(FORMAT_ID);
        if (!idMatch) return;
        const formatId = idMatch[1];
        if (!formatId || formatId.toLowerCase() === 'id') return;
        if (/storyboard|images? only|mhtml/i.test(line)) return;
        const option = document.createElement('option');
        option.value = formatId;
        const labelText = trimmed;
        const resolutionMatch = labelText.match(/(\d{3,4}x\d{3,4}|\d{3,4}p)/);
        const fpsMatch = labelText.match(/@?\s*(\d+)\s*fps/i);
        const sizeMatch = labelText.match(/(\d+(\.\d+)?(MiB|GiB|KiB))/);
        const codecMatch = line.match(
          /(avc1|vp9|vp09|av01|h264|h265|hevc|opus|mp4a|aac|vorbis|flac)/i
        );
        let cleanLabel = `ID: ${formatId}`;
        if (resolutionMatch) cleanLabel += ` ${resolutionMatch[0]}`;
        if (fpsMatch) cleanLabel += ` ${fpsMatch[1]}fps`;
        if (codecMatch) cleanLabel += ` (${codecMatch[0]})`;
        if (sizeMatch) cleanLabel += ` ~${sizeMatch[0]}`;
        option.text = cleanLabel;
        option.title = trimmed;
        const isVideoOnly = /video only/i.test(line);
        const isAudioOnly = /audio only/i.test(line);
        if (isAudioOnly) {
          if (audioSelect) audioSelect.appendChild(option);
          audioFormatsFound++;
        } else {
          // Video-only streams and combined video+audio formats. Combined
          // formats (common on sites with a single file) carry no marker.
          if (!isVideoOnly) option.text += ' (video + audio)';
          if (videoSelect) videoSelect.appendChild(option);
          videoFormatsFound++;
        }
      });
      if (videoFormatsFound === 0 && videoSelect)
        videoSelect.innerHTML = '<option value="">No video formats found</option>';
      if (audioFormatsFound === 0 && audioSelect)
        audioSelect.innerHTML = '<option value="">No audio formats found</option>';
      formatState.formatSelectionsUrl = videoUrl;
    } catch (e) {
      if (!isCurrentRequest()) return;
      const errorMessage = typeof e === 'string' ? e : (e as Error)?.message || 'Unknown error';
      if (videoSelect) videoSelect.innerHTML = '<option value="">Error loading formats</option>';
      if (audioSelect) audioSelect.innerHTML = '<option value="">Error loading formats</option>';
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
