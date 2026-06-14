import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

function readRepoFile(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('packaging and desktop contracts', () => {
  it('keeps Linux desktop integration aligned across package, builder, and Flatpak', () => {
    const pkg = JSON.parse(readRepoFile('package.json'));
    const desktop = readRepoFile('com.burnttoasters.rosi.desktop');
    const baseConfig = readRepoFile('electron-builder.base.yml');

    expect(pkg.desktopName).toBe('com.burnttoasters.rosi.desktop');
    expect(baseConfig).toMatch(/syncDesktopName:\s*true/);
    expect(desktop).toMatch(/StartupWMClass=com\.burnttoasters\.rosi/);
    expect(desktop).toMatch(/Icon=com\.burnttoasters\.rosi/);
  });

  it('keeps renderer script load order stable', () => {
    const indexHtml = readRepoFile('src/renderer/index.html');
    const moduleIndex = indexHtml.indexOf('modules/ui.js');
    const engineIndex = indexHtml.indexOf('rosiEngine.js');
    const detectorIndex = indexHtml.indexOf('msStoreDetector.js');

    expect(moduleIndex).toBeGreaterThan(-1);
    expect(engineIndex).toBeGreaterThan(moduleIndex);
    expect(detectorIndex).toBeGreaterThan(engineIndex);
  });

  it('keeps splash screen basics for headless packaging checks', () => {
    const splash = readRepoFile('src/renderer/splash.html');

    expect(splash).toMatch(/<html lang="en">/);
    expect(splash).toMatch(/Content-Security-Policy/);
    expect(splash).toMatch(/<title>Loading ROSI<\/title>/);
  });

  it('keeps AppStream launchable aligned with the desktop entry', () => {
    const metainfo = readRepoFile('com.burnttoasters.rosi.metainfo.xml');
    expect(metainfo).toMatch(
      /<launchable type="desktop-id">com\.burnttoasters\.rosi\.desktop<\/launchable>/
    );
  });
});
