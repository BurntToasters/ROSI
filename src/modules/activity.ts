import { copyText } from './clipboard';
import { formatBytes, hostFromUrl } from './format';
import { api } from '../api';

// window.rosiMessages is published by engine/messages.ts before any render runs.
const uiMessages = () => window.rosiMessages as NonNullable<Window['rosiMessages']>;

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
  partial?: boolean;
  title: string;
  subtitle: string;
  timestamp: number;
  url: string | null;
  outputPath?: string | null;
  outputPaths?: string[] | null;
  error?: string | null;
  request?: RosiDownloadCompletion['request'];
}

/** Last non-empty path segment, decoded when possible. Query and hash are never used. */
function lastPathSegmentFromUrl(url: string | null | undefined) {
  if (!url) return '';
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return '';
  }
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1] ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Filename first, then the URL's last path segment, then its host, then the raw URL. */
function activityTitle(entry: Pick<RosiDownloadActivity, 'filename' | 'url'>) {
  return (
    entry.filename || lastPathSegmentFromUrl(entry.url) || hostFromUrl(entry.url) || entry.url || ''
  );
}

function describeActivityProfile(entry: RosiDownloadActivity) {
  if (entry.presetName) return entry.presetName;
  if (entry.profile === 'compatible') return 'Compatible';
  if (entry.profile === 'best-video') return 'Best video';
  if (entry.profile === 'audio') return 'Audio';
  if (entry.profile === 'custom') return 'Custom';
  return '';
}

const LIVE_REGION_ID = 'activity-live-status';

function activityStatusLabel(row: Pick<ActivityRow, 'partial' | 'outcome'>) {
  return row.partial
    ? uiMessages().activity.partial
    : row.outcome === 'success'
      ? uiMessages().activity.completed
      : row.outcome === 'cancelled'
        ? uiMessages().activity.cancelled
        : uiMessages().activity.failed;
}

// The focused row action, by row id and action name, so it can be found again
// after the list is rebuilt. Null when focus is outside the list.
interface ActivityFocusKey {
  rowId: string;
  action: string;
}

function activityFocusKey(listEl: HTMLElement): ActivityFocusKey | null {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !listEl.contains(focused)) return null;
  const rowId = focused.closest<HTMLElement>('.history-item')?.dataset.activityId;
  const action = focused.dataset.activityAction;
  return rowId && action ? { rowId, action } : null;
}

function restoreActivityFocus(listEl: HTMLElement, key: ActivityFocusKey | null) {
  if (!key) return;
  const row = Array.from(listEl.querySelectorAll<HTMLElement>('.history-item')).find(
    (item) => item.dataset.activityId === key.rowId
  );
  const target = Array.from(
    row?.querySelectorAll<HTMLElement>('[data-activity-action]') ?? []
  ).find((button) => button.dataset.activityAction === key.action);
  // preventScroll: a rebuilt list must not jump to the focused row.
  target?.focus({ preventScroll: true });
}

// One polite region, never cleared, so each new entry is read once. Progress
// ticks never write to it. It sits beside the panel, which is hidden while
// another dock tab is selected.
function createActivityAnnouncer(): HTMLElement {
  const announcer = document.createElement('p');
  announcer.id = LIVE_REGION_ID;
  announcer.className = 'sr-only';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  announcer.setAttribute('aria-atomic', 'true');
  document.getElementById('download-history')?.before(announcer);
  return announcer;
}

function announceNewEntries(announcer: HTMLElement, rows: ActivityRow[], newIds: Set<string>) {
  const newRows = rows.filter((row) => newIds.has(row.id));
  const [only] = newRows;
  if (!only) return;
  announcer.textContent =
    newRows.length === 1
      ? `${activityStatusLabel(only)}: ${only.title}.`
      : `${newRows.length} new downloads recorded.`;
}

function toActivityRows(
  activityEntries: RosiDownloadActivity[],
  formatRelativeTime: RosiActivityPanelDeps['formatRelativeTime']
): ActivityRow[] {
  if (activityEntries.length > 0) {
    return activityEntries.map((entry) => {
      // A failed entry's retained original is listed as an output and as
      // a failure; count it once, as failed.
      const failedPaths = entry.failedPaths ?? [];
      const candidatePaths = [
        ...new Set([...(entry.outputPaths ?? []), ...(entry.outputPath ? [entry.outputPath] : [])]),
      ];
      const successfulPaths = candidatePaths.filter(
        (outputPath) => !failedPaths.includes(outputPath)
      );
      const successfulOutputs = successfulPaths.length;
      const failedOutputs = failedPaths.length;
      const host = hostFromUrl(entry.url);
      const title = activityTitle(entry);
      const parts = [
        // The title already shows the host when it is the only identifier.
        host !== title ? host : '',
        describeActivityProfile(entry),
        formatBytes(entry.sizeBytes),
        failedOutputs > 0
          ? uiMessages().activity.partialCount(successfulOutputs, successfulOutputs + failedOutputs)
          : successfulOutputs > 1
            ? uiMessages().activity.filesSaved(successfulOutputs)
            : '',
        formatRelativeTime(entry.completedAt),
      ].filter(Boolean);
      return {
        id: entry.id,
        outcome: entry.outcome,
        partial: entry.outcome === 'failed' && successfulOutputs > 0 && failedOutputs > 0,
        title,
        subtitle: parts.join(' • '),
        timestamp: entry.completedAt,
        url: entry.url,
        outputPath:
          entry.outputPath && successfulPaths.includes(entry.outputPath)
            ? entry.outputPath
            : (successfulPaths[0] ?? null),
        outputPaths: entry.outputPaths,
        error: entry.error,
        request: entry.request,
      };
    });
  }

  return loadLegacyHistory().map((entry, index) => ({
    id: `legacy-${index}`,
    outcome: entry.status,
    partial: false,
    title: entry.filename || 'Unknown file',
    subtitle: formatRelativeTime(entry.timestamp),
    timestamp: entry.timestamp,
    url: null,
    outputPath: entry.path ?? undefined,
  }));
}

function filterActivityRows(rows: ActivityRow[], filter: ActivityFilter): ActivityRow[] {
  return filter === 'all' ? rows : rows.filter((row) => row.outcome === filter);
}

function createActivityActionButton(
  icon: RosiActivityPanelDeps['icon'],
  iconName: string,
  label: string,
  ariaLabel: string,
  actionKey: 'replay' | 'copy' | 'reveal',
  action: () => void
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'history-open-btn btn btn--ghost btn--xs btn--icon btn--accent-hover';
  button.dataset.activityAction = actionKey;
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

// Replay, copy source, and open folder buttons for one row, in that order.
function appendActivityRowActions(
  actions: HTMLElement,
  row: ActivityRow,
  activityEntries: RosiDownloadActivity[],
  deps: RosiActivityPanelDeps
) {
  const { showToast, revealFileLocation, icon, onReplay } = deps;
  if (row.request) {
    const entry = activityEntries.find((candidate) => candidate.id === row.id);
    if (entry) {
      actions.appendChild(
        createActivityActionButton(
          icon,
          'rotate-ccw',
          'Download again',
          `Download ${row.title} again`,
          'replay',
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
        icon,
        'link',
        'Copy source',
        `Copy source link for ${row.title}`,
        'copy',
        () => {
          void copyText(sourceUrl).then((copied) =>
            copied
              ? showToast('Source link copied.', { type: 'info' })
              : showToast('Could not copy the source link.', { type: 'warning' })
          );
        }
      )
    );
  }
  if (row.outputPath && (row.outcome === 'success' || row.outputPaths?.length)) {
    const filePath = row.outputPath;
    actions.appendChild(
      createActivityActionButton(
        icon,
        'folder-open',
        'Open folder',
        `Open file location for ${row.title}`,
        'reveal',
        () => {
          void revealFileLocation(filePath);
        }
      )
    );
  }
}

function createActivityRowElement(
  row: ActivityRow,
  activityEntries: RosiDownloadActivity[],
  deps: RosiActivityPanelDeps
) {
  const { renderStatusText, formatRelativeTime } = deps;
  const item = document.createElement('div');
  item.className = 'history-item';
  item.dataset.activityId = row.id;
  item.setAttribute('role', 'listitem');

  const statusLabel = activityStatusLabel(row);

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
  statusEl.className = `history-status ${row.outcome}${row.partial ? ' partial' : ''}`;
  statusEl.textContent = statusLabel;
  actions.appendChild(statusEl);

  appendActivityRowActions(actions, row, activityEntries, deps);

  item.append(info, actions);
  return item;
}

function renderActivityList(
  activityEntries: RosiDownloadActivity[],
  activityFilter: ActivityFilter,
  deps: RosiActivityPanelDeps
) {
  const historySection = document.getElementById('download-history');
  const listEl = document.getElementById('history-list');
  const countEl = document.getElementById('history-count');
  if (!listEl || !historySection) return;

  const rows = toActivityRows(activityEntries, deps.formatRelativeTime);
  const visibleRows = filterActivityRows(rows, activityFilter);
  if (countEl) countEl.textContent = String(rows.length);

  // Read before the rows are replaced: removing the focused node moves focus
  // to BODY, and the same action is focused again after the rebuild.
  const focusKey = activityFocusKey(listEl);

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
    fragment.appendChild(createActivityRowElement(row, activityEntries, deps));
  });
  listEl.appendChild(fragment);
  restoreActivityFocus(listEl, focusKey);
}

function syncActivityFilterButtons(filter: ActivityFilter) {
  document.querySelectorAll<HTMLButtonElement>('.activity-filter').forEach((button) => {
    const isSelected = button.dataset.activityFilter === filter;
    button.classList.toggle('selected', isSelected);
    button.setAttribute('aria-pressed', String(isSelected));
  });
}

function bindActivityFilterButtons(setActivityFilter: (filter: ActivityFilter) => void) {
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
}

// Owns the download activity list. Call once, from the engine's startup.
export function initActivityPanel(deps: RosiActivityPanelDeps): RosiActivityPanel {
  const { showToast, formatRelativeTime, markUnseen } = deps;

  let activityEntries: RosiDownloadActivity[] = [];
  let activityFilter: ActivityFilter = 'all';
  let activityLoaded = false;

  const announcer = createActivityAnnouncer();

  function renderActivity() {
    renderActivityList(activityEntries, activityFilter, deps);
  }

  function setActivityEntries(entries: RosiDownloadActivity[]) {
    const previousIds = new Set(activityEntries.map((entry) => entry.id));
    activityEntries = Array.isArray(entries) ? entries : [];
    // Compare ids, not counts: the backend caps the log, so a full list can gain
    // a new entry without growing. The first load is history, which is not news.
    const newIds = new Set(
      activityEntries.filter((entry) => !previousIds.has(entry.id)).map((entry) => entry.id)
    );
    if (activityLoaded && newIds.size > 0) {
      markUnseen('activity');
    }
    if (activityLoaded) {
      announceNewEntries(announcer, toActivityRows(activityEntries, formatRelativeTime), newIds);
    }
    activityLoaded = true;
    renderActivity();
  }

  function setActivityFilter(filter: ActivityFilter) {
    activityFilter = filter;
    syncActivityFilterButtons(filter);
    renderActivity();
  }

  async function clearActivity(): Promise<boolean> {
    try {
      const result = await api.clearDownloadActivity();
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

  bindActivityFilterButtons(setActivityFilter);

  return { setEntries: setActivityEntries, clear: clearActivity };
}
