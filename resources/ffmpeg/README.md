# FFmpeg Binaries

The FFmpeg binaries are not included in the repository due to size constraints.

## Build Source

All bundled binaries are built by BurntToasters:

- **Repository:** https://github.com/BurntToasters/ffmpeg-static-builds
- **FFmpeg 9.0.2 source release:** https://github.com/BurntToasters/ffmpeg-static-builds/releases/tag/ffmpeg-v9.0.2

## Current Versions

| Platform            | Version |
| ------------------- | ------- |
| Windows x64 / arm64 | 9.0.2   |
| Linux x64 / arm64   | 9.0.2   |
| macOS x64 / arm64   | 9.0.2   |

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
- Use builds that compile their third-party libraries in, so the Windows and
  macOS binaries need no bundled DLLs or dylibs. Linkage in the current binaries
  (checked by inspection with `file`, `objdump -p`, and `otool -L`; the repository
  has no automated linkage check):
  - **Windows x64 and arm64:** the PE import tables list only Windows system DLLs
    and API sets.
  - **macOS x64 and arm64:** the Mach-O binaries load only system frameworks and
    `libc++`.
  - **Linux x64 and arm64:** the binaries are **dynamically linked** against glibc
    and `libgcc_s` (interpreter `/lib64/ld-linux-x86-64.so.2` on x64,
    `/lib/ld-linux-aarch64.so.1` on arm64). Keep them that way in a future bump;
    do not treat the dynamic link as a defect to fix.
  - Only the FFmpeg binaries were inspected on each platform. The ffprobe
    binaries were checked on Windows x64 and Linux x64 only.
- `scripts/check-linux-glibc.js` guards the glibc floor: the Linux release fails
  if a shipped binary needs a glibc newer than the documented floor (Ubuntu 24.04,
  glibc 2.39). Any new FFmpeg build must pass that check.
- Ensure binaries have execute permissions on macOS/Linux (`chmod +x`)
- Verify binaries before a build with `npm run ffmpeg:check:all`; `npm run prepare:sidecars` re-verifies them before packaging
- License text and GPLv2 written source offer ship with the app under the bundle resources at `ffmpeg/LICENSE.txt` and `ffmpeg/SOURCE_OFFER.txt`
