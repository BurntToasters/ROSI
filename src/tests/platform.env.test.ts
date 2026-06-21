import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as path from 'path';

const initialResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
const initialPlatform = process.platform;
const initialArch = process.arch;
function bundledHelperExists(
  target: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const ffmpegName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const ffprobeName = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const normalized = target.replace(/\\/g, '/');
  return (
    normalized.endsWith(`/ffmpeg/${ffmpegName}`) || normalized.endsWith(`/ffmpeg/${ffprobeName}`)
  );
}

interface PlatformEnvMocks {
  existsSyncMock: ReturnType<typeof vi.fn>;
  statSyncMock: ReturnType<typeof vi.fn>;
  chmodSyncMock: ReturnType<typeof vi.fn>;
  accessSyncMock: ReturnType<typeof vi.fn>;
  mkdirSyncMock: ReturnType<typeof vi.fn>;
  copyFileSyncMock: ReturnType<typeof vi.fn>;
  spawnMock: ReturnType<typeof vi.fn>;
  appQuitMock: ReturnType<typeof vi.fn>;
  showErrorBoxMock: ReturnType<typeof vi.fn>;
  logInfoMock: ReturnType<typeof vi.fn>;
  logWarnMock: ReturnType<typeof vi.fn>;
  logErrorMock: ReturnType<typeof vi.fn>;
}

function createProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  return proc;
}

function setProcessPlatform(platform: NodeJS.Platform, arch: NodeJS.Architecture = initialArch) {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
  Object.defineProperty(process, 'arch', {
    value: arch,
    configurable: true,
  });
}

async function loadPlatform(
  setup: (mocks: PlatformEnvMocks) => void = () => {},
  platform: NodeJS.Platform = initialPlatform,
  arch: NodeJS.Architecture = initialArch
) {
  vi.resetModules();
  setProcessPlatform(platform, arch);
  const mocks: PlatformEnvMocks = {
    existsSyncMock: vi.fn(() => false),
    statSyncMock: vi.fn(() => ({ isDirectory: () => false, mode: 0o755 })),
    chmodSyncMock: vi.fn(),
    accessSyncMock: vi.fn(),
    mkdirSyncMock: vi.fn(),
    copyFileSyncMock: vi.fn(),
    spawnMock: vi.fn(() => createProc()),
    appQuitMock: vi.fn(),
    showErrorBoxMock: vi.fn(),
    logInfoMock: vi.fn(),
    logWarnMock: vi.fn(),
    logErrorMock: vi.fn(),
  };
  setup(mocks);

  vi.doMock('fs', () => ({
    existsSync: mocks.existsSyncMock,
    statSync: mocks.statSyncMock,
    chmodSync: mocks.chmodSyncMock,
    accessSync: mocks.accessSyncMock,
    mkdirSync: mocks.mkdirSyncMock,
    copyFileSync: mocks.copyFileSyncMock,
    constants: { X_OK: 1 },
  }));

  vi.doMock('child_process', () => ({
    spawn: mocks.spawnMock,
  }));

  vi.doMock('electron', () => ({
    app: {
      isPackaged: false,
      getPath: vi.fn((name: string) => path.join('/tmp', name)),
      quit: mocks.appQuitMock,
    },
    dialog: {
      showErrorBox: mocks.showErrorBoxMock,
    },
  }));

  vi.doMock('electron-log/main.js', () => ({
    default: {
      info: mocks.logInfoMock,
      warn: mocks.logWarnMock,
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
  vi.doUnmock('os');
  vi.unstubAllEnvs();
  setProcessPlatform(initialPlatform, initialArch);
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = initialResourcesPath;
});

describe('platform env and ffmpeg verification', () => {
  it('spawnWithEnv keeps allowlisted environment and caller overrides', async () => {
    vi.stubEnv('HOME', '/home/tester');
    vi.stubEnv('PYTHONUNBUFFERED', '0');
    vi.stubEnv('SECRET_TOKEN', 'do-not-copy');
    const { mod, mocks } = await loadPlatform();

    mod.spawnWithEnv('tool', ['arg'], {
      env: { PYTHONUNBUFFERED: '1', CUSTOM_SAFE: 'yes' },
      cwd: '/work',
    });

    expect(mocks.spawnMock).toHaveBeenCalledWith(
      'tool',
      ['arg'],
      expect.objectContaining({
        cwd: '/work',
        env: expect.objectContaining({
          HOME: '/home/tester',
          PYTHONUNBUFFERED: '1',
          CUSTOM_SAFE: 'yes',
        }),
      })
    );
    const env = mocks.spawnMock.mock.calls[0]![2].env;
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(typeof env.PATH).toBe('string');
  });

  it('resolveFfmpegPath returns command names without filesystem probing', async () => {
    const { mod, mocks } = await loadPlatform();

    expect(mod.resolveFfmpegPath('ffmpeg')).toBe('ffmpeg');
    expect(mocks.existsSyncMock).not.toHaveBeenCalled();
  });

  it('resolveFfmpegPath returns fallback resolved path when stat throws', async () => {
    const { mod, mocks } = await loadPlatform((m) => {
      m.existsSyncMock.mockReturnValue(true);
      m.statSyncMock.mockImplementation(() => {
        throw new Error('stat denied');
      });
    });

    const result = mod.resolveFfmpegPath('/opt/ffmpeg');

    expect(result).toBe(path.resolve('/opt/ffmpeg'));
    expect(mocks.logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('Error resolving ffmpeg path'),
      expect.any(Error)
    );
  });

  it('resolveFfmpegPath adds exe extension on Windows when needed', async () => {
    const { mod } = await loadPlatform((m) => {
      m.existsSyncMock.mockImplementation((target: string) =>
        target.replace(/\\/g, '/').endsWith('/tools/ffmpeg.exe')
      );
    }, 'win32');

    expect(mod.resolveFfmpegPath('C:/tools/ffmpeg')?.replace(/\\/g, '/')).toBe(
      'C:/tools/ffmpeg.exe'
    );
  });

  it('getEffectiveFfmpegPath logs and falls back when custom path is missing', async () => {
    const { mod, mocks } = await loadPlatform();

    expect(mod.getEffectiveFfmpegPath('/missing/ffmpeg')).toBe('ffmpeg');
    expect(mocks.logWarnMock).toHaveBeenCalledWith(expect.stringContaining('falling back'));
  });

  it('verifyBundledFfmpeg logs when no bundled binary exists', async () => {
    const { mod, mocks } = await loadPlatform();

    mod.verifyBundledFfmpeg();

    expect(mocks.logInfoMock).toHaveBeenCalledWith(
      'No bundled ffmpeg found; will rely on system ffmpeg.'
    );
  });

  it('verifyBundledFfmpeg logs first version line on success', async () => {
    const proc = createProc();
    const { mod, mocks } = await loadPlatform((m) => {
      m.existsSyncMock.mockImplementation((target: string) => bundledHelperExists(target));
      m.spawnMock.mockReturnValue(proc);
    });

    mod.verifyBundledFfmpeg();
    proc.stdout.emit('data', Buffer.from('ffmpeg version 7.1\nmore'));
    proc.emit('close', 0);
    proc.stdout.emit('data', Buffer.from('ffprobe version 7.1\nmore'));
    proc.emit('close', 0);

    expect(mocks.logInfoMock).toHaveBeenCalledWith(
      expect.stringContaining('Bundled ffmpeg verified: ffmpeg version 7.1')
    );
    expect(mocks.spawnMock).toHaveBeenCalledTimes(2);
  });

  it('verifyBundledFfmpeg logs non-zero close and process errors', async () => {
    const proc = createProc();
    const { mod, mocks } = await loadPlatform((m) => {
      m.existsSyncMock.mockImplementation((target: string) => bundledHelperExists(target));
      m.spawnMock.mockReturnValue(proc);
    });

    mod.verifyBundledFfmpeg();
    proc.emit('close', 2);
    proc.emit('error', new Error('blocked'));
    proc.emit('close', 2);
    proc.emit('error', new Error('blocked'));

    expect(mocks.logWarnMock).toHaveBeenCalledWith(expect.stringContaining('exited with code 2'));
    expect(mocks.logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('failed to execute: blocked')
    );
  });

  it('verifyBundledFfmpeg catches spawn exceptions', async () => {
    const { mod, mocks } = await loadPlatform((m) => {
      m.existsSyncMock.mockImplementation((target: string) => bundledHelperExists(target));
      m.spawnMock.mockImplementation(() => {
        throw new Error('spawn blocked');
      });
    });

    mod.verifyBundledFfmpeg();

    expect(mocks.logWarnMock).toHaveBeenCalledWith(
      'Failed to verify bundled ffmpeg: spawn blocked'
    );
  });

  it('builds Linux enhanced PATH using home directory', async () => {
    vi.stubEnv('HOME', '/home/tester');
    vi.stubEnv('PATH', '/usr/bin');
    vi.doMock('os', () => ({
      homedir: vi.fn(() => '/home/tester'),
    }));
    const { mod } = await loadPlatform(() => {}, 'linux');

    const enhanced = mod.buildEnhancedPath().replace(/\\/g, '/');

    expect(enhanced).toContain('/home/tester/.deno/bin');
    expect(enhanced).toContain('/usr/local/bin');
    expect(enhanced).toContain('/usr/bin');
    expect(enhanced).toContain(':');
  });

  it('falls back when os.homedir throws on Linux', async () => {
    vi.stubEnv('HOME', '/fallback-home');
    vi.doMock('os', () => ({
      homedir: vi.fn(() => {
        throw new Error('homedir failed');
      }),
    }));
    const { mod } = await loadPlatform(() => {}, 'linux');

    expect(mod.buildEnhancedPath().replace(/\\/g, '/')).toContain('/fallback-home/.deno/bin');
  });

  it('uses USERPROFILE when os.homedir and HOME are unavailable', async () => {
    vi.stubEnv('HOME', '');
    vi.stubEnv('USERPROFILE', '/users/fallback');
    vi.doMock('os', () => ({
      homedir: vi.fn(() => {
        throw new Error('homedir failed');
      }),
    }));
    const { mod } = await loadPlatform(() => {}, 'linux');

    expect(mod.buildEnhancedPath().replace(/\\/g, '/')).toContain('/users/fallback/.deno/bin');
  });

  it('chmods bundled ffmpeg on Linux when not executable', async () => {
    const { mod, mocks } = await loadPlatform((m) => {
      m.existsSyncMock.mockImplementation((target: string) => bundledHelperExists(target, 'linux'));
      m.statSyncMock.mockReturnValue({ isDirectory: () => false, mode: 0o644 });
    }, 'linux');

    const resolved = mod.resolveBundledFfmpegPath();

    expect(resolved?.replace(/\\/g, '/')).toBe('/app/resources/ffmpeg/ffmpeg');
    expect(mocks.chmodSyncMock).toHaveBeenCalledWith(expect.stringContaining('ffmpeg'), 0o755);
    expect(mocks.chmodSyncMock).toHaveBeenCalledWith(expect.stringContaining('ffprobe'), 0o755);
  });

  it('copies bundled ffmpeg to temp bin when chmod and access fail on Linux', async () => {
    const { mod, mocks } = await loadPlatform((m) => {
      m.existsSyncMock.mockImplementation((target: string) => bundledHelperExists(target, 'linux'));
      m.statSyncMock.mockReturnValue({ isDirectory: () => false, mode: 0o644 });
      m.chmodSyncMock.mockImplementationOnce(() => {
        const err = new Error('readonly') as NodeJS.ErrnoException;
        err.code = 'EROFS';
        throw err;
      });
      m.accessSyncMock.mockImplementation(() => {
        throw new Error('not executable');
      });
    }, 'linux');

    const resolved = mod.resolveBundledFfmpegPath();

    expect(resolved?.replace(/\\/g, '/')).toBe('/tmp/temp/rosi-bin/ffmpeg');
    expect(mocks.mkdirSyncMock).toHaveBeenCalledWith(expect.stringContaining('rosi-bin'), {
      recursive: true,
    });
    expect(mocks.copyFileSyncMock).toHaveBeenCalledTimes(2);
    expect(mocks.chmodSyncMock).toHaveBeenCalledWith(expect.stringContaining('ffprobe'), 0o755);
  });

  it('copies bundled ffmpeg to app data bin inside Flatpak', async () => {
    vi.stubEnv('FLATPAK_ID', 'com.burnttoasters.rosi');
    const { mod, mocks } = await loadPlatform((m) => {
      m.existsSyncMock.mockImplementation((target: string) => bundledHelperExists(target, 'linux'));
      m.statSyncMock.mockReturnValue({ isDirectory: () => false, mode: 0o644 });
      m.chmodSyncMock.mockImplementationOnce(() => {
        const err = new Error('readonly') as NodeJS.ErrnoException;
        err.code = 'EROFS';
        throw err;
      });
      m.accessSyncMock.mockImplementation(() => {
        throw new Error('not executable');
      });
    }, 'linux');

    const resolved = mod.resolveBundledFfmpegPath();

    expect(resolved?.replace(/\\/g, '/')).toBe('/tmp/userData/.bin/ffmpeg');
    expect(mocks.mkdirSyncMock.mock.calls[0]?.[0].replace(/\\/g, '/')).toBe('/tmp/userData/.bin');
  });

  it('resolves bundled ffmpeg from Windows x64 fallback directory', async () => {
    const { mod } = await loadPlatform(
      (m) => {
        m.existsSyncMock.mockImplementation((target: string) => {
          const normalized = target.replace(/\\/g, '/');
          return (
            normalized.endsWith('/ffmpeg/x64') || normalized.endsWith('/ffmpeg/x64/ffmpeg.exe')
          );
        });
      },
      'win32',
      'ia32'
    );

    expect(mod.resolveBundledFfmpegPath()?.replace(/\\/g, '/')).toBe(
      '/app/resources/ffmpeg/x64/ffmpeg.exe'
    );
  });

  it('resolves bundled ffmpeg from Windows arm64 fallback directory', async () => {
    const { mod } = await loadPlatform(
      (m) => {
        m.existsSyncMock.mockImplementation((target: string) => {
          const normalized = target.replace(/\\/g, '/');
          return (
            normalized.endsWith('/ffmpeg/arm64') || normalized.endsWith('/ffmpeg/arm64/ffmpeg.exe')
          );
        });
      },
      'win32',
      'ia32'
    );

    expect(mod.resolveBundledFfmpegPath()?.replace(/\\/g, '/')).toBe(
      '/app/resources/ffmpeg/arm64/ffmpeg.exe'
    );
  });

  it('copies yt-dlp to Flatpak app data bin when bundled binary is read-only', async () => {
    vi.stubEnv('FLATPAK_ID', 'com.burnttoasters.rosi');
    const { mod, mocks } = await loadPlatform(
      (m) => {
        m.existsSyncMock.mockImplementation((target: string) =>
          target.replace(/\\/g, '/').endsWith('/assets/yt-dlp_linux')
        );
        m.chmodSyncMock.mockImplementationOnce(() => {
          const err = new Error('readonly') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        });
        m.accessSyncMock.mockImplementation(() => {
          throw new Error('not executable');
        });
      },
      'linux',
      'x64'
    );

    const resolved = mod.resolveYtdlpPath();

    expect(resolved.replace(/\\/g, '/')).toBe('/tmp/userData/.bin/yt-dlp_linux');
    expect(mocks.copyFileSyncMock).toHaveBeenCalled();
  });

  it('logs permission error when yt-dlp temp copy fails', async () => {
    const { mod, mocks } = await loadPlatform(
      (m) => {
        m.existsSyncMock.mockImplementation((target: string) =>
          target.replace(/\\/g, '/').endsWith('/assets/yt-dlp_linux')
        );
        m.chmodSyncMock.mockImplementationOnce(() => {
          const err = new Error('readonly') as NodeJS.ErrnoException;
          err.code = 'EROFS';
          throw err;
        });
        m.accessSyncMock.mockImplementation(() => {
          throw new Error('not executable');
        });
        m.copyFileSyncMock.mockImplementation(() => {
          throw new Error('copy failed');
        });
      },
      'linux',
      'x64'
    );

    mod.resolveYtdlpPath();

    expect(mocks.logErrorMock).toHaveBeenCalledWith(expect.stringContaining('copy failed'));
    expect(mocks.showErrorBoxMock).not.toHaveBeenCalled();
    expect(mocks.appQuitMock).not.toHaveBeenCalled();
  });

  it('logs permission error when yt-dlp chmod fails unexpectedly', async () => {
    const { mod, mocks } = await loadPlatform(
      (m) => {
        m.existsSyncMock.mockImplementation((target: string) =>
          target.replace(/\\/g, '/').endsWith('/assets/yt-dlp_linux')
        );
        m.chmodSyncMock.mockImplementationOnce(() => {
          const err = new Error('permission denied') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        });
      },
      'linux',
      'x64'
    );

    mod.resolveYtdlpPath();

    expect(mocks.logErrorMock).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
    expect(mocks.showErrorBoxMock).not.toHaveBeenCalled();
    expect(mocks.appQuitMock).not.toHaveBeenCalled();
  });

  it('selects platform-specific yt-dlp binary names', async () => {
    expect((await loadPlatform(() => {}, 'darwin')).mod.ytdlpBinary).toBe('yt-dlp_macos');
    expect((await loadPlatform(() => {}, 'linux', 'arm64')).mod.ytdlpBinary).toBe(
      'yt-dlp_linux_aarch64'
    );
    expect((await loadPlatform(() => {}, 'freebsd')).mod.ytdlpBinary).toBe('yt-dlp_linux');
  });

  it('logs and falls back to bundled ffmpeg path when Linux temp copy fails', async () => {
    const { mod, mocks } = await loadPlatform((m) => {
      m.existsSyncMock.mockImplementation((target: string) => {
        const normalized = target.replace(/\\/g, '/');
        return normalized.endsWith('/ffmpeg/ffmpeg');
      });
      m.statSyncMock.mockReturnValue({ isDirectory: () => false, mode: 0o644 });
      m.chmodSyncMock.mockImplementationOnce(() => {
        const err = new Error('readonly') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });
      m.accessSyncMock.mockImplementation(() => {
        throw new Error('not executable');
      });
      m.copyFileSyncMock.mockImplementation(() => {
        throw new Error('copy failed');
      });
    }, 'linux');

    const resolved = mod.resolveBundledFfmpegPath();

    expect(resolved?.replace(/\\/g, '/')).toBe('/app/resources/ffmpeg/ffmpeg');
    expect(mocks.logErrorMock).toHaveBeenCalledWith(
      'Failed to copy ffmpeg to temp for execution: copy failed'
    );
  });

  it('logs stat failures while resolving bundled ffmpeg on Linux', async () => {
    const { mod, mocks } = await loadPlatform((m) => {
      m.existsSyncMock.mockImplementation((target: string) =>
        target.replace(/\\/g, '/').endsWith('/ffmpeg/ffmpeg')
      );
      m.statSyncMock.mockImplementation(() => {
        throw new Error('stat failed');
      });
    }, 'linux');

    expect(mod.resolveBundledFfmpegPath()?.replace(/\\/g, '/')).toBe(
      '/app/resources/ffmpeg/ffmpeg'
    );
    expect(mocks.logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('statSync failed'),
      expect.any(Error)
    );
  });
});
