# DMG compression (ULMO): failure modes

Scope: `scripts/convert-dmg-ulmo.mjs`, which converts the release DMGs that
Tauri builds as UDZO (zlib) to ULMO (LZMA) before they are verified, GPG
signed, and uploaded. Plan item C6.2. Measured on a universal 5.0.0-beta.1
DMG: 139.3 MB as UDZO, 114.3 MB as ULMO (ULFO saved under 1 MB). macOS 15,
ROSI's minimum, opens ULMO images (supported since macOS 10.15).

Required behavior: every published DMG is ULMO, holds exactly the same
`ROSI.app` tree as the image Tauri produced, and is signed, notarized, and
stapled like before. The conversion never changes what is installed.

| #   | Failure mode                                                                                           | Required behavior                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The converted image holds a different `ROSI.app` (a file, mode, or symlink target changed or missing)  | Both images are mounted read-only and their full trees (relative path, type, mode, size, SHA-256, symlink target) must be identical, or the step fails. |
| 2   | The conversion leaves the image unreadable or damaged                                                  | `hdiutil verify` must pass on the converted image before it replaces the original.                                                                      |
| 3   | The original is replaced before the new image is proven, so a failure loses the only DMG               | The new image is written beside the original under a temporary name and renamed over it only after every check passes.                                  |
| 4   | The converted DMG is published unsigned or without a notarization ticket (Gatekeeper warns on open)    | In release mode the image is code-signed with `APPLE_SIGNING_IDENTITY`, submitted with `notarytool --wait`, stapled, and `stapler validate` must pass.  |
| 5   | Release mode runs without signing or notarization credentials and silently publishes an unsigned image | Release mode refuses to start when `APPLE_SIGNING_IDENTITY` or the notarization credentials are missing.                                                |
| 6   | The step runs on a stale DMG from an earlier build                                                     | Release mode requires each DMG to be newer than the release session start, like `e2e-macos-native-packages.mjs --require-real-builds`.                  |
| 7   | A DMG that is already ULMO is converted again, or a non-UDZO input is treated as Tauri output          | An input already in ULMO is left alone and reported as such; any other format than UDZO or ULMO fails the step.                                         |
| 8   | A mounted image stays attached after a failure                                                         | Every attach is detached in a `finally` block, forced if a normal detach fails.                                                                         |
| 9   | The images grow instead of shrink (a future Tauri or payload change)                                   | The step fails when the ULMO image is not smaller than the input, so a regression is noticed instead of published.                                      |
| 10  | The release chain verifies or signs the DMG before the conversion                                      | `release:mac:continue` runs the conversion right after the DMGs are built and before `test:e2e:macos-native-packages`, GPG signing, and upload.         |

Proof:

- Local, without credentials: `node scripts/convert-dmg-ulmo.mjs --dmg <path>
--no-notarize --out <copy>` converts a copy, runs rows 1, 2, 3, 7, 8, and 9,
  and writes `e2e/artifacts/dmg-ulmo-report.json`.
- Release: `npm run build:mac:dmg:ulmo` inside `release:mac:continue`, followed
  by `test:e2e:macos-native-packages -- --require-real-builds`, which already
  mounts each DMG, checks the app signature, and validates the staple.
