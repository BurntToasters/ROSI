# WebView2 lockout workaround: failure modes

Recorded before the code change (AGENTS.md). Each row is a way the arg merge
(`mergeWebView2BrowserArgs` in `e2e/helpers/profile.js`) or the temporary
feature entry could go wrong, and the guard for it.

Background: upstream WebView2/Chromium behavior (MicrosoftEdge/WebView2Feedback
#5722, Chromium #562403601). Creating a fresh WebView2 environment can log a
Windows Event 4625 failed logon, which increments the account bad-password
counter. E2E creates a fresh WebView2 profile per pass, so repeated runs can
lock the account. The temporary workaround disables the Chromium features
`AutofillAiWalletPrivatePasses` and `AutofillAmbientAutofill`. This is upstream
behavior; ROSI does not try passwords.

Mechanism (Chromium source, checked 2026-10-17):
`password_manager_util_win.cc` `CheckBlankPasswordWithPrefs()` calls
`LogonUser()` with a blank password to learn whether the OS password is blank.
It skips the call only when Local State already holds
`password_manager.os_password_last_changed` and the password has not changed
since. A fresh WebView2 user data folder has no Local State, so every fresh
profile runs it. Since crrev.com/c/7715959 (first in 148.0.7769.0) the
`ChromeAutofillClient` constructor reaches it through `SupportsDeviceReauth()`
when `AutofillAiWalletPrivatePasses` or (since crrev.com/c/8363705, merged to
M154) `AutofillAmbientAutofill` is enabled, which is why both are disabled.
A persistent profile hits it once per install or password change, so normal
app use is far less exposed than E2E.

| # | Failure mode | Guard |
|---|---|---|
| 1 | Existing switches dropped (e.g. `--remote-debugging-port`, a developer's `--disable-gpu`) | Every non-feature switch is kept once, in first-seen order |
| 2 | Two `--disable-features` switches emitted; Chromium honors only one and the other is silently ignored | All disable-features values collapse into one switch |
| 3 | Two `--enable-features` switches emitted | Same collapse for enable-features |
| 4 | Developer's externally supplied `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` overwritten by the E2E string | Developer value is an input to the merge, never replaced |
| 5 | `undefined`, empty, or whitespace-only input yields the text "undefined", empty tokens, or stray spaces | Falsy inputs skipped; split on whitespace and filter empty tokens |
| 6 | Duplicate feature names (e.g. `RendererCodeIntegrity` twice) | Deduped per feature, first-seen order |
| 7 | Feature value containing `=` (e.g. `--disable-features=Foo=bar`) mis-split | Only the `--disable-features=` prefix is stripped; the rest of the token is kept verbatim |
| 8 | Empty items in comma lists (`A, ,B`) produce blank feature names | Each item trimmed; empty items dropped |
| 9 | Merge or temp entry leaks into non-Windows environments | Merge called only inside the `win32` branch; other branches untouched |
| 10 | Removing the temp entry does not restore the exact original string (leftover comma or space) | `E2E_WEBVIEW2_BROWSER_ARGS` is built with `join(",")`; removal is checked to yield the original literal |
| 11 | Known limitation: a quoted value containing spaces in developer input is split into separate tokens | Not supported; developer args for this variable must not rely on quoting |

## Probe

`e2e/webview2-lockout-probe.mjs` launches the E2E binary on fresh profiles and
compares the account's bad-password counter (`BadPasswordAttempts`, readable
without elevation) before and after each launch. The 4625 event is a weaker
signal: reading it needs elevation and Windows writes it only when logon
failure auditing is on. The counter is what locks the account.

| # | Failure mode | Guard |
|---|---|---|
| P1 | A successful sign-in during the run resets the counter, hiding a failure | `LastLogin` is read with the counter; a launch where it changed is marked invalid |
| P2 | The lockout observation window resets the counter before the second read | The counter is read right after each launch; one launch takes well under a minute |
| P3 | The app never creates WebView2, so a 0 delta proves nothing | The probe waits for an `msedgewebview2.exe` whose command line names the profile's folder; none means invalid |
| P4 | The args never reach the browser process, so "with" proves nothing; or WebView2 adds its own `--disable-features` after ours and Chromium honors only the last one | Every `--disable-features` switch on the browser command line is recorded; the expected features are checked against the last one |
| P5 | Probing pushes the counter toward lockout | Refuses when the threshold is unreadable or when count + planned "without" launches would come within 3 of it; "without" allows 1 launch, "with" at most 3; a "with" launch that raises the counter stops the run |
| P6 | Run on macOS or Linux, where the variable means nothing | Exits unless `win32` |
| P7 | App or WebView2 processes left running | Kills only its own child's process tree, then waits for the profile's WebView2 processes to exit |
| P8 | Temp profiles left behind | Each profile directory is removed after its launch, also on failure |
| P9 | Kills a ROSI the developer is using | Only the spawned PID's tree is killed; refuses to start when another `rosi.exe` from the E2E binary path is running |
| P10 | Missing or stale binary | Never builds; refuses when the E2E binary is missing |
| P11 | The app exits before WebView2 starts and the cause is lost | The launch is invalid and the tail of the app's stderr goes into the artifact |

## Removal

Upstream status on 2026-10-17: not fixed. WebView2Feedback #5722 is open, and
no Chromium change removing the blank-password `LogonUser()` call has merged.
crrev.com/c/8504537 (work in progress) only moves the check off the UI thread
and lists the 4625 as an open follow-up.

Measured on 2026-10-17 with WebView2 155.0.4283.60 (local account, lockout
threshold 10): one fresh-profile launch without the flags raised the counter
by 1; three launches with them, plus a `main.spec.js` E2E pass, raised it by 0.

Remove the temporary workaround only after all of these hold:

1. A merged Chromium change removes or replaces the blank-password
   `LogonUser()` call, or stops it from running on a fresh Local State. Track
   #5722, Chromium #562403601 and #541310282, and Gerrit changes touching
   `password_manager_util_win.cc`.
2. That change's first release is known (chromiumdash `fetch_commit`), and the
   WebView2 Stable runtime installed on dev and test machines is at or past it
   (registry value `pv` under
   `EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`).
3. `node e2e/webview2-lockout-probe.mjs --mode without --launches 1`, run three
   separate times, never raises the counter.
4. A small E2E subset passes without the flags.
5. A normal full E2E run passes.

Cleanup deletes only `TEMP_WEBVIEW2_LOCKOUT_FEATURES` (the temporary entries)
and its `TEMP_WEBVIEW2_LOCKOUT_WORKAROUND` comment, the probe script, and this
file's Probe section. `mergeWebView2BrowserArgs` stays; it is still the single
place that merges WebView2 switches.
