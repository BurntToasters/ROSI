// Shared text helpers for byte sizes and host names.

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Byte size as text. Empty for a missing, negative, or non-finite value. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), SIZE_UNITS.length - 1);
  // Under 1 byte the log is negative, so clamp to the first unit.
  const unit = Math.max(i, 0);
  return parseFloat((bytes / Math.pow(k, unit)).toFixed(2)) + ' ' + SIZE_UNITS[unit];
}

/** Host name of a URL, or an empty string when it is missing or does not parse. */
export function hostFromUrl(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
