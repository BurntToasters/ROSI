// Compile-time gated WebDriver guest plugin for unpackaged E2E builds only.
// Comparing the Vite define directly lets Rollup drop this chunk in
// production builds.
export async function installE2eHookIfEnabled(): Promise<void> {
  if (import.meta.env.VITE_ROSI_E2E !== '1') return;
  await import('@wdio/tauri-plugin');
  (window as Window & { __ROSI_E2E__?: { ready: boolean } }).__ROSI_E2E__ = { ready: true };
}
