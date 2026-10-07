# Renderer round-three repair diagnostics

These repeatable DOM diagnostics load the shipping `src/index.html`, transpile the shipping renderer modules, and exercise the updater module with a controlled adapter. They cover audit findings 6, 7, 8, 9, and 12 without adding unit tests.

Run from the repository root:

```sh
node e2e/round3-renderer-repairs/run.cjs
```

The runner prints a JSON verification record and writes the same record to `e2e/artifacts/round3-renderer/renderer-repairs.json`. The artifact directory is ignored by Git.

The 15 checks cover sidebar/license/modal focus ownership and inert state, modal stacking and stale-hide retirement, candidate-bound updater actions and prompt retirement, URL-bound formats across stale replies and asynchronous submissions, explicit preset survival against a pending lookup, previous-channel forwarding, and latest-preview supersession. The controlled DOM harness does not replace manual assistive-technology review or a packaged Tauri E2E run.
