# Stable release runbook

This runbook covers the final transition from an accepted beta to its stable
release. In commands below, replace `X.Y.Z` with the stable version and `N`
with the accepted beta number. Do not use it to bypass a failed candidate or
`main` gate. Every command below is expected to run from a clean checkout of
the canonical repository.

## 1. One-time stable branch enforcement

The stable release branch, `main`, must be protected before stable promotion.
The `beta` branch is an intentionally mutable staging branch and does not need
branch protection. With a GitHub CLI account that has repository
administration permission, run:

```sh
npm run repo:protect-release-branches
```

The command protects `main` with the source-bound `ci-gate` status check that
aggregates every CI proof job, requires the branch to be up to date, allows the
intentional administrator bypass, and disables force pushes and branch
deletion. CI remains limited to tests, audits, validation, and unsigned compile
smoke; all release building, signing, and publishing stays on the manually
operated release VMs. Branch protection is optional: `release:preflight` does
not check it and does not wait for hosted CI. For both stable and beta it
requires a clean local checkout of the release branch that exactly matches its
`origin` branch.

Confirm the repository Settings page shows the rule before continuing.

## 2. Freeze and prove the stable candidate

### Soak gate

Stable promotion needs a tested beta. `release:preflight` does not check the
beta tag's age. Every condition below must hold before the candidate is frozen:

- No runtime change has landed since that tag. The production-tree comparison
  in the candidate proof below shows it.
- No open regression is known for that beta. Every report filed against it is
  either fixed in a later beta or closed with a recorded reason.
- The field exposure check is recorded. Download counts are a proxy, not a count
  of installs or updates. Record them before the gate opens:

  ```sh
  gh release view vX.Y.Z-beta.N --json assets --jq '.assets[] | [.name, .downloadCount] | @tsv'
  ```

  The maintainer sets the minimum download count before the soak starts. Write
  it, with the observed counts and the date, in the stable promotion record.
  Until that minimum is recorded and met, the gate is not met.

### Microsoft Store gate

Decision: v5 ships to the Microsoft Store as an MSIX bundle under the existing
Partner Center product (`9P4Q134B2JW3`), the same way the IYERIS project does.
`npm run build:msstore` builds that bundle (see the Microsoft Store section in
`build-setup.md`). The earlier NSIS `msstore` build was the wrong package type
for this product and is replaced.

- The Store is a low-priority follow-up after the GitHub stable release. It
  does not block stable. Stable can ship to GitHub while the Store package is
  still pending.
- Store packages are stable only, and their version is `X.Y.Z.0`. The version
  must be greater than ROSI 4's last Store version (see the Microsoft Store
  section of `build-setup.md`).
- Before the Store release goes public, run a Partner Center package flight of
  the signed bundle. The flight must prove the v4 to v5 data import from the
  Store package folder. The v4 import reads that folder through
  `store_package_dirs` in `src-tauri/src/legacy.rs`. The flight must show
  settings, queue, and statistics imported. Record the flight ID and the result
  in the release record.

### Candidate freeze and proof

The only stable candidate source branch is `next-X.Y.Z`, promoted directly to
`main`; promotion CI enforces this source/target pairing. The published `beta`
branch is not an intermediate merge target and does not need to contain
post-beta test-only fixes.

The production source must remain the accepted beta source users tested.
Review every post-beta difference and prove that any accepted difference is
limited to tests or documentation and cannot enter release binaries. No
production, packaging, updater, installer, build, or release-toolchain path may
change without another beta. Any such change requires a fresh beta, repeated
beta smoke testing, and a full new burn-in period before stable promotion. Then
run the complete gate, including E2E:

```sh
git fetch --tags origin
git rev-parse --verify "refs/tags/vX.Y.Z-beta.N^{commit}"
git switch next-X.Y.Z
git pull --ff-only origin next-X.Y.Z
git diff --name-status vX.Y.Z-beta.N..HEAD
git diff --check vX.Y.Z-beta.N..HEAD
npm ci --ignore-scripts
npm run workspace:bootstrap
npm run test:all -- --require-clean-proof
```

Confirm that the displayed beta-tag commit is the exact published beta source
users tested. Use this tag as the comparison baseline; do not substitute the
mutable `origin/beta` branch tip.

Do not run `release:preflight` on `next-X.Y.Z`; it deliberately accepts only an
actual release branch (`beta` for beta versions and `main` for stable versions).
Open the promotion pull request from `next-X.Y.Z` directly to `main`. All GitHub
Actions jobs for that exact pull-request head must be green on every supported
runner before merge. Do not treat a platform-local release build as a
replacement for cross-platform CI. If the production-tree comparison above
finds a runtime change, stop: that runtime must be beta-tested before stable
promotion. Download the `e2e-*` evidence artifacts from that CI run and confirm each
report lists every scenario as passed.

On a Mac, the local E2E gate runs ROSI in background mode by default
(`ROSI_E2E_BACKGROUND=1`, see `e2e/README.md`). CI runs in the foreground. The
gate report does not record the window mode, so the release record for any
macOS evidence must state the mode that produced it: background (the default)
or foreground (`ROSI_E2E_FOREGROUND=1`).

If the accepted beta still needs to be published, use the normal beta release
flow first and complete beta smoke testing before the stable version change.

## 3. Promote the tested source to main

Merge the exact accepted `next-X.Y.Z` pull-request head into protected `main`
through the normal GitHub merge flow. Do not merge it through `beta` first and
do not force push either release branch. Require the post-merge `main` CI run to
pass, then start a short-lived stable-metadata branch from that pushed `main`
tip:

```sh
git switch main
git pull --ff-only origin main
git switch -c release/X.Y.Z
```

Change only the release metadata needed for stable `X.Y.Z`. Edit `package.json`
`version` to `X.Y.Z`, then synchronize that value without performing dependency
updates:

```sh
npm run sync-version
```

Edit `CHANGELOG.md` so the current section is the final stable `X.Y.Z` entry and
remove beta-only release wording. Review the resulting diff carefully, then
commit it and merge the stable-metadata branch to protected `main` through the
normal pull-request flow. Require every pull-request and post-merge `main` CI
job to pass. CI accepts `release/*` to `main` only when the base version is the
same beta series, the head removes only the beta suffix, and every changed path
is an enumerated release-metadata file.

## 4. Prove the stable source

On the exact pushed stable commit, run the complete quality gate and strict
license collection:

```sh
npm ci --ignore-scripts
npm run workspace:bootstrap
npm run test:all -- --require-clean-proof
npm run licenses:cargo:strict
npm run release:preflight
```

The strict Cargo license step may fetch the exact immutable VCS revisions
recorded by crates.io when a published crate omitted a workspace-root license.
It accepts only HTTPS repositories and exact recorded commit hashes. If the
exact source revision also contains no license text, only an explicit
package-version-scoped source-omission review may satisfy the gate; generic
SPDX templates and moving-branch content are never accepted.

Also confirm:

- `git status --short` is empty apart from generated Tauri schema paths that the
  release tooling explicitly permits.
- `npm audit --omit=dev --audit-level=high` passes.
- `npm run audit:dev-reviewed` passes (fails only if an advisory is production-reachable).
- `cargo audit` reports no unignored vulnerability.
- The stable version is `X.Y.Z` everywhere and contains no `-beta.N` suffix.

On the macOS release machine, also run the E2E stability run on the exact
stable commit, after the gate above has passed:

```sh
npm run test:e2e:stability
```

It repeats the full E2E gate five times (`scripts/test-e2e.js --repeat 5`), so
expect several hours. It writes `e2e/artifacts/e2e-stability-darwin-arm64.json`,
and the release record must cite that file. Known flake: the macOS
`download-process-repairs` scenario (spec `e2e/download-process.spec.js`, runner
`e2e/run-download-process.mjs`) can fail on execute or async timeouts. Re-run
the failing pass once before debugging, and record both the first result and
the re-run result in the release record.

## 5. Build and sign on isolated platform VMs

Use clean, isolated release VMs. Load their signing secrets for the session
only and delete `.env` afterwards, as [KEY-COMPROMISE.md](KEY-COMPROMISE.md)
describes. The normal entry points run release preflight,
prepare locked dependencies, regenerate notices and sidecars, and create or
reuse the commit-bound draft:

```sh
# Windows release VM
npm run release:win

# macOS release VM
npm run release:mac

# Linux x64 release VM
npm run release:linux
```

Linux ARM64 wiring is retained for future development but is not part of the
v5 release matrix. Do not use beta recovery overrides for a stable release.

The platform release commands intentionally skip GUI E2E on the signing VM.
That is acceptable only because step 4 and protected CI already proved the
exact stable commit with E2E enabled.

## 6. Packaged-artifact QA

Before publishing, install each signed artifact on its platform and verify:
launch, a real download, an FFmpeg conversion, the queue, notifications, the
updater (stable and beta channels), macOS notarization and sidecar signatures,
and Linux desktop integration (AppImage/Flatpak launchers).

### Updater gate

Test the update path from the accepted beta to the stable candidate on each
platform. Install the accepted beta artifact, then update in-app to the stable
candidate's signed artifacts:

- **macOS, user-owned app location:** the update replaces the app, and the app
  relaunches as `X.Y.Z`.
- **macOS, admin-owned `/Applications`:** the update asks for administrator
  approval where needed and replaces the app. Record any failure in full.
- **Windows x64 NSIS and Windows ARM64 NSIS:** the update installs over the beta,
  and the app starts as `X.Y.Z`. Active downloads stop and the queue is saved
  first.
- **Linux AppImage:** the update replaces the AppImage, and it starts as `X.Y.Z`.
- **Flatpak:** the in-app updater does not apply. Reinstall the stable Flatpak
  asset manually, then confirm the installed version.

Record each result with the artifact name and its SHA-256 checksum.

Fix and rebuild any failing artifact. Do not publish a draft that has not
passed this matrix.

## 7. Verify the draft before publishing

After all required platform assets and signatures are present:

```sh
npm run release:verify:draft
```

This must pass against the complete stable draft. Resolve duplicate drafts,
missing signatures, incorrect manifest URLs, a missing or misdirected ROSI 4
update feed (see build-setup.md), or a wrong target commit instead of
overriding the verifier.

## 8. Publish, then verify the live feed

Publish only through the guarded command, which reruns draft verification
before changing the GitHub release state:

```sh
npm run release:publish
npm run release:verify:published
```

The second command must prove the live updater feed and signatures for `X.Y.Z`.
Verify GitHub shows `vX.Y.Z` as the latest non-prerelease release and that the
tag resolves to the exact stable `main` commit.

## 9. Post-release checks

Install or update to `X.Y.Z` through each supported distribution path and perform
a short smoke test of a download, a conversion, the queue, and the updater. Keep strict `main` protection enabled for the next cycle; `beta`
may remain unprotected.

If any publish-time verification fails, stop distribution work and repair the
release metadata or assets. Do not create a second same-version stable release.

## 10. Recovering an interrupted macOS update

The macOS in-app updater replaces only the `Contents` directory of the installed
app, so the outer `ROSI.app` directory and its Dock identity stay in place. The
swap is two renames (`swap_macos_app_contents` in
`src-tauri/vendor/tauri-plugin-updater/src/updater.rs`):

1. `ROSI.app/Contents` moves into a hidden sibling backup directory named
   `.ROSI-app.rosi-update-backup-<hash>`, where `<hash>` is 16 lowercase hex
   digits. The app name's `.` becomes `-` in that name, so the old `Contents` is
   at `/Applications/.ROSI-app.rosi-update-backup-<hash>/Contents`.
2. The staged `Contents` moves into `ROSI.app/Contents`, and the bundle identity
   is checked.

A crash or power loss between the two renames leaves `ROSI.app` with no
`Contents`. macOS cannot launch that bundle, and the updater's recovery
(`recover_macos_live_bundle`) runs inside an update install, so ROSI cannot
start to trigger it. Restore the app by hand. The paths below assume
`/Applications`; substitute the folder that contains `ROSI.app`.

1. Quit ROSI if it is running.
2. Check the state. `ls -la /Applications/ROSI.app` must show no `Contents`
   directory. If `ROSI.app/Contents` exists, stop: this is not the state
   described here. Do not move anything, and keep the backup.
3. Find the backup and confirm it holds `Contents`:
   `ls -la /Applications | grep rosi-update-backup` and then
   `ls /Applications/.ROSI-app.rosi-update-backup-*/Contents`. A backup with no
   `Contents` is empty, which means the first rename never happened and
   `ROSI.app` still has its `Contents`, so this case does not apply.
4. Move the backup's `Contents` back into the app, using the exact backup name
   from step 3:

   ```sh
   mv "/Applications/.ROSI-app.rosi-update-backup-<hash>/Contents" "/Applications/ROSI.app/Contents"
   ```

   If `/Applications` is owned by an administrator and `mv` is denied, run the
   same command with `sudo`.

5. Remove the emptied backup directory. `rmdir` refuses to remove a directory
   that still has files, which is a safe check:

   ```sh
   rmdir "/Applications/.ROSI-app.rosi-update-backup-<hash>"
   ```

6. Launch ROSI. The restored `Contents` is the pre-update build. The next update
   check offers the update again.

Record any case that does not match these steps, with the output of the `ls`
commands, before retrying the update.
