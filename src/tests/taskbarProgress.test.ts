import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setProgressBar = vi.fn();

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

describe('taskbarProgress', () => {
  const originalPlatform = process.platform;

  function setPlatform(value: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value });
  }

  beforeEach(() => {
    setProgressBar.mockClear();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('clears progress on none', async () => {
    setPlatform('win32');
    const win = { setProgressBar, isDestroyed: () => false };
    const { applyTaskbarProgress } = await import('../main/taskbarProgress');
    applyTaskbarProgress(win as never, 'none');
    expect(setProgressBar).toHaveBeenCalledWith(-1);
  });

  it('sets fractional progress on Windows', async () => {
    setPlatform('win32');
    const win = { setProgressBar, isDestroyed: () => false };
    const { applyTaskbarProgress } = await import('../main/taskbarProgress');
    applyTaskbarProgress(win as never, 0.42);
    expect(setProgressBar).toHaveBeenCalledWith(0.42);
    applyTaskbarProgress(win as never, 1.8);
    expect(setProgressBar).toHaveBeenCalledWith(1);
    applyTaskbarProgress(win as never, -0.2);
    expect(setProgressBar).toHaveBeenCalledWith(0);
  });

  it('sets progress on macOS', async () => {
    setPlatform('darwin');
    const win = { setProgressBar, isDestroyed: () => false };
    const { applyTaskbarProgress } = await import('../main/taskbarProgress');
    applyTaskbarProgress(win as never, 'indeterminate');
    expect(setProgressBar).toHaveBeenCalledWith(2);
  });

  it('no-ops on unsupported platforms', async () => {
    setPlatform('linux');
    const win = { setProgressBar, isDestroyed: () => false };
    const { applyTaskbarProgress } = await import('../main/taskbarProgress');
    applyTaskbarProgress(win as never, 0.5);
    expect(setProgressBar).not.toHaveBeenCalled();
    applyTaskbarProgress(win as never, 'none');
    expect(setProgressBar).not.toHaveBeenCalled();
  });

  it('no-ops when the window is missing or destroyed', async () => {
    setPlatform('win32');
    const { applyTaskbarProgress } = await import('../main/taskbarProgress');
    applyTaskbarProgress(null, 0.4);
    applyTaskbarProgress(undefined, 0.4);
    applyTaskbarProgress({ setProgressBar, isDestroyed: () => true } as never, 0.4);
    expect(setProgressBar).not.toHaveBeenCalled();
  });
});
