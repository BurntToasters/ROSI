// Splash window: show the running version (the only API it may call).
import { getVersion } from '@tauri-apps/api/app';

getVersion()
  .then((version) => {
    const element = document.getElementById('version-display');
    if (element) element.textContent = `v${version}`;
  })
  .catch(() => {});
