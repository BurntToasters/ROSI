import { afterEach, describe, expect, it, vi } from 'vitest';

interface PlatformMocks {
  existsSyncMock: ReturnType<typeof vi.fn>;
  chmodSyncMock: ReturnType<typeof vi.fn>;
  accessSyncMock: ReturnType<typeof vi.fn>;
  mkdirSyncMock: ReturnType<typeof vi.fn>;
  copyFileSyncMock: ReturnType<typeof vi.fn>;
  showErrorBoxMock: ReturnType<typeof vi.fn>;
  appQuitMock: ReturnType<typeof vi.fn>;
  logInfoMock: ReturnType<typeof vi.fn>;
  logErrorMock: ReturnType<typeof vi.fn>;
}

const initialResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

async function loadPlatformModule(
  isPackaged: boolean,
  setup: (mocks: PlatformMocks) => void = () => {}
) {
  vi.resetModules();
  const mocks: PlatformMocks = {
    existsSyncMock: vi.fn(() => true),
    chmodSyncMock: vi.fn(),
    accessSyncMock: vi.fn(),
    mkdirSyncMock: vi.fn(),
    copyFileSyncMock: vi.fn(),
    showErrorBoxMock: vi.fn(),
    appQuitMock: vi.fn(),
    logInfoMock: vi.fn(),
    logErrorMock: vi.fn(),
  };
  setup(mocks);

  vi.doMock('fs', () => ({
    existsSync: mocks.existsSyncMock,
    chmodSync: mocks.chmodSyncMock,
    accessSync: mocks.accessSyncMock,
    mkdirSync: mocks.mkdirSyncMock,
    copyFileSync: mocks.copyFileSyncMock,
    constants: { X_OK: 1 },
  }));

  vi.doMock('electron', () => ({
    app: {
      isPackaged,
      getPath: vi.fn(() => '/tmp/rosi-tests'),
      quit: mocks.appQuitMock,
    },
    dialog: {
      showErrorBox: mocks.showErrorBoxMock,
    },
  }));

  vi.doMock('electron-log/main', () => ({
    default: {
      info: mocks.logInfoMock,
      error: mocks.logErrorMock,
    },
  }));

  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = '/app/resources';
  const mod = await import('../main/platform');
  return { mod, mocks };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = initialResourcesPath;
});

describe('platform resolveYtdlpPath', () => {
  it('resolves non-packaged yt-dlp path', async () => {
    const { mod } = await loadPlatformModule(false);

    const resolved = mod.resolveYtdlpPath();
    expect(resolved).toContain('assets');
    expect(resolved).toContain(mod.ytdlpBinary);
  });

  it('resolves packaged yt-dlp path from expected locations', async () => {
    const { mod, mocks } = await loadPlatformModule(true, (m) => {
      m.existsSyncMock.mockImplementation((target: string) => target.includes('assets'));
    });

    const resolved = mod.resolveYtdlpPath();
    expect(resolved.replace(/\\/g, '/')).toContain('/app/resources');
    expect(mocks.logInfoMock).toHaveBeenCalled();
  });

  it('shows missing dependency error and quits when yt-dlp is absent', async () => {
    const { mod, mocks } = await loadPlatformModule(true, (m) => {
      m.existsSyncMock.mockReturnValue(false);
    });

    const resolved = mod.resolveYtdlpPath();
    expect(resolved).toContain(mod.ytdlpBinary);
    expect(mocks.showErrorBoxMock).toHaveBeenCalledWith(
      'Missing Dependency',
      expect.stringContaining('yt-dlp binary not found')
    );
    expect(mocks.appQuitMock).toHaveBeenCalled();
  });

  it('shows permission error and quits for non-recoverable chmod failures', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const { mod, mocks } = await loadPlatformModule(false, (m) => {
      m.existsSyncMock.mockReturnValue(true);
      m.chmodSyncMock.mockImplementation(() => {
        const err = new Error('chmod failed') as NodeJS.ErrnoException;
        err.code = 'EINVAL';
        throw err;
      });
    });

    mod.resolveYtdlpPath();
    expect(mocks.showErrorBoxMock).toHaveBeenCalledWith(
      'Permission Error',
      expect.stringContaining('Failed to set executable permissions')
    );
    expect(mocks.appQuitMock).toHaveBeenCalled();
  });
});
