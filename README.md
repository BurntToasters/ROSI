# ROSI

ROSI is a cross-platform GUI for yt-dlp, built with Tauri V2.

[<img src="https://get.microsoft.com/images/en-us%20dark.svg" width="200"/>](https://apps.microsoft.com/detail/9p4q134b2jw3?referrer=appbadge&mode=direct) [<img width="150" alt="ROSI" src="https://prod.rosie.run/img/download-for-windows.png"/>](https://github.com/BurntToasters/ROSI/releases/latest/download/ROSI-Windows-x64.exe) [<img width="150" alt="ROSI" src="https://prod.rosie.run/img/download-for-windows-arm64.png"/>](https://github.com/BurntToasters/ROSI/releases/latest/download/ROSI-Windows-arm64.exe) [<img width="150" alt="ROSI" src="https://prod.rosie.run/img/download-for-macos.png"/>](https://github.com/BurntToasters/ROSI/releases/latest/download/ROSI-MacOS-universal.dmg) [<img width="150" alt="ROSI" src="https://prod.rosie.run/img/download-for-linux.png"/>](https://github.com/BurntToasters/ROSI/releases/latest)

<p align="center">

<img width="45%" height="1012" alt="ROSI-v" src="https://media.rosie.run/rosi/gallery/ghv4/dark.png" />
  &nbsp;
  <img width="45%" height="1012" alt="ROSI-4" src="https://media.rosie.run/rosi/gallery/ghv4/purple.png" />
  &nbsp;
  <img width="45%" height="1012" alt="ROSI-4" src="https://media.rosie.run/rosi/gallery/ghv4/sidebar.png" />

</p>

See [ARCHITECTURE.md](ARCHITECTURE.md) and [build-setup.md](build-setup.md).

# ROSI 5

ROSI 5 moves from Electron to Tauri V2 with a Rust backend. It uses the system
webview, so installers and memory use are much smaller.

- ROSI 5 is a clean break from v4: the app identifier is now `run.rosie.rosi`,
  so settings, queue, stats, and activity start fresh, and v4 cannot auto-update
  to v5.
- The in-app updater has **stable** and **beta** channels (Settings > Update
  channel). `auto` follows the installed version.
- Linux ships x64 AppImage, DEB, RPM, and a sideloaded Flatpak. Linux ARM64
  builds are paused; the build wiring remains for a future release.

## System requirements

- macOS 26 or later (universal build for Intel and Apple silicon). The bundled
  FFmpeg is built for macOS 26.
- Windows 10 version 2004 (build 19041) or later, on x64 or ARM64, with the
  Microsoft Edge WebView2 runtime (installed automatically when missing).
- Linux x64 with WebKitGTK 4.1 (Ubuntu 24.04+, Debian 13+, Fedora 43+, or a
  compatible distribution).

# LICENSES

- ROSI includes the official yt-dlp binary, which on its own uses the
  [Unlicense](https://unlicense.org); the standalone binary bundles third-party
  packages. Read [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md) for more.
- The licenses view in the app lists every npm package and Rust crate compiled
  into ROSI, plus the exact bundled yt-dlp and FFmpeg notices.
- Please also read the [license](LICENSE) for the source of this project
  (excluding third-party binaries and packages).

# Requirements

Official ROSI builds bundle FFmpeg per platform and architecture. When building
from source, place FFmpeg binaries in `resources/ffmpeg/<platform>/<arch>/`
(or run `npm run get:ffmpeg`) before packaging. See
[resources/ffmpeg/README.md](resources/ffmpeg/README.md) for the required
layout. You can optionally set a custom FFmpeg path in Settings to override the
bundled binary.

The Microsoft Store build uses the same codebase: `npm run build:msstore`
builds with the Store channel, which hides the in-app updater.

# Build ROSI from source

1. Download the source of a release (non-release sources may contain unfixed
   issues) and unzip it somewhere convenient.
2. Install [Node.js](https://nodejs.org/en/download) (with npm 12) and
   [Rust](https://rustup.rs), plus the platform prerequisites in
   [build-setup.md](build-setup.md).
3. `npm install`
4. Development: `npm run tauri:dev` (uses non-functional FFmpeg stubs when
   FFmpeg is not present; point Settings > FFmpeg path at a local FFmpeg to
   convert).
5. Packaged builds:
   - Windows: `npm run build:win`
   - macOS: `npm run build:mac:universal`, then `npm run build:mac:zip`
   - Linux x64: `npm run build:linux` (or `npm run build:linux:x64`)
   - Linux ARM64 (native ARM64 hardware only): `npm run build:linux:arm64`
   - Flatpak: `npm run flatpak:bundle`

Release builds refuse FFmpeg stubs.

# Testing

`npm run test:all` runs type checking, lint, formatting, policy validators,
Vitest, Clippy, Rust tests, and the WebdriverIO E2E suite against the real app
and bundled yt-dlp sidecar. `npm run test:e2e` runs only the E2E suite and
writes a reproducible evidence report to
`e2e/artifacts/e2e-report-<platform>-<arch>.json`.

# Releases

Releases follow the same destructive, VM-based pipeline as Zinnia. See
[build-setup.md](build-setup.md) and [docs/RELEASE-STABLE.md](docs/RELEASE-STABLE.md).

- Beta: on each release VM run `npm run b`, then `npm run release:win`,
  `npm run release:mac` (or `release:mac:ssh`), or `npm run release:linux:x64`.
- Stable: `npm run r`, then the same platform commands.
- Beta signing publishes `latest-*-beta-*.json` onto the latest stable release
  so beta clients update immediately. After the draft is complete, run
  `npm run release:verify:draft`, then `npm run release:publish` and
  `npm run release:verify:published`.

# ROSI LTS Version

There is an LTS version of the previous stable full release of ROSI (`v3.x.x`)
at <b>[➡️ROSI-LTS's Repo](https://github.com/BurntToasters/ROSI-LTS)</b>.

This is mainly for people who prefer the previous look of ROSI, or have an issue
with a newly released major version. The LTS version only provides yt-dlp
updates and minor bug fixes.

# Need help with something?

If there is an issue with the program, feel free to create a **GitHub Issue**!
For other issues/general contact, please go to
[https://help.rosie.run/contact](https://help.rosie.run/contact).
