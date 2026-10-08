# Git history prune: bundled yt-dlp binaries

On 2026-10-08 the repository history was rewritten to remove committed yt-dlp
executables. Every branch and tag was rewritten in one pass.

## What was removed

Only these ten paths, from every commit:

- `yt-dlp.exe`, `yt-dlp_arm64.exe`, `yt-dlp_macos`, `yt-dlp_linux`,
  `yt-dlp_linux_aarch64`
- the same five names under `assets/`

Notices, license files, `assets/ytdlp-checksums.json` and all source files are
unchanged. Each rewritten branch and tag was checked to have the same files as
before, apart from those ten paths.

## Why

Each yt-dlp update committed about 155 MB of binaries. The history had grown to
1.24 GiB, almost all of it old yt-dlp builds, and it grew with every update.
After the prune, the history is about 11 MiB.

ROSI no longer commits these binaries. `assets/ytdlp-checksums.json` pins the
yt-dlp version and SHA-256 of each file, and `scripts/fetch-ytdlp.cjs`
downloads that pinned release from the official yt-dlp GitHub release, checking
yt-dlp's GPG-signed `SHA2-256SUMS` before installing it. Release builds run this
automatically through `npm run prepare:sidecars`. See build-setup.md.

## Effects

- Commit IDs changed for history after April 2025. Tags keep their names and
  GitHub releases and their assets are unaffected; release `.sig` and `.asc`
  files sign artifacts, not commits.
- Pull request pages on GitHub still show the original commits.
- Older tags no longer contain their yt-dlp binary. Those binaries are public
  upstream yt-dlp releases.

## Re-syncing an existing clone

Existing clones still hold the old history. From the repository root, run:

```sh
npm run git:reset:dry   # show what would change
npm run git:reset
```

It fetches branches and tags, moves every local branch that tracks `origin` to
its rewritten remote commit, then frees the old history's space. It never
touches untracked files, so downloaded yt-dlp binaries in `assets/` stay. It
refuses (and skips cleanup) if you have uncommitted changes to tracked files or
local commits that are not on the remote; `--force` stashes those changes and
keeps such commits on a `backup/git-reset-*` branch first. Cloning again also
works.
