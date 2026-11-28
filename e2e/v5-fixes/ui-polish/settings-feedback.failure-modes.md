# Settings feedback: failure modes

Written before the code changes. Each row names one way a fix could fail or
regress and the E2E check that must catch it. Checks drive the real renderer and
the native bridge on the built E2E binary.

## Update channel disclosure (U3)

1. **The second toggle removes the chevron.** The old click handler replaced the
   button text, which dropped the chevron icon. Check: the chevron node captured
   before toggling is the same node, still inside the button, after two toggles.
2. **The label changes.** The button keeps its markup (`Channel` plus the
   chevron). Check: the button's text is `Channel` before and after the toggles.
3. **`aria-expanded` falls out of step with the panel.** Check: after each
   toggle, `aria-expanded` equals whether `#updateChannelContainer` has the
   `visible` class.

## Section reset (L5)

4. **Interface reset also resets Flat UI.** Flat UI lives in the top bar, not
   the Interface section. Check: after Interface "Reset section" the saved
   `flatUi` and the `#flatUiToggle` checkbox both stay on.

## Settings import failure (L4)

5. **A failed import still says "or was cancelled".** Not E2E-checked: the
   native dialog seam only answers cancel, so a real import failure cannot be
   forced from the spec. Covered by code: the fallback text is `Import failed.`

## Reset Stats (L7a)

6. **Reset Stats resets with no prompt.** Check: the first click opens the
   "Reset Statistics?" confirm and the `resetStats` call count is 0.
7. **Cancel on Reset Stats still resets.** Check: after Cancel the count stays 0
   and the modal closes.
8. **The Reset Stats confirm does nothing.** Check: Confirm makes the count 1
   and the backend total downloads 0.

## Preset delete (L7b)

9. **Preset Delete removes with no prompt.** Check: the first click opens the
   "Delete Preset?" confirm and the backend still holds the preset.
10. **Cancel on preset Delete still deletes.** Check: after Cancel, the backend
    and the preset select still hold the preset.
11. **The preset Delete confirm does not delete.** Check: Confirm removes the
    preset from the backend and from the select.
12. **A refused delete drops the preset from memory.** Check: with `saveSettings`
    refused for the preset list, the select keeps the preset selected, the
    backend still holds it, and the status reads "Could not delete the preset.".
13. **A refused preset save keeps the unsaved preset in memory.** Check: with
    `saveSettings` refused, the select has no option for the new name and the
    backend does not hold it.

## Update download cancel (L7c)

14. **The cancelled update download still opens a priority modal.** Not checked
    here: the cancel needs a held update transfer, which the updater fixture
    provides. Covered by `updater-engine.spec.js`,
    `cancelled-busy.spec.js`, and `state-updater.spec.js`, which now wait for
    the info toast and assert that no modal is open.

## First-run wizard (L8)

15. **The wizard leaves a control stale after the hand-sync is removed.** Not
    E2E-checked: the first-run wizard runs only on a fresh profile. Covered by
    code: `closeWizard` runs `onComplete` after `finalizeWizard` saves, and
    `onComplete` calls `updateUIFromSettings()`, which sets the theme,
    notifications, update check, download-location and folder controls.

## Harness

16. **A check reads the backend before the renderer has reported the result.**
    The renderer re-renders the preset select and the stats toast after the
    backend persists, so a backend read taken at the click races the report.
    The spec waits for the renderer outcome first (the status text, the select
    option, or the toast), then cross-checks the backend.
