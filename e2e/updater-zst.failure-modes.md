# Compact macOS updater (per-arch `.app.tar.zst`) failure modes

Enumerated before implementation. Each case names the layer that must catch it.
`scripts/e2e-updater-zst.mjs` exercises the pipeline end to end and writes
`e2e/artifacts/updater-zst-report.json`.

## Z01: archive decoding (vendored updater plugin)

1. A truncated `.tar.zst` download must fail extraction. The live app must
   stay untouched and the update must stay retryable.
2. A frame whose window exceeds 2^27 bytes (for example, compressed with
   `--long=31`) must be rejected rather than allocating an unbounded window.
3. A decompression bomb (small archive, huge tar payload) must stop at the
   decompressed-byte cap.
4. Garbage after the last zstd frame, or a tar stream without both end
   blocks, must be rejected the same way the AppImage reader rejects it.
5. A gzip `.app.tar.gz` must still extract. Old and new feeds can both reach
   a new client.
6. Unknown leading bytes (neither gzip nor zstd magic) must fail with an
   invalid-format error, never be fed to a decoder.
7. Every existing tar member rule (confinement, hard links, symlink targets,
   directory collisions) must apply to zstd archives unchanged.

## Z02: staged bundle contents

1. A zstd archive whose app lacks a sidecar, or whose identity differs, must
   be refused by the existing completeness and identity checks.
2. A per-arch bundle for the wrong architecture must never be offered: the
   feed key carries the arch, and the client asks for its own compile-time
   arch (Rosetta processes ask for x86_64).
3. An arm64-only app later moved to an Intel Mac will not launch. This is
   accepted and documented; recovery is the universal DMG.

## Z03: client target selection and fallback

1. A packaged macOS app asks for `darwin-{arch}-app-zst` (stable) or
   `darwin-beta-{arch}-app-zst` (beta).
2. If the compact feed is missing or lacks the key (a release published
   without zst artifacts), the check must fall back to the legacy target and
   still find the update.
3. A compact feed that exists and reports no newer version must not trigger
   the fallback.
4. Clients on 5.0.x never request the compact key and keep receiving the
   universal `.app.tar.gz`.
5. Windows, Linux, and Flatpak targets must not change.

## Z04: release pipeline

1. Per-arch builds also produce an arch-less `ROSI.app.tar.gz`. It must never
   be collected as the universal updater archive, because then an Intel Mac
   could receive an arm64 bundle.
2. The packer must refuse a missing or stale per-arch `.app.tar.gz`, a tar
   whose top-level entry is not `ROSI.app`, and a bundle whose main executable
   is not thin for the expected arch.
3. The repacked `.tar.zst` must hold the exact tar bytes from Tauri's archive
   (round-trip check), so the code signature and staple inside survive.
4. A missing or mismatched `.sig` must stop manifest generation.
5. Stable and beta compact manifests must be generated, validated, listed in
   the required beta-manifest set, and pass the live validator.
6. Compact entries must never become the generic `darwin-{arch}` fallback for
   old clients.
