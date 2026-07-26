import { describe, expect, it } from 'vitest';
import {
  applyQueueWeighting,
  buildJobProgressEvent,
  computeItemOverallPercent,
  formatYtdlpProgressSummary,
  inferJobProgressPlan,
  parseFfmpegDurationFromProbe,
  parseFfmpegProgressChunk,
  parseYtdlpProgress,
  tryParseYtdlpProgressJson,
  ytdlpJsonToPhasePercent,
  createFfmpegProgressParseState,
  resolveJobProgressPlanFromSettings,
} from '../utils/downloadJobProgress';

describe('downloadJobProgress', () => {
  it('parseYtdlpProgress parses full and simple lines', () => {
    expect(parseYtdlpProgress('[download]  45.2% of ~10.5MiB at  1.2MiB/s ETA 00:08')).toEqual({
      percent: 45.2,
      totalSize: '10.5MiB',
      speed: '1.2MiB/s',
      eta: '00:08',
    });
    expect(parseYtdlpProgress('[download]  10.0% of ~5.00MiB')).toEqual({
      percent: 10,
      totalSize: '5.00MiB',
      speed: null,
      eta: null,
    });
    expect(parseYtdlpProgress('random')).toBeNull();
  });

  it('parses yt-dlp JSON progress and computes percent from bytes', () => {
    const json = tryParseYtdlpProgressJson(
      '{"status":"downloading","downloaded_bytes":500,"total_bytes":1000,"eta":5,"speed":100}'
    );
    expect(json).not.toBeNull();
    expect(ytdlpJsonToPhasePercent(json!)).toBe(50);
  });

  it('uses fragment index when byte totals are missing', () => {
    const percent = ytdlpJsonToPhasePercent({
      status: 'downloading',
      fragment_index: 2,
      fragment_count: 4,
    });
    expect(percent).toBe(50);
  });

  it('computes weighted overall percent for download-only jobs', () => {
    const plan = { expectMerge: false, expectConvert: false };
    expect(computeItemOverallPercent('download', 50, plan)).toBe(50);
  });

  it('computes weighted overall percent with merge and convert', () => {
    const plan = { expectMerge: true, expectConvert: true };
    expect(computeItemOverallPercent('download', 100, plan)).toBe(70);
    expect(computeItemOverallPercent('merge', 100, plan)).toBe(85);
    expect(computeItemOverallPercent('convert', 100, plan)).toBe(100);
  });

  it('blends queue progress', () => {
    const blended = applyQueueWeighting(50, { completedItems: 1, queueTotal: 4 });
    expect(blended).toBe(37.5);
  });

  it('buildJobProgressEvent marks indeterminate when phase percent is NaN', () => {
    const event = buildJobProgressEvent(
      'merge',
      Number.NaN,
      { expectMerge: true, expectConvert: false },
      null,
      'Merging...',
      undefined,
      true
    );
    expect(event.indeterminate).toBe(true);
    expect(event.overallPercent).toBeGreaterThanOrEqual(70);
  });

  it('formatYtdlpProgressSummary builds human-readable details', () => {
    const summary = formatYtdlpProgressSummary(
      {
        status: 'downloading',
        downloaded_bytes: 512000,
        total_bytes: 1024000,
        speed: 256000,
        eta: 2,
      },
      50
    );
    expect(summary.status).toBe('Downloading...');
    expect(summary.details).toContain('50.0%');
    expect(summary.details).toContain('ETA');
  });

  it('parses ffmpeg duration and progress chunks', () => {
    const duration = parseFfmpegDurationFromProbe(
      'Input #0, mov, Duration: 00:01:30.50, start: 0.000000'
    );
    expect(duration).toBeCloseTo(90.5, 1);

    const state = createFfmpegProgressParseState(100);
    const percent = parseFfmpegProgressChunk(state, 'out_time_ms=50000\n');
    expect(percent).toBe(50);
  });

  it('inferJobProgressPlan detects merge from format selector', () => {
    expect(inferJobProgressPlan(false, 'bestvideo+bestaudio/best').expectMerge).toBe(true);
    expect(inferJobProgressPlan(true, 'best[ext=mp4]/best').expectConvert).toBe(true);
  });

  it('resolveJobProgressPlanFromSettings respects download profiles', () => {
    expect(
      resolveJobProgressPlanFromSettings({
        downloadProfilesEnabled: true,
        downloadMode: 'best-video',
        bestQuality: false,
        audioOnly: false,
        advancedOptions: false,
        convertEnabled: true,
      })
    ).toEqual({ expectMerge: true, expectConvert: true });

    expect(
      resolveJobProgressPlanFromSettings({
        downloadProfilesEnabled: true,
        downloadMode: 'audio',
        bestQuality: false,
        audioOnly: false,
        advancedOptions: false,
        convertEnabled: false,
      })
    ).toEqual({ expectMerge: false, expectConvert: false });
  });
});
