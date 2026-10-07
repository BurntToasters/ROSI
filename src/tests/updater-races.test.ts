import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getVersion: vi.fn(),
  check: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: mocks.getVersion }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeUpdate(version: string, target: string) {
  return {
    version,
    target,
    body: `${target} release`,
    close: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
  };
}

async function loadUpdater() {
  vi.resetModules();
  return import('../updater');
}

describe('updater check and download ownership', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.getVersion.mockReset();
    mocks.check.mockReset();
    mocks.getVersion.mockResolvedValue('5.0.0-beta.2');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'is_packaged' || command === 'is_flatpak') {
        return command === 'is_packaged';
      }
      if (command === 'get_beta_updater_target') return 'darwin-beta-aarch64-app';
      if (command === 'get_settings') return { updateChannel: 'beta' };
      return null;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores an older beta check after a newer stable target wins', async () => {
    const older = deferred<ReturnType<typeof fakeUpdate> | null>();
    const newer = deferred<ReturnType<typeof fakeUpdate> | null>();
    mocks.check.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    let settingsRead = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'is_packaged') return true;
      if (command === 'is_flatpak') return false;
      if (command === 'get_beta_updater_target') return 'darwin-beta-aarch64-app';
      if (command === 'get_settings') {
        settingsRead += 1;
        return { updateChannel: settingsRead === 1 ? 'beta' : 'stable' };
      }
      return null;
    });

    const updater = await loadUpdater();
    const statuses: Array<{ status: string; version?: string }> = [];
    updater.onUpdaterStatus((event) => statuses.push(event));
    const oldCheck = updater.checkForUpdates();
    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(1));
    const newCheck = updater.checkForUpdates();
    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(2));

    const current = fakeUpdate('5.0.0-beta.4', 'stable');
    newer.resolve(current);
    await newCheck;
    const stale = fakeUpdate('5.0.0-beta.3', 'beta');
    older.resolve(stale);
    await oldCheck;

    expect(mocks.check.mock.calls[0]?.[0]).toMatchObject({
      target: 'darwin-beta-aarch64-app',
    });
    expect(mocks.check.mock.calls[1]?.[0]).not.toHaveProperty('target');
    expect(current.close).not.toHaveBeenCalled();
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(statuses.filter((event) => event.status === 'available').at(-1)).toMatchObject({
      status: 'available',
      version: current.version,
    });

    await updater.downloadUpdate();
    expect(current.download).toHaveBeenCalledTimes(1);
  });

  it('keeps download completion and install bound to the update that started it', async () => {
    const older = deferred<ReturnType<typeof fakeUpdate> | null>();
    const newer = deferred<ReturnType<typeof fakeUpdate> | null>();
    mocks.check.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const updater = await loadUpdater();
    const oldCheck = updater.checkForUpdates();
    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(1));
    const newCheck = updater.checkForUpdates();
    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(2));

    const downloadGate = deferred<void>();
    const active = fakeUpdate('5.0.0-beta.4', 'darwin-beta-aarch64-app');
    active.download.mockImplementation(() => downloadGate.promise);
    newer.resolve(active);
    await newCheck;
    const downloading = updater.downloadUpdate();

    const stale = fakeUpdate('5.0.0-beta.3', 'darwin-beta-aarch64-app');
    older.resolve(stale);
    await oldCheck;
    downloadGate.resolve();
    await expect(downloading).resolves.toMatchObject({ success: true });
    await updater.installUpdate();

    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(stale.install).not.toHaveBeenCalled();
    expect(active.install).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('restart_app');
  });
});
