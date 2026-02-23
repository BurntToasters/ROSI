import { describe, it, expect, vi } from 'vitest';

const { mockAppGetVersion, mockAutoUpdater } = vi.hoisted(() => {
  return {
    mockAppGetVersion: vi.fn(() => '3.4.3'),
    mockAutoUpdater: {
      channel: 'latest',
      allowPrerelease: false,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      on: vi.fn(),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  app: {
    getVersion: mockAppGetVersion,
  },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater,
  CancellationToken: class {
    cancel() {}
  },
}));

import {
  applyChannel,
  comparePrerelease,
  compareVersions,
  isBetaVersion,
  parseVersion,
  resolveUseBeta,
} from '../main/updater';

describe('updater versioning helpers', () => {
  it('detects prerelease versions', () => {
    expect(isBetaVersion('3.4.3-beta.1')).toBe(true);
    expect(isBetaVersion('3.4.3')).toBe(false);
  });

  it('parses semantic-like versions', () => {
    expect(parseVersion('v4.1.2-beta.3')).toEqual({
      major: 4,
      minor: 1,
      patch: 2,
      prerelease: ['beta', '3'],
    });
  });

  it('compares prerelease arrays in semver order', () => {
    expect(comparePrerelease([], [])).toBe(0);
    expect(comparePrerelease([], ['beta', '1'])).toBe(1);
    expect(comparePrerelease(['beta', '1'], ['beta', '2'])).toBe(-1);
  });

  it('compares versions with prerelease precedence', () => {
    expect(compareVersions('3.4.4', '3.4.3')).toBe(1);
    expect(compareVersions('3.4.3-beta.2', '3.4.3-beta.1')).toBe(1);
    expect(compareVersions('3.4.3', '3.4.3-beta.1')).toBe(1);
    expect(compareVersions('3.4.3-beta.1', '3.4.3')).toBe(-1);
  });

  it('resolves update channel behavior', () => {
    expect(resolveUseBeta('beta')).toBe(true);
    expect(resolveUseBeta('stable')).toBe(false);
    expect(resolveUseBeta('auto')).toBe(false);
  });

  it('applies updater channel settings', () => {
    applyChannel(true);
    expect(mockAutoUpdater.channel).toBe('beta');
    expect(mockAutoUpdater.allowPrerelease).toBe(true);

    applyChannel(false);
    expect(mockAutoUpdater.channel).toBe('latest');
    expect(mockAutoUpdater.allowPrerelease).toBe(false);
  });
});
