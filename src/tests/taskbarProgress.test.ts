import { describe, expect, it, vi, beforeEach } from 'vitest';

const setProgressBar = vi.fn();

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

describe('taskbarProgress', () => {
  beforeEach(() => {
    setProgressBar.mockClear();
  });

  it('clears progress on none', async () => {
    const win = { setProgressBar, isDestroyed: () => false };
    const { applyTaskbarProgress } = await import('../main/taskbarProgress');
    applyTaskbarProgress(win as never, 'none');
    expect(setProgressBar).toHaveBeenCalledWith(-1);
  });

  it('sets fractional progress on Windows', async () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const win = { setProgressBar, isDestroyed: () => false };
    const { applyTaskbarProgress } = await import('../main/taskbarProgress');
    applyTaskbarProgress(win as never, 0.42);
    expect(setProgressBar).toHaveBeenCalledWith(0.42);
    Object.defineProperty(process, 'platform', { value: platform });
  });

  it('no-ops on unsupported platforms', async () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const win = { setProgressBar, isDestroyed: () => false };
    const { applyTaskbarProgress } = await import('../main/taskbarProgress');
    applyTaskbarProgress(win as never, 0.5);
    expect(setProgressBar).not.toHaveBeenCalled();
    Object.defineProperty(process, 'platform', { value: platform });
  });
});
