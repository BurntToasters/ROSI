// Settings state, change tracking, and serialized saves to the backend.
import { RosiDownloadPreset, RosiSettings, logError } from './core';
import { showModal } from './overlays';
import { downloadState } from './progress';
import { queueController } from './queue-controller';
import { showRestartFailure } from './updater-ui';

export const trackSettings = (value: RosiSettings): RosiSettings =>
  new Proxy(value, {
    set(target, property, next, receiver) {
      const previous = Reflect.get(target, property, receiver);
      const applied = Reflect.set(target, property, next, receiver);
      if (applied && !settingsStore.reconcilingSettings && !Object.is(previous, next)) {
        settingsStore.settingsRevision += 1;
      }
      return applied;
    },
    deleteProperty(target, property) {
      const existed = Object.prototype.hasOwnProperty.call(target, property);
      const applied = Reflect.deleteProperty(target, property);
      if (applied && existed && !settingsStore.reconcilingSettings)
        settingsStore.settingsRevision += 1;
      return applied;
    },
  });

export const reconcileSettingsInPlace = (value: RosiSettings) => {
  const current = settingsStore.settings as unknown as Record<string, unknown>;
  const next = value as unknown as Record<string, unknown>;
  settingsStore.reconcilingSettings = true;
  try {
    Object.keys(current).forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(next, key)) delete current[key];
    });
    Object.assign(current, next);
  } finally {
    settingsStore.reconcilingSettings = false;
  }
};

export function showSettingsSaveError(message: string) {
  const now = Date.now();
  if (now - settingsStore.settingsSaveErrorShownAt < 5000) {
    return;
  }
  settingsStore.settingsSaveErrorShownAt = now;
  showModal({
    title: 'Settings Save Failed',
    message,
    buttons: [{ label: 'OK', primary: true }],
    priority: true,
  });
}

export function settleSettingsSaveWaiters(
  revision: number,
  saved: boolean,
  latestRevision: number
) {
  const settled: typeof settingsStore.settingsSaveWaiters = [];
  const remaining: typeof settingsStore.settingsSaveWaiters = [];
  settingsStore.settingsSaveWaiters.forEach((waiter) => {
    if (waiter.revision > revision) {
      remaining.push(waiter);
    } else if (waiter.immediate && latestRevision > revision) {
      // Lifecycle callers need the latest revision, even if their original
      // snapshot succeeded while a newer edit was waiting behind it.
      waiter.revision = latestRevision;
      remaining.push(waiter);
    } else {
      settled.push(waiter);
    }
  });
  settingsStore.settingsSaveWaiters = remaining;
  settled.forEach((waiter) => waiter.resolve(saved));
  return settled;
}

export function settingsValuesMatch(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => settingsValuesMatch(value, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        settingsValuesMatch(leftRecord[key], rightRecord[key])
    )
  );
}

export async function drainSettingsSaves() {
  if (settingsStore.settingsSaveInFlight || settingsStore.settingsSaveWaiters.length === 0) return;
  settingsStore.settingsSaveInFlight = true;
  const snapshotRevision = settingsStore.settingsRevision;
  const snapshot = JSON.parse(JSON.stringify(settingsStore.settings)) as RosiSettings;
  let saved = false;
  let errorMessage = 'Could not save settings due to an unexpected error.';

  let rejectedMessage: string | null = null;
  try {
    const result = await window.api.saveSettings(
      snapshot as unknown as Parameters<typeof window.api.saveSettings>[0]
    );
    if (result?.ok === true) {
      saved = true;
      settingsStore.lastSettingsSaveErrorCode = null;
      // The backend may normalize values. Reconcile only if this immutable
      // snapshot is still the newest renderer revision.
      if (snapshotRevision === settingsStore.settingsRevision) {
        reconcileSettingsInPlace(result.data as RosiSettings);
      }
    } else if (result?.error?.code === 'VALIDATION_ERROR' && result.error.details) {
      // The other fields were saved; only the listed ones were refused.
      // Restore those from disk so they are not sent again on every save.
      const refused = JSON.parse(result.error.details) as string[];
      const stored = (await window.api.getSettings()) as unknown as Record<string, unknown>;
      const current = settingsStore.settings as unknown as Record<string, unknown>;
      const rejectedSnapshot = snapshot as unknown as Record<string, unknown>;
      settingsStore.reconcilingSettings = true;
      try {
        refused.forEach((key) => {
          if (
            key in stored &&
            key in rejectedSnapshot &&
            settingsValuesMatch(current[key], rejectedSnapshot[key])
          ) {
            current[key] = stored[key];
          }
        });
      } finally {
        settingsStore.reconcilingSettings = false;
      }
      settingsStore.refreshSettingsControls?.();
      saved = true;
      settingsStore.lastSettingsSaveErrorCode = null;
      rejectedMessage = result.error.message;
    } else {
      settingsStore.lastSettingsSaveErrorCode = result?.error?.code ?? null;
      errorMessage = result?.error?.message || 'Could not save settings.';
    }
  } catch {
    // Keep the latest renderer state available for a later retry.
  }

  const latestRevision = settingsStore.settingsRevision;
  // A newer ROSI owns settings.json: the file is preserved and the user was
  // told once. Callers proceed with the in-memory values.
  const preserved = !saved && settingsStore.lastSettingsSaveErrorCode === 'NEWER_VERSION';
  const settled = settleSettingsSaveWaiters(snapshotRevision, saved || preserved, latestRevision);
  if (rejectedMessage) {
    showSettingsSaveError(
      `This setting was not changed:\n${rejectedMessage}\nYour other settings were saved.`
    );
  } else if (
    !saved &&
    settingsStore.lastSettingsSaveErrorCode !== 'NEWER_VERSION' &&
    snapshotRevision === latestRevision &&
    settled.some((waiter) => !waiter.silent)
  ) {
    // A newer-version settings file is reported once by the backend.
    showSettingsSaveError(`${errorMessage}\nChanges may not persist after restart.`);
  }
  settingsStore.settingsSaveInFlight = false;

  // A save requested during this request either fired its debounce already,
  // or explicitly asked for an immediate flush. Preserve debounce spacing
  // for ordinary edits while draining immediate lifecycle callers now.
  const mustContinue = settingsStore.settingsSaveWaiters.some((waiter) => waiter.immediate);
  if (
    settingsStore.settingsSaveWaiters.length > 0 &&
    (mustContinue || !settingsStore.persistDebounceTimer)
  ) {
    void drainSettingsSaves();
  }
}

export async function persistSettings(silent = false, immediate = false): Promise<boolean> {
  if (settingsStore.persistDebounceTimer) {
    clearTimeout(settingsStore.persistDebounceTimer);
    settingsStore.persistDebounceTimer = null;
  }
  const promise = new Promise<boolean>((resolve) => {
    settingsStore.settingsSaveWaiters.push({
      revision: settingsStore.settingsRevision,
      immediate,
      silent,
      resolve,
    });
  });
  if (immediate) {
    void drainSettingsSaves();
  } else {
    settingsStore.persistDebounceTimer = setTimeout(() => {
      settingsStore.persistDebounceTimer = null;
      void drainSettingsSaves();
    }, 300);
  }
  return promise;
}

/**
 * Restarts and update installs stop any active download. Ask first; an
 * interrupted queue item returns to the queue and runs again later.
 */
export function confirmInterruptActiveWork(action: string): Promise<boolean> {
  const queueActive = queueController.currentQueue.some((item) => item.status === 'downloading');
  if (!downloadState.isDownloading && !queueActive) return Promise.resolve(true);
  return new Promise((resolve) => {
    showModal({
      title: 'Download in Progress',
      message: `${action} stops the active download.${
        queueActive ? ' The interrupted queue item goes back to the queue.' : ''
      }`,
      priority: true,
      buttons: [
        { label: 'Keep Downloading', primary: true, action: () => resolve(false) },
        { label: 'Stop and Continue', danger: true, action: () => resolve(true) },
      ],
    });
  });
}

export async function flushBeforeRestart(action: string) {
  if (!(await confirmInterruptActiveWork(action))) return false;
  return persistSettings(false, true);
}

export async function restartAfterSettingsFlush() {
  if (!(await flushBeforeRestart('Restarting ROSI'))) return;
  try {
    await window.api.restartApp();
  } catch (error) {
    showRestartFailure(error);
  }
}

export function getPresets(): RosiDownloadPreset[] {
  return Array.isArray(settingsStore.settings.downloadPresets)
    ? settingsStore.settings.downloadPresets
    : [];
}

export async function loadDefaultSettings(): Promise<RosiSettings | null> {
  if (settingsStore.defaultSettingsCache) return settingsStore.defaultSettingsCache;
  if (typeof window.api.getDefaultSettings !== 'function') return null;
  try {
    const result = await window.api.getDefaultSettings();
    if (result && result.ok) {
      settingsStore.defaultSettingsCache = result.data as RosiSettings;
      return settingsStore.defaultSettingsCache;
    }
  } catch {
    /* fall through */
  }
  return null;
}

// Check for updates on startup
export async function checkUpdatesOnStartup() {
  const channel = window.api.getChannel();
  if (channel === 'msstore') return;
  if (!settingsStore.settings.checkUpdatesOnStartup) return;

  try {
    const isPackaged = await window.api.isPackaged();
    if (!isPackaged) return;

    await new Promise((resolve) => setTimeout(resolve, 2000));
    await window.api.checkForUpdates();
  } catch (e) {
    logError('Startup update check failed', e);
  }
}

// Owned by the renderer controller; set during startup and updated while it runs.
export const settingsStore: {
  settingsRevision: number;
  settings: RosiSettings;
  reconcilingSettings: boolean;
  settingsSaveErrorShownAt: number;
  persistDebounceTimer: ReturnType<typeof setTimeout> | null;
  settingsSaveInFlight: boolean;
  lastSettingsSaveErrorCode: string | null;
  refreshSettingsControls: (() => void) | null;
  settingsSaveWaiters: Array<{
    revision: number;
    immediate: boolean;
    silent: boolean;
    resolve: (saved: boolean) => void;
  }>;
  defaultSettingsCache: RosiSettings | null;
  isFlatpakBuild: boolean;
} = {
  settingsRevision: 0,
  settings: undefined as unknown as RosiSettings,
  reconcilingSettings: false,
  settingsSaveErrorShownAt: 0,
  persistDebounceTimer: null,
  settingsSaveInFlight: false,
  lastSettingsSaveErrorCode: null,
  refreshSettingsControls: null,
  settingsSaveWaiters: [],
  defaultSettingsCache: null,
  isFlatpakBuild: false,
};
