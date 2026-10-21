# Release secrets and compromise response

This document lists every secret the release pipeline uses, what each one
protects, how to store it, and what to do if it leaks. Read it before a stable
release and whenever a secret may have been exposed.

The release VMs read these values from `.env`, which is git-ignored (see
`.env.example` for names). No workflow in `.github/workflows/` reads any of
these names, so hosted CI cannot sign or publish a release.

## Inventory

| Secret or setting | Protects | If it leaks |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The Minisign key that signs every updater `.sig`. Installed apps trust one public key, `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. | An attacker can sign an update that every install accepts. This is the most serious case. |
| `GPG_KEY_ID`, `GPG_PASSPHRASE`, and the GPG secret key file | Detached `.asc` signatures on release assets, checked by users against the public key at `https://tuxedo.rosie.run/GPG/BurntToasters_0xF2FBC20F_public.asc`. | An attacker can forge `.asc` signatures that users would trust. `GPG_KEY_ID` is a public fingerprint; the passphrase and the key file are the secrets. |
| `AZURE_CLIENT_SECRET` | The credential that lets the release VM sign Windows binaries through Azure Artifact Signing. | An attacker with the secret can request Authenticode signatures under ROSI's signing profile while the credential is valid. |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_ARTIFACT_SIGNING_*` | Identifiers for the Azure app, tenant, account, and signing profile. | Not credentials by themselves. They help an attacker target the client secret, so treat them as internal. |
| `APPLE_PASSWORD` | The app-specific password used to notarize macOS builds with the Apple ID in `APPLE_ID`. | An attacker can submit software for notarization under ROSI's Apple ID. |
| `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`, `APPLE_ID` | Names that select the Developer ID certificate and account. | Not secret by themselves. The certificate's private key is in the macOS keychain, which is the real secret. |
| `SSH_USER_PWD` | The macOS login keychain password. `scripts/mac-keychain-ssh.sh` uses it to unlock the keychain for non-interactive SSH sessions on the macOS release VM. | Anyone with it can unlock the login keychain on that VM, including any Developer ID private key stored there. |
| `FFMPEG_DL_SERVER` | The base URL of the internal server that `scripts/get-ffmpeg.cjs` downloads FFmpeg from. | A compromised server could serve bad binaries. The binaries are checked against the committed `resources/ffmpeg/checksums.json` by `scripts/prepare-sidecars.js`, so a swapped binary fails unless the committed checksums also change. |

GitHub access is not in `.env`. `scripts/github-cli.cjs` requires the GitHub
CLI's own keyring (`gh auth login`) and ignores token environment variables.

## Storage

- Keep each secret in the OS keychain or a password manager. Load values into
  the shell only for the length of one release session, and clear them when the
  session ends.
- Do not keep a long-lived plaintext `.env` on a release VM. If a release command
  needs the file, create it for the session and delete it afterwards.
- Disposable VMs: delete `.env` after the release, before the VM is reused,
  shared, or snapshotted. A snapshot of a VM with `.env` in it is a copy of every
  secret in that file.
- Limit who can sign into the release VMs and the password manager vault. Keep
  a record of which release used which key, and never paste a secret into a
  chat, issue, log, or commit message.
- Store the GPG revocation certificate offline, separate from the key itself.
- Rotate on a schedule, and always after a release VM or vault is exposed.

## Updater key limitation

The updater trusts one Minisign public key, embedded in every shipped build.
This has three consequences:

- Rotating the key needs a release signed with the old key that carries the new
  public key. If the old key is compromised, the attacker can publish such a
  release too, so that path is not a reliable recovery.
- Nothing revokes the old key on installed apps. Each install keeps trusting it
  until it updates to a build with a new key.
- Dual-key support, where an update is accepted from either of two keys during a
  rotation, is on the roadmap in [ROADMAP-5.1.md](ROADMAP-5.1.md). Until it
  ships, an updater-key incident can require users to reinstall manually from
  the official release page.

## Response steps for any exposure

1. Stop releases. Do not run any `release:*` command until the incident is
   closed.
2. Record when the secret may have been exposed, which VMs and sessions could
   read it, and which releases were signed in that window.
3. Revoke or rotate the secret at its provider (see the sections below).
4. Review the provider's audit logs for activity in the exposure window.
5. Decide which artifacts are affected. Rebuild and re-sign them, or retract
   them, and check every affected release asset against its checksums.
6. Tell users through the GitHub release notes and the project's support
   channels. Say which versions are affected and what to do.

## Per-secret response

### Updater key (`TAURI_SIGNING_PRIVATE_KEY` and its password)

1. Check the GitHub release for unexpected assets, and the `latest-*.json` and
   beta manifests for signatures that do not match the expected release.
2. Generate a new key pair (`npx tauri signer generate -w ~/.tauri/rosi.key`,
   see [build-setup.md](../build-setup.md)).
3. Plan for the single-key limitation above. Decide whether installs that may
   have accepted an attacker's update need a notice with a manual reinstall.
4. Put the new public key in `plugins.updater.pubkey`, build, sign, and publish a
   corrective release. Its notes must name the affected versions.
5. Replace the key in the password manager. Destroy the old private key copies
   once the new release is public.

### GPG key (`GPG_KEY_ID`, `GPG_PASSPHRASE`, the secret key file)

1. Revoke the key. Use the revocation certificate stored offline. If none was
   stored, generate one from the secret key while it is still available
   (`gpg --gen-revoke <key id>`), then import and publish it.
2. Publish the revocation certificate and the replacement public key at the
   public key URL above. The release notes and the CHANGELOG "Release Info"
   section carry that URL. The README does not link it today, so add a link
   there when the key changes.
3. Create a new key and passphrase, and set `GPG_KEY_ID` and `GPG_PASSPHRASE`.
4. Re-sign the current release assets with the new key, or state in the release
   notes that `.asc` files from before the revocation came from a revoked key.
5. Update the password manager entry and destroy the old key files on every VM.

### Azure Artifact Signing (`AZURE_CLIENT_SECRET` and related values)

1. Delete the leaked client secret on the Azure app registration used by ROSI,
   and create a new one for `AZURE_CLIENT_SECRET`.
2. If the principal itself may be misused, remove its signing role on the
   Artifact Signing account and grant it again only after review.
3. Review sign-in and signing activity in the Azure audit logs for the exposure
   window. Any signature on a file that is not a ROSI release asset is an
   incident: compare every signed Windows file against the release checksums.
4. If the signing profile was used for unknown artifacts, raise it with Azure
   support.
5. Existing Authenticode signatures on published files stay valid. Confirm that
   each published file matches its checksum.

### Apple app-specific password (`APPLE_PASSWORD`)

1. Revoke the app-specific password on the Apple ID account security page and
   create a new one for `APPLE_PASSWORD`.
2. Review the notarization history for the Apple ID for submissions you did not
   make (`xcrun notarytool history` with the account's credentials).
3. If the Developer ID Application private key may have left the keychain,
   revoke that certificate in the Apple Developer portal and create a new one.
   Check Apple's current guidance before revoking, because revocation affects
   builds signed with that certificate. Update `APPLE_SIGNING_IDENTITY` to match
   the new certificate.
4. Publish a new notarized build for affected users.

### SSH user password (`SSH_USER_PWD`)

`SSH_USER_PWD` is the macOS login keychain password on the release VM. It is not
an SSH key or a password for a remote host.

1. Change the macOS account password on the release VM, then change the login
   keychain password to match.
2. Update `SSH_USER_PWD`, or remove it from `.env` and enter the keychain
   password for each session.
3. If the keychain may have been unlocked by someone else, treat the Apple
   section above as well.

### FFmpeg download server (`FFMPEG_DL_SERVER`)

1. Rotate any server credentials, and change the URL if the host is in doubt.
2. Check `git log -- resources/ffmpeg/checksums.json`. If the committed checksums
   changed after the exposure window, review those commits before trusting the
   binaries.
3. Rebuild FFmpeg from a known-good source, or compare against a known-good
   build, and run `npm run ffmpeg:check` to confirm the committed checksums.
4. Do not release until the binaries match the reviewed checksums.

### GitHub CLI credentials (not in `.env`)

Run `gh auth logout` on each release VM, revoke the token in the GitHub account
security settings, and run `gh auth login` again with a new token.

## Related

- [RELEASE-STABLE.md](RELEASE-STABLE.md) describes where these secrets are used
  in the stable release gates.
- [ROADMAP-5.1.md](ROADMAP-5.1.md) tracks dual-key updater support and other
  deferred work.
