# Settings string fields to enums: failure modes

`theme`, `dockTab`, `downloadMode`, `gpuType` and `updateChannel` move from
`String` to closed Rust enums (`src-tauri/src/types.rs`). The JSON names stay
the same.

1. A serialized value changes spelling (for example `best-video` becomes
   `BestVideo`), breaking the renderer, settings files and exports.
2. A stored value that is unknown or the wrong type stops the whole settings
   file from loading instead of falling back to that key's default.
3. The allowed lists used by IPC validation drift from the enum variants.
4. `downloadMode` inference from ROSI 4 fields (`audioOnly`, `advancedOptions`,
   `downloadProfilesEnabled: false`) changes.
5. Derived flags (`advancedOptions`, `audioOnly`, `bestQuality`) stop matching
   the mode.
6. A request-level `profile` or `gpuType` override no longer reaches the
   effective download settings.
7. The macOS `auto` GPU path or the explicit vendor encoders change.
8. The native title bar theme mapping (light, dark, purple, system) changes.
9. A settings patch with a valid value is rejected, or an invalid one accepted.
