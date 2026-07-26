> [!NOTE]
> 🅱️ This is a Beta build.

# ⬇️ Downloads

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows                                                                                                  | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS     | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux                                                                                                                  |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EXE:** [x64](https://github.com/BurntToasters/ROSI/releases/download/v4.3.0-beta.1/ROSI-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/ROSI/releases/download/v4.3.0-beta.1/ROSI-Windows-arm64.exe) | **[Universal DMG](https://github.com/BurntToasters/ROSI/releases/download/v4.3.0-beta.1/ROSI-MacOS-universal.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/ROSI/releases/download/v4.3.0-beta.1/ROSI-Linux-x86_64.AppImage) / [arm64](https://github.com/BurntToasters/ROSI/releases/download/v4.3.0-beta.1/ROSI-Linux-arm64.AppImage) |
| <div align="center"><a href="https://apps.microsoft.com/detail/9p4q134b2jw3?referrer=appbadge&mode=direct"><img src="https://get.microsoft.com/images/en-us%20dark.svg" width="150"/></a></div>                    | **[Universal ZIP](https://github.com/BurntToasters/ROSI/releases/download/v4.3.0-beta.1/ROSI-MacOS-universal.zip)** | **DEB:** [x64](https://github.com/BurntToasters/ROSI/releases/download/v4.3.0-beta.1/ROSI-Linux-amd64.deb) / [arm64](https://github.com/BurntToasters/ROSI/releases/download/v4.3.0-beta.1/ROSI-Linux-arm64.deb)                 |
|                                                                                                                                                                                                                    |                                                                                                                     | **RPM:** [x64](https://github.com/BurntToasters/ROSI/releases/download/v4.3.0-beta.1/ROSI-Linux-x86_64.rpm) / [arm64](https://github.com/BurntToasters/ROSI/releases/download/v4.3.0-beta.1/ROSI-Linux-aarch64.rpm)              |

> [!IMPORTANT]
> The `.sig` files in this repo are NOT normal GPG signatures — they are for ROSI's built-in updater to verify the integrity of updates before downloading and installing.
>
> The `.asc` files are my normal GPG signatures which you can verify using my GPG Public Key: https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc

### ℹ️ Enjoying ROSI? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

---

## Changes in `v4.3.0-beta.1:`

- **macOS:** Added a native application menu (About, Settings, Check for Updates, Edit, View, Window, Help) with actions wired into the existing UI.
- **Progress:** yt-dlp and FFmpeg now report structured progress for more accurate in-app percentages, including merge and conversion phases.
- **Taskbar / Dock:** Download and conversion progress appears in the Windows taskbar and macOS Dock; queue runs show an overall percent across items.
- **Settings:** New **Taskbar / Dock progress** toggle (settings schema v6).

## Changes in `v4.2.1:`

- **PKG:** Updated packages.

### FULL CHANGELOG:

<details>
  <summary>ℹ️ Click here to see the full change-log for v4!</summary>

## Changes in `v4.2.0:`

- **NEW - Windows code signing:** WOO HOO!! Windows Codesigning is here!
  - After a good while of not having it, Windows Binaries are now signed by Azure Artifact Signing!
- **NEW - Download Profiles:** Added download profiles to settings to allow selecting between Best video, Audio-only, and Custom quality modes.
- **Settings:** Added an "Ask every time" option to prompt for a download location on every run or download directly to your saved directory.
- **UI:** Added a collapsible layout to the queue section to save vertical screen space. The collapsed state is persisted in settings, and arrow keys can be used to expand or collapse it.
- **UI:** Removed the quality and audio toggles from the setup wizard, pointing users to the new download profiles in Settings.
- **FFMPEG:** Updated the bundled FFmpeg binaries, wording, notices, and GPL source offer to version `8.1.2` across Windows, macOS, and Linux.
- **Testing:** Added new unit and DOM tests to cover download profiles, folder selection settings, and collapsible queue behavior.
- **Codebase:** Migrated settings schema to version `5` to accommodate the new profiles and collapsible queue preferences.
- **YT-DLP:** Updated `yt-dlp` to `2026.07.04`.
- **Electron:** Updated electron major release to `v43`.
- **UI:** Updates to the UI buttons.
- **Settings:** Added the Flat UI setting to `settings.json` so it is wired into the app reset button.
- **UI:** Major updates to the UI: More subtle 3D additions and better overall UI.
- **UI:** Added a Flat UI toggle switch on the main sidebar so you can toggle between the Flat UI and the normal UI.
- **FFMPEG:** Enforced checksums for bundled binaries.
  - Added the `FFMPEG_DL_SERVER` environment variable and server download support.
  - Defined the `.7z` naming scheme as `ffmpeg_os_arch.7z` (`macOS` for the macOS platform).
  - Added `npm run get:ffmpeg:all` to download, extract, and checksum all platform and architecture builds.
- **UI:** Fixed WCAG color contrast failures on the download button, modal primary buttons, help-icon hover, history "Open" hover, reset-button hover, and modal danger hover. Added `--warning-contrast` and `--danger-contrast` design tokens.
- **UX:** Added a close-confirmation dialog when a download or queue is actively running to prevent accidental progress loss.
- **UX:** The download folder picker now opens to your last-chosen folder instead of always defaulting to `~/Downloads`.
- **NEW - Queue Drag-and-Drop:** You can now drag and drop URLs directly into the queue textarea.
- **NEW - Queue Keyboard Shortcut:** Added Ctrl/Cmd+Enter to submit URLs from the queue textarea.
- **UI:** Toast notifications are now capped at 5 visible per container to prevent screen flooding during rapid error loops.
- **UI:** Added explicit `type="button"` to all button elements for HTML robustness.
- **Testing:** Cleaned up ESLint configuration to suppress `no-unsafe-*` noise in test files while keeping full strictness on production code.
- **PKG:** Updated packages.

## Changes in `v4.1.0:`

- **NEW - Preview:** Added video preview before downloading so ROSI can show the title, uploader, duration, thumbnail, playlist info, and other basic metadata before saving.
- **NEW - Enhancements:** Added download options for embedded metadata, embedded thumbnails / cover art, subtitles with custom language codes, and SponsorBlock segment removal.
- **Updater:** Fixed macOS in-app updates where **Restart Now** did nothing after an update finished downloading.
- **Updater:** Fixed the `Auto` update channel so beta installs actually receive beta updates when that setting is selected.
- **Downloads:** Manual downloads and the queue no longer stomp each other. ROSI now blocks conflicting starts instead of silently killing one mid-run.
- **Downloads:** Queue downloads now use your chosen download folder instead of always saving to system Downloads.
- **Conversion:** Updated FFmpeg conversion to probe source codecs first, then copy compatible video/audio streams instead of re-encoding when possible.
- **GPU detection:** Updated hardware acceleration detection to probe actual FFmpeg encoders, cache the result, and only claim a GPU path when that encoder can run.
- **Settings:** Importing settings refreshes the UI in-place instead of forcing a full app restart.
- **macOS:** Closing the window now stops active downloads instead of leaving `yt-dlp` running headless in the background.
- **Security:** Tightened download URL validation, output path checks, `ffmpeg` path handling on import, and subprocess environment hardening.
- **Typescript:** Migrated the main renderer engine from JavaScript to TypeScript and widened renderer type coverage.
- **UI:** Split the renderer CSS into focused files, bundled local Manrope / IBM Plex Mono fonts, tightened CSP by removing remote Google Fonts, and shipped a broader accessibility and polish pass across the setup wizard, modals, queue, launch theming, and update progress UI.
- **FFMPEG:** Updated FFmpeg compliance docs, notices, source offer, and binary placeholders for bundled FFmpeg builds.
- **Testing:** Expanded automated coverage across the updater, downloader, preview pipeline, IPC validation, renderer modules, video info parsing, codec-aware FFmpeg args, GPU probing, settings migration, and queue wiring.
- **PKG:** Updated packages and bundled binaries.

## Changes in `v4.0.0:`

### Welcome to ROSI v4!

Version 4 is the biggest change to ROSI of all time! I have been working hard on this version to provide all the tools a person needs to easily download media :) and I hope you enjoy this new version with all of its new features! Checkout the notes below.

- **Logo:** ROSI has a new logo! Well maybe not fully new but its a new imagining of the ROSI logo for V4 and beyond! This is the first major logo redesign in ROSI's history!
- **FFMPEG:** Its here! FFMPEG binaries are now included within the app! No more "FFMPEG Required" warnings and having to manually install it yourself! ROSI now comes bundled with everything you need to start downloading!
- **TypeScript:** More typescript additions: Testing, hardening, bug fixes, you name it, we got it!
- **NEW - Audio Downloads:** Added download formats for audio only downloads!
- **GPU detection:** Improved the `auto` mode for GPU detection if a user chooses to convert a download.
- **NEW - UI:** The UI has been revamped again with a much more space efficient design with better UX/UI.
  - **Themes:** Say hello to theming in ROSI! Currently Dark, Light, and Purple (the old theme) are available!
- **Misc:** Much much more improvements to the code! Linux support has been improved and other aspects of the code now runs better!

---

</details>

## ℹ️ Release Info

### 🔐 GPG Signing

ROSI Binaries (`v2.1.2+`) are GPG signed. You can verify the authenticity of your download by downloading the installer, its accompanying sig, and the public key which is available at: [https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc](https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc)

> **Windows Users:** GitHub releases are fully code-signed. Alternatively, you can check out the [Microsoft Store](https://apps.microsoft.com/detail/9p4q134b2jw3?referrer=appbadge&mode=direct) version (Stable releases only).

_ROSI's macOS releases are fully code-signed by a developer ID from Apple, and Windows releases are fully code-signed using Azure Artifact Signing._

# LTS Version

This is the first release of the brand new re-designed ROSI, bugs and instability is expected. If you prefer to still get maintenance updates (Like bug fixes and yt-dlp updates) for the previous version (`3.x.x`), checkout the [ROSI-LTS](https://github.com/BurntToasters/ROSI-LTS) repo! Until the next major release, version 3.x.x will receive bug fixes and yt-dlp updates!
