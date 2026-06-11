// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const REPO = path.resolve(__dirname, '..', '..');
const RENDERER = path.join(REPO, 'src', 'renderer');

function transpile(tsSource: string): string {
  return ts.transpileModule(tsSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
    },
  }).outputText;
}

function loadModule(name: string) {
  (window as unknown as { rosiModules?: Record<string, unknown> }).rosiModules = {};
  const source = transpile(fs.readFileSync(path.join(RENDERER, 'modules', `${name}.ts`), 'utf-8'));
  (0, eval)(source);
}

type RosiModules = {
  downloads?: {
    formatBytes: (bytes: number) => string;
    parseYtdlpProgress: (message: string) => {
      percent: number;
      totalSize: string;
      speed: string | null;
      eta: string | null;
    } | null;
  };
  ui?: {
    isValidUrl: (value: string) => boolean;
  };
  updates?: {
    isPrereleaseVersion: (version: string) => boolean;
    formatUpdateProgressInfo: (
      data: {
        bytesPerSecond: number;
        percent: number;
        total: number;
        transferred: number;
      },
      formatBytes: (bytes: number) => string
    ) => string;
  };
};

function modules(): RosiModules {
  return (window as unknown as { rosiModules?: RosiModules }).rosiModules ?? {};
}

describe('renderer modules', () => {
  beforeEach(() => {
    (window as unknown as { rosiModules?: Record<string, unknown> }).rosiModules = {};
  });

  describe('downloads module', () => {
    beforeEach(() => loadModule('downloads'));

    it('parseYtdlpProgress parses full progress line', () => {
      const result = modules().downloads!.parseYtdlpProgress(
        '[download]  45.2% of ~10.5MiB at  1.2MiB/s ETA 00:08'
      );
      expect(result).toEqual({
        percent: 45.2,
        totalSize: '10.5MiB',
        speed: '1.2MiB/s',
        eta: '00:08',
      });
    });

    it('parseYtdlpProgress parses simple progress line', () => {
      const result = modules().downloads!.parseYtdlpProgress('[download]  10.0% of ~5.00MiB');
      expect(result).toEqual({
        percent: 10,
        totalSize: '5.00MiB',
        speed: null,
        eta: null,
      });
    });

    it('parseYtdlpProgress returns null for non-progress lines', () => {
      expect(modules().downloads!.parseYtdlpProgress('random output')).toBeNull();
    });

    it('formatBytes formats byte sizes', () => {
      expect(modules().downloads!.formatBytes(0)).toBe('0 B');
      expect(modules().downloads!.formatBytes(1024)).toBe('1 KB');
      expect(modules().downloads!.formatBytes(1536)).toBe('1.5 KB');
      expect(modules().downloads!.formatBytes(1048576)).toBe('1 MB');
    });
  });

  describe('ui module', () => {
    beforeEach(() => loadModule('ui'));

    it('isValidUrl accepts http and https URLs', () => {
      expect(modules().ui!.isValidUrl('https://example.com/video')).toBe(true);
      expect(modules().ui!.isValidUrl('http://example.com')).toBe(true);
    });

    it('isValidUrl rejects invalid and non-http URLs', () => {
      expect(modules().ui!.isValidUrl('not a url')).toBe(false);
      expect(modules().ui!.isValidUrl('ftp://example.com')).toBe(false);
      expect(modules().ui!.isValidUrl('javascript:alert(1)')).toBe(false);
    });
  });

  describe('updates module', () => {
    beforeEach(() => loadModule('updates'));

    it('isPrereleaseVersion detects prerelease suffixes', () => {
      expect(modules().updates!.isPrereleaseVersion('4.0.0-beta.1')).toBe(true);
      expect(modules().updates!.isPrereleaseVersion('4.0.0-alpha.2')).toBe(true);
      expect(modules().updates!.isPrereleaseVersion('4.0.0-rc.1')).toBe(true);
      expect(modules().updates!.isPrereleaseVersion('4.0.0')).toBe(false);
    });

    it('formatUpdateProgressInfo formats progress with byte helper', () => {
      const formatBytes = (bytes: number) => `${bytes}B`;
      const result = modules().updates!.formatUpdateProgressInfo(
        {
          bytesPerSecond: 1024,
          percent: 42.6,
          total: 4096,
          transferred: 2048,
        },
        formatBytes
      );
      expect(result).toBe('2048B / 4096B (1024B/s) — 43%');
    });
  });
});
