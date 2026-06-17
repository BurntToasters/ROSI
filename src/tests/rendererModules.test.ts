// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    showToast: (message: unknown, options?: { type?: string; duration?: number }) => void;
    setButtonLoading: (
      button: HTMLButtonElement | null,
      isLoading: boolean,
      onCancel?: (() => void) | null
    ) => void;
    appendConsoleOutput: (outputEl: HTMLElement | null, text: string) => void;
    updateConsoleVisibility: (show: boolean) => void;
    toggleAdvancedUI: (show: boolean) => void;
    getModifierKey: () => 'metaKey' | 'ctrlKey';
    getModifierKeyName: () => 'Cmd' | 'Ctrl';
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
  queue?: {
    renderQueue: (
      queue: Array<{ id: string; status: string; url: string }>,
      elements: {
        queueList: HTMLElement | null;
        queueSection: HTMLElement | null;
        queueCount: HTMLElement | null;
      },
      deps: {
        escapeHtml: (value: string) => string;
        removeFromQueue: (id: string) => unknown;
        focusQueueItemId?: string | null;
      }
    ) => void;
    resolveQueueSectionElement: (root?: Document) => HTMLElement | null;
  };
  settings?: {
    bindExternalLink: (
      element: HTMLElement | null,
      url: string,
      openExternal: (url: string) => unknown
    ) => void;
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
    beforeEach(() => {
      document.body.innerHTML =
        '<div id="toast-container"></div><section id="console-section"></section><div id="advanced-options" hidden></div>';
      loadModule('ui');
    });

    it('isValidUrl accepts http and https URLs', () => {
      expect(modules().ui!.isValidUrl('https://example.com/video')).toBe(true);
      expect(modules().ui!.isValidUrl('http://example.com')).toBe(true);
    });

    it('isValidUrl rejects invalid and non-http URLs', () => {
      expect(modules().ui!.isValidUrl('not a url')).toBe(false);
      expect(modules().ui!.isValidUrl('ftp://example.com')).toBe(false);
      expect(modules().ui!.isValidUrl('javascript:alert(1)')).toBe(false);
    });

    it('showToast renders a dismissible toast message', () => {
      modules().ui!.showToast('Saved settings', { type: 'success', duration: 0 });
      const toast = document.querySelector('.toast-success');
      expect(toast).not.toBeNull();
      expect(toast?.textContent).toContain('Saved settings');
      expect(toast?.getAttribute('role')).toBeNull();
    });

    it('setButtonLoading toggles loading state and aria-busy', () => {
      const button = document.createElement('button');
      button.textContent = 'Download';
      document.body.appendChild(button);

      modules().ui!.setButtonLoading(button, true);
      expect(button.classList.contains('loading')).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');

      modules().ui!.setButtonLoading(button, false);
      expect(button.classList.contains('loading')).toBe(false);
      expect(button.getAttribute('aria-busy')).toBeNull();
    });

    it('appendConsoleOutput appends text and toggles console visibility', () => {
      const output = document.createElement('pre');
      modules().ui!.appendConsoleOutput(output, 'line one');
      expect(output.textContent).toContain('line one');

      modules().ui!.updateConsoleVisibility(true);
      expect(document.getElementById('console-section')?.classList.contains('visible')).toBe(true);
      expect(document.body.classList.contains('console-visible')).toBe(true);
    });

    it('reports platform modifier keys', () => {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
      expect(modules().ui!.getModifierKey()).toBe('metaKey');
      expect(modules().ui!.getModifierKeyName()).toBe('Cmd');
    });

    it('toggleAdvancedUI shows and hides the format options section', () => {
      const formatSection = document.createElement('section');
      formatSection.id = 'formatOptions';
      document.body.appendChild(formatSection);

      modules().ui!.toggleAdvancedUI(true);
      expect(formatSection.classList.contains('visible')).toBe(true);

      modules().ui!.toggleAdvancedUI(false);
      expect(formatSection.classList.contains('visible')).toBe(false);
    });
  });

  describe('queue module', () => {
    beforeEach(() => {
      document.body.innerHTML =
        '<section id="queueSection"><div id="queue-list"></div><span id="queue-count"></span></section>';
      loadModule('queue');
    });

    it('resolveQueueSectionElement finds queueSection and legacy queue-section ids', () => {
      expect(modules().queue!.resolveQueueSectionElement()?.id).toBe('queueSection');
      const legacy = document.createElement('section');
      legacy.id = 'queue-section';
      document.body.appendChild(legacy);
      expect(modules().queue!.resolveQueueSectionElement()?.id).toBe('queueSection');
    });

    it('renderQueue shows an empty-state message', () => {
      const queueSection = document.getElementById('queueSection')!;
      modules().queue!.renderQueue(
        [],
        {
          queueList: document.getElementById('queue-list'),
          queueSection,
          queueCount: document.getElementById('queue-count'),
        },
        { escapeHtml: (value) => value, removeFromQueue: vi.fn() }
      );

      expect(queueSection.classList.contains('has-items')).toBe(false);
      expect(document.querySelector('.queue-empty-message')?.textContent).toContain(
        'No items in queue'
      );
    });

    it('does not allow crafted URL content to inject markup in renderQueue output', () => {
      // Intentionally pass a permissive escaper to prove the sink no longer
      // depends on escaping correctness: renderQueue now builds DOM nodes and
      // assigns untrusted values via textContent/title, so markup cannot inject.
      const escapeHtml = (value: string) => value;
      const maliciousUrl = 'https://example.com/"><img src=x onerror=alert(1)>';
      modules().queue!.renderQueue(
        [{ id: 'q_xss', status: 'pending', url: maliciousUrl }],
        {
          queueList: document.getElementById('queue-list'),
          queueSection: document.getElementById('queueSection'),
          queueCount: document.getElementById('queue-count'),
        },
        { escapeHtml, removeFromQueue: vi.fn() }
      );

      const queueList = document.getElementById('queue-list')!;
      // No element was injected from the URL string.
      expect(queueList.querySelector('img')).toBeNull();
      expect(queueList.querySelectorAll('.queue-item')).toHaveLength(1);
      // No event-handler attribute leaked onto any node.
      queueList.querySelectorAll('*').forEach((node) => {
        expect(node.getAttribute('onerror')).toBeNull();
        expect(node.getAttribute('onmouseover')).toBeNull();
      });
      const urlEl = queueList.querySelector('.queue-item-url')!;
      expect(urlEl.textContent).toContain('example.com');
      // The full raw URL is preserved verbatim as the title's text value
      // (stored as data, never parsed as HTML).
      expect(urlEl.getAttribute('title')).toBe(maliciousUrl);
    });

    it('removes pending queue items through the remove button', async () => {
      const removeFromQueue = vi.fn().mockResolvedValue(undefined);
      modules().queue!.renderQueue(
        [{ id: 'q1', status: 'pending', url: 'https://example.com/video' }],
        {
          queueList: document.getElementById('queue-list'),
          queueSection: document.getElementById('queueSection'),
          queueCount: document.getElementById('queue-count'),
        },
        { escapeHtml: (value) => value, removeFromQueue }
      );

      const removeBtn = document.querySelector<HTMLButtonElement>('.queue-item-remove');
      expect(removeBtn).not.toBeNull();
      removeBtn!.click();
      expect(removeFromQueue).toHaveBeenCalledWith('q1');
    });
  });

  describe('settings module', () => {
    beforeEach(() => loadModule('settings'));

    it('bindExternalLink stops propagation and opens external URL', () => {
      const link = document.createElement('a');
      link.href = '#';
      document.body.appendChild(link);
      const openExternal = vi.fn();
      const parentClick = vi.fn();
      document.body.addEventListener('click', parentClick);

      modules().settings!.bindExternalLink(link, 'https://example.com/help', openExternal);

      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      const stopPropagation = vi.spyOn(event, 'stopPropagation');
      const preventDefault = vi.spyOn(event, 'preventDefault');
      link.dispatchEvent(event);

      expect(stopPropagation).toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalled();
      expect(parentClick).not.toHaveBeenCalled();
      expect(openExternal).toHaveBeenCalledWith('https://example.com/help');
    });
  });

  describe('updates module', () => {
    beforeEach(() => loadModule('updates'));

    it('isPrereleaseVersion detects prerelease suffixes', () => {
      expect(modules().updates!.isPrereleaseVersion('4.0.0-beta.1')).toBe(true);
      expect(modules().updates!.isPrereleaseVersion('4.0.0-alpha.2')).toBe(true);
      expect(modules().updates!.isPrereleaseVersion('4.0.0-rc.1')).toBe(true);
      expect(modules().updates!.isPrereleaseVersion('4.0.0-RC.2')).toBe(true);
      expect(modules().updates!.isPrereleaseVersion('4.0.0')).toBe(false);
      expect(modules().updates!.isPrereleaseVersion('4.0.0-dev')).toBe(false);
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
