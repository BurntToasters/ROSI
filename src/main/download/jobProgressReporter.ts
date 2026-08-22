import type { BrowserWindow } from 'electron';
import { applyTaskbarProgress } from '../taskbarProgress';
import type {
  DownloadJobPhase,
  DownloadSession,
  JobProgressEvent,
  QueueDownloadProgress,
} from '../../types';
import {
  buildJobProgressEvent,
  formatYtdlpProgressSummary,
  parseYtdlpProgress,
  tryParseYtdlpProgressJson,
  ytdlpJsonToPhasePercent,
  type JobProgressPlan,
  type YtdlpProgressJson,
} from '../../utils/downloadJobProgress';

const EMIT_INTERVAL_MS = 200;

export class JobProgressReporter {
  private lastEmitAt = 0;
  private lastOverall = -1;
  private plan: JobProgressPlan;
  private queue: QueueDownloadProgress | null;
  private mainWindow: BrowserWindow | null;
  private showTaskbarProgress: boolean;

  constructor(
    mainWindow: BrowserWindow | null,
    plan: JobProgressPlan,
    queue: QueueDownloadProgress | null,
    showTaskbarProgress: boolean
  ) {
    this.mainWindow = mainWindow;
    this.plan = plan;
    this.queue = queue;
    this.showTaskbarProgress = showTaskbarProgress;
  }

  clearTaskbar(): void {
    if (!this.showTaskbarProgress) return;
    applyTaskbarProgress(this.mainWindow, 'none');
  }

  emitIdle(session: DownloadSession): void {
    this.emit(session, {
      phase: 'idle',
      phasePercent: 0,
      itemOverallPercent: 0,
      overallPercent: 0,
      queueItemId: this.queue?.queueItemId,
      status: 'Ready',
      indeterminate: false,
    });
    this.clearTaskbar();
  }

  handleYtdlpOutputLine(session: DownloadSession, line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;

    const json = tryParseYtdlpProgressJson(trimmed);
    if (json) {
      let phase: DownloadJobPhase = session.ytdlpPostprocess ? 'merge' : 'download';
      if (!session.ytdlpPostprocess && json.status === 'finished') {
        session.ytdlpDownloadFinished = true;
        phase = 'download';
      } else if (session.ytdlpDownloadFinished && !session.ytdlpPostprocess) {
        session.ytdlpPostprocess = true;
        phase = 'merge';
      }
      session.jobPhase = phase;

      const phasePercent =
        json.status === 'finished' && phase === 'download' ? 100 : ytdlpJsonToPhasePercent(json);
      const { status, details } = formatYtdlpProgressSummary(json, phasePercent);
      const label = phase === 'merge' ? 'Merging...' : status;
      this.emit(
        session,
        buildJobProgressEvent(
          phase,
          phasePercent,
          this.plan,
          this.queue,
          label,
          details,
          !Number.isFinite(phasePercent),
          {
            downloadedBytes: json.downloaded_bytes,
            totalBytes: json.total_bytes ?? json.total_bytes_estimate,
            speedBytesPerSecond: json.speed,
            etaSeconds: json.eta,
          }
        )
      );
      return true;
    }

    const legacy = parseYtdlpProgress(trimmed);
    if (legacy) {
      session.jobPhase = 'download';
      let detailsText = '';
      if (legacy.speed && legacy.eta) {
        detailsText = `${legacy.totalSize} • ${legacy.speed} • ETA: ${legacy.eta}`;
      } else if (legacy.totalSize) {
        detailsText = `Size: ${legacy.totalSize}`;
      }
      this.emit(
        session,
        buildJobProgressEvent(
          'download',
          legacy.percent,
          this.plan,
          this.queue,
          'Downloading...',
          detailsText
        )
      );
      return true;
    }

    if (trimmed.includes('Merging formats') || trimmed.includes('[Merger]')) {
      session.jobPhase = 'merge';
      session.ytdlpPostprocess = true;
      this.emit(
        session,
        buildJobProgressEvent(
          'merge',
          Number.NaN,
          this.plan,
          this.queue,
          'Merging video and audio...',
          undefined,
          true
        )
      );
      return false;
    }

    return false;
  }

  emitConvertProgress(
    session: DownloadSession,
    phasePercent: number | null,
    status = 'Converting...',
    details?: string
  ): void {
    session.jobPhase = 'convert';
    const percent = phasePercent ?? Number.NaN;
    this.emit(
      session,
      buildJobProgressEvent(
        'convert',
        percent,
        this.plan,
        this.queue,
        status,
        details,
        phasePercent === null || !Number.isFinite(percent)
      )
    );
  }

  emitPhaseIndeterminate(session: DownloadSession, phase: DownloadJobPhase, status: string): void {
    session.jobPhase = phase;
    this.emit(
      session,
      buildJobProgressEvent(phase, Number.NaN, this.plan, this.queue, status, undefined, true)
    );
  }

  emitDownloadComplete(session: DownloadSession): void {
    const phase: DownloadJobPhase = this.plan.expectConvert ? 'convert' : 'download';
    this.emit(
      session,
      buildJobProgressEvent(
        phase,
        100,
        this.plan,
        this.queue,
        'Download complete',
        undefined,
        false
      )
    );
  }

  private emit(session: DownloadSession, event: JobProgressEvent): void {
    const now = Date.now();
    const overallRounded = Math.round(event.overallPercent * 10) / 10;
    if (
      now - this.lastEmitAt < EMIT_INTERVAL_MS &&
      overallRounded === this.lastOverall &&
      !event.indeterminate
    ) {
      return;
    }
    this.lastEmitAt = now;
    this.lastOverall = overallRounded;

    if (!session.sender || session.sender.isDestroyed()) return;
    try {
      session.sender.send('job-progress', event);
    } catch {
      // ignore destroyed sender
    }

    if (!this.showTaskbarProgress) return;
    if (event.phase === 'idle') {
      applyTaskbarProgress(this.mainWindow, 'none');
      return;
    }
    if (event.indeterminate) {
      applyTaskbarProgress(this.mainWindow, 'indeterminate');
      return;
    }
    applyTaskbarProgress(this.mainWindow, event.overallPercent / 100);
  }
}

export function summarizeYtdlpJsonForConsole(data: YtdlpProgressJson): string | null {
  if (data.status !== 'downloading' && data.status !== 'finished') return null;
  const phasePercent = ytdlpJsonToPhasePercent(data);
  const { details } = formatYtdlpProgressSummary(data, phasePercent);
  const prefix = data.status === 'finished' ? '[download] Complete' : '[download]';
  return `${prefix} ${details}`;
}
