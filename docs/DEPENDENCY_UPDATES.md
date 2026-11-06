# Dependency updates

## Rust toolchain

`rust-toolchain.toml` is the single source of the Rust version. The `channel`
value in its `[toolchain]` table is the only place the version is written.
`scripts/rust-toolchain.mjs` reads that file for the npm scripts, CI reads its
output for the `dtolnay/rust-toolchain` steps, and the Flatpak manifest extracts
the same value with `sed`.

Do not copy the version into `package.json`, `.github/workflows/ci.yml`, or
`run.rosie.rosi.yml`.

To bump Rust:

1. Change `channel` in `rust-toolchain.toml`. Keep `profile` and `components`
   in that file as needed.
2. Run `npm run rust:update` to install the pinned toolchain.
3. Run `npm run rust:targets:win`, `npm run rust:targets:mac`, or
   `npm run rust:targets:linux` as appropriate.
4. Run `npm run validate:flatpak` and the normal test suite.

The helper is also usable directly:

```sh
node scripts/rust-toolchain.mjs              # print the pinned version
node scripts/rust-toolchain.mjs --install    # install profile and components
node scripts/rust-toolchain.mjs --target aarch64-apple-darwin
```

## npm and Cargo

Run the guarded updaters from a clean worktree:

```sh
node scripts/npm-safe-update.mjs
node scripts/cargo-safe-update.mjs --manifest-path src-tauri/Cargo.toml
```

`npm run u` runs both updaters plus version synchronization. Neither updater
changes the Rust pin; update `rust-toolchain.toml` separately when the toolchain
itself should move.
