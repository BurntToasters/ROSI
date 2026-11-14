# Dead-code removal (C16, T8): failure modes

Each row is a way a removal could break the app or a test, the evidence that
the code is dead, and the existing check that would catch a regression. No new
E2E case is added: every removal below is proven by existing suites, and the
frontend contract is proven by `npm test` and `npm run typecheck`.

## CSS: `-webkit-app-region` (03-main.css, three declarations)

| Failure mode | Evidence it is dead | Covered by |
| --- | --- | --- |
| The top bar stops dragging the window. | The main window is decorated: `src-tauri/tauri.conf.json` sets no `decorations` key (default true). `window.rs` `decorations(false)` applies only to the splash window. No `data-tauri-drag-region` and no `startDragging` call exists in `src/` or `src-tauri/src/`. WebView2 and WKWebView ignore `-webkit-app-region`. | No E2E checks drag. Native title bar stays, so there is no custom drag surface to lose. Manual check on Windows: drag the native title bar. |
| `controls.css:44,327` still carry the same declarations. | Outside this worker's file list. They are equally inert. | Same as above. Reported for a follow-up. |

## CSS: breakpoints `max-width: 780px` and `max-width: 560px` (06-responsive.css)

| Failure mode | Evidence it is dead | Covered by |
| --- | --- | --- |
| A layout below 780 CSS px loses its wrapping or single-column rules. | `minWidth: 900` (`tauri.conf.json`), applied by tauri-runtime-wry as a min size constraint. The main window has no zoom path: `zoom_hotkeys_enabled` defaults off and wry 0.57 sets `SetIsZoomControlEnabled` from it; `app_menu.rs` has no zoom item. The splash window does not load `main.css`. The CSS viewport is the window's client area, which is the 900 px minimum minus window borders (a few px), so it stays above 780 px and both rules never match. The border width is not measured here; the 900x560 E2E runs are the proof. | `contrast-layout.spec.js` (modal and toast at 900x560), `ui-polish-readiness.spec.js:795` (900x560 setWindowSize), `main.spec.js:2268` (small-window size). |
| The `max-width: 960px` rule is removed by mistake. | Kept on purpose: it applies at 900 to 960 px. | Same specs at 900x560. |
| `max-height: 700px` block. | Kept: height, not width. | Same specs. |

## Queue: bare-array branch (bind/backend-events.ts, `onQueueUpdate`)

| Failure mode | Evidence it is dead | Covered by |
| --- | --- | --- |
| A bare array from the backend is no longer rendered. | Only one emitter exists: `coordinator.rs` `publish` emits `QueueSnapshot { revision, items }` (`types.rs` `QueueSnapshot`, generated as `QueueSnapshot` in `generated/ipc-types.ts`). `api.ts` still types the callback as `RosiQueueSnapshot \| RosiQueueItem[]`, so the cast `payload as RosiQueueSnapshot` replaces the branch. `getQueue()` is a separate call and is not changed. | `queue-coordinator.spec.js` (revision ordering), `main.spec.js` queue scenarios, and `rosiEngine.dom.test.ts` "renders queue updates pushed from the main process", whose fixture now sends a snapshot. |
| A stale snapshot overwrites a newer one. | Revision check kept unchanged (`snapshot.revision < latestQueueRevision`). | `queue-coordinator.spec.js`. |

## Queue: `queue-section` fallback id (modules/queue.ts)

Kept. Not removed. `rendererModules.test.ts:217` asserts the legacy id
resolves, and that file is not in this worker's list. The app markup only uses
`queueSection`, so the fallback is dead in the app. Removing it breaks `npm test`.

## Handoff: `window.rosiMessages` (engine/messages.ts)

Kept. Not removed. Readers: `modules/activity.ts:6` and `modules/queue.ts:36`
(`uiMessages()`), `e2e/v5-fixes/ui-polish/wording.spec.js:560,591`, and a
comment in `rendererModules.test.ts`. Removing the handoff needs edits to
modules outside this worker's list and an E2E spec change.

## Always-true `typeof api.X === 'function'` checks

Each check is removed only where `X` is a required member of `RosiRendererApi`
(`src/api.ts`). The DOM test's `buildMockApi` is the only test double for
`api`; a removed check must have its member present in that mock or the test
throws.

| Site | X | Failure mode if removed | Mock in dom test | Covered by |
| --- | --- | --- | --- | --- |
| `engine/core.ts` `logError` | logError | An error log call throws. | present | `tsc`; error paths in `main.spec.js`. |
| `engine/bind/activity.ts` | getDownloadActivity | Activity panel never loads on start. | present | `main.spec.js` activity scenarios. |
| `engine/bind/backend-events.ts` | onDownloadActivityUpdate | Live activity updates stop. | present | `main.spec.js` activity scenarios. |
| `engine/messages.ts` | resolveDownloadOptions | Options summary throws inside a timer. The dead "unavailable" branch is removed too. The mock lacked this member, so it now resolves `ok({})`. | added | `download-options.spec.js`, `primary-action.spec.js`, `ui-polish-readiness.spec.js`. |
| `engine/queue-controller.ts` | retryQueueItem, reorderQueueItem | Retry or reorder throws on click. | present | `main.spec.js`, `ui-polish.spec.js` queue actions. |
| `engine/settings-store.ts` | getDefaultSettings | Reset defaults cache throws. | present | `settings-reset.spec.js`, `markup.spec.js`, `main.spec.js`. |
| `modules/activity.ts` | clearDownloadActivity | Clear history skips the backend call and the localStorage fallback is removed. The fallback was dead. | present | `main.spec.js` and `markup.spec.js` clear-history paths. |

Not removed: `rosiEngine.ts:84` (`getDefaultSettings`) is outside `src/engine/`
and outside this worker's list. Reported for a follow-up.

## Test fixtures (src/tests/rosiEngine.dom.test.ts, T8)

| Failure mode | Evidence | Covered by |
| --- | --- | --- |
| Deleting the mocks hides a live call. | `downloadUpdate`, `installUpdate`, `onUpdaterStatus` are absent from `RosiRendererApi` (`src/api.ts`). | `npm run typecheck` and `npm test`. |
| `checkForUpdates`, `cancelUpdateDownload`, `onUpdaterProgress` mocks are also absent from the type. | Not in the T8 list. Left for the manager to decide. | n/a |
