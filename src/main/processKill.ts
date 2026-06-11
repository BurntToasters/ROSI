import { execFile } from 'child_process';
import log from 'electron-log/main.js';
import type { ChildProcess } from 'child_process';
import { isWindows } from './platform';

export function killChildProcess(proc: ChildProcess | null, label: string) {
  if (!proc || proc.killed) return;
  const pid = proc.pid;
  try {
    proc.kill('SIGTERM');
    const forceKillTimer = setTimeout(() => {
      try {
        if (!proc.killed) proc.kill('SIGKILL');
      } catch {}
      if (isWindows && pid) {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
      }
    }, 5000);
    proc.once('exit', () => clearTimeout(forceKillTimer));
  } catch (error) {
    log.error(`Error killing ${label} process:`, error);
    if (isWindows && pid) {
      try {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
      } catch {}
    }
  }
}
