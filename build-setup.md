# Build prerequisites for ROSI

## Windows

- Windows 10/11 x64 or ARM64
- PowerShell 7.x
- Visual Studio 2022 or 2026 Build Tools with the C++ workload (x64 and ARM64)
  and the "C++ Clang Compiler for Windows" component
  (`Microsoft.VisualStudio.Component.VC.Llvm.Clang`). `ring` (via the
  updater's TLS stack) needs clang to build for `aarch64-pc-windows-msvc`.
  Build from a VS developer shell (`npm run win-compiler:arm64` or
  `win-compiler:x64`), which puts that clang on `PATH`; a plain PowerShell
  window does not.
- Node.js `^22.22.2 || ^24.15.0 || >=26` (`engines.node` in package.json)
- Rust (rustup)
- Azure Artifact Signing: once per release VM, as Administrator, run
  `npm run setup:win:artifact-signing`

## macOS

- macOS 15 or later. `minimumSystemVersion` in `tauri.conf.json` is
  15.0 because the bundled FFmpeg is built for macOS 15; `build:mac:zip` rejects
  any bundled Mach-O whose minimum OS is above that floor.
- Xcode Command Line Tools (`lipo`, `codesign`, `notarytool`)
- Node.js `^22.22.2 || ^24.15.0 || >=26`
- Rust (rustup)

## Linux

- Build the public AppImage on Ubuntu 24.04, the oldest supported glibc
  baseline.
- `npm run setup:deb` installs the Ubuntu build, E2E (xvfb), 7-Zip (for
  `get:ffmpeg`), and Flatpak prerequisites.
- Node.js `^22.22.2 || ^24.15.0 || >=26`
- Rust (rustup)
- Linux v5 releases ship x64 only (`npm run release:linux:x64`). ARM64 wiring
  (`release:linux:arm64`, `build:linux:arm64`) remains for future development
  and is not part of the v5 release matrix.

## Rust toolchain policy

ROSI builds with Rust `1.98.1`, pinned in `rust-toolchain.toml` and used by CI,
Flatpak, and release builds. Install that exact toolchain before building:

```sh
npm run rust:update
```

## Bundled sidecars

Tauri ships three `externalBin` sidecars next to the ROSI executable:
`rosi-yt-dlp`, `rosi-ffmpeg`, and `rosi-ffprobe`.
`npm run prepare:sidecars` copies them into `src-tauri/binaries/` using Tauri's
`<name>-<target-triple>` names after verifying every source binary:

- yt-dlp: committed `assets/yt-dlp*`, verified against
  `assets/ytdlp-checksums.json`. When updating yt-dlp, verify new binaries
  against upstream `SHA2-256SUMS`, then run `npm run ytdlp:check:generate`.
- FFmpeg: never committed. `npm run get:ffmpeg` downloads them from
  `FFMPEG_DL_SERVER` (see `.env.example`) into `resources/ffmpeg/`; they are
  verified against `resources/ffmpeg/checksums.json`. The universal macOS
  sidecar is merged with `lipo`. `workspace:bootstrap` (and therefore every
  `release:*` command) runs `npm run ffmpeg:ensure`, which fetches only the
  missing host targets, so each release VM needs `FFMPEG_DL_SERVER` in `.env`
  and 7-Zip (`7zz`/`7z` on PATH, or the default 7-Zip install on Windows).
  When the FFmpeg builder publishes new binaries, run `npm run get:ffmpeg:all`
  (which regenerates the checksums), review, and commit
  `resources/ffmpeg/checksums.json`.

`npm run prepare:rust-tests` (development and CI) writes non-functional FFmpeg
stubs when FFmpeg is absent. `build.rs` re-hashes the prepared sidecars and
fails release-profile builds that contain stubs; `scripts/gpg-sign.js` also
refuses to sign them. `ROSI_ALLOW_STUB_SIDECARS=1` only exists for CI compile
smoke and is rejected for stable releases.

## Updater signing key

`src-tauri/tauri.conf.json` carries ROSI's updater public key. To rotate it,
generate a new Minisign key pair before building a release:

```sh
npx tauri signer generate -w ~/.tauri/rosi.key
```

Put the printed public key in `plugins.updater.pubkey`, and set
`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in `.env` on
every release VM. `release:sign:gpg` cryptographically checks each `.sig`
against the configured public key, so a mismatched key fails before anything is
uploaded. When the v4 bridge is still supported, update its packaged public key
and key-ID guard in the final v4 release before publishing v5 artifacts.

## License notice audit

`npm run licenses:cargo` writes the packaged Cargo license data and an exact
unresolved-package report. Every prerelease and stable release runs
`npm run release:licenses`, which uses `licenses:cargo:strict` and fails until
every dependency has a verified license notice.

## Verify the toolchain

```sh
npm ci
npm run prepare:rust-tests
npm run test:all
npx tauri build --no-bundle
```

CI runs tests and checks only. It must never invoke `release:*` scripts or build
release binaries; signed bundles are produced on isolated platform build VMs.

## Release artifact freshness

The normal `npm run release:win`, `release:mac`, and `release:linux:x64` entry
points prepare locked dependencies, run the release-VM gate with GUI E2E
skipped, remove old bundles, and create a commit- and environment-bound build
session. The exact release commit must already have passed the complete
`test:all` gate with E2E enabled in protected CI or in a clean proving checkout.

If `npm run release:prepare` was run separately and completed successfully, use
the matching `release:win:resume`, `release:mac:resume`, or
`release:linux:x64:resume` command. `release:linux` is an alias of the x64
release. Resume still runs branch/upstream preflight and refuses sessions from a
different commit, version, lockfile, platform, architecture, Node/Rust
toolchain, or sessions older than 24 hours.

For a beta recovery where one platform already built the same version before
the release branch advanced, pass `--skip-check` to bypass only the draft's
exact target-commit check, for example `npm run release:mac -- --skip-check`.
Stable releases reject this override.

Windows creates the draft release (`release:draft`); macOS and Linux wait for it
(`release:wait-draft`).

## ROSI 4 update feed

ROSI 4's electron-updater reads `latest.yml`, `latest-mac.yml`,
`latest-linux.yml`, and `latest-linux-arm64.yml` from the newest GitHub
release, beta or stable. Without them, v4 users see update errors, so every v5
release must carry them. `release:win:continue` runs
`npm run release:legacy-v4-feed` right after `release:draft`. It copies the
feed files of the v4 release named in `legacy-v4-feed.json` (`sourceTag`),
rewrites every download URL to `../<sourceTag>/<file>` so it resolves to that
v4 release, and uploads them to the draft. `release:verify:draft` fails if any
of the four files is missing or points elsewhere, and `release:publish` checks
that every referenced v4 file exists with the listed size.

- Check without uploading: `npm run release:legacy-v4-feed -- --dry-run --check-urls`.
- When a new v4 release (such as the v4-to-v5 bridge) ships, set `sourceTag` to
  it and refresh the current latest v5 release:
  `npm run release:legacy-v4-feed -- --release vX.Y.Z --allow-published`. This
  replaces only the four feed files.
- Publish any v4 release made after v5 is live with "Set as the latest
  release" turned off. Otherwise `/releases/latest` points at v4 and ROSI 5's
  own updater endpoints break.

Flatpak packaging exports the exact clean `HEAD` tree (plus the verified Linux
FFmpeg binaries, which are never committed) into an ignored staging directory.
Commit the intended release state before running `npm run flatpak:bundle`.

Updater manifests are generated only after each Tauri Minisign signature has
been cryptographically matched to its artifact with the public key in
`tauri.conf.json`. The generated manifests are schema-validated before upload.

The `b`, `r`, and `release:*` scripts intentionally reset and clean their Git
worktrees. Run them only on disposable, isolated build VMs. Before publishing,
verify that the draft contains the Windows x64/ARM64 NSIS installers, the
universal macOS DMG/ZIP, Linux x64 AppImage/Flatpak, updater
manifests/signatures, SHA-256 lists, and GPG detached signatures
(`npm run release:verify:draft`).

## Microsoft Store

`npm run build:msstore` builds NSIS installers with the Microsoft Store channel
compiled in (`ROSI_DISTRIBUTION_CHANNEL=msstore`), which hides the in-app
updater and "check for updates" menu item.
