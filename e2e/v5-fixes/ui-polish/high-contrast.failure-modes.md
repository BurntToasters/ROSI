# High contrast, forced colors, reduced transparency: failure modes

Written before the CSS changes (finding F4). Each row names a way the change
could fail or regress and the check in `high-contrast.spec.js` that must catch
it. The rules live in `src/css/06-responsive.css`.

What the checks can and cannot show:

- The embedded WebDriver (`@wdio/tauri-plugin`) runs scripts in the webview and
  has no DevTools channel. `Emulation.setEmulatedMedia` is therefore not
  reachable, and the gate does not pass a forced-colors switch. Chromium has no
  documented launch switch for forced colors, so none is wired. A developer can
  still run the spec under a real Windows contrast theme; the live rows then run
  (rows 12 and 13).
- Without that, the spec reads the shipped stylesheet through
  `document.styleSheets`, the way `full-audit-b.spec.js` does for U9, and reads
  `src/css` source for the token mapping. It proves the rules exist and target
  the right selectors. It does not prove the painted pixels.
- A row that needs a live media query to match records `not-proven`
  (`invariantPassed: null`), never `passed`. The spec also writes each
  not-proven row to the pass results file as a skipped case with its reason, so
  the gate fails the area unless `e2e/suites.json` allows that case on the
  platform. Rows 12 and 13 need an OS contrast, transparency or forced-colors
  setting that the gate cannot turn on, so their allowances name that reason.
  Rows 1 to 7 get no allowance: a not-proven result there means the engine lacks
  support and needs a decision.
- Engine support is checked, not assumed. Rows that read `forced-color-adjust`
  or `(forced-colors: active)` CSSOM text first run `CSS.supports('forced-color-adjust:
none')` and a `matchMedia('(forced-colors: active)')` parse. Where either is
  missing, the row records `not-proven` with the reason (rows 1 to 7 and 13).
  Row 14 checks the forced-colors pair only where the query parses. On WebView2
  both checks pass, so the rows run as before.

## Forced colors: state stays visible

1. **A toggle is on or off with no visible difference.** Forced colors drops
   background colors, so the track and thumb merge. Check
   `forced-colors-state-rules`: inside `@media (forced-colors: active)`, the
   unchecked and checked `.toggle-slider` (settings and wizard) and
   `.flat-ui-toggle-slider` rules set a system-color background, and the checked
   rule uses `Highlight` for the track and `HighlightText` for the thumb.
2. **A progress fill vanishes.** The fills are `background` gradients or accent
   tokens. Check `forced-colors-state-rules`: `.progress-bar`,
   `.queue-item-progress-bar`, `.wizard-progress-bar` and `.update-banner-bar`
   each get `Highlight`, and their tracks get a `Canvas` background with a
   `ButtonText` outline (no layout change on the thin tracks).
3. **The selected wizard theme card looks like the others.** Check
   `forced-colors-state-rules`: the checked `.wizard-theme-card` rule sets a
   `Highlight` border and background, and the unchecked card keeps a
   `ButtonText` border.
4. **A selected segment or checked checkbox loses its mark.** Check
   `forced-colors-state-rules`: the pressed or selected `.segmented__item` and
   the checked `.check input` rules use `Highlight` and `HighlightText`.
5. **A theme swatch collapses to one color.** The preview swatches show theme
   colors, so they need `forced-color-adjust: none`. Check
   `forced-colors-adjust-scope`: `forced-color-adjust: none` appears on
   `.wizard-theme-preview` and on no other selector.

## Forced colors: only system colors

6. **A rule inside the forced-colors block uses a token or a literal color.**
   `var(--accent)`, hex and `rgb()` values are either replaced or fail to show
   state. Check `forced-colors-system-colours-only`: every color-valued longhand
   (color, background-color, border-color, outline-color, and so on) in the
   block is a system color keyword, `transparent`, `currentcolor`, or `none`.
   Gradients in `background-image` contain no `var(`, `#` or `rgb`.
7. **The default look changes.** A system color leaks outside the media block.
   Check `forced-colors-confined-to-media`: no style rule outside a media
   rule's body declares `Highlight`, `HighlightText`, `CanvasText`, `ButtonText`
   or `GrayText`.

## Contrast and transparency preferences

8. **The preference rules are missing.** Check `preference-media-rules`: the
   source has one block for `prefers-contrast: more` and
   `prefers-reduced-transparency: reduce`, and the shipped stylesheet carries
   the `prefers-contrast` media rule (it is supported, so the engine keeps it).
9. **The mapping drifts from the flat-UI tokens.** The surface, border, sidebar
   and modal tokens in the block must equal the values in the
   `html[data-flat-ui='true']` blocks of `01-base.css`, per theme. Check
   `preference-tokens-match-flat-ui`: the values are parsed from both files and
   compared for dark, purple and light.
10. **A panel stays translucent.** Settings, dialogs, toasts, the wizard and
    popovers are `color-mix(... 96%, transparent)`. Check
    `preference-panels-opaque`: the block sets `.sidebar`, `.modal-box`,
    `.toast`, `.wizard-card` and `.popover` to the opaque modal or sidebar
    token and turns `backdrop-filter` off.
11. **The default look changes without a preference.** Check
    `default-look-unchanged`: with no contrast or transparency preference and
    flat UI off, a probe on `var(--surface-1)` is still translucent and the
    open dialog surface is not fully opaque.
12. **The live preference does not apply.** Runs only when
    `prefers-contrast: more` or `prefers-reduced-transparency: reduce` matches.
    Check `preference-live-opaque`: `var(--surface-1)` is fully opaque and the
    dialog background alpha is 1. Otherwise it is recorded `not-proven`.
13. **Forced colors is active but the rules do not separate state.** Runs only
    when `forced-colors: active` matches. Check `forced-colors-live-state`: the
    checked toggle track differs from the unchecked track, the progress fill
    differs from its track, and the checked wizard card border differs from an
    unchecked one. Otherwise it is recorded `not-proven`.
14. **The media features disagree with each other.** Check
    `media-queries-consistent`: `forced-colors: active` and `none` are
    complements, as are `prefers-contrast: more`, `less`, `custom` and
    `no-preference` (exactly one holds), and the report records whether
    `prefers-reduced-transparency` is supported.

## Screenshots

15. **No evidence of the surfaces the rules touch.** Check `surface-screenshots`:
    PNGs of settings, a dialog, a toast and the wizard are saved in the gate's
    screenshot folder with hashes. They are evidence only; nothing compares
    them to a baseline. Under a normal run they show the default look, so they
    do not prove forced-colors rendering.
