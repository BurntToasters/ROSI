// Toasts, console output, sidebar, and button state helpers.
import {
  appendConsoleOutput as appendOutput,
  closeSidebar as closeSidebarPanel,
  setButtonLoading as setLoading,
  showToast as showToastMessage,
  toggleAdvancedUI as toggleAdvancedPanel,
  toggleSidebar as toggleSidebarPanel,
  updateConsoleVisibility as updateConsoleOutputVisibility,
} from '../modules/ui';
import { markUnseen } from '../modules/dock';
import { api } from '../api';

export function updateConsoleVisibility(show: boolean) {
  updateConsoleOutputVisibility(show);
}

export type ToastType = 'warning' | 'error' | 'success' | 'info';

// The duration is passed only when the caller sets it, so the toast module's
// per-type default (longer for errors and warnings) still applies.
export function showToast(
  message: unknown,
  { type = 'info', duration }: { type?: ToastType; duration?: number } = {}
) {
  showToastMessage(message, duration === undefined ? { type } : { type, duration });
}

/** Opens a link outside the app. A failure is logged and shown as an error toast. */
export async function openExternalLink(url: string, what: string) {
  let failure: string | null = null;
  try {
    const result = await api.openExternal(url);
    if (result && result.ok === false) failure = result.error?.message ?? 'refused';
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (failure === null) return;
  api.logError(`Could not open ${what}: ${failure}`);
  showToast(`Could not open ${what}.`, { type: 'error' });
}

export function appendConsoleOutput(outputEl: HTMLElement | null, text: string) {
  appendOutput(outputEl, text);
  markUnseen('console');
}

export function setButtonLoading(
  button: HTMLButtonElement | null,
  isLoading: boolean,
  onCancel?: (() => void) | null,
  cancelLabel?: string,
  cancelText?: string
) {
  setLoading(button, isLoading, onCancel, cancelLabel, cancelText);
}

export function toggleSidebar() {
  toggleSidebarPanel();
}

export function closeSidebar() {
  closeSidebarPanel();
}
export function toggleAdvancedUI(show: boolean) {
  toggleAdvancedPanel(show);
}
