import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

function readRepoFile(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function readJson(relativePath: string) {
  return JSON.parse(readRepoFile(relativePath));
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
    expect(splash).toMatch(/theme-init\.js/);
    expect(splash).toMatch(/css\/01-base\.css/);
    expect(splash).toMatch(/css\/splash\.css/);
  });

  it('keeps AppStream launchable aligned with the desktop entry', () => {
    const metainfo = readRepoFile('com.burnttoasters.rosi.metainfo.xml');
    expect(metainfo).toMatch(
      /<launchable type="desktop-id">com\.burnttoasters\.rosi\.desktop<\/launchable>/
    );
  });

  it('keeps package, lockfile, splash, and AppStream versions aligned', () => {
    const pkg = readJson('package.json');
    const lock = readJson('package-lock.json');
    const splash = readRepoFile('src/renderer/splash.html');
    const metainfo = readRepoFile('com.burnttoasters.rosi.metainfo.xml');

    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
    expect(splash).toContain(`id="version-display">v${pkg.version}</div>`);
    expect(metainfo).toContain(`<release version="${pkg.version}"`);
  });

  it('keeps AppStream releases newest-first with no duplicate version entries', () => {
    const metainfo = readRepoFile('com.burnttoasters.rosi.metainfo.xml');
    const releases = [...metainfo.matchAll(/<release version="([^"]+)" date="([^"]+)"\/>/g)].map(
      (match) => ({ version: match[1], date: match[2] })
    );
    const versions = releases.map((release) => release.version);

    expect(releases.length).toBeGreaterThan(0);
    expect(new Set(versions).size).toBe(versions.length);
    expect(releases[0].version).toBe(readJson('package.json').version);

    for (let index = 1; index < releases.length; index += 1) {
      expect(releases[index - 1].date >= releases[index].date).toBe(true);
    }
  });

  it('keeps the headless stability command wired to the full suite and runtime smoke', () => {
    const pkg = readJson('package.json');

    expect(pkg.scripts['test:headless']).toBe(
      'npm run test:all && npm run test:cov && npm run smoke:runtime:fast'
    );
  });
});
