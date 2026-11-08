# FFmpeg and package size for 5.1 (plan workstream C)

## Decision (C0)

Pre-compressing ffmpeg and ffprobe on the release machines and unpacking them
at first launch (plan items C1 to C5) is not done. Every package format ROSI
ships already compresses its payload, so a compressed sidecar archive leaves
the DMG, AppImage, and Flatpak about the same size and makes the Windows NSIS
installer and the macOS `.app.tar.zst` update larger. ROSI does the plan's
alternative levers (C6) instead.

Measured 2026-11-06 with FFmpeg 9.0.2: Windows x64 `ffmpeg.exe` is 143.9 MB
raw, 55 MB with gzip -6, and 43.8 MB with zstd -19, while the whole 5.0.2 NSIS
installer is 63.7 MB because NSIS already compresses its full payload (about
320 MB) as one solid LZMA stream. Published 5.0.2 sizes: universal DMG
146.9 MB, AppImage 175.9 MB, Flatpak 99.3 MB.

## C6.1 AppImage zstd SquashFS

The Linux builds pass `LDAI_COMP=zstd` to linuxdeploy's AppImage plugin, and
`scripts/check-appimage-compression.js` fails the release unless the payload is
zstd and the AppImage runtime can extract it. Failure modes:
[`e2e/appimage-zstd.failure-modes.md`](../e2e/appimage-zstd.failure-modes.md).
Size effect: not measured yet; the Linux release machine must build it once and
record the before and after sizes in IMPLEMENTATION-5.1.md.

## C6.2 DMG as ULMO

`build:mac:dmg:ulmo` converts each release DMG from UDZO to ULMO, proves the
`ROSI.app` tree is identical, then signs, notarizes, and staples it. Failure
modes: [`e2e/dmg-ulmo.failure-modes.md`](../e2e/dmg-ulmo.failure-modes.md).

| Image                       | UDZO (Tauri) | ULMO        | Saved            |
| --------------------------- | ------------ | ----------- | ---------------- |
| Universal DMG, 5.0.0-beta.1 | 139,316,852  | 114,260,300 | 25,056,552 (18%) |

Measured on macOS 27.2 arm64 with `scripts/convert-dmg-ulmo.mjs --no-notarize`
on a local build (report `e2e/artifacts/dmg-ulmo-report.json`). ULFO (LZFSE)
saved under 1 MB, so ULMO is used. Signed and notarized release DMGs are proven
by `release:mac:continue`.

## C6.3 Dropping ffprobe: not viable

ffprobe is as large as ffmpeg on every platform (both are static builds of the
same libraries), so removing it would halve the FFmpeg payload:

| Platform      | ffmpeg (bytes) | ffprobe (bytes) |
| ------------- | -------------- | --------------- |
| Windows x64   | 143,919,616    | 143,712,768     |
| Windows arm64 | 77,086,208     | 76,920,320      |
| macOS arm64   | 50,232,552     | 50,041,096      |
| macOS x64     | 75,667,112     | 75,481,112      |
| Linux x64     | 144,906,888    | 144,689,672     |
| Linux arm64   | 106,962,112    | 106,765,504     |

Study method: E2E builds accept `ROSI_E2E_FFPROBE=log:<path>` (record every
ffprobe call yt-dlp makes through ROSI's media-tool launcher) and
`ROSI_E2E_FFPROBE=absent` (give yt-dlp no ffprobe). Production builds ignore
both (`src-tauri/src/ffmpeg_guard.rs`). Both modes ran the `downloads` and
`conversion` groups on macOS arm64 on 2026-11-08.

Findings:

- With ffprobe present, yt-dlp called it 6 times: `-bsfs` (its capability
  check) and `-show_streams` on the file for audio extraction, three downloads.
- With ffprobe absent, every download, merge, conversion, and caption scenario
  still passed. Only the two checks that test the ffprobe launcher itself
  failed (`ffprobe-local-playlist-network-guard`, `ffprobe-only-path-without-ffmpeg`),
  as expected. yt-dlp falls back to `ffmpeg -i` for audio codec detection.
- The suites do not exercise features that need network sources, and yt-dlp's
  own code (2026.10.21, `yt_dlp/postprocessor/ffmpeg.py`
  `get_metadata_object`) raises "ffprobe not found" without ffprobe. ROSI turns
  on three of the features that call it: `--sponsorblock-remove`
  (`ModifyChaptersPP` needs the real duration), `--embed-thumbnail`
  (`EmbedThumbnailPP.get_stream_number` for MP4 and MKV), and
  `--embed-metadata` (chapter end-time fixup and info JSON attachment).

Conclusion: dropping ffprobe would break SponsorBlock removal, thumbnail
embedding, and parts of metadata embedding. Replacing it with a launcher that
turns `ffmpeg -i` output into ffprobe's JSON would have to reproduce
`-show_format -show_streams -print_format json` for every container and codec
yt-dlp reads, which is fragile. ROSI keeps ffprobe.

A lever that would shrink both tools without changing behavior is a shared
library FFmpeg build (ffmpeg and ffprobe linking one copy of the libav
libraries). It changes how the sidecars are built, signed, notarized, and
located at runtime on all three platforms, so it is a separate decision and is
not part of 5.1.0 unless chosen.
