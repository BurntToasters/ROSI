import * as path from 'path';
import * as fs from 'fs';
import { BrowserWindow, dialog } from 'electron';
import log from 'electron-log/main.js';
import type { MessageBoxOptions } from 'electron';
import {
  DENO_CHECK_TIMEOUT_MS,
  DENO_INSTALL_TIMEOUT_MS,
  MAX_OUTPUT_BUFFER,
  MAX_ERROR_BUFFER,
} from './constants';
import { spawnWithEnv, isMac, isWindows } from './platform';

interface DenoInstallerCommand {
  command: string;
  args: string[];
}

export function getDenoInstallerCommand(platform: NodeJS.Platform): DenoInstallerCommand | null {
  if (platform === 'win32') {
    return {
      command: 'winget.exe',
      args: [
        'install',
        '--exact',
        '--id',
        'DenoLand.Deno',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--silent',
      ],
    };
  }
  if (platform === 'darwin') {
    return { command: 'brew', args: ['install', 'deno'] };
  }
  return null;
}

function getDenoSearchPaths(): string[] {
  if (isWindows) {
    const userProfile = process.env.USERPROFILE || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    return [
      path.join(userProfile, '.deno', 'bin', 'deno.exe'),
      path.join(localAppData, 'deno', 'bin', 'deno.exe'),
      'C:\\Program Files\\deno\\deno.exe',
      'C:\\deno\\deno.exe',
    ];
  }

  const homeDir = process.env.HOME || '';
  return [
    path.join(homeDir, '.deno', 'bin', 'deno'),
    '/usr/local/bin/deno',
    '/opt/homebrew/bin/deno',
    '/usr/bin/deno',
    '/home/linuxbrew/.linuxbrew/bin/deno',
    path.join(homeDir, '.local', 'bin', 'deno'),
  ];
}

export async function checkDenoInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    for (const denoPath of getDenoSearchPaths()) {
      if (fs.existsSync(denoPath)) {
        resolve(true);
        return;
      }
    }

    const checkCmd = isWindows ? 'where' : 'which';
    const proc = spawnWithEnv(checkCmd, ['deno']);

    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch (killErr) {
        log.warn('Error killing deno check process:', killErr);
      }
      resolve(false);
    }, DENO_CHECK_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

export async function installDeno(
  mainWindow: BrowserWindow | null
): Promise<{ success?: boolean; cancelled?: boolean; output?: string; error?: string }> {
  const parentWindow = BrowserWindow.getFocusedWindow() || mainWindow;
  const confirmOptions: MessageBoxOptions = {
    type: 'warning',
    buttons: ['Install', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'This will install Deno through your system package manager. Do you want to continue?',
  };
  const confirm = parentWindow
    ? await dialog.showMessageBox(parentWindow, confirmOptions)
    : await dialog.showMessageBox(confirmOptions);

  if (confirm.response !== 0) {
    return { cancelled: true };
  }

  const installer = getDenoInstallerCommand(isWindows ? 'win32' : isMac ? 'darwin' : 'linux');
  if (!installer) {
    return {
      success: false,
      error:
        'Automatic Deno installation is unavailable on this platform. Use the official installation instructions at https://docs.deno.com/runtime/getting_started/installation/.',
    };
  }

  return new Promise((resolve) => {
    const proc = spawnWithEnv(installer.command, installer.args);
    let output = '';
    let error = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill();
      } catch (killErr) {
        log.warn('Error killing deno install process on timeout:', killErr);
      }
      resolve({ success: false, error: 'Installation timed out after 2 minutes' });
    }, DENO_INSTALL_TIMEOUT_MS);

    proc.stdout?.on('data', (data: Buffer) => {
      if (output.length < MAX_OUTPUT_BUFFER) output += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      if (error.length < MAX_ERROR_BUFFER) error += data.toString();
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ success: true, output });
      } else {
        resolve({ success: false, error: error || output });
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      log.error('Deno install error:', err);
      resolve({ success: false, error: err.message });
    });
  });
}
