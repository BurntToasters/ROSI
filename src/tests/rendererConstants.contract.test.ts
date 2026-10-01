import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

// rosiEngine runs as a plain browser script and cannot import the Rust
// backend's limits, so a few are duplicated as literals. These checks fail if
// the two copies ever drift apart.
const ENGINE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'rosiEngine.ts'), 'utf-8');
const BACKEND_CONSTANTS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src-tauri', 'src', 'constants.rs'),
  'utf-8'
);

function readBackendConstant(name: string): number {
  const match = BACKEND_CONSTANTS.match(new RegExp(`pub const ${name}: [a-z0-9]+ = ([0-9_]+);`));
  if (!match?.[1]) {
    throw new Error(`Could not find "pub const ${name}" in src-tauri/src/constants.rs`);
  }
  return Number(match[1].replace(/_/g, ''));
}

const MAX_DOWNLOAD_PRESETS = readBackendConstant('MAX_DOWNLOAD_PRESETS');
const MAX_PLAYLIST_ITEM_INDEX = readBackendConstant('MAX_PLAYLIST_ITEM_INDEX');

function readNumericLiteral(name: string): number {
  const match = ENGINE_SOURCE.match(new RegExp(`const ${name} = ([0-9_]+)`));
  if (!match?.[1]) {
    throw new Error(`Could not find "const ${name}" in rosiEngine.ts`);
  }
  return Number(match[1].replace(/_/g, ''));
}

describe('renderer constants mirror the backend limits', () => {
  it('uses the same saved-preset cap as the settings validator', () => {
    expect(readNumericLiteral('MAX_PRESETS')).toBe(MAX_DOWNLOAD_PRESETS);
  });

  it('uses the same playlist index ceiling as the payload validator', () => {
    expect(readNumericLiteral('MAX_PLAYLIST_INDEX')).toBe(MAX_PLAYLIST_ITEM_INDEX);
  });
});
