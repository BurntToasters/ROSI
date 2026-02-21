import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { app, dialog } from 'electron';
import log from 'electron-log/main';

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';
export const isArm64 = process.arch === 'arm64';
export const isPackaged = app.isPackaged;

export function buildEnhancedPath() {
  const currentPath = process.env.PATH || '';

  if (isWindows) {
    const userProfile = process.env.USERPROFILE || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    const extraPaths = [
      path.join(userProfile, '.deno', 'bin'),
      path.join(localAppData, 'deno', 'bin'),
      'C:\\Program Files\\ffmpeg\\bin',
      'C:\\ffmpeg\\bin',
      'C:\\Program Files\\deno',
      'C:\\deno',
    ];
    return [...extraPaths, currentPath].filter(Boolean).join(';');
  }

  const homeDir = process.env.HOME || '';
  const extraPaths = [
    path.join(homeDir, '.deno', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/home/linuxbrew/.linuxbrew/bin',
    path.join(homeDir, '.local', 'bin'),
  ];

  return [...extraPaths, currentPath].filter(Boolean).join(':');
}

export function spawnWithEnv(
  command: string,
  args: string[],
  options: Record<string, unknown> = {}
) {
  const baseEnv = (options.env as Record<string, string> | undefined) || {};
  return spawn(command, args, {
    ...options,
    env: { ...process.env, ...baseEnv, PATH: buildEnhancedPath() },
  } as Parameters<typeof spawn>[2]);
}

export function resolveFfmpegPath(customPath: unknown): string | null {
  if (!customPath || typeof customPath !== 'string') return null;
  const trimmed = customPath.trim();
  if (!trimmed) return null;

  let candidate = trimmed;

  try {
    if (fs.existsSync(candidate)) {
      const stats = fs.statSync(candidate);
      if (stats.isDirectory()) {
        candidate = path.join(candidate, isWindows ? 'ffmpeg.exe' : 'ffmpeg');
      }
    } else if (isWindows && path.extname(candidate) === '') {
      const withExe = `${candidate}.exe`;
      if (fs.existsSync(withExe)) {
        candidate = withExe;
      }
    }
  } catch {
    return trimmed;
  }

  return candidate;
}

function getYtdlpBinaryName() {
  if (isWindows) return isArm64 ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe';
  if (isMac) return 'yt-dlp_macos';
  if (isLinux) return isArm64 ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  return 'yt-dlp_linux';
}

export const ytdlpBinary = getYtdlpBinaryName();

export function resolveYtdlpPath(): string {
  let resolved = '';

  if (isPackaged) {
    const possiblePaths = [
      path.join(process.resourcesPath, 'assets', ytdlpBinary),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', ytdlpBinary),
      path.join(__dirname, '..', '..', 'assets', ytdlpBinary),
    ];

    for (const tryPath of possiblePaths) {
      log.info(`Trying yt-dlp path: ${tryPath}`);
      if (fs.existsSync(tryPath)) {
        resolved = tryPath;
        log.info(`Found yt-dlp at: ${resolved}`);
        break;
      }
    }

    if (!resolved) {
      log.error(`Could not find ${ytdlpBinary} in any expected location`);
      resolved = path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', ytdlpBinary);
    }
  } else {
    resolved = path.join(__dirname, '..', '..', 'assets', ytdlpBinary);
  }

  if (!isWindows && fs.existsSync(resolved)) {
    try {
      fs.chmodSync(resolved, 0o755);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EROFS' || code === 'EACCES') {
        // RoFS check if already executable
        try {
          fs.accessSync(resolved, fs.constants.X_OK);
        } catch {
          const tmpDir = path.join(app.getPath('temp'), 'rosi-bin');
          if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
          const tmpBin = path.join(tmpDir, ytdlpBinary);
          fs.copyFileSync(resolved, tmpBin);
          fs.chmodSync(tmpBin, 0o755);
          resolved = tmpBin;
        }
      } else {
        dialog.showErrorBox(
          'Permission Error',
          `Failed to set executable permissions on yt-dlp binary at ${resolved}.\nError: ${(err as Error).message}`
        );
        app.quit();
      }
    }
  }

  if (!fs.existsSync(resolved)) {
    dialog.showErrorBox(
      'Missing Dependency',
      `yt-dlp binary not found at ${resolved}.\nPlease ensure ${ytdlpBinary} is in the application's directory.`
    );
    app.quit();
  }

  return resolved;
}
