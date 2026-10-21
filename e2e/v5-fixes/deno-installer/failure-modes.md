# Deno installer failure modes

Written before the fix. Each item names how the automatic Deno install can
fail and what ROSI must do instead.

1. **Package manager missing (macOS).** Homebrew is not part of macOS. A bare
   `brew` spawn on a Mac without it fails with
   `No such file or directory (os error 2)`, after ROSI already asked to
   install "through your system package manager". ROSI must look for `brew`
   by absolute path before it shows the confirm dialog. When none is found it
   must return a failure that names Homebrew and points at the official
   instructions, without showing the dialog or spawning anything.
2. **Package manager missing (Windows).** winget is absent on Windows 10 LTSC,
   Server, and fresh accounts before App Installer registers, and is hidden
   when `%LOCALAPPDATA%\Microsoft\WindowsApps` is not on PATH. A bare
   `winget.exe` spawn fails with `program not found`. Same rule as item 1,
   naming winget.
3. **winget app execution alias.** `winget.exe` in WindowsApps is a zero-byte
   reparse point. A metadata check that follows the reparse point can fail
   even though the alias launches. Detection must not follow it.
4. **Homebrew symlink.** `/opt/homebrew/bin/brew` is a symlink into the
   Homebrew checkout. Detection must follow it and accept a regular file
   target.
5. **msstore source failure.** Without `--source winget`, winget also queries
   the msstore source, which fails on offline or locked-down networks even
   when the winget source works. The install must use the winget source only.
6. **Misleading dialog.** The confirm dialog must name the tool it will run
   (Homebrew or winget), not a generic "system package manager".
7. **Dead-end failure modal.** After any install failure, the reminder modal
   and the setup wizard must offer the official installation instructions
   (`https://docs.deno.com/runtime/getting_started/installation/`), not the
   Deno home page, and must still show the error text.
8. **Linux.** No automatic install exists. The backend must keep returning the
   instructions error, and the UI must keep offering only the instructions.
9. **Native dialog blocks automation.** The missing-package-manager path must
   return before any native dialog, so a WebDriver run can drive it end to
   end against the real backend.
