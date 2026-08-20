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
    settingsVersion: 7,
    theme: 'dark',
    showConsoleOutput: false,
    consoleCollapsed: false,
    queueCollapsed: false,
    downloadProfilesEnabled: false,
    downloadMode: 'best-video',
    downloadPresets: [],
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
    showTaskbarProgress: true,
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
    getAppPlatform: vi.fn(() => Promise.resolve('darwin' as NodeJS.Platform)),
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
    addToQueue: vi.fn(() => ok({ added: 1, skipped: 0 })),
    removeFromQueue: vi.fn(() => ok(undefined)),
    retryQueueItem: vi.fn(() => ok(undefined)),
    reorderQueueItem: vi.fn(() => ok(undefined)),
    clearQueue: vi.fn(() => ok(undefined)),
    startQueue: vi.fn(() => ok({ started: true })),
    cancelQueue: vi.fn(() => ok(undefined)),
    getStats: vi.fn(() => Promise.resolve({})),
    resetStats: vi.fn(() => ok(undefined)),
    getDefaultSettings: vi.fn(() => ok(defaultSettings())),
    getDownloadActivity: vi.fn(() => ok([])),
    clearDownloadActivity: vi.fn(() => ok(undefined)),
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
    onJobProgress: noop,
    onMenuAction: noop,
    onComplete: noop,
    onDownloadComplete: noop,
    onDownloadActivityUpdate: noop,
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

  it('asks once for a destination when Ask every time is enabled', async () => {
    const api = buildMockApi({
      getSettings: vi.fn(() =>
        Promise.resolve({ ...defaultSettings(), askDownloadLocation: true })
      ) as unknown as ReturnType<typeof vi.fn>,
      selectDownloadLocation: vi.fn(() => Promise.resolve('/tmp/queue-target')),
    });
    await loadEngine(api);

    const queueInput = document.getElementById('queueUrlInput') as HTMLTextAreaElement;
    queueInput.value = 'https://example.com/a\nhttps://example.com/b';
    (document.getElementById('addToQueueBtn') as HTMLButtonElement).click();
    await flush(30);

    // One prompt for the whole batch, and the choice is sent as an override.
    expect(api.selectDownloadLocation).toHaveBeenCalledTimes(1);
    expect(api.addToQueue).toHaveBeenCalledWith(
      ['https://example.com/a', 'https://example.com/b'],
      expect.objectContaining({ outputPath: '/tmp/queue-target' })
    );
  });

  it('queues nothing when the destination prompt is dismissed', async () => {
    const api = buildMockApi({
      getSettings: vi.fn(() =>
        Promise.resolve({ ...defaultSettings(), askDownloadLocation: true })
      ) as unknown as ReturnType<typeof vi.fn>,
      selectDownloadLocation: vi.fn(() => Promise.resolve(null)),
    });
    await loadEngine(api);

    const queueInput = document.getElementById('queueUrlInput') as HTMLTextAreaElement;
    queueInput.value = 'https://example.com/a';
    (document.getElementById('addToQueueBtn') as HTMLButtonElement).click();
    await flush(30);

    expect(api.addToQueue).not.toHaveBeenCalled();
    expect(queueInput.value).toBe('https://example.com/a');
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

  it('sends playlist current with a selected preset so All/Range presets cannot override the radios', async () => {
    const api = buildMockApi({
      getSettings: vi.fn(() =>
        Promise.resolve({
          ...defaultSettings(),
          downloadPresets: [
            {
              id: 'p-all',
              name: 'Whole playlist',
              profile: 'best-video',
              playlist: { mode: 'all' },
            },
          ],
        })
      ) as unknown as ReturnType<typeof vi.fn>,
    });
    await loadEngine(api);

    const presetSelect = document.getElementById('downloadPresetSelect') as HTMLSelectElement;
    presetSelect.value = 'p-all';
    presetSelect.dispatchEvent(new Event('change', { bubbles: true }));

    // Radios only count once the playlist scope UI is visible (after a playlist preview).
    document.getElementById('playlistScope')?.classList.remove('hidden');
    const currentRadio = document.querySelector(
      'input[name="playlist-scope"][value="current"]'
    ) as HTMLInputElement;
    currentRadio.checked = true;

    const queueInput = document.getElementById('queueUrlInput') as HTMLTextAreaElement;
    queueInput.value = 'https://example.com/watch';
    (document.getElementById('addToQueueBtn') as HTMLButtonElement).click();
    await flush();

    expect(api.addToQueue).toHaveBeenCalledWith(
      ['https://example.com/watch'],
      expect.objectContaining({
        presetId: 'p-all',
        playlist: { mode: 'current' },
      })
    );
  });

  it('flushes settings and sends custom format IDs when queueing in advanced mode', async () => {
    const api = buildMockApi({
      getSettings: vi.fn(() =>
        Promise.resolve({
          ...defaultSettings(),
          downloadProfilesEnabled: true,
          downloadMode: 'custom',
          advancedOptions: true,
        })
      ) as unknown as ReturnType<typeof vi.fn>,
    });
    await loadEngine(api);

    const videoSelect = document.getElementById('videoFormat') as HTMLSelectElement;
    const audioSelect = document.getElementById('audioFormat') as HTMLSelectElement;
    videoSelect.appendChild(new Option('137', '137'));
    audioSelect.appendChild(new Option('140', '140'));
    videoSelect.value = '137';
    audioSelect.value = '140';

    const queueInput = document.getElementById('queueUrlInput') as HTMLTextAreaElement;
    queueInput.value = 'https://example.com/watch';
    (document.getElementById('addToQueueBtn') as HTMLButtonElement).click();
    await flush();

    expect(api.saveSettings).toHaveBeenCalled();
    expect(api.addToQueue).toHaveBeenCalledWith(
      ['https://example.com/watch'],
      expect.objectContaining({
        videoFormat: '137',
        audioFormat: '140',
      })
    );
  });

  it('does not queue when settings cannot be saved', async () => {
    const api = buildMockApi({
      saveSettings: vi.fn(() =>
        Promise.resolve({ ok: false, error: { message: 'disk full' } })
      ) as unknown as ReturnType<typeof vi.fn>,
    });
    await loadEngine(api);
    const queueInput = document.getElementById('queueUrlInput') as HTMLTextAreaElement;
    queueInput.value = 'https://example.com/watch';
    (document.getElementById('addToQueueBtn') as HTMLButtonElement).click();
    await flush();
    expect(api.addToQueue).not.toHaveBeenCalled();
  });

  it('saves custom format IDs on a preset', async () => {
    const api = buildMockApi({
      getSettings: vi.fn(() =>
        Promise.resolve({
          ...defaultSettings(),
          downloadProfilesEnabled: true,
          downloadMode: 'custom',
          advancedOptions: true,
        })
      ) as unknown as ReturnType<typeof vi.fn>,
    });
    await loadEngine(api);

    const videoSelect = document.getElementById('videoFormat') as HTMLSelectElement;
    const audioSelect = document.getElementById('audioFormat') as HTMLSelectElement;
    videoSelect.appendChild(new Option('137', '137'));
    audioSelect.appendChild(new Option('140', '140'));
    videoSelect.value = '137';
    audioSelect.value = '140';

    (document.getElementById('presetNameInput') as HTMLInputElement).value = 'Custom 1080';
    (document.getElementById('savePresetBtn') as HTMLButtonElement).click();
    await flush();

    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        downloadPresets: [
          expect.objectContaining({
            name: 'Custom 1080',
            videoFormat: '137',
            audioFormatId: '140',
          }),
        ],
      })
    );
  });

  it('applies a playlist preset onto the radios', async () => {
    const api = buildMockApi({
      getSettings: vi.fn(() =>
        Promise.resolve({
          ...defaultSettings(),
          downloadPresets: [
            {
              id: 'p-range',
              name: 'Range 2-5',
              profile: 'best-video',
              playlist: { mode: 'range', start: 2, end: 5 },
            },
          ],
        })
      ) as unknown as ReturnType<typeof vi.fn>,
    });
    await loadEngine(api);

    const presetSelect = document.getElementById('downloadPresetSelect') as HTMLSelectElement;
    presetSelect.value = 'p-range';
    presetSelect.dispatchEvent(new Event('change', { bubbles: true }));
    (document.getElementById('applyPresetBtn') as HTMLButtonElement).click();
    await flush();

    expect(
      (
        document.querySelector(
          'input[name="playlist-scope"][value="range"]'
        ) as HTMLInputElement | null
      )?.checked
    ).toBe(true);
    expect((document.getElementById('playlistRangeStart') as HTMLInputElement).value).toBe('2');
    expect((document.getElementById('playlistRangeEnd') as HTMLInputElement).value).toBe('5');
    expect(document.getElementById('playlistScope')?.classList.contains('hidden')).toBe(false);
  });

  it('keeps a selected All playlist preset when radios are still hidden', async () => {
    const api = buildMockApi({
      getSettings: vi.fn(() =>
        Promise.resolve({
          ...defaultSettings(),
          downloadPresets: [
            {
              id: 'p-all',
              name: 'Whole playlist',
              profile: 'best-video',
              playlist: { mode: 'all' },
            },
          ],
        })
      ) as unknown as ReturnType<typeof vi.fn>,
    });
    await loadEngine(api);

    const presetSelect = document.getElementById('downloadPresetSelect') as HTMLSelectElement;
    presetSelect.value = 'p-all';
    presetSelect.dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.getElementById('playlistScope')?.classList.contains('hidden')).toBe(true);

    const queueInput = document.getElementById('queueUrlInput') as HTMLTextAreaElement;
    queueInput.value = 'https://example.com/watch';
    (document.getElementById('addToQueueBtn') as HTMLButtonElement).click();
    await flush();

    expect(api.addToQueue).toHaveBeenCalledWith(
      ['https://example.com/watch'],
      expect.objectContaining({
        presetId: 'p-all',
        convertEnabled: false,
      })
    );
    const overrides = (api.addToQueue as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as
      Record<string, unknown> | undefined;
    expect(overrides?.playlist).toBeUndefined();
  });

  it('detects multi-link paste into the download field using spaces', async () => {
    const api = buildMockApi();
    await loadEngine(api);
    const urlInput = document.getElementById('url') as HTMLInputElement;
    urlInput.value = 'https://example.com/a https://example.com/b';
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(document.querySelector('.download-card')?.classList.contains('is-batch')).toBe(true);
    expect(document.getElementById('downloadBtn')?.textContent).toContain('Add 2 to Queue');
  });

  it('filters settings sections by search text', async () => {
    const api = buildMockApi();
    await loadEngine(api);
    const search = document.getElementById('settingsSearch') as HTMLInputElement;
    search.value = 'gpu acceleration';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(
      document.getElementById('gpuAccelerationLabel')?.classList.contains('search-hidden')
    ).toBe(false);
    expect(
      document
        .getElementById('gpuAccelerationLabel')
        ?.closest('.settings-section')
        ?.classList.contains('search-hidden')
    ).toBe(false);
    expect(document.querySelectorAll('.settings-section.search-hidden').length).toBeGreaterThan(0);
  });

  it('replays activity using the entry url when the stored request omitted it', async () => {
    let activityCb: ((entries: unknown[]) => void) | null = null;
    const api = buildMockApi({
      onDownloadActivityUpdate: ((cb: (entries: unknown[]) => void) => {
        activityCb = cb;
        return () => {};
      }) as unknown as ReturnType<typeof vi.fn>,
    });
    await loadEngine(api);
    activityCb!([
      {
        id: 'a-replay',
        owner: 'manual',
        outcome: 'success',
        statusMessage: 'Download complete.',
        url: 'https://example.com/again',
        request: { outputPath: '/tmp/rosi' },
        filename: 'again.mp4',
        startedAt: Date.now() - 1000,
        completedAt: Date.now(),
      },
    ]);
    await flush();

    const replayBtn = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Download again'
    );
    expect(replayBtn).toBeTruthy();
    replayBtn!.click();
    await flush();

    expect(api.downloadVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/again',
        outputPath: '/tmp/rosi',
      })
    );
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

    expect(api.getVideoInfo).toHaveBeenCalledWith('https://youtube.com/watch?v=abc', 'current');
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

  it('renders activity from the main process instead of localStorage', async () => {
    let activityCb: ((entries: unknown[]) => void) | null = null;
    const api = buildMockApi({
      onDownloadActivityUpdate: ((cb: (entries: unknown[]) => void) => {
        activityCb = cb;
        return () => {};
      }) as unknown as ReturnType<typeof vi.fn>,
    });
    await loadEngine(api);
    expect(api.getDownloadActivity).toHaveBeenCalled();
    expect(document.querySelector('.history-empty')?.textContent).toContain('No downloads yet');

    expect(typeof activityCb).toBe('function');
    activityCb!([
      {
        id: 'a1',
        owner: 'manual',
        outcome: 'success',
        statusMessage: 'Download complete.',
        url: 'https://example.com/video',
        request: { url: 'https://example.com/video', outputPath: '/tmp' },
        filename: 'video.mp4',
        sizeBytes: 2048,
        startedAt: Date.now() - 1000,
        completedAt: Date.now(),
      },
    ]);
    await flush();

    expect(document.getElementById('history-count')?.textContent).toBe('1');
    expect(document.querySelector('.history-filename')?.textContent).toBe('video.mp4');
    expect(localStorage.getItem('rosi-download-history')).toBeNull();
  });

  it('filters activity rows by outcome', async () => {
    const api = buildMockApi({
      getDownloadActivity: vi.fn(() =>
        Promise.resolve({
          ok: true,
          data: [
            {
              id: 'ok1',
              owner: 'manual',
              outcome: 'success',
              statusMessage: 'done',
              url: 'https://example.com/a',
              request: { url: 'https://example.com/a', outputPath: '/tmp' },
              filename: 'a.mp4',
              startedAt: 1,
              completedAt: 2,
            },
            {
              id: 'bad1',
              owner: 'queue',
              outcome: 'failed',
              statusMessage: 'failed',
              url: 'https://example.com/b',
              request: { url: 'https://example.com/b', outputPath: '/tmp' },
              error: 'network unreachable',
              startedAt: 1,
              completedAt: 2,
            },
          ],
        })
      ) as unknown as ReturnType<typeof vi.fn>,
    });
    await loadEngine(api);
    await flush(20);
    expect(document.querySelectorAll('.history-item')).toHaveLength(2);

    document.querySelector<HTMLButtonElement>('[data-activity-filter="failed"]')!.click();
    await flush();
    const rows = document.querySelectorAll('.history-item');
    expect(rows).toHaveLength(1);
    expect(document.querySelector('.history-error')?.textContent).toBe('network unreachable');
  });
});
