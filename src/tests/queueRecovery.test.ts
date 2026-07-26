import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
  validateDownloadRequestPayload,
  validateQueueItemIdPayload,
  validateQueueReorderPayload,
} from '../utils/ipcValidation';

describe('queue item id validation', () => {
  it('accepts generated queue ids', () => {
    const result = validateQueueItemIdPayload('  q_1234-abcd  ');
    expect(result).toEqual({ ok: true, data: 'q_1234-abcd' });
  });

  it('rejects non-strings and unsafe ids', () => {
    for (const value of [
      null,
      42,
      '',
      '   ',
      '-leading',
      'has space',
      'bad/slash',
      'x'.repeat(200),
    ]) {
      expect(validateQueueItemIdPayload(value).ok).toBe(false);
    }
  });
});

describe('queue reorder validation', () => {
  it('accepts up and down for a valid id', () => {
    expect(validateQueueReorderPayload({ id: 'q_1', direction: 'up' })).toEqual({
      ok: true,
      data: { id: 'q_1', direction: 'up' },
    });
    expect(validateQueueReorderPayload({ id: 'q_1', direction: 'down' })).toEqual({
      ok: true,
      data: { id: 'q_1', direction: 'down' },
    });
  });

  it('rejects malformed payloads and unknown directions', () => {
    for (const payload of [
      null,
      'q_1',
      {},
      { id: 'q_1' },
      { id: 'q_1', direction: 'sideways' },
      { id: 'bad id', direction: 'up' },
      { direction: 'up' },
    ]) {
      expect(validateQueueReorderPayload(payload).ok).toBe(false);
    }
  });
});

describe('download request playlist and preset fields', () => {
  const outputPath = path.join(os.homedir(), 'Downloads');

  it('preserves a validated playlist range and preset identity', () => {
    const result = validateDownloadRequestPayload({
      url: 'https://example.com/watch?v=abc',
      outputPath,
      playlist: { mode: 'range', start: 2, end: 4 },
      presetId: 'my-preset',
      presetName: 'My Preset',
      profile: 'best-video',
      sponsorblockRemove: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.playlist).toEqual({ mode: 'range', start: 2, end: 4 });
    expect(result.data.presetId).toBe('my-preset');
    expect(result.data.presetName).toBe('My Preset');
    expect(result.data.profile).toBe('best-video');
    expect(result.data.sponsorblockRemove).toBe(true);
  });

  it('rejects unsafe playlist and preset values', () => {
    const base = { url: 'https://example.com/a', outputPath };
    for (const patch of [
      { playlist: { mode: 'range', start: 0, end: 3 } },
      { playlist: 'all' },
      { presetId: 'bad id' },
      { presetId: '' },
      { presetName: 'x'.repeat(60) },
      { presetId: 5 },
      { profile: 'ultra' },
      { audioOutputFormat: 'exe' },
      { gpuType: 'quantum' },
      { subtitleLangs: 'en;rm -rf /' },
      { convertFormat: 'mkv' },
      { videoFormat: 'has space' },
      { sponsorblockRemove: 'yes' },
      { browserChoice: 'netscape' },
    ]) {
      expect(validateDownloadRequestPayload({ ...base, ...patch }).ok).toBe(false);
    }
  });

  it('omits playlist when not provided', () => {
    const result = validateDownloadRequestPayload({ url: 'https://example.com/a', outputPath });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.playlist).toBeUndefined();
  });
});
