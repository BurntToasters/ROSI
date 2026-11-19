# Long-term audit: UI and error-reporting fixes: failure modes

Covers audit items U1, U2, U3, U4, U5, U6, U8, and U9 from
`~/security-audit-skill/ROSI/run-20261118-longterm/REPORT.md`. Written before the
spec. Each numbered row is one way a fix could fail or regress.
`longterm-audit.spec.js` checks each row by the check name in the Check column.
Rows marked "Not automated" name the reason.

Test seams used, and what they do not prove:

- `window.__ROSI_E2E__.modules.ui.showToast` and `.modules.dock.selectTab` are the
  real renderer functions. Toast geometry and the dock state are read from the DOM.
- `window.__ROSI_E2E__.api.getVideoInfo`, `downloadVideo` are replaced on the
  bridge object for the preview and busy-button rows only. The renderer reads them at
  call time. Every other check runs through the real backend.
- U5 and U6 use a real download of `${ROSI_E2E_MEDIA_URL}/missing-longterm.mp4`. The
  gate's media server answers 404 for it, so yt-dlp fails without network access.
- Contrast is computed from computed styles, like `contrast-layout.spec.js`. The
  light-theme measurement includes the element's `opacity`, since rendered contrast
  includes it.

## U1: the resolved-options summary follows the profile

1. **The video summary still lists the audio output format.** The fix does not gate
   `audioOutputFormat` on the audio profile. Check `summary-audio-format-follows-profile`:
   with the Compatible profile, `#downloadOutputSummary` must not contain the
   upper-case `audioOutputFormat` that the backend resolves.
2. **The audio profile loses its audio format.** The fix removes the format from both
   profiles. Same check: with the Audio only profile, the summary must contain it.
3. **The video summary goes blank or stops resolving.** An over-broad fix hides the
   summary. Same check: the summary must reach `data-state="resolved"` with
   `data-profile="compatible"` and non-empty text.
4. **The summary shows the previous profile after a switch.** Same check: it waits
   for `data-profile` to match the clicked profile before it reads the text.
5. **"Convert to MP3" appears for a video.** Not automated: this spec does not turn
   Convert on, so the conversion text is outside its inputs.

## U2: the loading preview does not show the previous video

6. **The previous title stays in `#preview-title` while B loads.** Check
   `preview-loading-hides-previous-video`: while `#preview-card` has `loading`, the
   title must read `Loading preview…`.
7. **The previous subtitle or duration stays.** Same check: the subtitle must not
   contain A's uploader or view count, and the duration must not read `0:42`.
8. **The card never gets the `loading` class while B is in flight.** Same check: it
   waits for `loading` to appear, so a missing class fails the check.
9. **The placeholder is blank, not `Loading preview…`.** Same check: the title must
   equal the placeholder text exactly.
10. **A stale reply from A repaints the card after B starts.** Not automated: this
    spec holds only B. The request-token path is the one full-audit-a already checks
    for cancel, so this spec does not add a second held reply for A.

## U3: the busy button says what it does

11. **The busy Download button shows only a spinner.** Check
    `busy-buttons-show-cancel-label`: `innerText` of `#downloadBtn` must contain
    `Cancel` while the `loading` class is set.
12. **The `loader.svg` image stays inside the busy button.** Same check: no
    `img[src*="loader.svg"]` inside the button.
13. **The cancel `aria-label` is lost or changed.** Same check: the Download button
    must keep `Cancel download`, and the Preview button must keep `Cancel preview`.
14. **The busy Preview button has no label.** Same check: it runs the same
    assertions with its held `getVideoInfo` call.
15. **The label stays `Cancel` after the busy state ends.** Same check: after the held
    call is released, the Download button text must be `Download` and the `loading`
    class must be gone.
16. **The spinner colour ignores the theme and fails contrast.** Not automated: a
    visual property with no computed-style test. The screenshot
    `longterm-audit-u3-busy-button.png` is kept for review.

## U4: error toasts do not cover info toasts

17. **An error toast is drawn over an info toast again.** Check
    `toasts-do-not-overlap`: an info toast and an error toast with a two-line message
    are shown together through the real `showToast`, and their bounding rects must not
    intersect. The two-line error is the case the audit names: a two-line toast is taller
    than the 80 px offset.
18. **The error toast leaves the assertive live region.** Same check: its parent must
    have `aria-live="assertive"`.
19. **The info toast leaves the polite live region.** Same check: its parent must have
    `aria-live="polite"`.
20. **The stack order is inverted.** Not automated: the audit asks only for no overlap,
    and this spec does not assert which toast is on top.

## U5: a failed download reports the yt-dlp reason

21. **The stored error reverts to `yt-dlp process exited with code 1`.** Check
    `real-failed-download-shows-ytdlp-reason`: the Activity entry's `error` must
    contain `HTTP Error 404`.
22. **The reason is kept but the exit code is dropped.** Same check: the error must
    still contain `code 1`, as a whole word.
23. **The reason is in the console only, not in the Activity row.** Same check: the
    row's `.history-error` text must contain `HTTP Error 404`.
24. **The download outcome changes to success or cancelled.** Same check: the entry's
    `outcome` must be `failed`.
25. **The stored error is unbounded.** Not automated: the audit gives no cap value, so
    this spec has no length to assert.
26. **Queue rows show the old error text.** Not automated: this spec reads only the
    Activity panel. Queue rows are outside the U5 check here.

## U6: a failed row names its file, not its host

27. **The title reverts to the host (`127.0.0.1`).** Check
    `activity-missing-file-row-title`: `.history-filename` for the failed row must read
    `missing-longterm.mp4`.
28. **The host appears as both title and subtitle.** Same check: the first `•` segment of
    `.history-time` must not equal the row title. A host in the subtitle under a file-name
    title is correct and is not a failure.
29. **The title shows the raw URL instead of the file name.** Same check: the title
    must equal the file name exactly, not the URL.
30. **A successful row loses its file name.** Not automated: this spec has no
    successful download fixture.

## U8: the closed settings panel and the hidden banner leave the Tab order

31. **Closed settings stay focusable.** Check `closed-settings-and-banner-inert`:
    `#sidebar.inert` must be `true` while `open` is absent, and focusing `#closeSidebar`
    in that state must not move focus.
32. **Settings stay inert after opening.** Same check: after `#settingsBtn` opens the
    panel, `#sidebar.inert` must be `false`.
33. **Inert is not set again after closing.** Same check: after `#closeSidebar`, the
    panel must be inert again.
34. **The hidden update banner is focusable.** Same check: when `#update-banner` lacks
    `active`, its `inert` must be `true`.
35. **The banner stays inert while shown.** Not automated: the banner shows only for a
    real updater download. The Update Ready prompt that full-audit-a drives is a modal,
    not this banner.

## U9: danger text and the light reset link reach 4.5:1

36. **Danger text in Flat dark is below 4.5:1.** Check `flat-dark-danger-text-contrast`:
    with Flat UI on and the dark theme, a `--danger-text` sample inside `.download-card`
    must reach 4.5:1 against its composited background.
37. **Only the token probe passes, while dialogs or settings stay low.** Not automated:
    the probe measures the token on the download card. Dialog and settings surfaces are
    not sampled, so a fix that changes only those surfaces would not show here.
38. **The light `.settings-section-reset` is below 4.5:1.** Check
    `light-settings-reset-contrast`: every visible reset link must reach 4.5:1, using
    the text colour multiplied by the element's `opacity`.
39. **The alpha is raised but the 0.75 opacity remains.** Same check: the opacity is in
    the measurement, so this fails.
40. **Only hover or focus passes.** Not automated: the spec measures the rest state,
    and no pointer or focus is set for the measurement.
41. **The reset links are measured mid slide-in.** This is a measurement fault, not a
    product regression: ancestor opacity below 1 makes the result far too low (1.10:1 was
    seen). Check `light-settings-reset-contrast` waits first (`readResetReadiness`): the
    sidebar is open, its transform is identity, every ancestor of each link has opacity 1,
    and no link is hovered or focused. Not a regression check on its own.

## Shared state

42. **A theme, Flat UI, download profile, Convert toggle, or URL stays changed.** Check
    `shared-state-restored`: each value must equal its starting value, and the backend
    must agree.
43. **A stub or held call stays installed.** Same check: `getVideoInfo` and
    `downloadVideo` must be the original functions, with no held promise.
44. **The real failed download stays in Activity history.** Same check: the spec clears
    Activity history with `clearDownloadActivity`, and no entry for the missing file
    may remain.
45. **A screenshot changes after the report is written.** Not automated here. The gate
    re-hashes each `v5-screenshots` record with `verifyScreenshots`. This spec collects
    its shots during the run and appends exactly one `v5-screenshots` record in its
    `after` hook. A second record would make the gate report the scenario as incomplete,
    so the spec must never write one per screenshot.
