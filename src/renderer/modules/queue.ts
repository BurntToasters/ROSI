(function initRosiQueueModule(global: Window & typeof globalThis) {
  type QueueStatus = 'pending' | 'downloading' | 'completed' | 'failed' | 'cancelled';

  interface QueueItem {
    id: string;
    status: QueueStatus;
    url: string;
  }

  interface QueueElements {
    queueList: HTMLElement | null;
    queueSection: HTMLElement | null;
    queueCount: HTMLElement | null;
  }

  interface QueueDeps {
    escapeHtml: (value: string) => string;
    removeFromQueue: (id: string) => Promise<unknown> | unknown;
    focusQueueItemId?: string | null;
  }

  interface QueueModule {
    renderQueue: (queue: QueueItem[], elements: QueueElements, deps: QueueDeps) => void;
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

  function renderQueue(queue: QueueItem[], elements: QueueElements, deps: QueueDeps) {
    const { queueList, queueSection, queueCount } = elements;
    const { removeFromQueue, focusQueueItemId = null } = deps;

    if (!queueList || !queueSection) return;
    if (queueCount) queueCount.textContent = String(queue.length);
    if (queue.length === 0) {
      queueSection.classList.remove('has-items');
      queueList.replaceChildren();
      const emptyMessage = document.createElement('p');
      emptyMessage.className = 'queue-empty-message';
      emptyMessage.textContent = 'No items in queue. Add URLs above to get started.';
      queueList.appendChild(emptyMessage);
      return;
    }
    queueSection.classList.add('has-items');
    queueList.replaceChildren();
    const fragment = document.createDocumentFragment();
    queue.forEach((item) => {
      // Build the row entirely with DOM APIs. All untrusted values (item.url,
      // item.id, hostname) are assigned via textContent / properties / dataset,
      // which the DOM escapes automatically — no HTML string interpolation, so
      // a crafted URL cannot inject markup or attributes here.
      const el = document.createElement('div');
      el.className = `queue-item queue-${item.status}`;
      el.setAttribute('role', 'listitem');
      el.dataset.queueId = item.id;
      const statusLabel = STATUS_LABELS[item.status];

      let urlDisplay: string;
      try {
        const parsed = new URL(item.url);
        urlDisplay = parsed.hostname + parsed.pathname.slice(0, 30);
      } catch {
        urlDisplay = item.url.slice(0, 40);
      }

      const hostname = getHostname(item.url);

      const statusEl = document.createElement('span');
      statusEl.className = 'queue-item-status';
      statusEl.setAttribute('aria-hidden', 'true');

      const srEl = document.createElement('span');
      srEl.className = 'sr-only';
      srEl.textContent = statusLabel;

      const urlEl = document.createElement('span');
      urlEl.className = 'queue-item-url';
      urlEl.title = item.url;
      urlEl.textContent = urlDisplay;

      el.append(statusEl, srEl, urlEl);

      if (item.status === 'pending') {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'queue-item-remove';
        removeBtn.dataset.queueId = item.id;
        removeBtn.setAttribute('aria-label', `Remove ${hostname} from queue`);
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', () => {
          removeBtn.disabled = true;
          void Promise.resolve(removeFromQueue(item.id)).finally(() => {
            removeBtn.disabled = false;
          });
        });
        el.appendChild(removeBtn);
      }
      fragment.appendChild(el);
    });
    queueList.appendChild(fragment);

    if (focusQueueItemId) {
      const focusTarget = queueList.querySelector<HTMLButtonElement>(
        `.queue-item-remove[data-queue-id="${CSS.escape(focusQueueItemId)}"]`
      );
      if (focusTarget) {
        focusTarget.focus();
        return;
      }
      const pendingRemoves = queueList.querySelectorAll<HTMLButtonElement>('.queue-item-remove');
      const lastPending = pendingRemoves[pendingRemoves.length - 1];
      if (lastPending) {
        lastPending.focus();
      }
    }
  }

  const windowRef = global as RosiWindow;
  const moduleTarget = (windowRef.rosiModules ?? {}) as QueueModules;
  moduleTarget.queue = {
    renderQueue,
    resolveQueueSectionElement,
  };
  windowRef.rosiModules = moduleTarget;
})(window);
