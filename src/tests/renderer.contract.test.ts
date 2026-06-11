import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

function readRendererFile(relativePath: string) {
  const filePath = path.join(process.cwd(), 'src', 'renderer', relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

describe('renderer wiring and accessibility contracts', () => {
  it('keeps renderer module sources in TypeScript', () => {
    const moduleFiles = ['ui.ts', 'downloads.ts', 'queue.ts', 'settings.ts', 'updates.ts'];
    moduleFiles.forEach((fileName) => {
      const filePath = path.join(process.cwd(), 'src', 'renderer', 'modules', fileName);
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  it('keeps queue section id aligned between HTML and renderer logic', () => {
    const indexHtml = readRendererFile('index.html');
    const engine = readRendererFile('rosiEngine.ts');

    expect(indexHtml).toMatch(/id="queueSection"/);
    expect(engine).toMatch(/'queueSection'/);
    expect(engine).not.toMatch(/getElementById\('queue-section'\)/);
  });

  it('loads queue once on startup to avoid duplicate bootstrap fetches', () => {
    const engine = readRendererFile('rosiEngine.ts');
    const getQueueCalls = engine.match(/\.getQueue\(\)/g) || [];
    expect(getQueueCalls).toHaveLength(1);
  });

  it('exposes explicit accessible labels for primary URL inputs', () => {
    const indexHtml = readRendererFile('index.html');

    expect(indexHtml).toMatch(/<label class="sr-only" for="url">Video URL<\/label>/);
    expect(indexHtml).toMatch(/id="url"[\s\S]*aria-label="Video URL"/);
    expect(indexHtml).toMatch(/<label class="sr-only" for="queueUrlInput">Queue URLs<\/label>/);
    expect(indexHtml).toMatch(/id="queueUrlInput"[\s\S]*aria-label="Queue URLs"/);
  });

  it('keeps queue controls and status messaging accessible', () => {
    const indexHtml = readRendererFile('index.html');
    const queueModule = readRendererFile('modules/queue.ts');

    expect(indexHtml).toMatch(/id="queueSection"/);
    expect(indexHtml).toMatch(/id="queueStatusMessage"[\s\S]*role="status"/);
    expect(indexHtml).toMatch(/id="queueStatusMessage"[\s\S]*aria-live="polite"/);
    expect(indexHtml).toMatch(/id="queueStatusMessage"[\s\S]*aria-atomic="true"/);
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
      /id="settingsSectionHeaderDownload"[\s\S]*aria-controls="settingsSectionBodyDownload"/
    );
    expect(indexHtml).toMatch(
      /id="settingsSectionHeaderBrowser"[\s\S]*aria-controls="settingsSectionBodyBrowser"/
    );
    expect(indexHtml).toMatch(
      /id="settingsSectionHeaderInterface"[\s\S]*aria-controls="settingsSectionBodyInterface"/
    );
    expect(indexHtml).toMatch(
      /id="settingsSectionHeaderApplication"[\s\S]*aria-controls="settingsSectionBodyApplication"/
    );
    expect(indexHtml).toMatch(/id="historyToggle"[\s\S]*aria-controls="history-list"/);
    expect(indexHtml).toMatch(/id="consoleToggleBtn"[\s\S]*aria-controls="output"/);
    expect(indexHtml).toMatch(/id="progress-bar-wrapper"[\s\S]*role="progressbar"/);
    expect(indexHtml).toMatch(/id="settingsBtn"[\s\S]*aria-expanded="false"/);
    expect(indexHtml).toMatch(/<title>ROSI<\/title>/);
    expect(indexHtml).toMatch(/aria-label="Learn more about SponsorBlock"/);
    expect(readRendererFile('rosiEngine.ts')).toMatch(/onSettingsImported/);
    expect(readRendererFile('modules/settings.ts')).toMatch(/stopPropagation/);
  });

  it('supports arrow-key ergonomics for collapsible header controls', () => {
    const engine = readRendererFile('rosiEngine.ts');

    expect(engine).toContain("e.key === 'ArrowLeft'");
    expect(engine).toContain("e.key === 'ArrowRight'");
    expect(engine).toContain("e.key === 'ArrowDown'");
    expect(engine).toContain("e.key === 'ArrowUp'");
    expect(engine).toContain("e.key === 'Home'");
    expect(engine).toContain("e.key === 'End'");
  });

  it('keeps overlay, wizard, and progress accessibility contracts', () => {
    const indexHtml = readRendererFile('index.html');
    const engine = readRendererFile('rosiEngine.ts');
    const uiModule = readRendererFile('modules/ui.ts');

    expect(indexHtml).toMatch(/id="licenses-overlay"[\s\S]*aria-hidden="true"/);
    expect(indexHtml).toMatch(/id="licenses-frame"[\s\S]*title="ROSI licenses"/);
    expect(engine).toMatch(/licensesOverlayEl\.addEventListener\('click'/);
    expect(engine).not.toMatch(/licensesOverlay\.addEventListener\('click'/);

    expect(indexHtml).toMatch(/class="wizard-progress"[\s\S]*role="progressbar"/);
    expect(indexHtml).toMatch(/id="wizard-step-announce"[\s\S]*aria-live="polite"/);
    expect(engine).toMatch(/backBtnEl\.setAttribute\('hidden'/);

    expect(indexHtml).toMatch(
      /id="subtitleLangsInput"[\s\S]*aria-describedby="subtitleLangsHint subtitleLangsError"/
    );
    expect(indexHtml).toMatch(/id="progress-details"[\s\S]*aria-live="polite"/);
    expect(indexHtml).toMatch(/id="versionLink"[\s\S]*opens externally/);
    expect(engine).toMatch(/barWrapper\.setAttribute\('aria-valuenow', '0'\)/);
    expect(engine).toMatch(/aria-current', 'step'/);
    expect(engine).toMatch(/busy: true/);
    expect(engine).toMatch(
      /primary: true,\s*\n\s*action: \(\) => \{\s*\n\s*void window\.api\.openExternal\('https:\/\/rosie\.run\/support'\)/
    );

    expect(readRendererFile('licenses-iframe.html')).toMatch(/<html lang="en">/);
    expect(uiModule).toMatch(/setAttribute\('aria-label', 'Cancel download'\)/);
  });
});
