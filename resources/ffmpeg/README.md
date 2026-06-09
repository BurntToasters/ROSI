# FFmpeg Binaries

The FFmpeg binaries are not included in the repository due to size constraints.

## Build Source

All bundled binaries are built by BurntToasters:

- **Repository:** https://github.com/BurntToasters/ffmpeg-static-builds
- **FFmpeg 8.1 source release:** https://github.com/BurntToasters/ffmpeg-static-builds/releases/tag/ffmpeg-v8.1
- **FFmpeg 8.0.1 source release (macOS x64 only):** https://github.com/BurntToasters/ffmpeg-static-builds/releases/tag/ffmpeg-v8.0.1

## Current Versions

| Platform            | Version                                              |
| ------------------- | ---------------------------------------------------- |
| Windows x64 / arm64 | 8.1                                                  |
| Linux x64 / arm64   | 8.1                                                  |
| macOS arm64         | 8.1                                                  |
| macOS x64           | 8.0.1 (unchanged - no Intel Mac hardware to rebuild) |

## Required Structure

```
resources/ffmpeg/
├── NOTICE.txt
├── SOURCE_OFFER.txt
├── ffmpeg_license.txt
├── README.md
├── win/
│   ├── x64/
│   │   ├── ffmpeg.exe
│   │   └── ffprobe.exe
│   └── arm64/
│       ├── ffmpeg.exe
│       └── ffprobe.exe
├── mac/
│   ├── x64/
│   │   ├── ffmpeg
│   │   └── ffprobe
│   └── arm64/
│       ├── ffmpeg
│       └── ffprobe
└── linux/
    ├── x64/
    │   ├── ffmpeg
    │   └── ffprobe
    └── arm64/
        ├── ffmpeg
        └── ffprobe
```

## Notes

- Use **GPL builds** (not LGPL) for x264/x265 support
- Use **static builds** (not shared) for easier bundling
- Ensure binaries have execute permissions on macOS/Linux (`chmod +x`)
- Verify binaries before a build with `npm run ffmpeg:check:all`
- License text and GPLv2 written source offer ship with the app at `ffmpeg/LICENSE.txt` and `ffmpeg/SOURCE_OFFER.txt`
