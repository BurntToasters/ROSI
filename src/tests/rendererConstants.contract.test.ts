import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { MAX_DOWNLOAD_PRESETS, MAX_PLAYLIST_ITEM_INDEX } from '../main/constants';

// rosiEngine runs as a plain browser script and cannot import main-process
// constants, so a few limits are duplicated as literals. These checks fail if
// the two copies ever drift apart.
const ENGINE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'rosiEngine.ts'),
  'utf-8'
);

function readNumericLiteral(name: string): number {
  const match = ENGINE_SOURCE.match(new RegExp(`const ${name} = ([0-9_]+)`));
  if (!match?.[1]) {
    throw new Error(`Could not find "const ${name}" in rosiEngine.ts`);
  }
  return Number(match[1].replace(/_/g, ''));
}

describe('renderer constants mirror the main-process limits', () => {
  it('uses the same saved-preset cap as the settings validator', () => {
    expect(readNumericLiteral('MAX_PRESETS')).toBe(MAX_DOWNLOAD_PRESETS);
  });

  it('uses the same playlist index ceiling as the payload validator', () => {
    expect(readNumericLiteral('MAX_PLAYLIST_INDEX')).toBe(MAX_PLAYLIST_ITEM_INDEX);
  });
});
