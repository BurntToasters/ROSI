// Shared text helpers for byte sizes and host names.

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Byte size as text. Empty for a missing, negative, or non-finite value. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), SIZE_UNITS.length - 1);
  // Under 1 byte the log is negative, so clamp to the first unit.
  let unit = Math.max(i, 0);
  let value = parseFloat((bytes / Math.pow(k, unit)).toFixed(2));
  // Rounding can reach the next unit (1048575 bytes is 1024.00 KB), so pick the unit after rounding.
  if (value >= k && unit < SIZE_UNITS.length - 1) {
    unit += 1;
    value = parseFloat((bytes / Math.pow(k, unit)).toFixed(2));
  }
  return value + ' ' + SIZE_UNITS[unit];
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
