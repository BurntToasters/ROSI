(function initRosiActivityModule(global: Window & typeof globalThis) {
  const windowRef = global;

  // Read at render time so module load order cannot leave it unset.
  function formatBytes(bytes: number) {
    return windowRef.rosiModules?.downloads?.formatBytes(bytes) ?? String(bytes);
  }

  const HISTORY_KEY = 'rosi-download-history';

  interface LegacyHistoryEntry {
    filename: string;
    path: string | null;
    timestamp: number;
    status: 'success' | 'failed' | 'cancelled';
  }

  /**
   * Pre-4.3 downloads were tracked in localStorage. The main process is now the
   * authoritative store, so these records are only read for display when the
   * durable activity log is still empty.
   */
  function loadLegacyHistory(): LegacyHistoryEntry[] {
    try {
      const data = localStorage.getItem(HISTORY_KEY);
      const parsed: unknown = data ? JSON.parse(data) : [];
      return Array.isArray(parsed) ? (parsed as LegacyHistoryEntry[]) : [];
    } catch {
      return [];
    }
  }

  type ActivityFilter = 'all' | 'success' | 'failed' | 'cancelled';

  interface ActivityRow {
    id: string;
    outcome: 'success' | 'failed' | 'cancelled';
    title: string;
    subtitle: string;
    timestamp: number;
    url: string | null;
    outputPath?: string;
    outputPaths?: string[];
    error?: string;
    request?: Record<string, unknown>;
  }

  function hostFromUrl(url: string | null | undefined) {
    if (!url) return '';
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  function describeActivityProfile(entry: RosiDownloadActivity) {
    if (entry.presetName) return entry.presetName;
    if (entry.profile === 'compatible') return 'Compatible';
    if (entry.profile === 'best-video') return 'Best video';
    if (entry.profile === 'audio') return 'Audio';
    if (entry.profile === 'custom') return 'Custom';
    return '';
  }

  // Owns the download activity list. Call once, from the engine's startup.
  function initActivityPanel(deps: RosiActivityPanelDeps): RosiActivityPanel {
    const {
      showToast,
      renderStatusText,
      formatRelativeTime,
      revealFileLocation,
      icon,
      markUnseen,
      onReplay,
    } = deps;

    let activityEntries: RosiDownloadActivity[] = [];
    let activityFilter: ActivityFilter = 'all';
    let activityLoaded = false;

    function toActivityRows(): ActivityRow[] {
      if (activityEntries.length > 0) {
        return activityEntries.map((entry) => {
          // A failed entry's retained original is listed as an output and as
          // a failure; count it once, as failed.
          const failedPaths = entry.failedPaths ?? [];
          const successfulOutputs = entry.outputPaths
            ? entry.outputPaths.filter((outputPath) => !failedPaths.includes(outputPath)).length
            : entry.outputPath
              ? 1
              : 0;
          const failedOutputs = failedPaths.length;
          const parts = [
            hostFromUrl(entry.url),
            describeActivityProfile(entry),
            typeof entry.sizeBytes === 'number' ? formatBytes(entry.sizeBytes) : '',
            failedOutputs > 0
              ? `${successfulOutputs} of ${successfulOutputs + failedOutputs} entries completed`
              : successfulOutputs > 1
                ? `${successfulOutputs} files saved`
                : '',
            formatRelativeTime(entry.completedAt),
          ].filter(Boolean);
          return {
            id: entry.id,
            outcome: entry.outcome,
            title: entry.filename || hostFromUrl(entry.url) || entry.url,
            subtitle: parts.join(' • '),
            timestamp: entry.completedAt,
            url: entry.url,
            outputPath: entry.outputPath,
            outputPaths: entry.outputPaths,
            error: entry.error,
            request: entry.request,
          };
        });
      }

      return loadLegacyHistory().map((entry, index) => ({
        id: `legacy-${index}`,
        outcome: entry.status,
        title: entry.filename || 'Unknown file',
        subtitle: formatRelativeTime(entry.timestamp),
        timestamp: entry.timestamp,
        url: null,
        outputPath: entry.path ?? undefined,
      }));
    }
    function createActivityActionButton(
      iconName: string,
      label: string,
      ariaLabel: string,
      action: () => void
    ) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'history-open-btn btn btn--ghost btn--xs btn--icon btn--accent-hover';
      button.setAttribute('aria-label', ariaLabel);
      button.title = label;
      const svg = icon(iconName, 16) ?? null;
      if (svg) button.appendChild(svg);
      else button.textContent = label;
      button.addEventListener('focus', () => button.classList.add('is-focused'));
      button.addEventListener('blur', () => button.classList.remove('is-focused'));
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        action();
      });
      return button;
    }

    function renderActivity() {
      const historySection = document.getElementById('download-history');
      const listEl = document.getElementById('history-list');
      const countEl = document.getElementById('history-count');
      if (!listEl || !historySection) return;

      const rows = toActivityRows();
      const visibleRows =
        activityFilter === 'all' ? rows : rows.filter((row) => row.outcome === activityFilter);
      if (countEl) countEl.textContent = String(rows.length);

      // The panel now stays mounted so the empty state remains discoverable.
      historySection.classList.add('visible');
      listEl.replaceChildren();

      if (visibleRows.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'history-empty';
        empty.textContent =
          rows.length === 0
            ? 'No downloads yet. Finished, failed, and cancelled downloads will appear here.'
            : 'No downloads match this filter.';
        listEl.appendChild(empty);
        return;
      }

      const fragment = document.createDocumentFragment();
      visibleRows.forEach((row) => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.setAttribute('role', 'listitem');

        const statusLabel =
          row.outcome === 'success'
            ? 'Completed'
            : row.outcome === 'cancelled'
              ? 'Cancelled'
              : 'Failed';

        const info = document.createElement('div');
        info.className = 'history-item-info';
        const filenameEl = document.createElement('span');
        filenameEl.className = 'history-filename';
        filenameEl.title = row.url || row.title;
        filenameEl.textContent = row.title;
        const timeEl = document.createElement('span');
        timeEl.className = 'history-time';
        timeEl.textContent = row.subtitle || formatRelativeTime(row.timestamp);
        info.append(filenameEl, timeEl);
        if (row.error) {
          const errorEl = document.createElement('span');
          errorEl.className = 'history-error';
          renderStatusText(errorEl, row.error);
          info.appendChild(errorEl);
        }

        const actions = document.createElement('div');
        actions.className = 'history-item-actions';
        const statusEl = document.createElement('span');
        statusEl.className = `history-status ${row.outcome}`;
        statusEl.textContent = statusLabel;
        actions.appendChild(statusEl);

        if (row.request) {
          const entry = activityEntries.find((candidate) => candidate.id === row.id);
          if (entry) {
            actions.appendChild(
              createActivityActionButton(
                'rotate-ccw',
                'Download again',
                `Download ${row.title} again`,
                () => {
                  onReplay(entry);
                }
              )
            );
          }
        }
        if (row.url) {
          const sourceUrl = row.url;
          actions.appendChild(
            createActivityActionButton(
              'link',
              'Copy source',
              `Copy source link for ${row.title}`,
              () => {
                void navigator.clipboard.writeText(sourceUrl).then(
                  () => showToast('Source link copied.', { type: 'info' }),
                  () => showToast('Could not copy the source link.', { type: 'warning' })
                );
              }
            )
          );
        }
        if (row.outputPath && (row.outcome === 'success' || row.outputPaths?.length)) {
          const filePath = row.outputPath;
          actions.appendChild(
            createActivityActionButton(
              'folder-open',
              'Open folder',
              `Open file location for ${row.title}`,
              () => {
                void revealFileLocation(filePath);
              }
            )
          );
        }

        item.append(info, actions);
        fragment.appendChild(item);
      });
      listEl.appendChild(fragment);
    }

    function setActivityEntries(entries: RosiDownloadActivity[]) {
      const previousCount = activityEntries.length;
      activityEntries = Array.isArray(entries) ? entries : [];
      // The first load is history from earlier sessions, which is not news.
      if (activityLoaded && activityEntries.length > previousCount) {
        markUnseen('activity');
      }
      activityLoaded = true;
      renderActivity();
    }

    function setActivityFilter(filter: ActivityFilter) {
      activityFilter = filter;
      document.querySelectorAll<HTMLButtonElement>('.activity-filter').forEach((button) => {
        const isSelected = button.dataset.activityFilter === filter;
        button.classList.toggle('selected', isSelected);
        button.setAttribute('aria-pressed', String(isSelected));
      });
      renderActivity();
    }

    async function clearActivity(): Promise<boolean> {
      if (typeof window.api.clearDownloadActivity !== 'function') {
        try {
          localStorage.removeItem(HISTORY_KEY);
        } catch {
          /* ignore */
        }
        setActivityEntries([]);
        return true;
      }
      try {
        const result = await window.api.clearDownloadActivity();
        if (!result || !result.ok) {
          showToast(result?.error?.message || 'Could not clear activity.', { type: 'error' });
          return false;
        }
      } catch {
        showToast('Could not clear activity.', { type: 'error' });
        return false;
      }
      try {
        localStorage.removeItem(HISTORY_KEY);
      } catch {
        /* ignore */
      }
      setActivityEntries([]);
      return true;
    }
    renderActivity();

    document.querySelectorAll<HTMLButtonElement>('.activity-filter').forEach((button) => {
      button.addEventListener('click', () => {
        const filter = button.dataset.activityFilter;
        if (
          filter === 'all' ||
          filter === 'success' ||
          filter === 'failed' ||
          filter === 'cancelled'
        ) {
          setActivityFilter(filter);
        }
      });
    });

    return { setEntries: setActivityEntries, clear: clearActivity };
  }

  const moduleTarget: RosiModules = windowRef.rosiModules ?? {};
  moduleTarget.activity = { initActivityPanel };
  windowRef.rosiModules = moduleTarget;
})(window);
