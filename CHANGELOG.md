# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows                                                                                                  | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS                                                                                                                                                                                                              | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux    |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------- |
| **EXE: [x64](https://github.com/BurntToasters/ROSI/releases/download/v5.1.0-beta.1/ROSI-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/ROSI/releases/download/v5.1.0-beta.1/ROSI-Windows-arm64.exe)** | **DMG: [arm64](https://github.com/BurntToasters/ROSI/releases/download/v5.1.0-beta.1/ROSI-MacOS-arm64.dmg) / [x64](https://github.com/BurntToasters/ROSI/releases/download/v5.1.0-beta.1/ROSI-MacOS-x64.dmg) / [universal](https://github.com/BurntToasters/ROSI/releases/download/v5.1.0-beta.1/ROSI-MacOS-universal.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/ROSI/releases/download/v5.1.0-beta.1/ROSI-Linux-x64.AppImage) |
| <div align="center"><a href="https://apps.microsoft.com/detail/9p4q134b2jw3?referrer=appbadge&mode=direct"><img src="https://get.microsoft.com/images/en-us%20dark.svg" width="150"/></a></div>                    | **ZIP: [arm64](https://github.com/BurntToasters/ROSI/releases/download/v5.1.0-beta.1/ROSI-MacOS-arm64.zip) / [x64](https://github.com/BurntToasters/ROSI/releases/download/v5.1.0-beta.1/ROSI-MacOS-x64.zip) / [universal](https://github.com/BurntToasters/ROSI/releases/download/v5.1.0-beta.1/ROSI-MacOS-universal.zip)** | **Flatpak:** [x64](https://github.com/BurntToasters/ROSI/releases/download/v5.1.0-beta.1/ROSI-Linux-x64.flatpak)   |

> macOS downloads require macOS 15 or later.
> Native arm64 builds run on Apple silicon; native x64 builds run on Intel and
> under Rosetta on Apple silicon. Universal builds run on both architectures.

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal GPG signatures. They are for Tauri V2's updater to verify the integrity of updates before downloading and installing.
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc
> ⚠️ ROSI 5 Linux downloads are x64-only: AppImage and Flatpak. ARM64 build wiring remains for future development, but ARM64 downloads are not supported in v5.

### ℹ️ Enjoying ROSI? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

ROSI! A cross platform yt-dlp GUI built on Tauri V2!

## Changes in `v5.1.0-beta.1:`

- **Updater:** macOS in-app updates now download compact per-architecture archives (`.app.tar.zst`), reducing update sizes from ~141 MB to ~60 MB using zstd compression.
- **Updater:** Added seamless fallback to universal updates if per-architecture manifests are missing.
- **Updater:** Architecture verification ensures downloaded macOS updates match the host machine before installation.
- **Updater:** Rosetta-translated processes on Apple Silicon automatically request the native arm64 target to migrate away from emulation.
- **Packaging:** Per-architecture updater archives are verified for codesigning and notarization stapling prior to packaging.
- **Packaging:** Native arm64 and x64 DMG/ZIP downloads are available alongside the universal macOS packages.
- **Updater:** Update checks use only the `latest` release feed URLs. The version-pinned fallback URLs were removed, and update signatures must name the version they were signed for (`requireSignedVersion`).
- **Queue:** All queue changes now go through one coordinator, so queue updates reach the window in the order they happen. Each update carries a revision, and an older update never replaces a newer one.
- **Downloads:** Manual downloads, queued downloads, and the effective-options preview share one option-resolution path in the backend, so the options shown before a download match the options it uses.
- **Downloads:** A summary under the output settings shows the effective options for the current URL, profile, formats, and playlist selection. It explains what is missing (a valid URL, a save location, a format, or a valid playlist selection) and waits while settings are saving.
- **Formats:** The video and audio format lists are built from structured data returned by the backend, not from parsing yt-dlp's text output. Each entry shows its resolution, frame rate, codecs, and size when yt-dlp reports them.
- **Network:** The outbound proxy relay runs on the Tokio runtime and serves up to 256 connections at once. Up to 128 more connections wait for a free slot for up to 5 seconds. Connections beyond that, or still waiting after 5 seconds, receive HTTP 503.
- **Settings:** Settings show whether they are saving, saved, or not saved. A failed save keeps your choices on screen and offers a "Retry save" button. If the backend refuses one setting, the other settings still save, and the refused one returns to its saved value.
- **Settings:** Each section's reset button asks for confirmation first, and reports whether the restored defaults were saved.
- **Setup:** The setup wizard shows an inline message when choosing a download folder is cancelled or fails. If the Deno check or install fails, it offers the install instructions.
- **Deno:** If the Deno check fails, ROSI shows a dialog with the install instructions instead of only writing to the log.
- **Build:** Building from source now requires Node.js `^24.22.1` or `>=26.13.0` and npm 12.2.1 or later. CI builds with Node.js 26.13.0 LTS.
- **Build:** The pinned Rust toolchain is 1.99.1, read from `rust-toolchain.toml`. The Flatpak build installs that exact compiler with rustup.
- **Tests:** End-to-end scenarios are grouped by feature in `e2e/suites.json`. `npm run test:e2e -- --group <names>` runs only the named groups, and reports list each scenario's groups.
- **Downloads:** With "Ask where to save" off and no folder chosen, downloads and the effective-options summary use the system Downloads folder instead of blocking or opening a folder picker.
- **Downloads:** Presets are resolved only by the backend. Applying a preset shows the backend's values, a later change to the stored preset takes effect, and the format lists always download exactly what they show.
- **Downloads:** The reason a download cannot start, and what to do next, now appears beside the Download button.
- **Downloads:** Choosing a folder from the destination strip, or turning off "Ask where to save" without a folder, reports a cancelled or failed folder pick inline.
- **Formats:** Format option labels are built by the backend.
- **Settings:** If settings cannot be loaded at startup, the defaults come from the backend instead of a copy kept in the window.
- **Queue:** When retry, remove, reorder, or open location fails, the message appears on that queue row and the row's other actions stay available.
- **Activity:** Keyboard focus stays on the same activity action when the list updates, and each new entry is announced once to screen readers.
- **Accessibility:** Dialogs move focus inside as soon as they open. Long URLs, paths, titles, and errors wrap or truncate instead of widening the window.
- **Network:** A proxy client turned away with HTTP 503 now receives the full response on macOS instead of a connection reset.
- **Security:** Every backend command now checks its input against a typed structure. Error messages are unchanged.
- **Updater:** Update checks, downloads, and installs run in the backend, and the window only shows their status. The window no longer has permission to use the updater plugin directly.

## Changes in `v5.0.2:`

- **YT-DLP:** Updated `yt-dlp` to `2026.10.21`.
  - This addresses TLS security issues regarding the eMudhra incident.
- **PKG:** Updated packages.

## Changes in `v5.0.1:`

- **Fix:** The automatic Deno install now checks for Homebrew (macOS) or winget (Windows) before it offers to run, and the confirm dialog names the tool it will use. On Windows it uses only the winget source, which avoids failures on locked-down networks. When automatic install is not possible, ROSI explains why and links to the official Deno installation guide.
- **Flatpak:** The JavaScript runtime bundled for yt-dlp is now Node.js 24 (previously Node.js 22).
- **Build:** Building ROSI from source now requires Node.js 24.15 or later. Node.js 22 is no longer supported.
- **Tests:** New end-to-end tests cover the Deno installer paths, including a missing package manager.
- **Docs:** The README explains how to upgrade from v4 to v5, and when ROSI 5 must be installed manually.

## Changes in `v5.0.0:`

- **Security:** ROSI's update checks and preview thumbnail downloads now reject the eight eMudhra intermediate certificates whose keys were compromised (disclosed October 2026).
- **Network:** New optional Upstream proxy setting. Downloads, format lists, previews, and thumbnails can now go through your HTTP proxy (`http://host:port`, without authentication). ROSI still checks every destination before using the proxy, and private network targets stay blocked.
- **Flatpak:** The Flatpak now includes its own JavaScript runtime (Node.js) for yt-dlp, so YouTube downloads that needed Deno now work in the Flatpak.
- **Flatpak:** ROSI now tells Flatpak users when an update is available and opens the release page so they can download it. Flatpak builds still update by reinstalling the bundle.
- **Quality:** Internal cleanup of download cancellation, queue status and settings handling, and the app's interface code is split into smaller modules, with no change in behavior.
- **Release checks:** Windows CI yt-dlp signature verification now works with Git for Windows' gpg. CI runs every platform's checks even if one fails, and runs the updater install-safety tests on Windows and macOS. Release scripts that reset the working tree refuse to run outside release machines.
- **Release checks:** Microsoft Store builds are now packaged as an MSIX bundle under the existing Store product, not as an NSIS installer.
- **Docs:** The stable release runbook gained Microsoft Store migration, soak, and updater QA gates, and new key-compromise and 5.1 roadmap docs were added.

## ℹ️ Release Info

### 🔐 GPG Signing

ROSI Binaries (`v2.1.2+`) are GPG signed. You can verify the authenticity of your download by downloading the installer, its accompanying sig, and the public key which is available at: [https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc](https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc)

> **Windows Users:** GitHub releases are fully code-signed. Alternatively, you can check out the [Microsoft Store](https://apps.microsoft.com/detail/9p4q134b2jw3?referrer=appbadge&mode=direct) version (Stable releases only).

_ROSI's macOS releases are fully code-signed by a developer ID from Apple, and Windows releases are fully code-signed using Azure Artifact Signing._
