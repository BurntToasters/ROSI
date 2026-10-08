# Renderer refactor: failure modes (written before the change)

## Map of src/rosiEngine.ts (6045 lines)

Module-level `let`s: 37 total. Most logic lives in `initializeRenderer()` (lines ~2645-6030) as closures.

| Area (approx. lines)                          | Module-level state                                                                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Theme and system listener (209-367)           | appliedTheme, themePreference, systemThemeMediaQuery, systemThemeMediaQueryHandler                                                                                |
| Modal queue and focus trap (462-737)          | isModalActive, currentModalData, previousFocus, modalTrapHandler, modalFocusinHandler, modalHideTimer, modalHideGeneration, modalHidingData (modalQueue is const) |
| Format picker (748-930)                       | isFetchingFormats, fetchFormatsAbort, formatRequestGeneration, formatRequestUrl, formatSelectionsUrl                                                              |
| Video preview (961-1031)                      | isFetchingPreview, previewAbort                                                                                                                                   |
| Progress bar and phases (1036-1187)           | isDownloading, downloadAbort, lastDownloadedFilePath                                                                                                              |
| Activity / download history (1188-1516)       | activityEntries, activityFilter, activityReplayHandler, activityLoaded (+ const HISTORY_KEY) **extracted**                                                        |
| Updater and update banner (1513-1817)         | isManualUpdateCheck, updateCheckTimeout, updateCheckBtnRef, updaterCleanupFunctions, updaterCandidateId                                                           |
| Licenses overlay (1815-1915)                  | licensesPreviousFocus, licensesTrapHandler (also reads shared previousFocus, licensesFocusinHandler)                                                              |
| Deno check, flat UI, setup wizard (1925-2626) | none (WIZARD_SETTING_KEYS const)                                                                                                                                  |
| Startup-ready and close handshake (2627-2644) | resolveRendererStartupReady, resolvePrepareForCloseHandler, prepareForCloseHandlerIsSet                                                                           |
| initializeRenderer body (2645-6029)           | none at module level; ~50 closures: presets, playlist scope, preview cache, settings search, replay, queue wiring, IPC listeners                                  |

Shared with the rest of the engine and therefore NOT moved: `showToast`, `renderStatusText`, `formatBytes` wrapper, `formatRelativeTime` (used by stats too), `revealFileLocation` (used by activity and by queue `openFileLocation`), `logError`, `dockModule`, `iconsModule`.

## Extraction chosen: download activity panel

Moves: `loadLegacyHistory`, `hostFromUrl`, `describeActivityProfile`, `toActivityRows`, `createActivityActionButton`, `renderActivity`, `setActivityEntries`, `setActivityFilter`, `clearActivity`, the `HISTORY_KEY` const, and the four activity `let`s. Owned state lives in a closure created by `initActivityPanel(...)`.

Hosting: the new code lives in `src/modules/downloads.ts`, not a new file. Reason: `src/tests/rosiEngine.dom.test.ts` evaluates a hard-coded `MODULE_FILES` list (ui, downloads, queue, settings, updates, dock) and the engine itself is evaluated without imports. A brand-new module file would not be loaded in that suite, so the activity replay and list tests would fail. Changing that list would edit a test, which the rules forbid. Follow-up: add a new `activity.ts` once the test list can be updated with the owner's approval.

## Ways this refactor could break behavior

1. Double event binding: filter buttons (`.activity-filter` click) or `onDownloadActivityUpdate` could be registered twice if init runs twice. Mitigation: `initActivityPanel` has exactly one caller (the engine's startup, at the old `renderActivity()` position). No guard is added, so this rule depends on that single call site.
2. Init order: `renderActivity()` ran before filter wiring and before `activityReplayHandler` was set. The replay handler is now passed in at init. With no entries at init time, no replay button can render earlier, so the visible result is identical. Verified by reading the code path (`toActivityRows` returns legacy rows with no `request`).
3. Init order versus `window.api`: `window.api` is defined by tauri-bridge.ts, which main.ts imports first. The module reads `window.api` only inside functions called after init, so a late bind is fine. The module must not touch `window.api` at load time.
4. Module-level state duplicated: `activityEntries` must exist once. The engine must not keep a second copy. `activityLoaded` gates the unseen-marker logic and must still skip the first load.
5. DOM ids not found at import time: `#download-history`, `#history-list`, `#history-count` are looked up inside `renderActivity` at call time, not at load time. Missing nodes must still return early.
6. Lost closures and `this`: `activityReplayHandler` previously captured `replayActivityDownload` (a closure in initializeRenderer). It now goes in through an `onReplay` option. `showToast` and `renderStatusText` are passed in as deps so the module does not reach back into the engine.
7. `formatBytes`: the engine wrapper returns `String(bytes)` when the downloads module is missing. The moved code calls the module-local `formatBytes` directly. Same output whenever downloads.ts is loaded, which main.ts always does. Documented, not a behavior change in practice.
8. Icon lookup: `iconsModule?.icon(name, 16)` returned null when icons was missing, and the code fell back to text. The icons dep must keep that null-tolerant path.
9. Dock unseen: `dockModule?.markUnseen('activity')` must still run only on growth after the first load. The dep is optional.
10. clearActivity error paths: the toast text and `false` return must stay identical. The caller still decides the success toast.
11. Legacy localStorage history: `HISTORY_KEY` removal happens on clear. A corrupt JSON value must still fall back to []. Behavior kept verbatim.
12. Contract tests grep rosiEngine.ts text (`queueSection`, `.getQueue()` once, `licensesOverlayEl.addEventListener('click'`, arrow keys, `onSettingsImported`, `Digit`-style keys). None of those strings are moved. Verified by running vitest.
13. Typecheck: engine still needs `RosiDownloadActivity` (global type). The module needs the same global type plus local ActivityFilter/ActivityRow types. The `RosiModules.downloads` type gets the new `initActivity` signature in renderer-globals.d.ts.
14. Lint comments: moved comments must stay under the comment lint rules, with no em dashes.
15. Event listener leaks on tests: the dom test tracks document listeners. The activity module adds no document-level listeners; it only adds listeners to the filter buttons and the replay/copy/open buttons it creates.

## Activity module split (re-audit, written before the move)

A1. `modules/activity.ts` loads before `modules/downloads.ts`, so its byte
    formatter is missing when the panel first renders. Guard: activity reads
    the formatter lazily at render time, and main.ts imports downloads first.
A2. The engine still calls `downloadsModule.initActivityPanel`, which no longer
    exists, so Activity never renders. Guard: the engine calls
    `activityModule.initActivityPanel`; vitest replay/activity tests fail otherwise.
A3. The DOM contract test does not load the new module, so the engine sees no
    activity module. Guard: `activity` is added to that test's module list
    (no new assertions).
A4. The production bundle omits the module. Guard: main.ts imports it; typecheck
    and the E2E Activity scenarios cover the shipped bundle.
