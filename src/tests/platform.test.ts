import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => path.join(os.tmpdir(), 'rosi-tests')),
    quit: vi.fn(),
  },
  dialog: {
    showErrorBox: vi.fn(),
  },
}));

vi.mock('electron-log/main', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { buildEnhancedPath, isWindows, resolveFfmpegPath } from '../main/platform';

describe('platform helpers', () => {
  const originalPath = process.env.PATH;
  const originalUserProfile = process.env.USERPROFILE;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.PATH = isWindows ? 'C:\\Windows\\System32' : '/usr/bin';
    process.env.USERPROFILE = 'C:\\Users\\Tester';
    process.env.LOCALAPPDATA = 'C:\\Users\\Tester\\AppData\\Local';
    process.env.HOME = '/home/tester';
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    process.env.USERPROFILE = originalUserProfile;
    process.env.LOCALAPPDATA = originalLocalAppData;
    process.env.HOME = originalHome;
  });

  it('builds an enhanced PATH that retains current PATH', () => {
    const enhanced = buildEnhancedPath();
    expect(enhanced).toContain(process.env.PATH || '');

    if (isWindows) {
      expect(enhanced).toContain('C:\\Program Files\\ffmpeg\\bin');
      expect(enhanced).toContain('C:\\Users\\Tester\\.deno\\bin');
      expect(enhanced.includes(';')).toBe(true);
    } else {
      expect(enhanced).toContain('/usr/local/bin');
      expect(enhanced).toContain('/home/tester/.deno/bin');
      expect(enhanced.includes(':')).toBe(true);
    }
  });

  it('resolves ffmpeg binary from a directory path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rosi-platform-'));
    try {
      const resolved = resolveFfmpegPath(tempDir);
      const expected = path.join(tempDir, isWindows ? 'ffmpeg.exe' : 'ffmpeg');
      expect(resolved).toBe(expected);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns null for empty custom path', () => {
    expect(resolveFfmpegPath(undefined)).toBeNull();
    expect(resolveFfmpegPath('')).toBeNull();
    expect(resolveFfmpegPath('   ')).toBeNull();
  });

  it('keeps explicit binary path when it exists', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rosi-platform-'));
    const binaryPath = path.join(tempDir, isWindows ? 'ffmpeg.exe' : 'ffmpeg');
    fs.writeFileSync(binaryPath, '');
    try {
      expect(resolveFfmpegPath(binaryPath)).toBe(binaryPath);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
