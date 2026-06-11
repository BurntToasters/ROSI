import { describe, it, expect, vi } from 'vitest';

vi.mock('../main/platform', () => ({
  spawnWithEnv: vi.fn(),
}));

vi.mock('electron-log/main.js', () => ({
  default: { warn: vi.fn(), error: vi.fn() },
}));

import { parseVideoInfo } from '../main/download/videoInfo';

describe('parseVideoInfo', () => {
  it('returns null for invalid JSON', () => {
    expect(parseVideoInfo('not json')).toBeNull();
    expect(parseVideoInfo('')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseVideoInfo('42')).toBeNull();
    expect(parseVideoInfo('"string"')).toBeNull();
    expect(parseVideoInfo('[1,2,3]')).toBeNull();
  });

  it('extracts the trimmed subset from a single video', () => {
    const info = parseVideoInfo(
      JSON.stringify({
        title: 'Test Video',
        uploader: 'Test Channel',
        duration: 125,
        thumbnail: 'https://i.ytimg.com/vi/abc/maxres.jpg',
        ext: 'mp4',
        view_count: 1234,
        webpage_url: 'https://youtube.com/watch?v=abc',
        formats: [{ format_id: '137' }],
      })
    );
    expect(info).toEqual({
      title: 'Test Video',
      uploader: 'Test Channel',
      durationSeconds: 125,
      thumbnail: 'https://i.ytimg.com/vi/abc/maxres.jpg',
      ext: 'mp4',
      viewCount: 1234,
      isPlaylist: false,
      playlistCount: null,
      webpageUrl: 'https://youtube.com/watch?v=abc',
    });
  });

  it('falls back to channel/creator for uploader and fulltitle for title', () => {
    const info = parseVideoInfo(JSON.stringify({ fulltitle: 'Full', channel: 'Chan' }));
    expect(info?.title).toBe('Full');
    expect(info?.uploader).toBe('Chan');
  });

  it('rejects non-http thumbnails to avoid unsafe img src', () => {
    const info = parseVideoInfo(JSON.stringify({ title: 'X', thumbnail: 'javascript:alert(1)' }));
    expect(info?.thumbnail).toBeNull();
  });

  it('uses the last entry of thumbnails array when top-level thumbnail is missing', () => {
    const info = parseVideoInfo(
      JSON.stringify({
        title: 'X',
        thumbnails: [
          { url: 'https://example.com/low.jpg' },
          { url: 'https://example.com/high.jpg' },
        ],
      })
    );
    expect(info?.thumbnail).toBe('https://example.com/high.jpg');
  });

  it('detects playlists and counts entries', () => {
    const info = parseVideoInfo(
      JSON.stringify({
        _type: 'playlist',
        title: 'My Playlist',
        entries: [{ title: 'a', thumbnail: 'https://example.com/a.jpg' }, { title: 'b' }],
      })
    );
    expect(info?.isPlaylist).toBe(true);
    expect(info?.playlistCount).toBe(2);
    expect(info?.thumbnail).toBe('https://example.com/a.jpg');
  });

  it('uses Playlist as the fallback title for playlist payloads', () => {
    const info = parseVideoInfo(JSON.stringify({ _type: 'playlist', entries: [{ title: 'a' }] }));
    expect(info?.title).toBe('Playlist');
    expect(info?.isPlaylist).toBe(true);
  });

  it('defaults missing optional fields to null', () => {
    const info = parseVideoInfo(JSON.stringify({ title: 'Bare' }));
    expect(info).toEqual({
      title: 'Bare',
      uploader: null,
      durationSeconds: null,
      thumbnail: null,
      ext: null,
      viewCount: null,
      isPlaylist: false,
      playlistCount: null,
      webpageUrl: null,
    });
  });
});
