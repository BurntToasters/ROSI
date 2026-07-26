(function initRosiQueueModule(global: Window & typeof globalThis) {
  type QueueStatus = 'pending' | 'downloading' | 'completed' | 'failed' | 'cancelled';
  type QueueDirection = 'up' | 'down';

  interface QueueProgress {
    phase: 'download' | 'merge' | 'convert' | 'idle';
    phasePercent: number;
    itemOverallPercent: number;
    overallPercent: number;
    status: string;
    details?: string;
    indeterminate?: boolean;
    speedBytesPerSecond?: number;
    etaSeconds?: number;
  }

  interface QueueItem {
    id: string;
    status: QueueStatus;
    url: string;
    filename?: string;
    outputPath?: string;
    sizeBytes?: number;
    error?: string;
    progress?: QueueProgress;
  }

  interface QueueElements {
    queueList: HTMLElement | null;
    queueSection: HTMLElement | null;
    queueCount: HTMLElement | null;
  }

  interface QueueDeps {
    removeFromQueue: (id: string) => Promise<unknown> | unknown;
    retryQueueItem: (id: string) => Promise<unknown> | unknown;
    reorderQueueItem: (id: string, direction: QueueDirection) => Promise<unknown> | unknown;
    copyDiagnostics: (item: QueueItem) => Promise<unknown> | unknown;
    openFileLocation?: (filePath: string) => Promise<unknown> | unknown;
    focusQueueItemId?: string | null;
  }

  interface QueueModule {
    renderQueue: (queue: QueueItem[], elements: QueueElements, deps: QueueDeps) => void;
    updateQueueItemProgress: (item: QueueItem, elements: QueueElements) => boolean;
    resolveQueueSectionElement: (root?: Document) => HTMLElement | null;
  }

  type QueueModules = {
    queue?: QueueModule;
  };

  type RosiWindow = Window & typeof globalThis & { rosiModules?: QueueModules };

  const STATUS_LABELS: Record<QueueStatus, string> = {
    pending: 'Pending',
    downloading: 'Downloading',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };

  function resolveQueueSectionElement(root?: Document) {
    const doc = root ?? document;
    return doc.getElementById('queueSection') || doc.getElementById('queue-section');
  }

  function getHostname(url: string) {
    try {
      return new URL(url).hostname;
    } catch {
      return url.slice(0, 40);
    }
  }

  /**
   * Find a row by id without building a selector, so no CSS.escape dependency
   * and no chance of a crafted id breaking the lookup.
   */
  function findQueueRow(queueList: HTMLElement, id: string): HTMLElement | null {
    const rows = queueList.querySelectorAll<HTMLElement>('.queue-item');
    for (const row of rows) {
      if (row.dataset.queueId === id) return row;
    }
    return null;
  }

  function getUrlDisplay(url: string) {
    try {
      const parsed = new URL(url);
      return parsed.hostname + parsed.pathname.slice(0, 40);
    } catch {
      return url.slice(0, 56);
    }
  }

  function formatBytes(bytes: number | undefined) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** index;
    return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
  }

  function formatEta(seconds: number | undefined) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
    const rounded = Math.round(seconds);
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const remaining = rounded % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
      : `${minutes}:${String(remaining).padStart(2, '0')}`;
  }

  function createActionButton(
    label: string,
    className: string,
    item: QueueItem,
    action: () => Promise<unknown> | unknown,
    ariaLabel = label
  ) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `queue-item-action ${className}`;
    button.dataset.queueId = item.id;
    button.dataset.queueAction = className;
    button.setAttribute('aria-label', ariaLabel);
    button.textContent = label;
    button.addEventListener('click', () => {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      void Promise.resolve(action()).finally(() => {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      });
    });
    return button;
  }

  function buildProgressBlock(item: QueueItem): HTMLElement | null {
    const progress = item.progress;
    if (item.status !== 'downloading' || !progress || progress.phase === 'idle') return null;

    const row = document.createElement('div');
    row.className = 'queue-item-progress';
    const header = document.createElement('div');
    header.className = 'queue-item-progress-header';
    const status = document.createElement('span');
    status.textContent = progress.status || STATUS_LABELS.downloading;
    const percent = document.createElement('span');
    const clamped = Math.max(0, Math.min(100, progress.itemOverallPercent));
    percent.textContent = progress.indeterminate ? 'Working…' : `${Math.round(clamped)}%`;
    header.append(status, percent);

    const track = document.createElement('div');
    track.className = 'queue-item-progress-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', `${getHostname(item.url)} download progress`);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    const bar = document.createElement('div');
    bar.className = 'queue-item-progress-bar';
    if (progress.indeterminate) {
      bar.classList.add('indeterminate');
      track.removeAttribute('aria-valuenow');
      track.setAttribute('aria-valuetext', progress.status || 'Working');
    } else {
      bar.style.width = `${clamped}%`;
      track.setAttribute('aria-valuenow', String(Math.round(clamped)));
    }
    track.appendChild(bar);

    const detailParts: string[] = [];
    if (progress.details) detailParts.push(progress.details);
    if (typeof progress.speedBytesPerSecond === 'number') {
      detailParts.push(`${formatBytes(progress.speedBytesPerSecond)}/s`);
    }
    const eta = formatEta(progress.etaSeconds);
    if (eta) detailParts.push(`ETA ${eta}`);
    const details = document.createElement('div');
    details.className = 'queue-item-progress-details';
    details.textContent = detailParts.join(' • ');

    row.append(header, track);
    if (details.textContent) row.appendChild(details);
    return row;
  }

  function appendProgress(content: HTMLElement, item: QueueItem) {
    const block = buildProgressBlock(item);
    if (block) content.appendChild(block);
  }

  /**
   * Patch only the active row's progress block. Progress arrives several times
   * a second, so re-rendering the whole list would be wasteful and would steal
   * focus from any queue control the user is currently on. Returns false when
   * the row is not present, so the caller can fall back to a full render.
   */
  function updateQueueItemProgress(item: QueueItem, elements: QueueElements): boolean {
    const { queueList } = elements;
    if (!queueList) return false;
    const row = findQueueRow(queueList, item.id);
    if (!row || !row.classList.contains(`queue-${item.status}`)) return false;
    const content = row.querySelector<HTMLElement>('.queue-item-content');
    if (!content) return false;

    const existing = content.querySelector('.queue-item-progress');
    const next = buildProgressBlock(item);
    if (!next) {
      existing?.remove();
      return true;
    }
    if (existing) {
      existing.replaceWith(next);
    } else {
      content.appendChild(next);
    }
    return true;
  }

  function renderQueue(queue: QueueItem[], elements: QueueElements, deps: QueueDeps) {
    const { queueList, queueSection, queueCount } = elements;
    const {
      removeFromQueue,
      retryQueueItem,
      reorderQueueItem,
      copyDiagnostics,
      openFileLocation,
      focusQueueItemId = null,
    } = deps;

    if (!queueList || !queueSection) return;
    if (queueCount) queueCount.textContent = String(queue.length);
    if (queue.length === 0) {
      queueSection.classList.remove('has-items');
      queueList.replaceChildren();
      const emptyMessage = document.createElement('p');
      emptyMessage.className = 'queue-empty-message';
      emptyMessage.textContent = 'No items in queue. Paste one or more links above to get started.';
      queueList.appendChild(emptyMessage);
      return;
    }

    const pendingItems = queue.filter((item) => item.status === 'pending');
    queueSection.classList.add('has-items');
    queueList.replaceChildren();
    const fragment = document.createDocumentFragment();

    queue.forEach((item) => {
      const hostname = getHostname(item.url);
      const statusLabel = STATUS_LABELS[item.status];
      const row = document.createElement('div');
      row.className = `queue-item queue-${item.status}`;
      row.setAttribute('role', 'listitem');
      row.dataset.queueId = item.id;

      const statusEl = document.createElement('span');
      statusEl.className = 'queue-item-status';
      statusEl.setAttribute('aria-hidden', 'true');
      const srEl = document.createElement('span');
      srEl.className = 'sr-only';
      srEl.textContent = statusLabel;

      const content = document.createElement('div');
      content.className = 'queue-item-content';
      const title = document.createElement('span');
      title.className = 'queue-item-title';
      title.title = item.filename || item.url;
      title.textContent = item.filename || getUrlDisplay(item.url);
      const meta = document.createElement('span');
      meta.className = 'queue-item-meta';
      const metaParts = [statusLabel];
      if (item.filename) metaParts.push(hostname);
      const size = formatBytes(item.sizeBytes);
      if (size) metaParts.push(size);
      meta.textContent = metaParts.join(' • ');
      content.append(title, meta);
      appendProgress(content, item);

      const actions = document.createElement('div');
      actions.className = 'queue-item-actions';

      if (item.status === 'pending') {
        const pendingIndex = pendingItems.findIndex((candidate) => candidate.id === item.id);
        const up = createActionButton(
          'Up',
          'queue-item-move-up',
          item,
          () => reorderQueueItem(item.id, 'up'),
          `Move ${hostname} up in queue`
        );
        up.disabled = pendingIndex <= 0;
        const down = createActionButton(
          'Down',
          'queue-item-move-down',
          item,
          () => reorderQueueItem(item.id, 'down'),
          `Move ${hostname} down in queue`
        );
        down.disabled = pendingIndex === pendingItems.length - 1;
        const remove = createActionButton(
          'Remove',
          'queue-item-remove',
          item,
          () => removeFromQueue(item.id),
          `Remove ${hostname} from queue`
        );
        actions.append(up, down, remove);
        // The shortcut listens on the row so it works from any control inside
        // it. The row itself is deliberately not focusable: a long queue would
        // otherwise add hundreds of extra tab stops.
        row.addEventListener('keydown', (event) => {
          if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
          event.preventDefault();
          const direction: QueueDirection = event.key === 'ArrowUp' ? 'up' : 'down';
          if ((direction === 'up' && up.disabled) || (direction === 'down' && down.disabled))
            return;
          void Promise.resolve(reorderQueueItem(item.id, direction));
        });
      } else if (item.status === 'failed' || item.status === 'cancelled') {
        const retry = createActionButton(
          item.status === 'failed' ? 'Retry' : 'Requeue',
          'queue-item-retry',
          item,
          () => retryQueueItem(item.id),
          `${item.status === 'failed' ? 'Retry' : 'Requeue'} ${hostname}`
        );
        const copy = createActionButton(
          'Copy details',
          'queue-item-copy',
          item,
          () => copyDiagnostics(item),
          `Copy diagnostics for ${hostname}`
        );
        actions.append(retry, copy);
      } else if (item.status === 'completed' && item.outputPath && openFileLocation) {
        actions.append(
          createActionButton(
            'Open folder',
            'queue-item-open',
            item,
            () => openFileLocation(item.outputPath as string),
            `Open folder containing ${item.filename || hostname}`
          )
        );
      }

      row.append(statusEl, srEl, content);
      if (actions.childElementCount > 0) row.appendChild(actions);

      if (item.status === 'failed' || item.status === 'cancelled') {
        const details = document.createElement('details');
        details.className = 'queue-item-details';
        const summary = document.createElement('summary');
        summary.textContent = item.status === 'failed' ? 'Failure details' : 'Cancellation details';
        const message = document.createElement('p');
        message.textContent =
          item.error ||
          (item.status === 'cancelled'
            ? 'This item was cancelled before it completed.'
            : 'The download failed without additional diagnostic information.');
        details.append(summary, message);
        row.appendChild(details);
      }

      fragment.appendChild(row);
    });

    queueList.appendChild(fragment);

    if (focusQueueItemId) {
      // Prefer an enabled control: after a retry or removal the first action can
      // be disabled (for example "Up" on the new first item), and focusing a
      // disabled button silently drops focus to the body.
      const focusRow = findQueueRow(queueList, focusQueueItemId);
      const focusTarget =
        focusRow?.querySelector<HTMLElement>('[data-queue-action]:not([disabled])') ?? null;
      focusTarget?.focus();
    }
  }

  const windowRef = global as RosiWindow;
  const moduleTarget = (windowRef.rosiModules ?? {}) as QueueModules;
  moduleTarget.queue = {
    renderQueue,
    updateQueueItemProgress,
    resolveQueueSectionElement,
  };
  windowRef.rosiModules = moduleTarget;
})(window);
