// @vitest-environment jsdom
import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const REPO = path.resolve(__dirname, '..', '..');
const DETECTOR = path.join(REPO, 'src', 'renderer', 'msStoreDetector.js');

function runDetector(channel: string | null) {
  document.body.innerHTML = `
    <button id="checkUpdateBtn">Check</button>
    <label id="checkUpdatesOnStartupLabel">Startup updates</label>
  `;
  (window as unknown as { api?: { getChannel: () => string | null } }).api = {
    getChannel: () => channel,
  };
  const source = fs.readFileSync(DETECTOR, 'utf-8');
  (0, eval)(source);
}

describe('msStoreDetector', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    delete (window as unknown as { api?: unknown }).api;
  });

  it('hides update controls for Microsoft Store builds', () => {
    runDetector('msstore');

    expect(document.getElementById('checkUpdateBtn')?.style.display).toBe('none');
    expect(document.getElementById('checkUpdatesOnStartupLabel')?.style.display).toBe('none');
  });

  it('leaves update controls visible for GitHub builds', () => {
    runDetector('github');

    expect(document.getElementById('checkUpdateBtn')?.style.display).toBe('');
    expect(document.getElementById('checkUpdatesOnStartupLabel')?.style.display).toBe('');
  });
});
