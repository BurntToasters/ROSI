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
    const engine = readRendererFile('rosiEngine.js');

    expect(indexHtml).toMatch(/id="queueSection"/);
    expect(engine).toMatch(/getElementById\('queueSection'\)/);
    expect(engine).not.toMatch(/getElementById\('queue-section'\)/);
  });

  it('loads queue once on startup to avoid duplicate bootstrap fetches', () => {
    const engine = readRendererFile('rosiEngine.js');
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

    expect(indexHtml).toMatch(/id="queueSection"/);
    expect(indexHtml).toMatch(/id="queueStatusMessage"[\s\S]*role="status"/);
    expect(indexHtml).toMatch(/id="queueStatusMessage"[\s\S]*aria-live="polite"/);
    expect(indexHtml).toMatch(/id="queueStatusMessage"[\s\S]*aria-atomic="true"/);

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
    expect(indexHtml).toMatch(/id="historyHeader"[\s\S]*aria-controls="history-list"/);
    expect(indexHtml).toMatch(/id="consoleHeader"[\s\S]*aria-controls="output"/);
  });

  it('supports arrow-key ergonomics for collapsible header controls', () => {
    const engine = readRendererFile('rosiEngine.js');

    expect(engine).toContain("e.key === 'ArrowLeft'");
    expect(engine).toContain("e.key === 'ArrowRight'");
    expect(engine).toContain("e.key === 'ArrowDown'");
    expect(engine).toContain("e.key === 'ArrowUp'");
    expect(engine).toContain("e.key === 'Home'");
    expect(engine).toContain("e.key === 'End'");
  });
});
