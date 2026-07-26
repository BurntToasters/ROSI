import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { updateMetainfo, updateSplash } = require('../../build-scripts/update-metainfo.js');

function makeTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rosi-metainfo-'));
  fs.mkdirSync(path.join(repoRoot, 'src', 'renderer'), { recursive: true });
  return repoRoot;
}

function writeRepoFiles(repoRoot: string, version: string, releases: string) {
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ version }), 'utf8');
  fs.writeFileSync(
    path.join(repoRoot, 'com.burnttoasters.rosi.metainfo.xml'),
    `<component>
  <releases>
${releases}
  </releases>
</component>
`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(repoRoot, 'src', 'renderer', 'splash.html'),
    '<div class="version" id="version-display">v0.0.0</div>',
    'utf8'
  );
}

function readMetainfo(repoRoot: string) {
  return fs.readFileSync(path.join(repoRoot, 'com.burnttoasters.rosi.metainfo.xml'), 'utf8');
}

describe('update-metainfo helper', () => {
  const tempDirs: string[] = [];
  const logger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it('updates the current release date without duplicating the same version', () => {
    const repoRoot = makeTempRepo();
    tempDirs.push(repoRoot);
    writeRepoFiles(
      repoRoot,
      '4.1.5',
      '    <release version="4.1.5" date="2026-06-30"/>\n    <release version="4.1.4" date="2026-06-22"/>'
    );

    updateMetainfo({
      repoRoot,
      now: new Date('2026-07-03T12:00:00Z'),
      logger,
    });

    const metainfo = readMetainfo(repoRoot);
    expect(metainfo).toContain('<release version="4.1.5" date="2026-07-03"/>');
    expect(metainfo.match(/version="4\.1\.5"/g)).toHaveLength(1);
    expect(metainfo).toContain('<release version="4.1.4" date="2026-06-22"/>');
  });

  it('prepends a new version while preserving release history', () => {
    const repoRoot = makeTempRepo();
    tempDirs.push(repoRoot);
    writeRepoFiles(repoRoot, '4.1.6', '    <release version="4.1.5" date="2026-07-03"/>');

    updateMetainfo({
      repoRoot,
      now: new Date('2026-07-04T12:00:00Z'),
      logger,
    });

    const metainfo = readMetainfo(repoRoot);
    expect(metainfo).toContain(
      '<releases>\n    <release version="4.1.6" date="2026-07-04"/>\n    <release version="4.1.5" date="2026-07-03"/>'
    );
  });

  it('updates splash.html version via updateSplash', () => {
    const repoRoot = makeTempRepo();
    tempDirs.push(repoRoot);
    writeRepoFiles(repoRoot, '4.1.6', '    <release version="4.1.5" date="2026-07-03"/>');

    updateSplash({ repoRoot, version: '4.1.6' });

    const splash = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'splash.html'), 'utf8');
    expect(splash).toContain('id="version-display">v4.1.6</div>');
  });
});
