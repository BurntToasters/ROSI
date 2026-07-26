import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadSession } from '../types';

const applyTaskbarProgressMock = vi.fn();

vi.mock('../main/taskbarProgress', () => ({
  applyTaskbarProgress: (...args: unknown[]) => applyTaskbarProgressMock(...args),
}));

function createSession(): DownloadSession {
  return {
    id: 'test-session',
    sender: {
      isDestroyed: () => false,
      send: vi.fn(),
    },
    lifecycle: 'active',
    ytdlpPostprocess: false,
    ytdlpDownloadFinished: false,
    jobPhase: 'download',
  } as unknown as DownloadSession;
}

describe('JobProgressReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    applyTaskbarProgressMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clearTaskbar clears progress when enabled', async () => {
    const { JobProgressReporter } = await import('../main/download/jobProgressReporter');
    const mainWindow = {} as never;
    const reporter = new JobProgressReporter(mainWindow, { expectConvert: false }, null, true);
    reporter.clearTaskbar();
    expect(applyTaskbarProgressMock).toHaveBeenCalledWith(mainWindow, 'none');
  });

  it('clearTaskbar is a no-op when taskbar progress is disabled', async () => {
    const { JobProgressReporter } = await import('../main/download/jobProgressReporter');
    const reporter = new JobProgressReporter(null, { expectConvert: false }, null, false);
    reporter.clearTaskbar();
    expect(applyTaskbarProgressMock).not.toHaveBeenCalled();
  });

  it('throttles duplicate job-progress emissions', async () => {
    const { JobProgressReporter } = await import('../main/download/jobProgressReporter');
    const session = createSession();
    const reporter = new JobProgressReporter(null, { expectConvert: false }, null, false);

    reporter.emitDownloadComplete(session);
    reporter.emitDownloadComplete(session);

    expect(session.sender.send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    reporter.emitDownloadComplete(session);
    expect(session.sender.send).toHaveBeenCalledTimes(2);
  });

  it('sets indeterminate taskbar mode for indeterminate events', async () => {
    const { JobProgressReporter } = await import('../main/download/jobProgressReporter');
    const mainWindow = {} as never;
    const session = createSession();
    const reporter = new JobProgressReporter(mainWindow, { expectConvert: true }, null, true);

    reporter.emitPhaseIndeterminate(session, 'merge', 'Merging...');
    vi.advanceTimersByTime(250);

    expect(applyTaskbarProgressMock).toHaveBeenCalledWith(mainWindow, 'indeterminate');
  });
});
