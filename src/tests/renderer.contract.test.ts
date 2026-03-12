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
});
