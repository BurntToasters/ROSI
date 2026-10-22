# Flatpak bundled JavaScript runtime: failure modes (written before the changes)

Goal: the Flatpak build ships Node.js at `/app/lib/rosi/js-runtime/node` and
every yt-dlp invocation gets `--js-runtimes node:/app/lib/rosi/js-runtime/node`.
Other builds get no new argument and no behavior change. Deno stays a
yt-dlp default runtime and is not removed or disabled.

Scope of automated proof: the argument function is pure and takes the Flatpak
flag and runtime path as inputs. The unit tests in
`src-tauri/src/command_builders.rs` (`audit4_tests` module) pin it without
depending on the host. A real Flatpak E2E cannot run on this macOS machine. It
needs flatpak-builder and a Linux host with network access to YouTube (see
"Manual verification" below).

## Argument function (unit tests, Rust)

A1. Flatpak flag true, runtime is an executable regular file: emits exactly
`["--js-runtimes", "node:<path>"]`.
A2. Flatpak flag false, runtime file present and executable: emits nothing.
Non-Flatpak builds must never get the flag.
A3. Flatpak flag true, runtime file missing: emits nothing (no broken flag,
yt-dlp keeps its default runtimes).
A4. Flatpak flag true, runtime path is a directory: emits nothing (not a
regular file).
A5. Flatpak flag true, runtime file exists but has no execute bit (unix):
emits nothing. yt-dlp would fail to run it.
A6. Path containing spaces: the value is one argv element `node:/a b/node`
with no added shell quoting, because yt-dlp is spawned without a shell.
A7. The constant `FLATPAK_JS_RUNTIME_PATH` is `/app/lib/rosi/js-runtime/node`
(pins the manifest install target against the Rust constant).
A8. Output never contains `--no-js-runtimes`, `deno`, or any other runtime
name, so Deno and yt-dlp's default runtimes stay enabled alongside Node.
A9. `--ignore-config` (already in `build_ytdlp_runtime_args`) does not stop
command-line `--js-runtimes`. Command-line options are not config-file options.
This is confirmed from yt-dlp's documented behavior, not by a test.

## Call sites

C1. `build_ytdlp_runtime_args()` is spliced into both `build_ytdlp_args`
(downloader.rs) and `insert_common_args` (media_info.rs), so the new args reach
download, info, playlist, and probe calls. Verified by reading the code; the
E2E log check covers it at runtime.
C2. Duplicate flag: if both sites call the builder, the flag would appear
twice. Only `build_ytdlp_runtime_args` adds it; the other sites must not.

## Manifest (run.rosie.rosi.yml)

M1. The node24 SDK extension binary is missing at `/usr/lib/sdk/node24/bin/node`:
the `test -f` fails the build with a clear message. It must not skip silently.
M2. The Node license is missing from the SDK extension: the bounded `find`
finds nothing and the build fails with a clear message.
M3. `install -Dm755` copies a symlink target that does not exist: caught by M1.
M4. The node binary does not run in the build sandbox (missing shared
libraries): the `--version` smoke check fails the build. Unverified until a
Linux Flatpak build runs.
M5. No new `finish-args`, and no `--share=network` added to finish-args.
(`--share=network` already exists under the module build-args for npm/Cargo.)

## Licenses

L1. `ROSI_FLATPAK_NODE_LICENSE` unset (every non-Flatpak build): the copy script
writes the same `bundled-licenses.json` as before, with no Node entry.
L2. Env var set but the file is missing: the copy script throws, failing the
Flatpak build (no silent omission).
L3. The Node entry is added to `bundled-licenses.json` and copied to
`public/`, so the existing licenses iframe lists it without JS changes.

## Frontend wording

F1. Flatpak: the wizard status and the Deno reminder text no longer say Deno
or "some YouTube videos may not download". The Deno reminder stays hidden in
Flatpak as before.
F2. Non-Flatpak: the wizard and reminder text are unchanged.
F3. Cookie hint (`browserFlatpakHint`): unchanged.

## Deno on non-Flatpak (must not change)

D1. `enhanced_path` and `deno.rs` detection are not touched. Deno on PATH still
works on Linux AppImage, macOS, and Windows.

## Manual verification (Linux Flatpak build, not run here)

1. `npm run flatpak:bundle` (or the documented flatpak-builder command) on a
Linux host. Confirm the build log shows the `test -f` and `--version` steps
pass and the Node license path resolves.
2. `flatpak run --command=sh run.rosie.rosi -c 'ls -l /app/lib/rosi/js-runtime/node && /app/lib/rosi/js-runtime/node --version'`
prints Node 22.x.
3. Start ROSI, download a YouTube video (one that needs a JS challenge solver).
4. Check the verbose yt-dlp command in the download log: it must contain
`--js-runtimes node:/app/lib/rosi/js-runtime/node`, and the download must succeed.
5. Open Settings, Licenses: the "Node.js runtime (Flatpak build)" entry is listed.
6. Non-Flatpak AppImage or dev build: the yt-dlp command line has no
`--js-runtimes` argument, and the licenses list has no Node entry.

## yt-dlp support evidence

Option `--js-runtimes RUNTIME[:PATH]` is documented in yt-dlp's README at tag
2026.08.19 (https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/README.md). The
README says the option is repeatable, deno is the only default, and priority is
deno, node, quickjs, bun. The changelog for the release that added the option
was not confirmed (a search suggested 2025.11.12); 2026.08.19 is later.
Unverified: whether the standalone binary bundles the yt-dlp-ejs solver
component, or fetches it on first use via `--remote-components` (the README
does not say). A Linux Flatpak E2E run confirms it.
