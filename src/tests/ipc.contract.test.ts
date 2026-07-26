import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

function readRepoFile(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function extractQuotedCalls(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]).filter(Boolean);
}

function extractMainToRendererSendChannels(mainSources: string): string[] {
  const channels = new Set<string>();
  const patterns = [
    /\.webContents\.send\('([^']+)'/g,
    /\.send\('([^']+)'/g,
    /safeSend\([^,]+,\s*'([^']+)'/g,
    /sendToWindow\('([^']+)'/g,
  ];
  for (const pattern of patterns) {
    for (const channel of extractQuotedCalls(mainSources, pattern)) {
      channels.add(channel);
    }
  }
  return [...channels];
}

describe('IPC channel contracts', () => {
  const preload = readRepoFile('src/main/preload.ts');
  const main = readRepoFile('src/main/main.ts');
  const appMenu = readRepoFile('src/main/appMenu.ts');
  const jobProgressReporter = readRepoFile('src/main/download/jobProgressReporter.ts');
  const updater = readRepoFile('src/main/updater.ts');
  const downloader = readRepoFile('src/main/downloader.ts');
  const mainSources = [main, appMenu, jobProgressReporter, updater, downloader].join('\n');

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
        'job-progress',
        'menu-action',
        'prepare-for-close',
        'progress',
        'queue-update',
        'settings-imported',
        'updater-progress',
        'updater-status',
      ].sort()
    );
  });

  it('emits every preload subscription event from main-process senders', () => {
    const emitted = extractMainToRendererSendChannels(mainSources);
    const missing = rendererEventChannels.filter((channel) => !emitted.includes(channel));
    expect(missing, `main never sends: ${missing.join(', ')}`).toEqual([]);
    expect(emitted.length).toBeGreaterThan(0);
  });
});
