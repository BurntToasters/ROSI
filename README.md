# ROSI

ROSI is an Electron GUI for yt-dlp

[<img src="https://get.microsoft.com/images/en-us%20dark.svg" width="200"/>](https://apps.microsoft.com/detail/9p4q134b2jw3?referrer=appbadge&mode=direct) [<img width="150" alt="ROSI" src="https://prod.rosie.run/img/download-for-windows.png"/>](https://github.com/BurntToasters/ROSI/releases/latest/download/ROSI-Windows-x64.exe) [<img width="150" alt="ROSI" src="https://prod.rosie.run/img/download-for-windows-arm64.png"/>](https://github.com/BurntToasters/ROSI/releases/latest/download/ROSI-Windows-arm64.exe) [<img width="150" alt="ROSI" src="https://prod.rosie.run/img/download-for-macos.png"/>](https://github.com/BurntToasters/ROSI/releases/latest/download/ROSI-MacOS-universal.dmg) [<img width="150" alt="ROSI" src="https://prod.rosie.run/img/download-for-linux.png"/>](https://github.com/BurntToasters/ROSI/releases/latest)

<p align="center">

<img width="45%" height="1012" alt="ROSI-v" src="https://media.rosie.run/rosi/gallery/ghv4/dark.png" />
  &nbsp;
  <img width="45%" height="1012" alt="ROSI-4" src="https://media.rosie.run/rosi/gallery/ghv4/purple.png" />
  &nbsp;
  <img width="45%" height="1012" alt="ROSI-4" src="https://media.rosie.run/rosi/gallery/ghv4/sidebar.png" />

</p>

# LICENSES

- Rosi includes the official YT-DLP binary which on its own uses the [unlicense] license, however there are bundled third party packages. Read [THIRD‑PARTY‑NOTICES](THIRD‑PARTY‑NOTICES.md) for more.
- Please make sure to also read the [license](LICENSE) for the source of this project (excluding third part binaries and packages).

# Requirements

Official ROSI builds bundle FFmpeg per platform and architecture.

When building from source, you must place FFmpeg binaries in `resources/ffmpeg/<platform>/<arch>/`
before packaging. See [resources/ffmpeg/README.md](resources/ffmpeg/README.md) for the required
layout.

You can optionally set a custom FFmpeg path in Settings to override the bundled binary.

## ℹ️ The Microsoft Store version of ROSI is now integrated into the main codebase. Its customizations are run via electron-builder when specifying to release for the ms store.

# Build ROSI from source:

Download ROSI source code from source (main)

1. Download zip of release source code (non-release source code are not recommended as they may contain issues not yet fixed for a release).
2. Unzip the folder folder, place it in a good location on your computer.
3. Install [NodeJS](https://nodejs.org/en/download) and [NPM](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) _(Required to build ROSI)_.
4. Run `npm i --save-dev` to download the required electron packages.
5. View the package.json file to see the `npm run build` commands available.

# ROSI LTS Version

There is an LTS version of the previous stable full release of ROSI (which is now `v3.x.x`) which can be found at <b>[➡️ROSI-LTS's Repo](https://github.com/BurntToasters/ROSI-LTS)</b>

This is mainly for people who perfered the previous look of ROSI, or has a current issue with a newly released major version.

The LTS version only provides yt-dlp updates and minor bug fixes. No feature additions will happen with LTS versions. Whatever features were added to that version before it became LTS are the last features it will receive.

# Need help with something?

If there is an issue with the program, feel free to create a **Github Issue**!  
For other issues/general contact, please go to [https://help.rosie.run/contact](https://help.rosie.run/contact).
