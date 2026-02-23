import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { BrowserWindow, dialog } from 'electron';
import log from 'electron-log/main';
import type { MessageBoxOptions } from 'electron';
import { DENO_CHECK_TIMEOUT_MS, DENO_INSTALL_TIMEOUT_MS } from './constants';
import { isWindows } from './platform';

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

function buildDenoEnhancedPath(): string {
  if (isWindows) {
    const userProfile = process.env.USERPROFILE || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    return [
      path.join(userProfile, '.deno', 'bin'),
      path.join(localAppData, 'deno', 'bin'),
      'C:\\Program Files\\deno',
      'C:\\deno',
      process.env.PATH || '',
    ].join(';');
  }

  const homeDir = process.env.HOME || '';
  return [
    path.join(homeDir, '.deno', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    path.join(homeDir, '.local', 'bin'),
    process.env.PATH || '',
  ].join(':');
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
    const proc = spawn(checkCmd, ['deno'], {
      env: { ...process.env, PATH: buildDenoEnhancedPath() },
    });

    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
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
    message:
      'This will download and run the Deno installer from deno.land. Do you want to continue?',
  };
  const confirm = parentWindow
    ? await dialog.showMessageBox(parentWindow, confirmOptions)
    : await dialog.showMessageBox(confirmOptions);

  if (confirm.response !== 0) {
    return { cancelled: true };
  }

  return new Promise((resolve, reject) => {
    let installCmd: string;
    let installArgs: string[];

    if (isWindows) {
      installCmd = 'powershell.exe';
      installArgs = [
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'irm https://deno.land/install.ps1 | iex',
      ];
    } else {
      installCmd = 'sh';
      installArgs = ['-c', 'curl -fsSL https://deno.land/install.sh | sh'];
    }

    const proc = spawn(installCmd, installArgs, {
      env: { ...process.env, PATH: buildDenoEnhancedPath() },
    });
    let output = '';
    let error = '';

    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      reject({ success: false, error: 'Installation timed out after 2 minutes' });
    }, DENO_INSTALL_TIMEOUT_MS);

    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      error += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ success: true, output });
      } else {
        reject({ success: false, error: error || output });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      log.error('Deno install error:', err);
      reject({ success: false, error: err.message });
    });
  });
}
