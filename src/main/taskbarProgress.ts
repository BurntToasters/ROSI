import type { BrowserWindow } from 'electron';

export type TaskbarProgressMode = number | 'indeterminate' | 'none';

export function applyTaskbarProgress(
  win: BrowserWindow | null | undefined,
  mode: TaskbarProgressMode
): void {
  if (!win || win.isDestroyed()) return;
  const platform = process.platform;
  if (platform !== 'win32' && platform !== 'darwin') return;

  if (mode === 'none') {
    win.setProgressBar(-1);
    return;
  }
  if (mode === 'indeterminate') {
    win.setProgressBar(2);
    return;
  }
  const clamped = Math.max(0, Math.min(1, mode));
  win.setProgressBar(clamped);
}
