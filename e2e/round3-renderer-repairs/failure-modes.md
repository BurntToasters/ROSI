# Failure modes recorded before implementation

Scope: audit findings 6, 7, 8, 9, and 12 from `/private/tmp/rosi-audit3-report.md`. This list and its DOM diagnostic harness were prepared before implementation.

## Finding 6: overlay focus and inert state

- Opening Reset from the sidebar can make the sidebar and modal focus traps redirect focus to each other until a RangeError occurs.
- Closing the top modal can clear `aria-hidden` and `inert` from main content while the sidebar remains open.
- Closing either overlay can restore focus into a lower layer that is hidden or inert instead of the remaining active layer.
- Repeated overlay open/close operations can retain stale trap listeners or leave the document trapped.

## Finding 7: updater approval identity and stale prompt retirement

- A visible prompt for candidate A can invoke an unbound global action after candidate B replaced A, downloading B under A's approval.
- Queued prompts for retired candidates can appear after a newer prompt or after a no-update/error state.
- Clicking an action from a retired prompt must not download or install any current candidate.
- Rechecking the same candidate must not invalidate the prompt accidentally or permit duplicate downloads.

## Finding 8: URL-bound formats and stale replies

- Changing URL A to B can preserve A's video/audio format IDs and submit them with B.
- A delayed format reply for A can repopulate the controls after B becomes current.
- An old request can clear the loading/error state owned by a newer request.
- A download must not proceed with format choices whose originating URL differs from its submitted URL.

## Finding 9: previous updater channel forwarding

- The bridge can drop the previous channel, leaving both updater override values null on the initial persisted Stable-to-Auto change.
- A null/null comparison can suppress invalidation, rechecking, and retirement of work for the old target.
- Forwarding the previous value must retain the new value and the pending save promise.

## Finding 12: latest preview supersession

- URL B entered while A is fetching can be dropped by the busy guard and never fetched after A settles.
- A stale response for A can overwrite B's preview or clear B's loading state.
- Rapid changes can fetch obsolete intermediate URLs or leave the UI idle without the latest preview.
- Success, rejection, cancellation, and URL-clear paths must drain or cancel the latest pending request safely.

## Integration follow-up: overlay ordering, modal retirement, and preset provenance

These cases were recorded before extending the controlled renderer diagnostic or changing implementation:

- The two `.modal-overlay` elements share `--z-modal`, but `#licenses-overlay` follows `#app-modal` in the document. When both are active, paint order places licenses above the app modal while focus trapping assumes the app modal owns focus.
- Opening an app modal over licenses can make the modal and licenses focusin handlers redirect focus recursively; Escape can close the lower licenses layer while the app modal remains active.
- Closing the app modal while licenses remains open can restore focus to its now-hidden source outside licenses instead of returning focus into licenses.
- Closing licenses while an app modal remains active can restore focus to an element covered by the modal and can clear inert state for the lower page.
- Hiding modal A starts a 200 ms timeout. If A is retired or priority modal B replaces it before that timeout fires, A's stale timeout can remove B's active class, clear its focus ownership, run A's action, or restore stale focus.
- Existing custom-format tests manually insert select options without a successful URL lookup. The new URL-provenance guard correctly treats those values as unverified; adapting test setup must perform the real mocked format lookup before selecting IDs, without weakening stale-URL rejection.
- Applying a saved custom preset inserts its saved format IDs into the selects without a lookup, but those explicit preset choices are legitimate. The renderer must preserve preset-origin choices while continuing to reject lookup choices from a different URL.
- A manual download can validate and capture formats for URL A, then wait for folder selection/settings persistence while the user switches the field to URL B. If final preset overrides are rebuilt after the wait, the request remains for A but carries B's format IDs.
- Queue submission can capture URL list A, wait for a folder picker or settings save while the current URL/formats become B, then read B's selections for the already-submitted A list. Preserve the entry-time selection snapshot across the awaits; do not accept late/stale lookup replies as that snapshot.
- If a format lookup for URL G is still pending when a saved custom preset is explicitly applied, the late lookup response can overwrite those preset IDs even though they belong to a deliberate user action. Applying a preset must invalidate any older in-flight lookup before it sets its own values.
