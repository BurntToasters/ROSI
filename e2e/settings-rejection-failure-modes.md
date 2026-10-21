# Settings rejection failure modes

The settings save queue submits immutable snapshots, but renderer edits remain
possible while `saveSettings` and the follow-up `getSettings` call are pending.
The rejection path must handle these cases:

1. A field listed in `VALIDATION_ERROR.details` is changed after its rejected
   snapshot is submitted but before the save response arrives. Restoring the
   on-disk value must not erase the newer edit.
2. A refused field is changed while the rejection handler is waiting for
   `getSettings`. The post-read restore must compare against the rejected
   snapshot and retain the new value.
3. An unrelated setting changes while a refused field is pending. Restore the
   unchanged refused field while preserving the unrelated newer setting; a
   global revision check would leave the refused value in memory.
4. A structured setting has equal contents but a different object identity.
   Equality must be deep so a clone is still recognized as the rejected value;
   arrays must retain order and object keys must be compared independent of
   insertion order.
5. When a refused field itself is unchanged, restore it from disk, refresh its
   control, save valid fields as before, and keep the existing rejection
   message.
6. Successful save responses must retain their existing revision handling and
   backend normalization behavior.

The renderer E2E case holds an actual backend rejection, edits the same field
during the save and settings-read waits, then checks both the visible control
and `settings.json`. Its recorded observation is the repeatable proof artifact.
