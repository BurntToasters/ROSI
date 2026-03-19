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
  }

  interface QueueModule {
    renderQueue: (queue: QueueItem[], elements: QueueElements, deps: QueueDeps) => void;
    resolveQueueSectionElement: (root?: Document) => HTMLElement | null;
  }

  type QueueModules = {
    queue?: QueueModule;
  };

  type RosiWindow = Window & typeof globalThis & { rosiModules?: QueueModules };

  function resolveQueueSectionElement(root?: Document) {
    const doc = root ?? document;
    return doc.getElementById('queueSection') || doc.getElementById('queue-section');
  }

  function renderQueue(queue: QueueItem[], elements: QueueElements, deps: QueueDeps) {
    const { queueList, queueSection, queueCount } = elements;
    const { escapeHtml, removeFromQueue } = deps;

    if (!queueList || !queueSection) return;
    if (queueCount) queueCount.textContent = String(queue.length);
    if (queue.length === 0) {
      queueSection.classList.remove('has-items');
      queueList.innerHTML = '';
      return;
    }
    queueSection.classList.add('has-items');
    queueList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    queue.forEach((item) => {
      const el = document.createElement('div');
      el.className = `queue-item queue-${item.status}`;
      const statusIcon =
        item.status === 'completed'
          ? '✅'
          : item.status === 'failed'
            ? '❌'
            : item.status === 'cancelled'
              ? '⏹️'
              : item.status === 'downloading'
                ? '⏳'
                : '⏸️';

      let urlDisplay: string;
      try {
        const parsed = new URL(item.url);
        urlDisplay = parsed.hostname + parsed.pathname.slice(0, 30);
      } catch {
        urlDisplay = item.url.slice(0, 40);
      }

      el.innerHTML = `
        <span class="queue-item-status">${statusIcon}</span>
        <span class="queue-item-url" title="${escapeHtml(item.url)}">${escapeHtml(urlDisplay)}</span>
        ${item.status === 'pending' ? '<button class="queue-item-remove" aria-label="Remove">✕</button>' : ''}
      `;
      const removeBtn = el.querySelector<HTMLButtonElement>('.queue-item-remove');
      if (removeBtn) {
        removeBtn.addEventListener('click', () => {
          removeBtn.disabled = true;
          void Promise.resolve(removeFromQueue(item.id)).finally(() => {
            removeBtn.disabled = false;
          });
        });
      }
      fragment.appendChild(el);
    });
    queueList.appendChild(fragment);
  }

  const windowRef = global as RosiWindow;
  const moduleTarget = (windowRef.rosiModules ?? {}) as QueueModules;
  moduleTarget.queue = {
    renderQueue,
    resolveQueueSectionElement,
  };
  windowRef.rosiModules = moduleTarget;
})(window);
