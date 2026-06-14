// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const REPO = path.resolve(__dirname, '..', '..');
const RENDERER = path.join(REPO, 'src', 'renderer');
const ENGINE_TS = path.join(RENDERER, 'rosiEngine.ts');
const INDEX_HTML = path.join(RENDERER, 'index.html');
const MODULE_FILES = ['ui', 'downloads', 'queue', 'settings', 'updates'];

function transpile(tsSource: string): string {
  return ts.transpileModule(tsSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
    },
  }).outputText;
}

// Transpile the renderer modules (which attach to window.rosiModules) and the
// engine once for the whole suite.
const moduleSources = MODULE_FILES.map((name) =>
  transpile(fs.readFileSync(path.join(RENDERER, 'modules', `${name}.ts`), 'utf-8'))
);
const engineSource = transpile(fs.readFileSync(ENGINE_TS, 'utf-8'));

// Extract the <body> markup from the real index.html (minus its <script> tags,
// which we run ourselves) so the engine binds against the shipping DOM.
const bodyHtml = (() => {
  const html = fs.readFileSync(INDEX_HTML, 'utf-8');
  const match = html.match(/<body>([\s\S]*?)<\/body>/i);
  const inner = match ? match[1] : '';
  return inner.replace(/<script[\s\S]*?<\/script>/gi, '');
})();

interface MockApi {
  [key: string]: ReturnType<typeof vi.fn> | (() => unknown);
}

function defaultSettings() {
  return {
    settingsVersion: 3,
    theme: 'dark',
    showConsoleOutput: false,
    consoleCollapsed: false,
    advancedOptions: false,
    audioOnly: false,
    audioFormat: 'mp3',
    convertEnabled: false,
    convertFormat: 'mp4',
    keepOriginalAfterConvert: true,
    firstLaunch: false,
    hookBrowser: false,
    browserChoice: 'Chrome',
    animateBackground: true,
    notifications: true,
    denoReminderDismissed: true,
    gpuAcceleration: false,
    gpuType: 'auto',
    bestQuality: false,
    ffmpegPath: '',
    hideSupportModal: true,
    checkUpdatesOnStartup: false,
    updateChannel: 'auto',
    writeSubtitles: false,
    subtitleLangs: 'en',
    embedThumbnail: false,
    embedMetadata: false,
    sponsorblockRemove: false,
  };
}

function buildMockApi(overrides: Partial<MockApi> = {}): MockApi {
  const noop = () => () => {};
  const ok = (data: unknown) => Promise.resolve({ ok: true, data });
  const api: MockApi = {
    getChannel: () => 'github',
    getSettings: vi.fn(() => Promise.resolve(defaultSettings())),
    saveSettings: vi.fn((s: unknown) => ok(s)),
    resetSettings: vi.fn(),
    getAppVersion: vi.fn(() => Promise.resolve('4.1.0')),
    isPackaged: vi.fn(() => Promise.resolve(false)),
    checkDenoInstalled: vi.fn(() => Promise.resolve(true)),
    getQueue: vi.fn(() => Promise.resolve([])),
    getFormats: vi.fn(() => ok('')),
    getVideoInfo: vi.fn(() => ok({})),
    cancelVideoInfo: vi.fn(),
    selectDownloadLocation: vi.fn(() => Promise.resolve(null)),
    downloadVideo: vi.fn(() => ok({ started: true })),
    cancelDownload: vi.fn(),
    cancelFormats: vi.fn(),
    addToQueue: vi.fn(() => ok({ added: 1 })),
    removeFromQueue: vi.fn(() => ok(undefined)),
    clearQueue: vi.fn(() => ok(undefined)),
    startQueue: vi.fn(() => ok({ started: true })),
    cancelQueue: vi.fn(() => ok(undefined)),
    getStats: vi.fn(() => Promise.resolve({})),
    resetStats: vi.fn(() => ok(undefined)),
    openExternal: vi.fn(() => ok({ opened: true })),
    openFileLocation: vi.fn(() => ok({ opened: true })),
    showNotification: vi.fn(() => ok({ shown: true })),
    exportSettings: vi.fn(() => ok({ exported: true })),
    importSettings: vi.fn(() => ok({ imported: true })),
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn(() => Promise.resolve({ success: true })),
    cancelUpdateDownload: vi.fn(),
    installUpdate: vi.fn(),
    restartApp: vi.fn(),
    logError: vi.fn(),
    notifySettingsFlushed: vi.fn(),
    installDeno: vi.fn(() => Promise.resolve({ success: true })),
    detectGpu: vi.fn(() => Promise.resolve({ nvidia: false, amd: false, intel: false })),
    onProgress: noop,
    onComplete: noop,
    onQueueUpdate: noop,
    onPrepareForClose: noop,
    onUpdaterStatus: noop,
    onUpdaterProgress: noop,
    onSettingsImported: noop,
    ...overrides,
  };
  return api;
}

const flush = async (ms = 0) => {
  await new Promise((r) => setTimeout(r, ms));
};

// The engine registers document-level listeners (focusin, keydown) that would
// otherwise accumulate across tests in this shared jsdom document. Track and
// remove them between tests for isolation.
const trackedDocListeners: Array<[string, EventListenerOrEventListenerObject, unknown]> = [];
const realDocAdd = document.addEventListener.bind(document);
document.addEventListener = ((
  type: string,
  listener: EventListenerOrEventListenerObject,
  opts?: unknown
) => {
  trackedDocListeners.push([type, listener, opts]);
  return realDocAdd(type, listener, opts as boolean);
}) as typeof document.addEventListener;

function clearTrackedDocListeners() {
  for (const [type, listener, opts] of trackedDocListeners) {
    document.removeEventListener(type, listener, opts as boolean);
  }
  trackedDocListeners.length = 0;
}

// Load the engine into the current jsdom window with a mock api, then fire the
// DOMContentLoaded the engine waits on.
async function loadEngine(api: MockApi) {
  document.body.innerHTML = bodyHtml;
  (window as unknown as { api: MockApi }).api = api;
  // matchMedia is not implemented in jsdom; stub it for theme resolution.
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
  // Load the renderer modules first (they attach to window.rosiModules), then
  // the engine — mirroring index.html's script order.
  for (const src of moduleSources) {
    (0, eval)(src);
  }

  (0, eval)(engineSource);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await flush(50);
}

describe('rosiEngine DOM wiring', () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearTrackedDocListeners();
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('initializes and loads settings on DOMContentLoaded', async () => {
    const api = buildMockApi();
    await loadEngine(api);
    expect(api.getSettings).toHaveBeenCalled();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('renders the app version into the version link', async () => {
    const api = buildMockApi();
    await loadEngine(api);
    expect(document.getElementById('versionLink')?.textContent).toBe('v4.1.0');
  });

  it('enables the download + preview buttons only for a valid URL', async () => {
    const api = buildMockApi();
    await loadEngine(api);
    const url = document.getElementById('url') as HTMLInputElement;
    const downloadBtn = document.getElementById('downloadBtn') as HTMLButtonElement;
    const previewBtn = document.getElementById('previewBtn') as HTMLButtonElement;

    url.value = 'not a url';
    url.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(downloadBtn.disabled).toBe(true);
    expect(previewBtn.disabled).toBe(true);

    url.value = 'https://youtube.com/watch?v=abc';
    url.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(downloadBtn.disabled).toBe(false);
    expect(previewBtn.disabled).toBe(false);
  });

  it('opens and closes the settings sidebar', async () => {
    const api = buildMockApi();
    await loadEngine(api);
    const sidebar = document.getElementById('sidebar') as HTMLElement;
    const click = (el: HTMLElement | null) =>
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sidebar.classList.contains('open')).toBe(false);

    click(document.getElementById('settingsBtn'));
    await flush();
    expect(sidebar.classList.contains('open')).toBe(true);

    click(document.getElementById('closeSidebar'));
    await flush();
    expect(sidebar.classList.contains('open')).toBe(false);
  });

  it('persists a settings change when a toggle is flipped', async () => {
    const api = buildMockApi();
    await loadEngine(api);
    const notifications = document.getElementById('notificationsToggle') as HTMLInputElement;
    notifications.checked = false;
    notifications.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(400); // persistSettings debounce is 300ms
    expect(api.saveSettings).toHaveBeenCalled();
  });

  it('adds URLs to the queue via the queue input', async () => {
    const api = buildMockApi();
    await loadEngine(api);
    const queueInput = document.getElementById('queueUrlInput') as HTMLTextAreaElement;
    queueInput.value = 'https://example.com/a\nhttps://example.com/b';
    (document.getElementById('addToQueueBtn') as HTMLButtonElement).click();
    await flush();
    expect(api.addToQueue).toHaveBeenCalledWith(['https://example.com/a', 'https://example.com/b']);
  });

  it('renders a video preview from getVideoInfo', async () => {
    const api = buildMockApi({
      getVideoInfo: vi.fn(() =>
        Promise.resolve({
          ok: true,
          data: {
            title: 'Test Clip',
            uploader: 'Test Channel',
            durationSeconds: 65,
            thumbnail: 'https://example.com/t.jpg',
            ext: 'mp4',
            viewCount: 2000,
            isPlaylist: false,
            playlistCount: null,
            webpageUrl: null,
          },
        })
      ),
    });
    await loadEngine(api);
    const url = document.getElementById('url') as HTMLInputElement;
    url.value = 'https://youtube.com/watch?v=abc';
    url.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    (document.getElementById('previewBtn') as HTMLButtonElement).click();
    await flush(50);

    expect(api.getVideoInfo).toHaveBeenCalledWith('https://youtube.com/watch?v=abc');
    const card = document.getElementById('preview-card') as HTMLElement;
    expect(card.classList.contains('visible')).toBe(true);
    expect(document.getElementById('preview-title')?.textContent).toBe('Test Clip');
    expect(document.getElementById('preview-duration')?.textContent).toBe('1:05');
    const thumb = document.getElementById('preview-thumb') as HTMLImageElement;
    expect(thumb.getAttribute('src')).toBe('https://example.com/t.jpg');
  });

  it('shows the enhancements subtitle-language field only when subtitles are enabled', async () => {
    const api = buildMockApi();
    await loadEngine(api);
    const container = document.getElementById('subtitleLangsContainer') as HTMLElement;
    expect(container.classList.contains('visible')).toBe(false);

    const toggle = document.getElementById('writeSubtitlesToggle') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(container.classList.contains('visible')).toBe(true);
  });

  it('hides the setup wizard back button on the first step', async () => {
    const api = buildMockApi({
      getSettings: vi.fn(() =>
        Promise.resolve({
          ...defaultSettings(),
          firstLaunch: true,
        })
      ),
    });
    await loadEngine(api);
    const backBtn = document.getElementById('wizard-back') as HTMLButtonElement;
    expect(backBtn.hasAttribute('hidden')).toBe(true);
  });

  it('records download history in localStorage on completion', async () => {
    let completeCb: ((msg: string) => void) | null = null;
    const api = buildMockApi({
      onComplete: ((cb: (msg: string) => void) => {
        completeCb = cb;
        return () => {};
      }) as unknown as ReturnType<typeof vi.fn>,
    });
    await loadEngine(api);
    expect(typeof completeCb).toBe('function');
    completeCb!('✅ Download complete (no conversion).');
    await flush();
    const history = JSON.parse(localStorage.getItem('rosi-download-history') || '[]');
    expect(history.length).toBe(1);
    expect(history[0].status).toBe('success');
  });
});
