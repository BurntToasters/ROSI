import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const initialResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
const tempDirs: string[] = [];

function createTempResourcesPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rosi-ffmpeg-'));
  tempDirs.push(dir);
  return dir;
}

function createBinary(resourcesRoot: string, relativePath: string) {
  const fullPath = path.join(resourcesRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, '');
  if (process.platform !== 'win32') {
    fs.chmodSync(fullPath, 0o755);
  }
  return fullPath;
}

async function loadPlatformModule(resourcesPath: string) {
  vi.resetModules();

  vi.doMock('electron', () => ({
    app: {
      isPackaged: false,
      getPath: vi.fn(() => path.join(os.tmpdir(), 'rosi-tests')),
      quit: vi.fn(),
    },
    dialog: {
      showErrorBox: vi.fn(),
    },
  }));

  vi.doMock('electron-log/main.js', () => ({
    default: {
      info: vi.fn(),
      error: vi.fn(),
    },
  }));

  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = resourcesPath;
  return import('../main/platform');
}

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = initialResourcesPath;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('platform bundled ffmpeg resolution', () => {
  it('resolves bundled ffmpeg from resources/ffmpeg root', async () => {
    const resourcesPath = createTempResourcesPath();
    const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const expectedPath = createBinary(resourcesPath, path.join('ffmpeg', ffmpegName));
    const platform = await loadPlatformModule(resourcesPath);

    expect(platform.resolveBundledFfmpegPath()).toBe(expectedPath);
    expect(platform.hasBundledFfmpeg()).toBe(true);
    expect(platform.getEffectiveFfmpegPath('')).toBe(expectedPath);
  });

  it('resolves bundled ffmpeg from architecture subdirectory when supported', async () => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      return;
    }

    const resourcesPath = createTempResourcesPath();
    const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const expectedPath = createBinary(resourcesPath, path.join('ffmpeg', process.arch, ffmpegName));
    const platform = await loadPlatformModule(resourcesPath);

    expect(platform.resolveBundledFfmpegPath()).toBe(expectedPath);
    expect(platform.getEffectiveFfmpegPath('')).toBe(expectedPath);
  });

  it('resolveFfmpegLocationForYtdlp returns bundled directory for yt-dlp', async () => {
    const resourcesPath = createTempResourcesPath();
    const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const ffprobeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
    createBinary(resourcesPath, path.join('ffmpeg', ffmpegName));
    createBinary(resourcesPath, path.join('ffmpeg', ffprobeName));
    const platform = await loadPlatformModule(resourcesPath);

    expect(platform.resolveFfmpegLocationForYtdlp('')).toBe(path.join(resourcesPath, 'ffmpeg'));
  });

  it('resolveFfmpegLocationForYtdlp returns null when no bundled or custom path exists', async () => {
    const resourcesPath = createTempResourcesPath();
    fs.mkdirSync(path.join(resourcesPath, 'ffmpeg'), { recursive: true });
    const platform = await loadPlatformModule(resourcesPath);

    expect(platform.resolveFfmpegLocationForYtdlp('')).toBeNull();
    expect(platform.resolveBundledFfmpegPath()).toBeNull();
    expect(platform.hasBundledFfmpeg()).toBe(false);
    expect(platform.getEffectiveFfmpegPath('')).toBe('ffmpeg');
  });

  it('prefers custom ffmpeg path over bundled ffmpeg path', async () => {
    const resourcesPath = createTempResourcesPath();
    const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    createBinary(resourcesPath, path.join('ffmpeg', ffmpegName));
    const customPath = createBinary(resourcesPath, path.join('custom-bin', ffmpegName));
    const platform = await loadPlatformModule(resourcesPath);

    expect(platform.getEffectiveFfmpegPath(customPath)).toBe(customPath);
  });

  it('resolves relative paths to absolute via path.resolve', async () => {
    const resourcesPath = createTempResourcesPath();
    const platform = await loadPlatformModule(resourcesPath);

    const result = platform.resolveFfmpegPath('../etc/ffmpeg');
    expect(result).not.toBeNull();
    expect(path.isAbsolute(result!)).toBe(true);
    expect(result).not.toContain('..');
  });

  it('rejects null, empty, and whitespace-only custom paths', async () => {
    const resourcesPath = createTempResourcesPath();
    const platform = await loadPlatformModule(resourcesPath);

    expect(platform.resolveFfmpegPath(null)).toBeNull();
    expect(platform.resolveFfmpegPath('')).toBeNull();
    expect(platform.resolveFfmpegPath('   ')).toBeNull();
  });
});
