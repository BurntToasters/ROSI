# Queue and format picker feedback: failure modes

Written before the code changes. Each row names one way a fix could fail or
regress and the E2E check in `queue-format-feedback.spec.js` that must catch it.
Rows marked "not E2E-checked" say why the spec cannot reach the case and what
covers it instead. The spec drives the real renderer and the native bridge on
the built E2E binary, and it writes a hashed `report.json` under
`e2e/artifacts/v5-fixes-ui-polish/`. Every wait polls a state the code under
test sets. No fixed sleeps are used to prove a negative except where noted.

## Clear Queue gate (U7b)

1. **Clear is enabled on an empty queue.** The gate read only the busy flag.
   Check: `#clearQueueBtn` is disabled at the start of the case, with an empty
   queue.
2. **Clear stays disabled after items arrive.** The gate must follow every queue
   render, not only the first one. Check: after one link is queued through the
   visible Add to queue path, the button is enabled within 10 seconds.
3. **Clear stays enabled after the queue empties.** Check: after the backend
   `clearQueue`, the button is disabled again within 10 seconds.
4. **The button and the busy lock fight over `disabled`.** If the busy-state
   path still assigns the button and `updateQueueButtonStates` also assigns it,
   the last writer wins and the gate is lost. Check: rows 2 and 3 hold after a
   queue render that follows an add and a clear, with the lock released.
5. **Clear is enabled while a queue action holds the lock.** Not E2E-checked:
   the lock window is too short to observe reliably. Covered by code:
   `updateQueueButtonStates` reads `queueController.queueActionLocks > 0`, as the
   other queue buttons do, and `syncQueueActionBusyState` calls it after every
   lock change.

## Clear Queue confirm (U7a)

6. **The confirm omits the stop warning while an item downloads.** Check: with a
   downloading item, the confirm message matches "current download will be
   stopped".
7. **The confirm claims a stop when nothing downloads.** Check: with an idle
   queue, the confirm message is exactly "Remove all queued and completed items?"
   and does not mention a stop.
8. **Cancel on the confirm removes items.** Check: Cancel on both confirms leaves
   the queue length and the item unchanged.

## Format picker input errors (L6)

9. **An empty URL still opens a modal.** Check: a warning toast carries "Please
   enter a video URL first." and `#app-modal` stays inactive.
10. **An invalid URL still opens a modal.** Check: a warning toast carries "Please
    enter a valid URL starting with http:// or https://" and `#app-modal` stays
    inactive.
11. **The message uses the wrong toast type.** A plain info toast would hide the
    error. Check: both entries have the `toast-warning` class.
12. **The picker message is lost.** `setPickerMessage('Invalid URL')` and
    `clearAdvancedFormatSelections()` must still run for an invalid URL. Not
    E2E-checked as a separate row: the picker text is not part of this spec's
    contract. Covered by code: the call order in `fetchFormats` is unchanged.
