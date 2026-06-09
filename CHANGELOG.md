<!-- hidden <p align="center">

<img width="45%" height="1012" alt="ROSI-3-1-1" src="https://github.com/user-attachments/assets/c42baa99-5ffa-4700-86c1-cc9aad3b9c7c" />
  &nbsp;
  <img width="45%" height="1012" alt="ROSI-3-x-app" src="https://github.com/user-attachments/assets/2105b523-7392-4c4c-8241-425b0096ca24" />

</p> -->

 <!-- >[!NOTE]
> 🅱️ This is a beta build.
-->

# ⬇️ Downloads

[<img src="https://get.microsoft.com/images/en-us%20dark.svg" width="175"/>](https://apps.microsoft.com/detail/9p4q134b2jw3?referrer=appbadge&mode=direct)

| <img height="20" src="https://github.com/user-attachments/assets/340d360e-79b1-4c70-bfab-d944085f75df" /> Windows                                                                                                    | <img height="20" src="https://github.com/user-attachments/assets/42d7e887-4616-4e8c-b1d3-e44e01340f8c" /> macOS     | <img height="20" src="https://github.com/user-attachments/assets/e0cc4f33-4516-408b-9c5c-be71a3ac316b" /> Linux                                                                                                                  |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Universal EXE](https://github.com/BurntToasters/ROSI/releases/download/v4.1.0-beta.1/ROSI-Windows.exe)** <br>_(Both x64 and arm64)_                                                                               | **[Universal DMG](https://github.com/BurntToasters/ROSI/releases/download/v4.1.0-beta.1/ROSI-MacOS-universal.dmg)** | **AppImage:** [x64](https://github.com/BurntToasters/ROSI/releases/download/v4.1.0-beta.1/ROSI-Linux-x86_64.AppImage) / [arm64](https://github.com/BurntToasters/ROSI/releases/download/v4.1.0-beta.1/ROSI-Linux-arm64.AppImage) |
| **Other:** [x64](https://github.com/BurntToasters/ROSI/releases/download/v4.1.0-beta.1/ROSI-Windows-x64.exe) / [arm64](https://github.com/BurntToasters/ROSI/releases/download/v4.1.0-beta.1/ROSI-Windows-arm64.exe) |                                                                                                                     | **DEB:** [x64](https://github.com/BurntToasters/ROSI/releases/download/v4.1.0-beta.1/ROSI-linux_amd64.deb) / [arm64](https://github.com/BurntToasters/ROSI/releases/download/v4.1.0-beta.1/ROSI-linux_arm64.deb)                 |
|                                                                                                                                                                                                                      |                                                                                                                     | **RPM:** [x64](https://github.com/BurntToasters/ROSI/releases/download/v4.1.0-beta.1/ROSI-linux.x86_64.rpm) / [arm64](https://github.com/BurntToasters/ROSI/releases/download/v4.1.0-beta.1/ROSI-linux.aarch64.rpm)              |

<!-- REMOVED <details>
  <summary>🛠️ Build Status & OS App Store Publishing Status (for NERDS)</summary>

| Platform | Build Status | Notes |
| :--- | :--- | :--- |
| **Windows (ARM/x64)** | ✅ Signed (GPG) | GPG Signed. |
| **Microsoft Store** | ❌ | `v4.0.0` is still in beta. |
| **macOS (ARM/x64)** | ✅ Signed (GPG & Apple Developer Cert) | Fully codesigned by Apple Developer cert. |
| **Linux (ARM/x64)**| ✅ Signed (GPG) | GPG Signed. |
</details> -->

### ℹ️ Enjoying ROSI? Consider [❤️ Supporting Me! ❤️](https://rosie.run/support)

---

## Changes in `v4.1.0-beta.1:`

- **NEW - Preview:** Added video preview before downloading so ROSI can show the title, uploader, duration, thumbnail, playlist info, and other basic metadata before saving.
- **NEW - Enhancements:** Added download options for embedded metadata, embedded thumbnails / cover art, subtitles with custom language codes, and SponsorBlock segment removal.
- **Conversion:** Updated FFmpeg conversion to probe source codecs first, then copy compatible video/audio streams instead of re-encoding when possible.
- **GPU detection:** Updated hardware acceleration detection to probe actual FFmpeg encoders, cache the result, and only claim a GPU path when that encoder can run.
- **Typescript:** Migrated the main renderer engine from JavaScript to TypeScript and widened renderer type coverage.
- **UI:** Split the renderer CSS into focused files, bundled local Manrope / IBM Plex Mono fonts, tightened CSP by removing remote Google Fonts, and added the preview/enhancement UI.
- **FFMPEG:** Updated FFmpeg compliance docs, notices, source offer, and binary placeholders for FFmpeg `8.1` builds on Windows, Linux, and macOS arm64. macOS x64 stays on FFmpeg `8.0.1`.
- **Testing:** Added jsdom DOM coverage for the renderer plus tests for video info parsing, codec-aware FFmpeg args, GPU probing, settings migration, IPC validation, and queue wiring.
- **PKG:** Updated packages.

## Changes in `v4.0.13:`

- **Electron:** Updated electron to `42.2.0`
- **PKG:** Updated packages.

## Changes in `v4.0.12:`

- **Electron:** Updated electron to `42.0.0`.
- **PKG:** Updated packages.

## Changes in `v4.0.9:`

- **Electron:** Updated electron to `41.5.0`.
- **PKG:** Updated packages.

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

### FULL CHANGELOG:

<details>
  <summary>ℹ️ Click here to see the full change-log for v4!</summary>

Nothing.. yet!

---

</details>

# ℹ️ Installation & Notes

### 🔐 GPG Signing

ROSI Binaries (`v2.1.2+`) are GPG signed. You can verify the authenticity of your download by downloading the installer, its accompanying sig, and the public key which is available at: [https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc](https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc)

> **Windows Users:** If you want a fully codesigned experience for Windows, check out the [Microsoft Store](https://apps.microsoft.com/detail/9p4q134b2jw3?referrer=appbadge&mode=direct) version (Stable releases only).

_ROSI's macOS release is the only GitHub release that is fully codesigned by a developer cert from apple. If you are looking for a version of ROSI that is codesigned for windows, check out the [Microsoft Store](https://apps.microsoft.com/detail/9p4q134b2jw3?referrer=appbadge&mode=direct) version!_

# LTS Version

This is the first release of the brand new re-designed ROSI, bugs and instability is expected. If you prefer to still get maintenance updates (Like bug fixes and yt-dlp updates) for the previous version (`3.x.x`), checkout the [ROSI-LTS](https://github.com/BurntToasters/ROSI-LTS) repo! Until the next major release, version 3.x.x will receive bug fixes and yt-dlp updates!
