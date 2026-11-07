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

## Typed `save_settings` payload (B4)

`save_settings` takes `FalliblePayload<JsonObject<SettingsPatchInput>>`. Every
known key is an `Option<FalliblePayload<T>>`, so one bad field never fails the
whole struct. These cases must keep the behavior of the old `Value` validator:

1. Wrong JSON type for a field (a string for a boolean, a number for an enum,
   an array for `ffmpegPath`): the field is refused with its existing message
   (`"<key> must be a boolean."`, `"theme must be one of: ..."`, and so on), the
   other fields are saved, and `details` lists the refused key.
2. `null` for a boolean, enum or path field is a wrong type, not an absent field,
   so it is refused with the field's message. `present_payload` keeps `null` as
   `Invalid`. Notification options and queue reorder fields still treat `null`
   as absent, as before.
3. Missing field: not a rejection. The stored value is kept.
4. Extra unknown key: ignored and not saved, as before. No `deny_unknown_fields`
   is added, so this stays a deliberate decision.
5. Non-object payload (array, string, number, `null`): `VALIDATION_ERROR` with
   `"Settings payload must be an object."`. `JsonObject` rejects arrays, because
   serde would otherwise build a struct with all defaults from `[]`.
6. Message drift: every refused field keeps the literal message from the old
   `validate_setting_value`. The rejection list is sorted by key, matching the
   old `serde_json::Map` (no `preserve_order`), so the joined message order is
   unchanged.
7. Validator skipped by the typed path: each typed value still goes through its
   policy closure (allow-lists, length limits, `validate_download_path`,
   `validate_ffmpeg_path_value`, `parse_upstream_proxy`, subtitle language
   syntax). A typed `theme: "neon"` is refused the same way the `Value` path
   refused it.
8. Unchanged value: a field equal to the stored JSON is skipped before
   validation, as before, so a stored FFmpeg path that is missing on disk is not
   reported on every save. Equality uses the field's JSON (`as_json`), which is
   the re-serialized typed value or the raw invalid value.
9. `downloadPresets` keeps its nested grammar in `validate_preset_list`. Both the
   typed and the invalid path run that validator, so its messages are unchanged.
