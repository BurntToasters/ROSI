// Compile-time gated WebDriver guest plugin for unpackaged E2E builds only.
// Comparing the Vite define directly lets Rollup drop this chunk in
// production builds.
import { api, type RosiRendererApi } from './api';
import * as dockModule from './modules/dock';
import * as iconsModule from './modules/icons';
import * as uiModule from './modules/ui';

export async function installE2eHookIfEnabled(): Promise<void> {
  if (import.meta.env.VITE_ROSI_E2E !== '1') return;
  await import('@wdio/tauri-plugin');
  (
    window as Window & {
      __ROSI_E2E__?: {
        ready: boolean;
        api: RosiRendererApi;
        modules: { dock: typeof dockModule; ui: typeof uiModule; icons: typeof iconsModule };
      };
    }
  ).__ROSI_E2E__ = {
    ready: true,
    api,
    modules: { dock: dockModule, ui: uiModule, icons: iconsModule },
  };
}
