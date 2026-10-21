// Video preview rendering and its request state.
export function formatDuration(totalSeconds: number | null | undefined) {
  if (typeof totalSeconds !== 'number' || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return '';
  }
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function formatViewCount(count: number | null | undefined) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return '';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M views`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K views`;
  return `${count} views`;
}

export interface RosiVideoInfo {
  title: string;
  uploader: string | null;
  durationSeconds: number | null;
  thumbnail: string | null;
  ext: string | null;
  viewCount: number | null;
  isPlaylist: boolean;
  playlistCount: number | null;
  webpageUrl: string | null;
}

export const MAX_PREVIEW_THUMBNAIL_BYTES = 2 * 1024 * 1024;
export const PREVIEW_THUMBNAIL_DATA_URL_PATTERN =
  /^data:image\/(?:jpeg|png|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/i;

export function isSafePreviewThumbnail(value: string | null): value is string {
  if (!value) return false;
  const encoded = PREVIEW_THUMBNAIL_DATA_URL_PATTERN.exec(value)?.[1];
  if (!encoded) return false;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const decodedBytes = (encoded.length / 4) * 3 - padding;
  return decodedBytes <= MAX_PREVIEW_THUMBNAIL_BYTES;
}

export function hideVideoPreview() {
  const card = document.getElementById('preview-card');
  const thumb = document.getElementById('preview-thumb') as HTMLImageElement | null;
  if (card) card.classList.remove('visible', 'loading', 'is-playlist');
  if (thumb) {
    thumb.removeAttribute('src');
    thumb.alt = '';
  }
}

export function renderVideoPreview(info: RosiVideoInfo) {
  const card = document.getElementById('preview-card');
  const thumb = document.getElementById('preview-thumb') as HTMLImageElement | null;
  const titleEl = document.getElementById('preview-title');
  const subEl = document.getElementById('preview-sub');
  const durationEl = document.getElementById('preview-duration');
  if (!card || !titleEl || !subEl) return;

  card.classList.remove('loading');
  card.classList.add('visible');
  card.classList.toggle('is-playlist', !!info.isPlaylist);

  titleEl.textContent = info.title || 'Untitled';

  const subParts: string[] = [];
  if (info.uploader) subParts.push(info.uploader);
  if (info.isPlaylist && info.playlistCount) {
    subParts.push(`${info.playlistCount} items`);
  } else {
    const views = formatViewCount(info.viewCount);
    if (views) subParts.push(views);
  }
  subEl.textContent = subParts.join(' • ');

  if (durationEl) {
    const duration = formatDuration(info.durationSeconds);
    durationEl.textContent = duration;
    durationEl.style.display = duration ? 'inline-block' : 'none';
  }

  if (thumb) {
    const wrap = thumb.parentElement as HTMLElement | null;
    if (isSafePreviewThumbnail(info.thumbnail)) {
      thumb.src = info.thumbnail;
      thumb.alt = info.title || 'Video thumbnail';
      if (wrap) wrap.style.display = '';
    } else {
      thumb.removeAttribute('src');
      thumb.alt = '';
      if (wrap) wrap.style.display = 'none';
    }
  }
}

// Shared with the renderer controller, which updates these while it runs.
export const previewState: {
  isFetchingPreview: unknown;
  previewAbort: (() => void) | null;
} = {
  isFetchingPreview: false,
  previewAbort: null,
};
