export type DownloadJobPhase = 'download' | 'merge' | 'convert' | 'idle';

export interface JobProgressEvent {
  phase: DownloadJobPhase;
  /** 0–100 within the current phase; NaN means indeterminate for that phase */
  phasePercent: number;
  /** 0–100 for the current queue item (or single download) */
  overallPercent: number;
  status: string;
  details?: string;
  indeterminate?: boolean;
}

export interface ParsedYtdlpProgress {
  percent: number;
  totalSize: string;
  speed: string | null;
  eta: string | null;
}

export interface JobProgressPlan {
  expectMerge: boolean;
  expectConvert: boolean;
}

export interface QueueProgressContext {
  completedItems: number;
  queueTotal: number;
}

export interface YtdlpProgressJson {
  status?: string;
  downloaded_bytes?: number;
  total_bytes?: number;
  total_bytes_estimate?: number;
  eta?: number;
  speed?: number;
  fragment_index?: number;
  fragment_count?: number;
}

const PHASE_DOWNLOAD_END = 70;
const PHASE_MERGE_END = 85;
const PHASE_CONVERT_END = 100;

export function parseYtdlpProgress(message: string): ParsedYtdlpProgress | null {
  const progressMatch = message.match(
    /\[download\]\s+(\d+\.?\d*)%\s+of\s+~?(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/
  );
  if (progressMatch?.[1] && progressMatch[2] && progressMatch[3] && progressMatch[4]) {
    return {
      percent: parseFloat(progressMatch[1]),
      totalSize: progressMatch[2],
      speed: progressMatch[3],
      eta: progressMatch[4],
    };
  }

  const simpleMatch = message.match(/\[download\]\s+(\d+\.?\d*)%\s+of\s+~?(\S+)/);
  if (simpleMatch?.[1] && simpleMatch[2]) {
    return {
      percent: parseFloat(simpleMatch[1]),
      totalSize: simpleMatch[2],
      speed: null,
      eta: null,
    };
  }

  return null;
}

export function tryParseYtdlpProgressJson(line: string): YtdlpProgressJson | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as YtdlpProgressJson;
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  const value = bytes / Math.pow(k, i);
  return `${parseFloat(value.toFixed(2))} ${sizes[i] ?? 'B'}`;
}

export function formatEta(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function ytdlpJsonToPhasePercent(data: YtdlpProgressJson): number {
  if (data.status === 'finished') return 100;

  const total = data.total_bytes ?? data.total_bytes_estimate;
  if (typeof data.downloaded_bytes === 'number' && typeof total === 'number' && total > 0) {
    return Math.min(100, (data.downloaded_bytes / total) * 100);
  }

  if (
    typeof data.fragment_index === 'number' &&
    typeof data.fragment_count === 'number' &&
    data.fragment_count > 0
  ) {
    return Math.min(100, (data.fragment_index / data.fragment_count) * 100);
  }

  return Number.NaN;
}

export function formatYtdlpProgressSummary(
  data: YtdlpProgressJson,
  phasePercent: number
): { status: string; details: string } {
  const total = data.total_bytes ?? data.total_bytes_estimate;
  const percentLabel = Number.isFinite(phasePercent) ? `${phasePercent.toFixed(1)}%` : '…';
  const totalLabel = typeof total === 'number' ? formatBytes(total) : 'unknown size';
  const speedLabel =
    typeof data.speed === 'number' && data.speed > 0 ? `${formatBytes(data.speed)}/s` : null;
  const etaLabel = formatEta(data.eta);

  const parts = [`${percentLabel} of ${totalLabel}`];
  if (speedLabel) parts.push(`at ${speedLabel}`);
  if (etaLabel) parts.push(`ETA ${etaLabel}`);

  return {
    status: 'Downloading...',
    details: parts.join(' '),
  };
}

export function computeItemOverallPercent(
  phase: DownloadJobPhase,
  phasePercent: number,
  plan: JobProgressPlan
): number {
  const clampedPhase = Number.isFinite(phasePercent) ? Math.max(0, Math.min(100, phasePercent)) : 0;

  const { expectMerge, expectConvert } = plan;

  if (!expectMerge && !expectConvert) {
    if (phase === 'download') return clampedPhase;
    if (phase === 'idle') return 0;
    return 100;
  }

  if (expectMerge && !expectConvert) {
    if (phase === 'download') return (clampedPhase / 100) * PHASE_DOWNLOAD_END;
    if (phase === 'merge') {
      const span = PHASE_MERGE_END - PHASE_DOWNLOAD_END;
      return PHASE_DOWNLOAD_END + (clampedPhase / 100) * span;
    }
    return phase === 'idle' ? 0 : 100;
  }

  if (!expectMerge && expectConvert) {
    if (phase === 'download') return (clampedPhase / 100) * PHASE_DOWNLOAD_END;
    if (phase === 'convert') {
      const span = PHASE_CONVERT_END - PHASE_DOWNLOAD_END;
      return PHASE_DOWNLOAD_END + (clampedPhase / 100) * span;
    }
    return phase === 'idle' ? 0 : 100;
  }

  // merge + convert
  if (phase === 'download') return (clampedPhase / 100) * PHASE_DOWNLOAD_END;
  if (phase === 'merge') {
    const span = PHASE_MERGE_END - PHASE_DOWNLOAD_END;
    return PHASE_DOWNLOAD_END + (clampedPhase / 100) * span;
  }
  if (phase === 'convert') {
    const span = PHASE_CONVERT_END - PHASE_MERGE_END;
    return PHASE_MERGE_END + (clampedPhase / 100) * span;
  }
  return phase === 'idle' ? 0 : 100;
}

export function applyQueueWeighting(
  itemOverallPercent: number,
  queue: QueueProgressContext | null
): number {
  if (!queue || queue.queueTotal <= 0) {
    return Math.max(0, Math.min(100, itemOverallPercent));
  }
  const itemFraction = Math.max(0, Math.min(100, itemOverallPercent)) / 100;
  const blended = ((queue.completedItems + itemFraction) / queue.queueTotal) * 100;
  return Math.max(0, Math.min(100, blended));
}

export function buildJobProgressEvent(
  phase: DownloadJobPhase,
  phasePercent: number,
  plan: JobProgressPlan,
  queue: QueueProgressContext | null,
  status: string,
  details?: string,
  indeterminate?: boolean
): JobProgressEvent {
  const itemOverall = computeItemOverallPercent(phase, phasePercent, plan);
  const overallPercent = applyQueueWeighting(itemOverall, queue);
  const isIndeterminate =
    indeterminate === true || (indeterminate !== false && !Number.isFinite(phasePercent));

  return {
    phase,
    phasePercent: Number.isFinite(phasePercent) ? phasePercent : Number.NaN,
    overallPercent,
    status,
    details,
    indeterminate: isIndeterminate,
  };
}

export function parseFfmpegDurationFromProbe(stderr: string): number | null {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseFloat(match[3]);
  if (!Number.isFinite(hours + minutes + seconds)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

export interface FfmpegProgressParseState {
  buffer: string;
  durationSeconds: number | null;
}

export function createFfmpegProgressParseState(
  durationSeconds: number | null
): FfmpegProgressParseState {
  return { buffer: '', durationSeconds };
}

export function parseFfmpegProgressChunk(
  state: FfmpegProgressParseState,
  chunk: string
): number | null {
  state.buffer += chunk;
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop() ?? '';

  let outTimeUs: number | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('out_time_us=')) {
      const raw = trimmed.slice('out_time_us='.length);
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) outTimeUs = parsed;
    }
    if (trimmed.startsWith('out_time_ms=')) {
      const raw = trimmed.slice('out_time_ms='.length);
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) outTimeUs = parsed * 1000;
    }
  }

  if (outTimeUs === null || state.durationSeconds === null || state.durationSeconds <= 0) {
    return null;
  }
  const elapsedSeconds = outTimeUs / 1_000_000;
  return Math.min(100, (elapsedSeconds / state.durationSeconds) * 100);
}

export function inferJobProgressPlan(
  convertEnabled: boolean,
  formatSelector: string
): JobProgressPlan {
  const expectMerge = /\+/.test(formatSelector) || /bestvideo/i.test(formatSelector);
  return {
    expectMerge,
    expectConvert: convertEnabled,
  };
}

export interface JobProgressSettingsInput {
  downloadProfilesEnabled: boolean;
  downloadMode: 'best-video' | 'audio' | 'custom';
  bestQuality: boolean;
  audioOnly: boolean;
  advancedOptions: boolean;
  convertEnabled: boolean;
}

/** Align phase weights with download profile / quality settings (not only yt-dlp -f string). */
export function resolveJobProgressPlanFromSettings(
  settings: JobProgressSettingsInput
): JobProgressPlan {
  if (
    settings.audioOnly ||
    (settings.downloadProfilesEnabled && settings.downloadMode === 'audio')
  ) {
    return { expectMerge: false, expectConvert: settings.convertEnabled };
  }
  if (settings.downloadProfilesEnabled) {
    return {
      expectMerge: settings.downloadMode === 'best-video' || settings.downloadMode === 'custom',
      expectConvert: settings.convertEnabled,
    };
  }
  return {
    expectMerge: settings.bestQuality || settings.advancedOptions,
    expectConvert: settings.convertEnabled,
  };
}
