// Theme resolution, the system theme listener, and theme-dependent styling.
export type ThemeName = 'system' | 'light' | 'dark' | 'purple';

export let systemThemeMediaQuery: MediaQueryList | null = null;
export let systemThemeMediaQueryHandler: (() => void) | null = null;
export let appliedTheme: ThemeName = 'dark';
export let themePreference: ThemeName = 'system';

export function resolveAppliedTheme(preference: ThemeName): ThemeName {
  if (preference === 'light' || preference === 'dark' || preference === 'purple') {
    return preference;
  }
  const query =
    systemThemeMediaQuery ||
    (typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null);
  return query && query.matches ? 'dark' : 'light';
}

export function syncLicensesTheme(theme: ThemeName) {
  try {
    const frame = document.getElementById('licenses-frame') as HTMLIFrameElement | null;
    const root = frame?.contentDocument?.documentElement;
    if (root) {
      root.dataset.theme = theme;
    }
  } catch {
    /* ignore */
  }
}

// Pin the native title bar to the rendered theme rather than the system
// appearance, so a dark page never sits under a light bar.
export function syncWindowTheme(theme: ThemeName) {
  window.api?.setWindowTheme?.(theme === 'light' ? 'light' : 'dark');
}

export function teardownSystemThemeListener() {
  if (!systemThemeMediaQuery || !systemThemeMediaQueryHandler) {
    return;
  }
  if (typeof systemThemeMediaQuery.removeEventListener === 'function') {
    systemThemeMediaQuery.removeEventListener('change', systemThemeMediaQueryHandler);
  } else if (typeof systemThemeMediaQuery.removeListener === 'function') {
    systemThemeMediaQuery.removeListener(systemThemeMediaQueryHandler);
  }
  systemThemeMediaQueryHandler = null;
}

export function ensureSystemThemeListener() {
  if (themePreference !== 'system') {
    teardownSystemThemeListener();
    return;
  }
  if (!systemThemeMediaQuery && typeof window.matchMedia === 'function') {
    systemThemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  }
  if (!systemThemeMediaQuery || systemThemeMediaQueryHandler) {
    return;
  }
  systemThemeMediaQueryHandler = () => {
    if (themePreference !== 'system') {
      return;
    }
    appliedTheme = resolveAppliedTheme('system');
    document.documentElement.dataset.theme = appliedTheme;
    syncLicensesTheme(appliedTheme);
    syncWindowTheme(appliedTheme);
  };
  if (typeof systemThemeMediaQuery.addEventListener === 'function') {
    systemThemeMediaQuery.addEventListener('change', systemThemeMediaQueryHandler);
  } else if (typeof systemThemeMediaQuery.addListener === 'function') {
    systemThemeMediaQuery.addListener(systemThemeMediaQueryHandler);
  }
}

export function applyTheme(preference: string) {
  themePreference =
    preference === 'light' || preference === 'dark' || preference === 'purple'
      ? (preference as ThemeName)
      : 'system';
  ensureSystemThemeListener();
  appliedTheme = resolveAppliedTheme(themePreference);
  document.documentElement.dataset.theme = appliedTheme;
  syncLicensesTheme(appliedTheme);
  syncWindowTheme(appliedTheme);
  try {
    localStorage.setItem('rosi-theme', themePreference);
  } catch {
    /* ignore */
  }
  return appliedTheme;
}

export function updateBackgroundAnimation(animate: boolean) {
  const body = document.body;
  if (animate) {
    body.classList.add('animate-bg');
  } else {
    body.classList.remove('animate-bg');
  }
}

export function applyFlatUi(isFlat: boolean) {
  if (isFlat) document.documentElement.dataset.flatUi = 'true';
  else delete document.documentElement.dataset.flatUi;
  try {
    localStorage.setItem('rosi-flat-ui', isFlat ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}
