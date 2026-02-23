import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const { existsSyncMock, spawnMock, showMessageBoxMock, getFocusedWindowMock, logErrorMock } =
  vi.hoisted(() => {
    return {
      existsSyncMock: vi.fn(),
      spawnMock: vi.fn(),
      showMessageBoxMock: vi.fn(),
      getFocusedWindowMock: vi.fn(),
      logErrorMock: vi.fn(),
    };
  });

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: getFocusedWindowMock,
  },
  dialog: {
    showMessageBox: showMessageBoxMock,
  },
}));

vi.mock('../main/platform', () => ({
  isWindows: process.platform === 'win32',
}));

vi.mock('electron-log/main', () => ({
  default: {
    error: logErrorMock,
  },
}));

import { checkDenoInstalled, installDeno } from '../main/deno';

function createProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

describe('deno helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFocusedWindowMock.mockReturnValue(null);
    showMessageBoxMock.mockResolvedValue({ response: 0 });
  });

  it('returns true when deno binary exists in known paths', async () => {
    existsSyncMock.mockReturnValue(true);
    const installed = await checkDenoInstalled();
    expect(installed).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('falls back to shell lookup for deno presence', async () => {
    existsSyncMock.mockReturnValue(false);
    const proc = createProc();
    spawnMock.mockReturnValue(proc);

    const pending = checkDenoInstalled();
    proc.emit('close', 0);
    const installed = await pending;

    expect(installed).toBe(true);
    expect(spawnMock).toHaveBeenCalled();
  });

  it('returns cancelled when user declines deno install', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 });
    const result = await installDeno(null);
    expect(result).toEqual({ cancelled: true });
  });

  it('shows install dialog without parent window when none is available', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 });
    await installDeno(null);

    expect(showMessageBoxMock).toHaveBeenCalledTimes(1);
    const call = showMessageBoxMock.mock.calls[0];
    expect(call).toHaveLength(1);
    expect(call[0]).toMatchObject({ type: 'warning' });
  });

  it('shows install dialog with focused parent window when available', async () => {
    const focusedWindow = {} as any;
    getFocusedWindowMock.mockReturnValue(focusedWindow);
    showMessageBoxMock.mockResolvedValue({ response: 1 });
    await installDeno(null);

    expect(showMessageBoxMock).toHaveBeenCalledTimes(1);
    const call = showMessageBoxMock.mock.calls[0];
    expect(call).toHaveLength(2);
    expect(call[0]).toBe(focusedWindow);
    expect(call[1]).toMatchObject({ type: 'warning' });
  });

  it('resolves with success payload when installer exits successfully', async () => {
    const proc = createProc();
    spawnMock.mockReturnValue(proc);

    const pending = installDeno(null);
    await Promise.resolve();
    proc.stdout.emit('data', Buffer.from('install complete'));
    proc.emit('close', 0);

    await expect(pending).resolves.toMatchObject({
      success: true,
      output: 'install complete',
    });
  });

  it('rejects with installer error output when installer exits non-zero', async () => {
    const proc = createProc();
    spawnMock.mockReturnValue(proc);

    const pending = installDeno(null);
    await Promise.resolve();
    proc.stderr.emit('data', Buffer.from('error output'));
    proc.emit('close', 1);

    await expect(pending).rejects.toMatchObject({
      success: false,
      error: 'error output',
    });
  });
});
