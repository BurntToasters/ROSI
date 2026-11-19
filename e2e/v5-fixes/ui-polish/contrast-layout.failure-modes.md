# Contrast, modal height, queue textarea, URL field padding, toast placement: failure modes

Written before the code changes. Each row names a way the fix could fail or
regress and the E2E check in `contrast-layout.spec.js` that must catch it. Checks
drive the real renderer through the E2E bridge and read computed styles and
bounding rectangles from the live page.

## Status and accent text contrast (C10)

1. **A text token is still the fill color.** A status or accent text element
   resolves to `--success`, `--warning`, `--danger`, or `--accent-light` on a
   light or purple background. Check: in every theme, a sample element colored
   with each `--*-text` token has a computed color whose WCAG contrast against
   its effective background is at least 4.5:1, and the check fails if a token
   is missing (empty computed value).
2. **The fix changes the dark theme.** Dark text tokens must keep the existing
   look, except `--danger-text`, which the U9 fix moves to #fa8888 (rgb(250, 136, 136))
   so it passes AA on tinted dark surfaces. Check `dark-theme-text-values-unchanged`
   pins the four dark values to these exact colors, so any further change must update
   the pin on purpose. The `text-tokens-contrast-4_5` check also requires each dark
   token to be at least 4.5:1 on the dark background. Purple's `--danger-text` is also
   #fa8888, but no check pins purple's exact color; only the 4.5:1 check covers it.
3. **Effective background is read from the wrong layer.** Contrast is computed
   against `body` only, so translucent surfaces above it are ignored. Check: the
   background walk alpha-composites every ancestor background before measuring,
   and the sample is placed inside the live shell so a surface layer contributes.
4. **Contrast passes only because the sample is not visible.** A `display:none`
   or zero-size sample gives a meaningless color. Check: each sample has a
   non-zero bounding box before its contrast is recorded.
5. **Fill tokens change by mistake.** Fills, borders and icons must stay on the
   original tokens. Check by grep at review time (not E2E): `--success`,
   `--warning`, `--danger` remain on fills and borders in the four owned files
   except where a text use is switched to a `*-text` token.

## Modal height at the minimum window (C6)

6. **A long message pushes the buttons off-screen.** A 4,000-character message in
   the app modal at 900x560 must keep every button inside the viewport. Check:
   after showing the modal, each `.modal-buttons .btn` rectangle has top and
   bottom within `0..innerHeight` and left and right within `0..innerWidth`.
7. **The box is taller than the viewport.** The modal box height must not exceed
   the viewport. Check: `.modal-box` bounding height is at most `innerHeight`.
8. **The message does not scroll.** The message area must scroll instead of
   growing. Check: `.modal-message` has `scrollHeight > clientHeight` and an
   overflow-y of `auto` or `scroll`, and the buttons are still visible after the
   scroll position is set to the bottom.
9. **The window cannot be resized on this platform.** The 900x560 case cannot run.
   Check: the report records `resized: false` and the check's `invariantPassed`
   is `null` (not proven). It must never be recorded as passed.
10. **A short message is clipped.** A one-line message must render without a
    scroll container overflow (`scrollHeight <= clientHeight`), and the box still
    shows its heading. Check: the same modal with a short message keeps its
    message fully visible.

## Queue textarea at rest (C13)

11. **The empty one-row textarea still shows a scrollbar.** The rest padding is
    overridden: `textarea.field` in controls.css sets 0.45rem, which outranks the
    queue rule, so the one-row line (about 16.7px) needs 31px against a 28px
    client box. Check: with the textarea empty and not focused, `scrollHeight <=
    clientHeight` and no scrollbar gutter (border-adjusted `offsetWidth -
    clientWidth` and `offsetHeight - clientHeight` are 0).
12. **The resize grip is still shown.** Check: the computed `resize` of the queue
    textarea is `none`.
13. **Overflow is hidden for real content.** Typed content taller than the box
    must still scroll. Check: after entering six lines, the computed `overflow-y`
    is `auto`, `scrollHeight > clientHeight`, and setting `scrollTop` to the end
    moves it.
14. **The placeholder rule breaks typing.** Placeholder-only CSS must not change
    the value or the height of a filled textarea. Check: a typed URL keeps its
    value and the height is 64px when not empty.

## URL field text padding (C14)

15. **The padding is still the old 7.5rem default, or too small for the actions
    group.** Check: the input's `padding-right` is at least the widest actions
    group plus its right inset, measured in each state with the preview button
    forced visible (value state: preview and clear; empty state: preview and paste).
16. **A visible in-field button starts inside the text area.** Check: every button
    visible in the worst case of its state starts at or right of the content edge
    (input right minus border minus padding). The clear button must be among them.
17. **The natural layout leaves a button in the text area.** Check: with the app's
    own state (no forced styles), every visible in-field button starts at or right
    of the content edge. The app hides paste while the field has text and hides
    clear while it is empty (url-actions.ts), so each button is judged in the state
    where it shows.

## Toast placement (C13)

18. **A toast covers the dock toolbar or the Download button at 900x560.** An info
    toast and an error toast are shown together; neither rectangle may intersect
    the `.dock-toolbar` rectangle or the `#downloadBtn` rectangle.
19. **Toast placement moves off-screen.** Each toast rectangle must lie inside
    `0..innerWidth` and `0..innerHeight`.
20. **The polite and assertive toasts stack on each other.** Shown together, the
    two toast rectangles must not overlap.
21. **The window cannot be resized on this platform.** The 900x560 toast case
    records `resized: false` and `invariantPassed: null`, never a pass.

## Computed contrast (WCAG 2.x relative luminance)

Ratios are computed from the two background stops each theme's body gradient
uses (`--bg-gradient-mid` and `--bg-gradient-end`), with the text color on top.
These are opaque-background figures. The E2E check also composites the live
translucent ancestors of its probe, so its measured ratio can differ slightly.
Each token passes on both stops.

Before (fill tokens used as text):

| Theme | Token | Background | Ratio |
| --- | --- | --- | --- |
| light | `--success` #22c55e | #eef3f8 | 2.04 (about 2.1, as briefed) |
| light | `--warning` #f59e0b | #eef3f8 | 1.92 |
| light | `--danger` #ef4444 | #eef3f8 | 3.37 |
| purple | `--accent-light` #7c3aed | #18122a / #1e163a | 3.18 / 2.99 |

After (text tokens, per theme):

| Theme | Token (value) | Background | Ratio (mid / end) |
| --- | --- | --- | --- |
| dark | `--success-text` #22c55e | #0d0f14 / #10131a | 8.41 / 8.16 |
| dark | `--warning-text` #f59e0b | #0d0f14 / #10131a | 8.93 / 8.65 |
| dark | `--danger-text` #fa8888 | #0d0f14 / #10131a | 8.16 / 7.91 |
| dark | `--accent-text` #67e8f9 | #0d0f14 / #10131a | 13.22 / 12.82 |
| purple | `--success-text` #22c55e | #18122a / #1e163a | 7.95 / 7.49 |
| purple | `--warning-text` #f59e0b | #18122a / #1e163a | 8.44 / 7.94 |
| purple | `--danger-text` #fa8888 | #18122a / #1e163a | 7.72 / 7.26 |
| purple | `--accent-text` #a78bfa | #18122a / #1e163a | 6.66 / 6.27 |
| light | `--success-text` #166534 | #eef3f8 / #e7edf5 | 6.39 / 6.05 |
| light | `--warning-text` #9a5a0a | #eef3f8 / #e7edf5 | 4.90 / 4.64 |
| light | `--danger-text` #b91c1c | #eef3f8 / #e7edf5 | 5.80 / 5.49 |
| light | `--accent-text` #1d4ed8 | #eef3f8 / #e7edf5 | 6.00 / 5.69 |

The `system` option resolves to dark or light and is measured as that theme.
The dark values equal the previous fill colors, except `--danger-text`, which is lighter (#fa8888, rgb(250, 136, 136)) so danger text passes AA on tinted dark surfaces. The `dark-theme-text-values-unchanged` check pins this value.
