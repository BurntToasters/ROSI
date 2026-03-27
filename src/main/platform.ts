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
      'C:\\Program Files\\deno',
      'C:\\deno',
    ];
    const result = [...extraPaths, currentPath].filter(Boolean).join(';');
    return result || 'C:\\Windows\\System32';
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

  const result = [...extraPaths, currentPath].filter(Boolean).join(':');
  return result || '/usr/local/bin:/usr/bin:/bin';
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
  if (
    !path.isAbsolute(trimmed) &&
    !trimmed.includes(path.sep) &&
    !trimmed.includes('/') &&
    !trimmed.includes('\\')
  ) {
    return trimmed;
  }

  const resolved = path.resolve(trimmed);

  let candidate = resolved;

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
  } catch (err) {
    log.warn(`Error resolving ffmpeg path for '${trimmed}':`, err);
    return resolved;
  }

  return candidate;
}

function ensureExecutable(filePath: string): string {
  if (isWindows) return filePath;

  try {
    const stats = fs.statSync(filePath);
    const isExec = (stats.mode & 0o111) !== 0;

    if (!isExec) {
      try {
        fs.chmodSync(filePath, stats.mode | 0o755);
      } catch (chmodErr) {
        const code = (chmodErr as NodeJS.ErrnoException).code;
        if (code === 'EROFS' || code === 'EACCES') {
          try {
            fs.accessSync(filePath, fs.constants.X_OK);
          } catch {
            try {
              const binaryName = path.basename(filePath);
              const isFlatpak = Boolean(process.env.FLATPAK_ID);
              const binDir = isFlatpak
                ? path.join(app.getPath('userData'), '.bin')
                : path.join(app.getPath('temp'), 'rosi-bin');
              if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
              const tmpBin = path.join(binDir, binaryName);
              fs.copyFileSync(filePath, tmpBin);
              fs.chmodSync(tmpBin, 0o755);
              return tmpBin;
            } catch (copyErr) {
              log.error(
                `Failed to copy ffmpeg to temp for execution: ${(copyErr as Error).message}`
              );
            }
          }
        }
      }
    }
  } catch (statErr) {
    log.warn(`statSync failed for ${filePath}:`, statErr);
  }

  return filePath;
}

function getBundledFfmpegDir(): string | null {
  if (typeof process.resourcesPath !== 'string') return null;

  const baseDir = path.join(process.resourcesPath, 'ffmpeg');
  const ffmpegName = isWindows ? 'ffmpeg.exe' : 'ffmpeg';

  if (fs.existsSync(path.join(baseDir, ffmpegName))) {
    return baseDir;
  }

  if (isMac || isWindows) {
    const archDir = path.join(baseDir, process.arch);
    if (fs.existsSync(archDir)) return archDir;
    const x64Dir = path.join(baseDir, 'x64');
    if (process.arch === 'x64' && fs.existsSync(x64Dir)) return x64Dir;
    const arm64Dir = path.join(baseDir, 'arm64');
    if (process.arch === 'arm64' && fs.existsSync(arm64Dir)) return arm64Dir;
  }

  if (fs.existsSync(baseDir)) return baseDir;
  return null;
}

let cachedBundledFfmpegPath: string | null | undefined;

export function resolveBundledFfmpegPath(): string | null {
  if (cachedBundledFfmpegPath !== undefined) return cachedBundledFfmpegPath;

  const bundledDir = getBundledFfmpegDir();
  if (bundledDir) {
    const ext = isWindows ? '.exe' : '';
    const bundledPath = path.join(bundledDir, `ffmpeg${ext}`);
    if (fs.existsSync(bundledPath)) {
      const effectivePath = ensureExecutable(bundledPath);
      cachedBundledFfmpegPath = effectivePath;
      log.info(`Resolved bundled ffmpeg at: ${effectivePath}`);
      return effectivePath;
    }
  }

  cachedBundledFfmpegPath = null;
  return null;
}

export function getEffectiveFfmpegPath(customPath?: string | null): string {
  const resolved = resolveFfmpegPath(customPath);
  if (resolved) {
    const pathLike =
      path.isAbsolute(resolved) ||
      resolved.includes(path.sep) ||
      resolved.includes('/') ||
      resolved.includes('\\');
    if (!pathLike || fs.existsSync(resolved)) {
      return resolved;
    }
    log.warn(`Custom ffmpeg path does not exist, falling back: ${resolved}`);
  }

  const bundled = resolveBundledFfmpegPath();
  if (bundled) return bundled;

  return 'ffmpeg';
}

export function hasBundledFfmpeg(): boolean {
  return resolveBundledFfmpegPath() !== null;
}

export function verifyBundledFfmpeg(): void {
  const ffmpegPath = resolveBundledFfmpegPath();
  if (!ffmpegPath) {
    log.info('No bundled ffmpeg found; will rely on system ffmpeg.');
    return;
  }

  try {
    const proc = spawnWithEnv(ffmpegPath, ['-version'], { shell: false });
    let output = '';
    proc.stdout?.on('data', (data: Buffer) => {
      if (output.length < 512) output += data.toString();
    });
    proc.on('close', (code: number | null) => {
      if (code === 0 && output) {
        const firstLine = output.split('\n')[0]?.trim() ?? '';
        log.info(`Bundled ffmpeg verified: ${firstLine}`);
      } else {
        log.warn(`Bundled ffmpeg at ${ffmpegPath} exited with code ${code}`);
      }
    });
    proc.on('error', (err: Error) => {
      log.warn(`Bundled ffmpeg at ${ffmpegPath} failed to execute: ${err.message}`);
    });
  } catch (err) {
    log.warn(`Failed to verify bundled ffmpeg: ${(err as Error).message}`);
  }
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
          try {
            const isFlatpak = Boolean(process.env.FLATPAK_ID);
            const binDir = isFlatpak
              ? path.join(app.getPath('userData'), '.bin')
              : path.join(app.getPath('temp'), 'rosi-bin');
            if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
            const tmpBin = path.join(binDir, ytdlpBinary);
            fs.copyFileSync(resolved, tmpBin);
            fs.chmodSync(tmpBin, 0o755);
            resolved = tmpBin;
          } catch (copyErr) {
            dialog.showErrorBox(
              'Permission Error',
              `Failed to prepare yt-dlp for execution at ${resolved}.\nError: ${(copyErr as Error).message}`
            );
            app.quit();
          }
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
