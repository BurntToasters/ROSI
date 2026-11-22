import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

function readRendererFile(relativePath: string) {
  const filePath = path.join(process.cwd(), 'src', relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

// The renderer controller is rosiEngine.ts plus its src/engine/ modules.
function readEngineSources() {
  const engineDir = path.join(process.cwd(), 'src', 'engine');
  const parts = fs
    .readdirSync(engineDir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => fs.readFileSync(path.join(engineDir, name), 'utf8'));
  return [readRendererFile('rosiEngine.ts'), ...parts].join('\n');
}

describe('renderer wiring and accessibility contracts', () => {
  it('keeps renderer module sources in TypeScript', () => {
    const moduleFiles = ['ui.ts', 'downloads.ts', 'queue.ts', 'settings.ts', 'updates.ts'];
    moduleFiles.forEach((fileName) => {
      const filePath = path.join(process.cwd(), 'src', 'modules', fileName);
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  it('keeps queue section id aligned between HTML and renderer logic', () => {
    const indexHtml = readRendererFile('index.html');
    const engine = readEngineSources();

    expect(indexHtml).toMatch(/id="queueSection"/);
    expect(engine).toMatch(/'queueSection'/);
    expect(engine).not.toMatch(/getElementById\('queue-section'\)/);
  });

  it('loads queue once on startup to avoid duplicate bootstrap fetches', () => {
    const engine = readEngineSources();
    const getQueueCalls = engine.match(/\.getQueue\(\)/g) || [];
    expect(getQueueCalls).toHaveLength(1);
  });

  it('exposes explicit accessible labels for primary URL inputs', () => {
    const indexHtml = readRendererFile('index.html');

    expect(indexHtml).toMatch(/<label class="sr-only" for="url">Video URL<\/label>/);
    expect(indexHtml).toMatch(/id="url"[^>]*aria-label="Video URL"/);
    expect(indexHtml).toMatch(/<label class="sr-only" for="queueUrlInput">Queue URLs<\/label>/);
    expect(indexHtml).toMatch(/id="queueUrlInput"[^>]*aria-label="Queue URLs"/);
  });

  it('keeps queue controls and status messaging accessible', () => {
    const indexHtml = readRendererFile('index.html');
    const queueModule = readRendererFile('modules/queue.ts');

    expect(indexHtml).toMatch(/id="queueSection"/);
    expect(indexHtml).toMatch(/id="queueStatusMessage"[^>]*role="status"/);
    expect(indexHtml).toMatch(/id="queueStatusMessage"[^>]*aria-live="polite"/);
    expect(indexHtml).toMatch(/id="queueStatusMessage"[^>]*aria-atomic="true"/);
    expect(indexHtml).toMatch(/id="queueList"[^>]*role="list"/);
    expect(indexHtml).not.toMatch(/id="queueList"[^>]*aria-live/);
    expect(queueModule).toMatch(/setAttribute\('role', 'listitem'\)/);

    expect(indexHtml).toMatch(/id="addToQueueBtn"/);
    expect(indexHtml).toMatch(/title="Add to queue"/);
    expect(indexHtml).toMatch(/id="startQueueBtn"/);
    expect(indexHtml).toMatch(/title="Start queue"/);
    expect(indexHtml).toMatch(/id="cancelQueueBtn"/);
    expect(indexHtml).toMatch(/title="Cancel queue"/);
    expect(indexHtml).toMatch(/id="clearQueueBtn"/);
    expect(indexHtml).toMatch(/title="Clear queue"/);
  });

  it('wires collapsible regions with explicit aria-controls relationships', () => {
    const indexHtml = readRendererFile('index.html');

    expect(indexHtml).toMatch(
      /id="settingsSectionHeaderDownload"[^>]*aria-controls="settingsSectionBodyDownload"/
    );
    expect(indexHtml).toMatch(
      /id="settingsSectionHeaderBrowser"[^>]*aria-controls="settingsSectionBodyBrowser"/
    );
    expect(indexHtml).toMatch(
      /id="settingsSectionHeaderInterface"[^>]*aria-controls="settingsSectionBodyInterface"/
    );
    expect(indexHtml).toMatch(
      /id="settingsSectionHeaderApplication"[^>]*aria-controls="settingsSectionBodyApplication"/
    );
    expect(indexHtml).toMatch(/id="dockTabQueue"[^>]*aria-controls="queueSection"/);
    expect(indexHtml).toMatch(/id="dockTabActivity"[^>]*aria-controls="download-history"/);
    expect(indexHtml).toMatch(/id="dockTabConsole"[^>]*aria-controls="console-section"/);
    expect(indexHtml).toMatch(/id="progress-bar-wrapper"[^>]*role="progressbar"/);
    expect(indexHtml).toMatch(/id="settingsBtn"[^>]*aria-expanded="false"/);
    expect(indexHtml).toMatch(/<title>ROSI<\/title>/);
    expect(indexHtml).toMatch(/aria-label="Learn more about SponsorBlock"/);
    expect(readEngineSources()).toMatch(/onSettingsImported/);
    expect(readRendererFile('modules/settings.ts')).toMatch(/stopPropagation/);
  });

  it('supports arrow-key ergonomics for collapsible header controls', () => {
    const engine = readEngineSources();

    expect(engine).toContain("e.key === 'ArrowLeft'");
    expect(engine).toContain("e.key === 'ArrowRight'");
    expect(engine).toContain("e.key === 'ArrowDown'");
    expect(engine).toContain("e.key === 'ArrowUp'");
    expect(engine).toContain("e.key === 'Home'");
    expect(engine).toContain("e.key === 'End'");
  });

  it('keeps overlay, wizard, and progress accessibility contracts', () => {
    const indexHtml = readRendererFile('index.html');
    const engine = readEngineSources();
    const uiModule = readRendererFile('modules/ui.ts');

    expect(indexHtml).toMatch(/id="licenses-overlay"[^>]*aria-hidden="true"/);
    expect(indexHtml).toMatch(/id="licenses-frame"[^>]*title="ROSI licenses"/);
    expect(engine).toMatch(/licensesOverlayEl\.addEventListener\('click'/);
    expect(engine).not.toMatch(/licensesOverlay\.addEventListener\('click'/);

    expect(indexHtml).toMatch(/class="wizard-progress"[^>]*role="progressbar"/);
    expect(indexHtml).toMatch(/id="wizard-step-announce"[^>]*aria-live="polite"/);
    expect(engine).toMatch(/backBtnEl\.setAttribute\('hidden'/);

    expect(indexHtml).toMatch(
      /id="subtitleLangsInput"[^>]*aria-describedby="subtitleLangsHint subtitleLangsError"/
    );
    expect(indexHtml).toMatch(/id="progress-status"[^>]*aria-live="polite"/);
    expect(indexHtml).toMatch(/id="progress-details" class="progress-details"><\/div>/);
    expect(indexHtml).toMatch(/id="versionLink"[^>]*opens externally/);
    expect(engine).toMatch(/barWrapper\.setAttribute\('aria-valuenow', '0'\)/);
    expect(engine).toMatch(/aria-current', 'step'/);
    expect(engine).toMatch(/busy: true/);
    expect(engine).toMatch(
      /primary: true,\s*\n\s*action: \(\) => \{\s*\n\s*void openExternalLink\('https:\/\/rosie\.run\/support'/
    );

    expect(
      fs.readFileSync(path.join(process.cwd(), 'public', 'licenses-iframe.html'), 'utf8')
    ).toMatch(/<html lang="en">/);
    expect(uiModule).toMatch(/setAttribute\('aria-label', cancelLabel\)/);
    expect(engine).toMatch(/'Cancel format check'/);
    expect(engine).toMatch(/'Cancel preview'/);
  });
});
