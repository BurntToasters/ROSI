# Windows .exe x64 & arm64

npm run build:win:x64
npm run build:win:arm64

# Windows .appx x64 & arm64

npm run build:msstore:x64
npm run build:msstore:arm64

# macOS Universal

npm run build:mac:universal

# Linux x64 & arm64 (all formats)

npm run build:linux

# Linux x64 only

npm run build:linux:x64

# Linux arm64 only

npm run build:linux:arm64

# FFmpeg prebuild checks

# Validate all required FFmpeg binaries

npm run ffmpeg:check:all

# Validate only a specific target

npm run ffmpeg:check -- --target win:x64

# Licenses

npx license-checker --production --json --out licenses.json

# ROSI 5 upgrade (v5 bridge) E2E

Real upgrade on a Windows test VM. It uninstalls ROSI 4 and ROSI 5 and deletes
their data first, so never run it on a machine you use. Build the ROSI 5
installer from the ROSI 5 repo first.

node e2e/bridge/run.js --tauri-cli <ROSI 5 repo>/node_modules/@tauri-apps/cli/tauri.js --v5-installer <ROSI 5 setup.exe> --v5-version <its version> --reset-this-machine

macOS (temporary folders only; ROSI 5 is a signed stand-in app):

node e2e/bridge/run.js --tauri-cli <ROSI 5 repo>/node_modules/@tauri-apps/cli/tauri.js

Evidence: e2e/artifacts/bridge-e2e-<platform>-<arch>.json. Failure modes are
listed in build-scripts/v5-bridge-failure-modes.json.

# Before releasing v4.4.0

- src/main/v5bridge/config.json must keep ROSI 5's real updater key (checked by
  build-scripts/check-bridge-config.js in prebuild).
- Once v4.4.0 is published, set sourceTag in ROSI 5's legacy-v4-feed.json to
  v4.4.0 so ROSI 4.3.x users update to it first. If ROSI 5 stable is already
  live, publish v4.4.0 with "Set as the latest release" turned off.
