# Typed command map: failure modes

`src/commands.ts` lists the Rust commands the renderer calls. These are the
ways it can drift from the backend; `commands.contract.test.ts` checks each.

1. The map names a command Rust does not register (typo or removed command), so
   the call fails at runtime with "command not found".
2. Rust registers a production command the map does not list, so the renderer
   cannot call it with types (or calls it through an untyped path).
3. An E2E-only command enters the production map.
4. Renderer code calls `invoke()` directly with a string name, bypassing the map.
5. `window.api` forwards to a command name that is not in the map.
6. The capability file grants a command the map omits, or omits one it lists.
