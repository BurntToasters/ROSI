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

export function updateConsoleVisibility(show: boolean) {
  updateConsoleOutputVisibility(show);
}

export type ToastType = 'warning' | 'error' | 'success' | 'info';

export function showToast(
  message: unknown,
  { type = 'info', duration = 4000 }: { type?: ToastType; duration?: number } = {}
) {
  showToastMessage(message, { type, duration });
}

export function appendConsoleOutput(outputEl: HTMLElement | null, text: string) {
  appendOutput(outputEl, text);
  markUnseen('console');
}

export function setButtonLoading(
  button: HTMLButtonElement | null,
  isLoading: boolean,
  onCancel?: (() => void) | null,
  cancelLabel?: string
) {
  setLoading(button, isLoading, onCancel, cancelLabel);
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
