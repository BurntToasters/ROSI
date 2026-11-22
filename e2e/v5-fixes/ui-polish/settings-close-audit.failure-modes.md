# Settings drain, close save error, and wizard skip: failure modes

Written before the code changes. Each row names the way the fix could fail or
regress and the E2E check that must catch it. Checks drive the real renderer on
the built E2E binary. Backend answers are replaced only through the E2E IPC stub
registry (`window.__ROSI_E2E_IPC_STUBS__`, read by `call()` in
`src/commands.ts`); every stub is removed in a `finally` block.

## Settings save drain (F6)

1. **A thrown save reports success from a stale error code.** An earlier save
   left `lastSettingsSaveErrorCode` at `NEWER_VERSION`; a later save that throws
   keeps that code, so `preserved` is true and `persistSettings` resolves true.
   Check: set the code to `NEWER_VERSION`, make `save_settings` reject, and
   expect `persistSettings({ immediate: true })` to resolve false.
2. **A refused save keeps the code of the save before it.** A result with
   `ok: false` and a new code must replace the old code, and a later success must
   clear it. Check: after a `NEWER_VERSION` refusal then a plain `IO_ERROR`
   refusal, the store holds `IO_ERROR`; after a passing save it is null.
3. **A real `NEWER_VERSION` refusal stops counting as preserved.** The reset
   must not break the preserved path. Check: a `NEWER_VERSION` refusal resolves
   true and leaves the code at `NEWER_VERSION`.
4. **The catch stays silent.** A thrown save must reach the log. Check: the
   `log_error` stub records a line that names the settings save failure.
5. **The thrown save leaves no visible failure.** The settings panel feedback
   must read the error state after the throw. Check: `#settingsSaveFeedback`
   has `data-state="error"`.

## Close handler save error (F7)

6. **A failed final save shows nothing until the backend dialog.** Check: with
   `save_settings` refused, a real window close produces a toast that names the
   failure, and the E2E cancel of that close generation still succeeds. A cancel
   after the 1.5 s backend flush timeout fails with "no longer current", so the
   cancel succeeding proves the toast came first.
7. **The error toast carries no backend detail.** Check: the toast text includes
   the backend message that the stub returned.
8. **The handshake reply changes on failure.** A failed save must still send no
   `notify_settings_flushed`. Check: the recording stub sees zero calls after
   the failed save.
9. **A successful save now toasts or stops acknowledging.** Check: with the
   real `save_settings`, the close sends exactly one `notify_settings_flushed`
   with the generation that the `prepare-for-close` listener saw, and shows no
   failure toast.
10. **A newer-version settings file now blocks the close or toasts.** That case
    keeps closing. Check: with a `NEWER_VERSION` refusal, the acknowledgement is
    sent once and no close failure toast appears.

## Setup wizard skip and finish (F9)

11. **Finish during a skip overwrites the defaults in memory.** Skip loads the
    defaults and saves them; a Finish click in that gap runs `gatherSettings`
    over them, so memory and disk disagree. Check: on the last step with the
    dark theme chosen, start Skip through the Escape prompt while the defaults
    request is held, click Finish, release; the saved theme equals the default
    theme, not dark.
12. **Next and Finish stay enabled during a skip.** Check: while the defaults
    request is held, `#wizard-next` and `#wizard-back` are disabled, and a
    programmatic click leaves the step unchanged. The step and the disabled
    state are re-read after two animation frames, so the "no save" check runs
    only once the wizard has shown the held state again. Then `saveCalls` must
    still be 0.
13. **Skip starts during a finish.** Check: with the Finish save held, the
    Escape prompt's "Skip setup" never requests the defaults. The check reads
    `defaultsCalls` only after the prompt has closed (the skip was confirmed) and
    two animation frames have passed, so a request that follows the confirm is
    counted.
14. **A failed defaults load leaves the controls locked.** Check: with
    `get_default_settings` refused, Next, Skip and the error text are restored
    (`#wizard-error` visible, buttons enabled).
15. **A failed skip save leaves the controls locked.** Check: with
    `save_settings` refused, Next is enabled again, Skip is enabled again, the
    error is visible, and Next advances the step afterwards.
16. **The block leaks after a skip finishes.** Check: after a successful skip
    the wizard is closed and `firstLaunch` is false on disk.

## Regression guards

17. **A stub outlives its case.** Every case removes only its own registry keys
    and the page-side state, and restores the stored settings through the real
    API, then reloads the renderer. Check: before each case installs its stubs,
    the stub registry is read and must be empty (no keys at all). The suite's
    `after` hook makes the same read once the last case has finished. Deleting
    the keys and reading them back cannot fail, so that read is not the check.

## Coverage

`settings-close-audit.spec.js` checks rows 1 to 17. Each case lists its rows in
`failureModes`.
