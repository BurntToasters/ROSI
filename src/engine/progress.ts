// Download progress bar, phase display, and manual download state.
import { RosiJobProgressEvent, downloadsModule, renderStatusText } from './core';
import { showToast } from './ui-helpers';

export function setProgressPhase(phase: string) {
  const phases = document.querySelectorAll<HTMLElement>('.progress-phase');
  const phaseOrder = ['download', 'merge', 'convert'];
  const phaseIndex = phaseOrder.indexOf(phase);

  phases.forEach((el) => {
    const elPhase = el.dataset.phase ?? '';
    const elIndex = phaseOrder.indexOf(elPhase);
    el.classList.remove('active', 'completed');
    el.removeAttribute('aria-current');
    if (elIndex < phaseIndex) {
      el.classList.add('completed');
    } else if (elIndex === phaseIndex) {
      el.classList.add('active');
      el.setAttribute('aria-current', 'step');
    }
  });
}

export function configureProgressPhases(showMerge: boolean, showConvert: boolean) {
  const mergePhase = document.querySelector<HTMLElement>('.progress-phase[data-phase="merge"]');
  const convertPhase = document.querySelector<HTMLElement>('.progress-phase[data-phase="convert"]');
  const connectors = document.querySelectorAll<HTMLElement>('.progress-phase-connector');

  const setPhaseVisibility = (phaseEl: HTMLElement | null, visible: boolean) => {
    if (!phaseEl) return;
    phaseEl.style.display = visible ? 'flex' : 'none';
    phaseEl.setAttribute('aria-hidden', String(!visible));
  };

  setPhaseVisibility(mergePhase, showMerge);
  setPhaseVisibility(convertPhase, showConvert);

  if (connectors[0]) {
    connectors[0].style.display = showMerge ? 'block' : 'none';
    connectors[0].setAttribute('aria-hidden', String(!showMerge));
  }
  if (connectors[1]) {
    const connectorVisible = showMerge && showConvert ? true : showConvert;
    connectors[1].style.display = connectorVisible ? 'block' : 'none';
    connectors[1].setAttribute('aria-hidden', String(!connectorVisible));
  }
}

export function showProgressComplete() {
  const icon = document.getElementById('progress-complete-icon');
  if (icon) icon.classList.add('visible');
}

export function hideProgressComplete() {
  const icon = document.getElementById('progress-complete-icon');
  if (icon) icon.classList.remove('visible');
}

export function showProgressBar(status = 'Downloading...') {
  const container = document.getElementById('progress-container');
  const statusEl = document.getElementById('progress-status');
  const percentEl = document.getElementById('progress-percent');
  const bar = document.getElementById('progress-bar') as HTMLElement | null;
  const barWrapper = document.getElementById('progress-bar-wrapper');
  const details = document.getElementById('progress-details');

  if (container) {
    container.classList.add('visible');
  }
  if (statusEl) renderStatusText(statusEl, status);
  if (percentEl) percentEl.textContent = '0%';
  if (bar) {
    bar.style.width = '0%';
    bar.classList.remove('indeterminate');
    bar.classList.add('active-glow');
  }
  if (barWrapper) {
    barWrapper.setAttribute('aria-valuenow', '0');
    barWrapper.removeAttribute('aria-valuetext');
  }
  if (details) details.textContent = '';
  hideProgressComplete();
  setProgressPhase('download');
}

export function updateProgressBar(
  percent: number,
  statusText: string | null = null,
  detailsText: string | null = null
) {
  const statusEl = document.getElementById('progress-status');
  const percentEl = document.getElementById('progress-percent');
  const bar = document.getElementById('progress-bar') as HTMLElement | null;
  const barWrapper = document.getElementById('progress-bar-wrapper');
  const details = document.getElementById('progress-details');

  const clamped = Math.max(0, Math.min(100, percent));
  const rounded = Math.round(clamped);
  if (percentEl) percentEl.textContent = `${rounded}%`;
  if (bar) {
    bar.style.width = `${clamped}%`;
    bar.classList.remove('indeterminate');
  }
  if (barWrapper) {
    barWrapper.setAttribute('aria-valuenow', String(rounded));
    barWrapper.removeAttribute('aria-valuetext');
  }
  if (statusText && statusEl) renderStatusText(statusEl, statusText);
  if (detailsText && details) details.textContent = detailsText;
}

export function setProgressIndeterminate(status = 'Processing...') {
  const statusEl = document.getElementById('progress-status');
  const percentEl = document.getElementById('progress-percent');
  const bar = document.getElementById('progress-bar');
  const barWrapper = document.getElementById('progress-bar-wrapper');
  const details = document.getElementById('progress-details');

  if (statusEl) renderStatusText(statusEl, status);
  if (percentEl) percentEl.textContent = '';
  if (bar) bar.classList.add('indeterminate');
  if (barWrapper) {
    barWrapper.removeAttribute('aria-valuenow');
    barWrapper.setAttribute('aria-valuetext', status);
  }
  if (details) details.textContent = '';
}

export function applyJobProgress(event: RosiJobProgressEvent) {
  if (event.phase && event.phase !== 'idle') {
    setProgressPhase(event.phase);
  }
  if (event.indeterminate) {
    setProgressIndeterminate(event.status);
    return;
  }
  const displayPercent = Number.isFinite(event.overallPercent)
    ? event.overallPercent
    : (event.phasePercent ?? 0);
  updateProgressBar(displayPercent, event.status, event.details ?? null);
}

export function hideProgressBar() {
  const container = document.getElementById('progress-container');
  const bar = document.getElementById('progress-bar');
  const barWrapper = document.getElementById('progress-bar-wrapper');
  if (container) {
    container.classList.remove('visible');
  }
  if (bar) bar.classList.remove('active-glow');
  if (barWrapper) {
    barWrapper.setAttribute('aria-valuenow', '0');
  }
  hideProgressComplete();
}

export function formatBytes(bytes: number) {
  if (downloadsModule && typeof downloadsModule.formatBytes === 'function') {
    return downloadsModule.formatBytes(bytes);
  }
  return String(bytes);
}

export function formatRelativeTime(timestamp: number) {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** Opening a folder can fail (moved file, unmounted volume); surface that. */
export async function revealFileLocation(filePath: string) {
  try {
    const result = await window.api.openFileLocation(filePath);
    if (!result || !result.ok) {
      showToast(result?.error?.message || 'Could not open that file location.', {
        type: 'warning',
      });
    }
  } catch {
    showToast('Could not open that file location.', { type: 'warning' });
  }
}

// Shared with the renderer controller, which updates these while it runs.
export const downloadState: {
  isDownloading: unknown;
  downloadAbort: (() => void) | null;
  lastDownloadedFilePath: string | null;
} = {
  isDownloading: false,
  downloadAbort: null,
  lastDownloadedFilePath: null,
};
