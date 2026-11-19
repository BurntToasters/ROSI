# Full audit B renderer fixes: failure modes

Covers audit items U3, U5, U6, U7, U8, and U9. Each numbered row is one way the
change could fail or regress. `full-audit-b.spec.js` checks each row by the check
name in the Check column. Rows marked "not automated" name the reason.

## U3: queue links use the main URL's playlist scope only for the main URL

1. **A queue link that is not the main URL is blocked by an invalid main-URL
   range.** Check `queue-other-links-ignore-invalid-range`: with the playlist
   range set to 5-2 (invalid), a textarea holding a different URL reaches
   `addToQueue`, and the status does not say "Fix the playlist range".
2. **A queue link that is not the main URL inherits the visible range.** Check
   `queue-other-links-no-playlist-override`: with a valid range 2-4 visible, the
   overrides sent for a different URL have no `playlist` key.
3. **The guard is too wide: the main URL with an invalid range is no longer
   blocked.** Check `main-url-invalid-range-blocks-queue`: the textarea holds only
   the main URL with range 5-2; `addToQueue` is not called and the status reads
   "Fix the playlist range before adding to the queue."
4. **The guard is too narrow: the main URL loses its valid range.** Check
   `main-url-range-sent-to-queue`: the textarea holds only the main URL with range
   2-4; the overrides carry `playlist` equal to `{ mode: "range", start: 2, end: 4 }`.
5. **Whitespace around the main URL line drops its range.** Check
   `main-url-range-sent-to-queue`: the same case with the line padded by spaces
   still sends the range.
6. **A batch that includes the main URL takes the main range or is blocked.**
   Check `multi-link-batch-ignores-main-range`: two lines, one of them the main URL,
   with range 5-2; the add is not blocked and no `playlist` key is sent.
7. **A hidden playlist scope starts sending a playlist.** Check
   `hidden-scope-sends-no-playlist`: with the scope hidden, the main URL alone is
   queued with no `playlist` key.
8. **Format selections for other links start leaking or stop applying.** Not
   automated: the format branch is unchanged, and the test profile has no format
   selections set, so a leak would not show in the overrides. The existing
   ui-polish and presets specs cover the format path.

## U5: focus stays on a failed or cancelled row's details summary

9. **The summary still loses focus when the queue re-renders.** Check
   `failed-details-focus-kept`: focus the failure summary, add a second pending
   item (one broadcast), and the focused element is the same summary inside the same
   failed row.
10. **Restore breaks for the row's existing controls.** Check
    `failed-row-retry-focus-kept`: focus the Retry control on the failed row, run one
    broadcast, and Retry is still focused.
11. **Details open state is lost, or the summary stops toggling.** Check
    `failed-details-focus-kept`: `details.open` is true after a summary click and
    still true after the broadcast.
12. **Focus lands on another row's control because the summary now matches a
    different row.** Check `failed-details-focus-kept`: the focused summary's closest
    `.queue-item` is the failed row (matched by `data-queue-id`).
13. **After a retry or removal, the summary is picked up ahead of an enabled
    action.** Not automated: the DOM order keeps the action buttons before the
    summary in each row, and a retry needs a backend failure cycle that this
    spec does not drive.
14. **Some selector or count of `[data-queue-action]` changes.** Not automated:
    the existing queue selectors in the ui-polish and queue-coordinator specs use
    exact action values (for example `queue-item-remove`), so the new `details`
    value does not match them.

## U6: the Activity tab is marked unseen when a new entry arrives at the cap

15. **A new entry does not mark the tab once the list is full.** Check
    `activity-unseen-at-cap`: with the activity tab not selected, a three-entry
    list is replaced by a three-entry list that drops the oldest id and adds one new
    id. `#dockTabActivity` has class `has-unseen`.
16. **A re-sent snapshot with no new ids marks the tab.** Check
    `activity-resend-no-unseen`: after the badge is cleared, the same list and then
    an empty list are sent; `has-unseen` stays absent.
17. **The badge appears while the Activity tab is selected.** Check
    `activity-unseen-tab-selected`: with the Activity tab selected, a new id does not
    add `has-unseen`.
18. **The first load marks the tab.** Not automated: the first load runs once at
    renderer start, from the backend log. The spec cannot seed that log without a
    real download and a renderer restart, and the in-page stubs do not survive a
    reload. The `activityLoaded` guard is unchanged by this fix.

## U7: an empty folder reads "Downloads folder (default)"

19. **The rendered summary still says "Choose a folder" with no folder set.**
    Check `empty-folder-downloads-default`: after saving an empty folder with
    "Ask every time" off and reloading the renderer, `#downloadFolderSummary` text is
    "Downloads folder (default)".
20. **The tooltip still shows the old text.** Check `empty-folder-downloads-default`:
    the title is "No folder set. Downloads save to your Downloads folder."
21. **The initial markup disagrees with the renderer text.** Check
    `initial-html-folder-text`: `src/index.html` holds the same text inside
    `#downloadFolderSummary`. The renderer overwrites that text at startup, so the
    check reads the source file.
22. **A set folder renders wrong (the path is split into head and tail).** Check
    `folder-set-shows-path`: with a real folder set, the `.download-destination-tail`
    is the folder name and the title is the full path.
23. **"Ask every time" on with no folder shows the default text while a folder prompt
    appears.** Not automated: the requested wording is for the empty folder without
    regard to the toggle. This is reported as uncertain in the run report.

## U8: the wizard theme radios have a group name

24. **The theme radios have no group name.** Check `wizard-theme-radiogroup`:
    `.wizard-theme-grid` has `role="radiogroup"` and `aria-label="Theme"`.
25. **The markup change drops a radio from the group or changes its name.** Check
    `wizard-theme-radiogroup`: the grid holds four `input[name="wizard-theme"]`
    radios, and the `system` radio is still checked.
26. **Arrow-key movement between the radios breaks.** Not automated: the radios
    stay native inputs, so arrow keys work without any change. The wizard is not
    open in the test profile, and this spec does not drive it.

## U9: focus outline remains visible in Windows forced-colors mode

27. **The `.field:focus-visible` rule has no outline in forced colors.** Check
    `focus-outline-css-rules`: the rule's outline is `2px solid` with a transparent
    color, and its outline offset is at least the 3px ring.
28. **The URL field focus rule has no outline in forced colors.** Check
    `focus-outline-css-rules`: `.url-input-container input:focus` has the same
    outline and an offset of at least 4px.
29. **The wizard toggle focus rule has no outline in forced colors.** Check
    `focus-outline-css-rules`: `.wizard-toggle input:focus-visible + .toggle-slider`
    has the same outline and an offset of at least 4px.
30. **Normal rendering changes.** Check `focus-outline-css-rules`: each of the three
    rules still sets `border-color` and `box-shadow`, and the outline color is
    transparent, so the outline is invisible outside forced colors.
31. **The forced-colors rendering itself is not shown.** Not automated: WebDriver
    cannot turn on forced colors for this WebKit window. The check reads the
    computed CSS rules, not the painted pixels.
