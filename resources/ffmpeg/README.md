# FFmpeg Binaries

The FFmpeg binaries are not included in the repository due to size constraints.

## Download Sources

| Platform | Source                                                               | Build Type         |
| -------- | -------------------------------------------------------------------- | ------------------ |
| Windows  | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) | GPL (n8.0 release) |
| Linux    | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) | GPL (n8.0 release) |
| macOS    | [osxexperts.net](https://www.osxexperts.net/)                        | GPL                |

## Required Structure

```
resources/ffmpeg/
├── NOTICE.txt
├── SOURCE_OFFER.txt
├── ffmpeg_license.txt
├── README.md
├── win/
│   ├── x64/
│   │   └── ffmpeg.exe
│   └── arm64/
│       └── ffmpeg.exe
├── mac/
│   ├── x64/
│   │   └── ffmpeg
│   └── arm64/
│       └── ffmpeg
└── linux/
    ├── x64/
    │   └── ffmpeg
    └── arm64/
        └── ffmpeg
```

## Notes

- Use **GPL builds** (not LGPL) if you need x264/x265 support
- Use **static builds** (not shared) for easier bundling
- Ensure binaries have execute permissions on macOS/Linux (`chmod +x`)
- ffprobe is NOT required — ROSI only uses ffmpeg
