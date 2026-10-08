> [!NOTE]
> 🅱️ This is a Beta build.

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux |
| :-- | :-- | :-- |
| **EXE: [x64](https://github.com/BurntToasters/ROSI/releases/download/v5.0.0-beta.2/ROSI-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/ROSI/releases/download/v5.0.0-beta.2/ROSI-Windows-arm64.exe)** | **[Universal DMG](https://github.com/BurntToasters/ROSI/releases/download/v5.0.0-beta.2/ROSI-MacOS-universal.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/ROSI/releases/download/v5.0.0-beta.2/ROSI-Linux-x64.AppImage) |
| <div align="center"><a href="https://apps.microsoft.com/detail/9p4q134b2jw3?referrer=appbadge&mode=direct"><img src="https://get.microsoft.com/images/en-us%20dark.svg" width="150"/></a></div> | **[Universal ZIP](https://github.com/BurntToasters/ROSI/releases/download/v5.0.0-beta.2/ROSI-MacOS-universal.zip)** | **Flatpak:** [x64](https://github.com/BurntToasters/ROSI/releases/download/v5.0.0-beta.2/ROSI-Linux-x64.flatpak) |

> macOS downloads require macOS 15 or later.

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal GPG signatures. They are for Tauri V2's updater to verify the integrity of updates before downloading and installing.
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc
> ⚠️ ROSI 5 Linux downloads are x64-only: AppImage and Flatpak. ARM64 build wiring remains for future development, but ARM64 downloads are not supported in v5.

### ℹ️ Enjoying ROSI? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

ROSI! A cross platform yt-dlp GUI built on Tauri V2!

## Changes in `v5.0.0-beta.2:`

- **UI:** Added docked Downloads and Queue controls, expanded the first-run setup flow, refreshed status icons, and improved keyboard focus and small-window layouts.
- **Platform:** Synchronized the app theme with the native window and refined scrolling behavior.
- **Security:** Downloads, previews, and format discovery now route requests through a destination-checking proxy that blocks private network targets across redirects and extractor-provided URLs. Preview thumbnails are fetched by ROSI, size-limited, and embedded only when they are PNG, JPEG, or WebP images.
- **Release checks:** Release evidence now distinguishes full E2E acceptance from build-VM checks that rely on successful hosted CI for the exact source revision. Strict Cargo notices cover the updated dependency graph, and the reviewed development-tool advisories are recorded with a targeted dependency fix where available.
- **Quality:** Refreshed package and sidecar metadata and expanded native E2E coverage for the updated UI and security boundaries.
- **Downloads:** Saving to drives that do not support no-overwrite renames (such as exFAT, FAT, SMB and NFS) now works without ever replacing an existing file.
- **Recovery:** On startup, ROSI cleans up temporary download folders left by a crash or forced quit that are more than a day old, in your download folders. Complete media found there is moved next to your downloads as `<name> (recovered)`, and yt-dlp temporary files are removed. On Windows these temporary folders are now hidden while a download runs.
- **Data safety:** Damaged download statistics or activity files are kept as a recovery copy instead of being reset. The queue backup now holds the previous saved copy. If a newer ROSI version saved your queue, activity or statistics, this version will not overwrite them and tells you once.
- **Breaking - downgrades:** The queue and activity files now carry a version number. ROSI `v5.0.0-beta.1` cannot read them, so going back to beta.1 shows an empty queue and will overwrite it. ROSI 4 is not affected.
- **Security:** Reserved and shared address ranges (such as `100.64.0.0/10`, `198.18.0.0/15` and `240.0.0.0/4`) are now rejected as soon as you paste a link, not only when downloading. On IPv6-only networks with NAT64, public sites reached through `64:ff9b::/96` now work.
- **Startup:** The splash screen is now opaque, and ROSI no longer uses private macOS window APIs.

## Changes in `v5.0.0-beta.1:`

- **NEW - Tauri V2:** ROSI moved from Electron to Tauri V2 with a Rust backend. Installers, app size, and memory use are much smaller, and the app now uses the system webview.
- **NEW - Update channels:** The in-app updater now uses signed Tauri updater manifests with separate stable and beta channels (Settings > Update channel).
- **Breaking:** ROSI 5 is a new app. The app identifier is now `run.rosie.rosi`, and v4 cannot auto-update to v5. Install v5 manually.
- **NEW - v4 import:** On its first launch, ROSI 5 imports your ROSI 4 settings, queue, lifetime stats, and download activity. Values ROSI 5 does not accept fall back to defaults, and the ROSI 4 files are left untouched.
- **Breaking - macOS:** ROSI 5 requires macOS 15 or later, matching the bundled FFmpeg build.
- **Linux - DEB and RPM builds are retired:** ROSI 5 supports Linux x64 AppImage and Flatpak downloads only. Linux ARM64 downloads are not supported in v5, although the build wiring remains for future development. DEB and RPM packaging is retired for v5 releases.
- **Packaging:** Bundled helpers are now named `rosi-yt-dlp`, `rosi-ffmpeg`, and `rosi-ffprobe` so Linux packages never collide with distro `yt-dlp` / `ffmpeg` files.
- **Licenses:** The licenses view now also lists every compiled Rust crate and shows the exact bundled yt-dlp and FFmpeg notices.
- **Windows:** Dragging a link from the browser onto the download card or queue works again, and F5, Ctrl+R, Ctrl+P, and the page right-click menu no longer reload or print the app mid-download.
- **Windows:** Titles and file names in non-Latin scripts stay intact on systems that use a legacy code page, and installing an update now stops active downloads and saves the queue first.
- **Linux:** Downloads work on systems that mount `/tmp` with `noexec`, and RPM in-app updates from a beta to its stable release are no longer refused as a downgrade.
- **Flatpak:** Download folders chosen outside Downloads, Videos, and Music are accepted, and **Open folder** can select the file in the host file manager.
- **Windows / Linux:** The window fits smaller screens (such as 1366x768 laptops at 125% scaling), `Ctrl+,` opens settings, and `Ctrl+Shift+,` toggles the sidebar on every keyboard layout.
- **Windows:** Deno installed with the in-app **Install** button is found without signing out.
- **Linux:** The Deno reminder links to the official install instructions instead of offering an automatic install that Linux does not support.
- **Linux:** The AppImage starts on Wayland sessions without XWayland, and a Downloads, Videos, or Music folder that `user-dirs.dirs` places outside your home folder (such as on a data disk) is accepted as a download location.
- **Settings:** The cookie browser selection no longer shows blank after a restart.

### FULL CHANGELOG:

<details>
  <summary>ℹ️ Click here to see the full change-log for v5!</summary>
Nothing here yet!
---

</details>

## ℹ️ Release Info

### 🔐 GPG Signing

ROSI Binaries (`v2.1.2+`) are GPG signed. You can verify the authenticity of your download by downloading the installer, its accompanying sig, and the public key which is available at: [https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc](https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc)

> **Windows Users:** GitHub releases are fully code-signed. Alternatively, you can check out the [Microsoft Store](https://apps.microsoft.com/detail/9p4q134b2jw3?referrer=appbadge&mode=direct) version (Stable releases only).

_ROSI's macOS releases are fully code-signed by a developer ID from Apple, and Windows releases are fully code-signed using Azure Artifact Signing._

# LTS Version

This is the first release of the brand new re-designed ROSI, bugs and instability is expected. If you prefer to still get maintenance updates (Like bug fixes and yt-dlp updates) for the previous version (`3.x.x`), checkout the [ROSI-LTS](https://github.com/BurntToasters/ROSI-LTS) repo! Until the next major release, version 3.x.x will receive bug fixes and yt-dlp updates!
