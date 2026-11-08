interface UpdateProgressData {
  bytesPerSecond: number;
  percent: number;
  total: number;
  transferred: number;
}

export function formatUpdateProgressInfo(
  data: UpdateProgressData,
  formatBytes: (bytes: number) => string
) {
  const speed = formatBytes(data.bytesPerSecond) + '/s';
  const downloaded = formatBytes(data.transferred);
  const total = formatBytes(data.total);
  return `${downloaded} / ${total} (${speed}) - ${Math.round(data.percent)}%`;
}
