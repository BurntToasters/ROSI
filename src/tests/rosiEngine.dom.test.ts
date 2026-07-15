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
    settingsVersion: 5,
    theme: 'dark',
    showConsoleOutput: false,
    consoleCollapsed: false,
    queueCollapsed: false,
    downloadProfilesEnabled: false,
    downloadMode: 'best-video',
    askDownloadLocation: false,
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
    flatUi: false,
    notifications: true,
    denoReminderDismissed: true,
    gpuAcceleration: false,
    gpuType: 'auto',
    bestQuality: false,
    ffmpegPath: '',
    downloadFolder: '',
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

  it('keeps download profiles hidden until enabled in settings', async () => {
    const api = buildMockApi();
    await loadEngine(api);

    const composer = document.getElementById('downloadProfilesComposer') as HTMLElement;
    const profilesToggle = document.getElementById('downloadProfilesToggle') as HTMLInputElement;
    expect(composer.classList.contains('hidden')).toBe(true);

    profilesToggle.checked = true;
    profilesToggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(composer.classList.contains('hidden')).toBe(false);
    expect(api.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        downloadProfilesEnabled: true,
        downloadMode: 'best-video',
        bestQuality: true,
      })
    );
  });

  it('switches enabled profiles and exposes Audio format choice', async () => {
    const api = buildMockApi({
      getSettings: vi.fn(() =>
        Promise.resolve({
          ...defaultSettings(),
          downloadProfilesEnabled: true,
          downloadMode: 'best-video',
          bestQuality: true,
        })
      ),
    });
    await loadEngine(api);

    (document.getElementById('profileAudioBtn') as HTMLButtonElement).click();
    await flush();

    expect(
      document.getElementById('profileAudioFormatContainer')?.classList.contains('hidden')
    ).toBe(false);
    expect(api.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        downloadMode: 'audio',
        audioOnly: true,
        advancedOptions: false,
        bestQuality: false,
      })
    );
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

  it('adds queue URLs with Ctrl+Enter from the queue textarea', async () => {
    const api = buildMockApi();
    await loadEngine(api);
    const queueInput = document.getElementById('queueUrlInput') as HTMLTextAreaElement;
    queueInput.value = 'https://example.com/shortcut';

    queueInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
    );
    await flush();

    expect(api.addToQueue).toHaveBeenCalledWith(['https://example.com/shortcut']);
  });

  it('collapses queue and persists the preference', async () => {
    const api = buildMockApi();
    await loadEngine(api);

    const queueSection = document.getElementById('queueSection') as HTMLElement;
    const queueBody = document.getElementById('queueBody') as HTMLElement;
    const queueToggle = document.getElementById('queueToggleBtn') as HTMLButtonElement;

    expect(queueSection.classList.contains('collapsed')).toBe(false);
    expect(queueToggle.getAttribute('aria-expanded')).toBe('true');

    queueToggle.click();
    await flush(350);

    expect(queueSection.classList.contains('collapsed')).toBe(true);
    expect(queueToggle.getAttribute('aria-expanded')).toBe('false');
    expect(queueBody.getAttribute('aria-hidden')).toBe('true');
    expect(queueBody.inert).toBe(true);
    expect(api.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queueCollapsed: true,
      })
    );
  });

  it('accepts dropped URLs in the queue textarea', async () => {
    const api = buildMockApi();
    await loadEngine(api);
    const queueInput = document.getElementById('queueUrlInput') as HTMLTextAreaElement;
    queueInput.value = 'https://example.com/existing';
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: {
        getData: (type: string) => (type === 'text/uri-list' ? 'https://example.com/dropped' : ''),
      },
    });

    queueInput.dispatchEvent(dropEvent);

    expect(queueInput.value).toBe('https://example.com/existing\nhttps://example.com/dropped');
  });

  it('renders queue updates pushed from the main process', async () => {
    let queueUpdateCb:
      | ((queue: Array<{ id: string; status: string; url: string; addedAt: number }>) => void)
      | null = null;
    const api = buildMockApi({
      onQueueUpdate: ((cb: typeof queueUpdateCb) => {
        queueUpdateCb = cb;
        return () => {};
      }) as unknown as ReturnType<typeof vi.fn>,
    });
    await loadEngine(api);

    queueUpdateCb?.([
      {
        id: 'q_1',
        status: 'pending',
        url: 'https://example.com/queued',
        addedAt: Date.now(),
      },
    ]);
    await flush();

    expect(document.getElementById('queueCount')?.textContent).toBe('1');
    expect(document.getElementById('queueList')?.textContent).toContain('example.com');
  });

  it('persists settings and notifies the main process before close', async () => {
    let prepareForCloseCb: (() => Promise<void>) | null = null;
    const api = buildMockApi({
      onPrepareForClose: ((cb: () => Promise<void>) => {
        prepareForCloseCb = cb;
        return () => {};
      }) as unknown as ReturnType<typeof vi.fn>,
    });
    await loadEngine(api);

    expect(typeof prepareForCloseCb).toBe('function');
    await prepareForCloseCb?.();

    expect(api.saveSettings).toHaveBeenCalled();
    expect(api.notifySettingsFlushed).toHaveBeenCalled();
  });

  it('refreshes the visible theme when settings are imported', async () => {
    let settingsImportedCb: ((settings: ReturnType<typeof defaultSettings>) => void) | null = null;
    const api = buildMockApi({
      onSettingsImported: ((cb: typeof settingsImportedCb) => {
        settingsImportedCb = cb;
        return () => {};
      }) as unknown as ReturnType<typeof vi.fn>,
    });
    await loadEngine(api);

    settingsImportedCb?.({
      ...defaultSettings(),
      theme: 'light',
      queueCollapsed: true,
    });
    await flush();

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.getElementById('queueSection')?.classList.contains('collapsed')).toBe(true);
  });

  it('persists flat UI through settings when the toggle changes', async () => {
    const api = buildMockApi();
    await loadEngine(api);

    const toggle = document.getElementById('flatUiToggle') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(350);

    expect(document.documentElement.dataset.flatUi).toBe('true');
    expect(localStorage.getItem('rosi-flat-ui')).toBe('true');
    expect(api.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        flatUi: true,
      })
    );
  });

  it('starts a direct download from a valid URL and selected folder', async () => {
    const savePath = '/Users/test/Downloads';
    const api = buildMockApi({
      selectDownloadLocation: vi.fn(() => Promise.resolve(savePath)),
    });
    await loadEngine(api);
    const url = document.getElementById('url') as HTMLInputElement;
    url.value = 'https://example.com/video';
    url.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    (document.getElementById('downloadBtn') as HTMLButtonElement).click();
    await flush(50);

    expect(api.selectDownloadLocation).toHaveBeenCalled();
    expect(api.downloadVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/video',
        outputPath: savePath,
      })
    );
  });

  it('uses saved folder for direct downloads unless Ask every time is enabled', async () => {
    const savePath = '/Users/test/Downloads';
    const api = buildMockApi({
      getSettings: vi.fn(() => Promise.resolve({ ...defaultSettings(), downloadFolder: savePath })),
    });
    await loadEngine(api);
    const url = document.getElementById('url') as HTMLInputElement;
    url.value = 'https://example.com/video';
    url.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    (document.getElementById('downloadBtn') as HTMLButtonElement).click();
    await flush(50);

    expect(api.selectDownloadLocation).not.toHaveBeenCalled();
    expect(api.downloadVideo).toHaveBeenCalledWith(
      expect.objectContaining({ outputPath: savePath })
    );
  });

  it('opens folder picker when Ask every time is enabled', async () => {
    const savedPath = '/Users/test/Downloads';
    const selectedPath = '/Users/test/Other Downloads';
    const api = buildMockApi({
      getSettings: vi.fn(() =>
        Promise.resolve({
          ...defaultSettings(),
          downloadFolder: savedPath,
          askDownloadLocation: true,
        })
      ),
      selectDownloadLocation: vi.fn(() => Promise.resolve(selectedPath)),
    });
    await loadEngine(api);
    const url = document.getElementById('url') as HTMLInputElement;
    url.value = 'https://example.com/video';
    url.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    (document.getElementById('downloadBtn') as HTMLButtonElement).click();
    await flush(50);

    expect(api.selectDownloadLocation).toHaveBeenCalledOnce();
    expect(api.downloadVideo).toHaveBeenCalledWith(
      expect.objectContaining({ outputPath: selectedPath })
    );
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
