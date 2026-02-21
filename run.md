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

# Licenses

npx npm-license-crawler --production --json licenses.json
