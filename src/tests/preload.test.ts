import { beforeEach, describe, expect, it, vi } from 'vitest';

const { exposeInMainWorldMock, invokeMock, sendMock, onMock, removeListenerMock } = vi.hoisted(
  () => ({
    exposeInMainWorldMock: vi.fn(),
    invokeMock: vi.fn(),
    sendMock: vi.fn(),
    onMock: vi.fn(),
    removeListenerMock: vi.fn(),
  })
);

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: exposeInMainWorldMock,
  },
  ipcRenderer: {
    invoke: invokeMock,
    send: sendMock,
    on: onMock,
    removeListener: removeListenerMock,
  },
}));

function getExposedApi() {
  const call = exposeInMainWorldMock.mock.calls[0];
  if (!call) {
    throw new Error('API was not exposed');
  }
  return call[1] as any;
}

async function loadPreloadModule() {
  vi.resetModules();
  exposeInMainWorldMock.mockClear();
  invokeMock.mockClear();
  sendMock.mockClear();
  onMock.mockClear();
  removeListenerMock.mockClear();
  delete process.env.CHANNEL;
  (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore = false;
  await import('../main/preload');
}

function getApiMethod(api: any, methodName: string): (...args: unknown[]) => unknown {
  const method = api[methodName];
  if (typeof method !== 'function') {
    throw new Error(`API method missing: ${methodName}`);
  }
  return method;
}

async function expectInvokeCall(
  api: any,
  methodName: string,
  channel: string,
  args: unknown[] = []
) {
  invokeMock.mockClear();
  await getApiMethod(api, methodName)(...args);
  expect(invokeMock).toHaveBeenCalledWith(channel, ...args);
}

function expectSendCall(api: any, methodName: string, channel: string, args: unknown[] = []) {
  sendMock.mockClear();
  getApiMethod(api, methodName)(...args);
  expect(sendMock).toHaveBeenCalledWith(channel, ...args);
}

describe('preload api contract', () => {
  beforeEach(async () => {
    await loadPreloadModule();
  });

  it('exposes the expected renderer API methods', () => {
    expect(exposeInMainWorldMock).toHaveBeenCalledOnce();
    expect(exposeInMainWorldMock).toHaveBeenCalledWith('api', expect.any(Object));
    const api = getExposedApi();
    expect(Object.keys(api).sort()).toEqual(
      [
        'addToQueue',
        'cancelDownload',
        'cancelFormats',
        'cancelQueue',
        'cancelUpdateDownload',
        'cancelVideoInfo',
        'checkDenoInstalled',
        'checkForUpdates',
        'clearQueue',
        'detectGpu',
        'downloadUpdate',
        'downloadVideo',
        'exportSettings',
        'getAppVersion',
        'getChannel',
        'getFormats',
        'getQueue',
        'getSettings',
        'getStats',
        'getVideoInfo',
        'importSettings',
        'installDeno',
        'installUpdate',
        'isPackaged',
        'logError',
        'notifySettingsFlushed',
        'onComplete',
        'onPrepareForClose',
        'onProgress',
        'onQueueUpdate',
        'onSettingsImported',
        'onUpdaterProgress',
        'onUpdaterStatus',
        'openExternal',
        'openFileLocation',
        'removeFromQueue',
        'resetSettings',
        'resetStats',
        'restartApp',
        'saveSettings',
        'selectDownloadLocation',
        'showNotification',
        'startQueue',
      ].sort()
    );
  });

  it('maps invoke-based methods to the correct IPC channels', async () => {
    const api = getExposedApi();
    const settingsPatch = { theme: 'dark' };
    const notification = { title: 'Done', body: 'Saved' };
    const downloadOptions = { url: 'https://example.com', outputPath: '/tmp' };

    await expectInvokeCall(api, 'restartApp', 'restart-app');
    await expectInvokeCall(api, 'getFormats', 'getFormats', ['https://example.com']);
    await expectInvokeCall(api, 'getVideoInfo', 'get-video-info', ['https://example.com']);
    await expectInvokeCall(api, 'selectDownloadLocation', 'select-download-location');
    await expectInvokeCall(api, 'getSettings', 'get-settings');
    await expectInvokeCall(api, 'saveSettings', 'save-settings', [settingsPatch]);
    await expectInvokeCall(api, 'openExternal', 'open-external', ['https://rosie.run']);
    await expectInvokeCall(api, 'downloadVideo', 'download-video', [downloadOptions]);
    await expectInvokeCall(api, 'getAppVersion', 'get-app-version');
    await expectInvokeCall(api, 'checkDenoInstalled', 'check-deno-installed');
    await expectInvokeCall(api, 'installDeno', 'install-deno');
    await expectInvokeCall(api, 'detectGpu', 'detect-gpu');
    await expectInvokeCall(api, 'isPackaged', 'is-packaged');
    await expectInvokeCall(api, 'checkForUpdates', 'check-for-updates');
    await expectInvokeCall(api, 'downloadUpdate', 'download-update');
    await expectInvokeCall(api, 'openFileLocation', 'open-file-location', ['C:/tmp/file.txt']);
    await expectInvokeCall(api, 'showNotification', 'show-notification', [notification]);
    await expectInvokeCall(api, 'exportSettings', 'export-settings');
    await expectInvokeCall(api, 'importSettings', 'import-settings');
    await expectInvokeCall(api, 'getStats', 'get-stats');
    await expectInvokeCall(api, 'resetStats', 'reset-stats');
    await expectInvokeCall(api, 'addToQueue', 'add-to-queue', [['https://example.com/a']]);
    await expectInvokeCall(api, 'removeFromQueue', 'remove-from-queue', ['q_1']);
    await expectInvokeCall(api, 'clearQueue', 'clear-queue');
    await expectInvokeCall(api, 'getQueue', 'get-queue');
    await expectInvokeCall(api, 'startQueue', 'start-queue');
    await expectInvokeCall(api, 'cancelQueue', 'cancel-queue');
  });

  it('maps send-based methods to the correct IPC channels', () => {
    const api = getExposedApi();
    expectSendCall(api, 'logError', 'log-error', ['test error']);
    expectSendCall(api, 'resetSettings', 'reset-settings');
    expectSendCall(api, 'cancelDownload', 'cancel-download');
    expectSendCall(api, 'cancelFormats', 'cancel-formats');
    expectSendCall(api, 'cancelVideoInfo', 'cancel-video-info');
    expectSendCall(api, 'cancelUpdateDownload', 'cancel-update-download');
    expectSendCall(api, 'installUpdate', 'install-update');
    expectSendCall(api, 'notifySettingsFlushed', 'settings-flush-complete');
  });

  it('registers and cleans up event subscriptions', () => {
    const api = getExposedApi();
    const callback = vi.fn();

    const validateSubscription = (
      methodName: string,
      channel: string,
      payload: unknown,
      expectedCallbackArg: unknown = payload
    ) => {
      onMock.mockClear();
      removeListenerMock.mockClear();
      callback.mockClear();

      const unsubscribe = getApiMethod(api, methodName)(callback) as () => void;
      expect(onMock).toHaveBeenCalledWith(channel, expect.any(Function));
      const firstOnCall = onMock.mock.calls[0];
      if (!firstOnCall) {
        throw new Error('Expected ipcRenderer.on to be called');
      }
      const listener = firstOnCall[1] as (...args: unknown[]) => void;
      listener({}, payload);
      expect(callback).toHaveBeenCalledWith(expectedCallbackArg);

      unsubscribe();
      expect(removeListenerMock).toHaveBeenCalledWith(channel, listener);
    };

    validateSubscription('onUpdaterStatus', 'updater-status', { status: 'checking' });
    validateSubscription('onUpdaterProgress', 'updater-progress', { percent: 50 });
    validateSubscription('onSettingsImported', 'settings-imported', { imported: true });
    validateSubscription('onProgress', 'progress', 'line');
    validateSubscription('onComplete', 'complete', 'done');
    validateSubscription('onQueueUpdate', 'queue-update', [{ id: 'q_1' }]);

    onMock.mockClear();
    removeListenerMock.mockClear();
    callback.mockClear();
    const unsubscribePrepareForClose = getApiMethod(
      api,
      'onPrepareForClose'
    )(callback) as () => void;
    expect(onMock).toHaveBeenCalledWith('prepare-for-close', expect.any(Function));
    const firstOnCall = onMock.mock.calls[0];
    if (!firstOnCall) {
      throw new Error('Expected prepare-for-close listener to be registered');
    }
    const prepareForCloseListener = firstOnCall[1] as (...args: unknown[]) => void;
    prepareForCloseListener({});
    expect(callback).toHaveBeenCalledTimes(1);
    unsubscribePrepareForClose();
    expect(removeListenerMock).toHaveBeenCalledWith('prepare-for-close', prepareForCloseListener);
  });

  it('returns expected channel by environment flags', async () => {
    let api = getExposedApi();
    expect(api.getChannel()).toBe('github');

    process.env.CHANNEL = 'msstore';
    expect(api.getChannel()).toBe('msstore');

    delete process.env.CHANNEL;
    (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore = true;
    expect(api.getChannel()).toBe('msstore');

    await loadPreloadModule();
    api = getExposedApi();
    expect(api.getChannel()).toBe('github');
  });
});
