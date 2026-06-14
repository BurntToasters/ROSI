import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

function readRepoFile(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function extractQuotedCalls(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]).filter(Boolean);
}

describe('IPC channel contracts', () => {
  const preload = readRepoFile('src/main/preload.ts');
  const main = readRepoFile('src/main/main.ts');

  const invokeChannels = extractQuotedCalls(preload, /ipcRenderer\.invoke\('([^']+)'/g);
  const sendChannels = extractQuotedCalls(preload, /ipcRenderer\.send\('([^']+)'/g);
  const rendererEventChannels = extractQuotedCalls(preload, /ipcRenderer\.on\('([^']+)'/g);
  const mainHandlers = extractQuotedCalls(main, /ipcMain\.handle\('([^']+)'/g);
  const mainEvents = extractQuotedCalls(main, /ipcMain\.on\('([^']+)'/g);

  it('registers a main handler for every preload invoke channel', () => {
    const missing = invokeChannels.filter((channel) => !mainHandlers.includes(channel));
    expect(missing, `missing ipcMain.handle registrations: ${missing.join(', ')}`).toEqual([]);
  });

  it('registers a main listener for every preload send channel', () => {
    const missing = sendChannels.filter((channel) => !mainEvents.includes(channel));
    expect(missing, `missing ipcMain.on registrations: ${missing.join(', ')}`).toEqual([]);
  });

  it('documents renderer event channels used by preload subscriptions', () => {
    expect(rendererEventChannels.sort()).toEqual(
      [
        'complete',
        'prepare-for-close',
        'progress',
        'queue-update',
        'settings-imported',
        'updater-progress',
        'updater-status',
      ].sort()
    );
  });
});
