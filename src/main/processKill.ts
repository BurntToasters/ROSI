import { execFile } from 'child_process';
import log from 'electron-log/main.js';
import type { ChildProcess } from 'child_process';
import { isWindows } from './platform';

export function killChildProcess(proc: ChildProcess | null, label: string) {
  if (!proc || proc.killed) return;
  const pid = proc.pid;
  try {
    if (!isWindows && pid) {
      // Try group kill first. If the process was spawned with detached:true it is
      // a process-group leader (PGID = PID), so kill(-pid) delivers the signal to
      // it AND every descendant (e.g. yt-dlp's internal merge-ffmpeg). If it was
      // NOT spawned detached its PGID ≠ pid, so kill(-pid) targets an empty group
      // and throws ESRCH harmlessly — we fall back to a direct kill.
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        proc.kill('SIGTERM');
      }
    } else {
      proc.kill('SIGTERM');
    }
    const forceKillTimer = setTimeout(() => {
      try {
        if (!proc.killed) {
          if (!isWindows && pid) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              proc.kill('SIGKILL');
            }
          } else {
            proc.kill('SIGKILL');
          }
        }
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
