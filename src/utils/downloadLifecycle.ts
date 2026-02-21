import type { DownloadLifecycleState } from '../types';

export function createDownloadLifecycleState(): DownloadLifecycleState {
  return { cancelled: false, completed: false };
}

export function markDownloadCancelled(state: DownloadLifecycleState): DownloadLifecycleState {
  return {
    ...state,
    cancelled: true,
  };
}

export function shouldEmitTerminalEvent(state: DownloadLifecycleState | null) {
  return Boolean(state) && state!.completed !== true;
}

export function markTerminalEventEmitted(state: DownloadLifecycleState): DownloadLifecycleState {
  return {
    ...state,
    completed: true,
  };
}

export function classifyDownloadExit(state: DownloadLifecycleState | null, exitCode: number) {
  if (state && state.cancelled) return 'cancelled';
  return exitCode === 0 ? 'success' : 'failed';
}
