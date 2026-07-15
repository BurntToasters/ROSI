import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';

const { execFileMock, platformState, logErrorMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  platformState: { isWindows: false },
  logErrorMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('../main/platform', () => ({
  get isWindows() {
    return platformState.isWindows;
  },
}));

vi.mock('electron-log/main.js', () => ({
  default: {
    error: logErrorMock,
  },
}));

import { killChildProcess } from '../main/processKill';

function createProc(pid = 4242) {
  const proc = new EventEmitter() as ChildProcess & {
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.pid = pid;
  proc.killed = false;
  proc.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === 'SIGKILL') {
      proc.killed = true;
    }
  });
  return proc;
}

describe('killChildProcess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    platformState.isWindows = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no-ops for null or already killed processes', () => {
    const proc = createProc();
    proc.killed = true;
    killChildProcess(null, 'yt-dlp');
    killChildProcess(proc, 'yt-dlp');
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('sends SIGTERM and schedules SIGKILL after 5 seconds', () => {
    const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const proc = createProc();
    try {
      killChildProcess(proc, 'yt-dlp');

      expect(processKillSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(proc.kill).not.toHaveBeenCalledWith('SIGTERM');
      expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL');

      vi.advanceTimersByTime(5000);
      expect(processKillSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
      expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL');
    } finally {
      processKillSpy.mockRestore();
    }
  });

  it('falls back to direct POSIX kills when process-group signals fail', () => {
    const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('missing process group');
    });
    const proc = createProc();
    try {
      killChildProcess(proc, 'yt-dlp');

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      vi.advanceTimersByTime(5000);
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      processKillSpy.mockRestore();
    }
  });

  it('clears the force-kill timer when the process exits', () => {
    const proc = createProc();
    killChildProcess(proc, 'yt-dlp');

    proc.emit('exit', 0);
    vi.advanceTimersByTime(5000);

    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('uses taskkill on Windows when force-kill is needed', () => {
    platformState.isWindows = true;
    const proc = createProc(9001);
    killChildProcess(proc, 'ffmpeg');

    vi.advanceTimersByTime(5000);

    expect(execFileMock).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '9001', '/T', '/F'],
      expect.any(Function)
    );
  });

  it('logs and falls back to taskkill on Windows when SIGTERM throws', () => {
    platformState.isWindows = true;
    const proc = createProc(9002);
    proc.kill = vi.fn(() => {
      throw new Error('kill failed');
    });

    killChildProcess(proc, 'yt-dlp');

    expect(logErrorMock).toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '9002', '/T', '/F'],
      expect.any(Function)
    );
  });
});
