# Queue publication failure modes

Recorded before changing the production queue code. The verifier compiles the
exact `revisioned_snapshot` and `broadcast` functions with a bounded Rust
harness and a stub event transport; it does not launch ROSI or replace native
E2E coverage.

| Failure mode | Guard |
| --- | --- |
| The publication mutex is acquired after the snapshot, so a later queue update can still emit first and leave the older payload last. | The verifier blocks the first transport call, starts a concurrent producer, and requires the emitted arrays to be `[[1], [2]]` with authoritative state `[2]`. |
| A call site holds `QueueState` while waiting for the publication mutex, creating an inverse lock order against `broadcast` acquiring the queue lock. | Review every `broadcast()` call site in `src-tauri/src/queue.rs`; each state guard must be dropped by scope or explicitly before publication. `START_GUARD` may span publication; its documented order is never acquired while holding queue state. |
| Serializing publication changes the event name, payload from an array, or the existing persistence scheduling behavior. | The exact extracted function must compile against the `queue-update` array transport stub, and the verifier requires two persistence schedule calls for two broadcasts. |
| A poisoned publication mutex makes later queue events panic. | Use the existing poison recovery pattern (`unwrap_or_else(|poisoned| poisoned.into_inner())`) and verify the function compiles. |
| The verifier hangs when an expected synchronization step does not happen. | Every coordination wait has a fixed timeout; on timeout, the harness releases the first emitter before exiting with failure. |

