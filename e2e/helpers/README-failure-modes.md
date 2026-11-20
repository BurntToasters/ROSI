# Shared E2E helper failure modes

Written before `ui.js` and `host.js`. Each entry lists how the per-spec copies
can pass falsely or hang, and what the shared helper does about it. Counts are
the files that defined a local copy when the helpers were created.

## host.js (Node side)

### processesMatching (4 copies)

- The process listing command can fail to start (`ENOENT`), time out, or exit
  nonzero. The copies read `.stdout` of the failed result, get `undefined`, fall
  back to `""`, and return `[]`. "No process left" then passes without any
  check. The helper asserts no spawn error, exit status 0, and non-empty output.
- A listing that succeeds but has the wrong shape (an error banner, a locale
  change, a truncated pipe) also returns `[]`. The helper prefixes each line
  with a pid and requires the line for the test's own pid. A listing that
  cannot see its own process is rejected.
- Windows `Get-CimInstance` prints blank lines for processes with no command
  line, so "non-empty output" alone is weak. The own-pid line closes that gap.
- The copies match the needle against the lister's own command line. The
  `queue-coordinator` copy drops any line containing "powershell", which also
  hides a real process whose arguments mention it. The helper drops only the
  lister itself (by its marker text) and the test's own pid.
- Windows output encoding: non-ASCII needles can fail to match a line decoded
  with the OEM code page. The helper forces UTF-8 output.
- A hung lister blocks the whole spec. The helper sets a spawn timeout, and a
  timeout is an error, not an empty list.
- The `waitForNoProcess` copies poll `processesMatching`, so a failed listing
  counted as "no process" and ended the wait with success. The helper version
  reuses the strict `processesMatching`, so a failing lister ends the wait
  with the listing error.

### sha256File (3 copies)

- A missing or unreadable file throws a bare `ENOENT`. The helper keeps the
  throw (never returns an empty digest) and names the path in the message.
- Hashing an empty file gives the well-known empty digest, which can equal an
  expected digest of a truncated output. The helper does not special-case it;
  callers that compare against fixture digests already fail on a mismatch.
  Documented here so nobody adds a default digest.

### record (about 15 copies, several shapes)

- Copies differ in whether they write a file, which file name, whether they
  add `status: "passed"`, and whether `invariantPassed === false` marks a
  failure. A spec that records a failed invariant but only checks the results
  file can pass with a failure inside it. `createRecorder` keeps a `failures`
  list of names whose details carry `invariantPassed: false`, so the spec can
  assert it is empty in its `after` hook.
- A copy that writes only at the end loses evidence when the spec crashes. With
  `filePath`, the helper rewrites the whole file after each record.
- A record with no name makes the evidence unmatched. The helper throws on an
  empty or non-string name.

## ui.js (renderer side)

### api (2 copies, identical)

- `app-bridge.js` already owns it. `ui.js` re-exports it so there is one
  implementation. A failed bridge call throws with the method name, so it does
  not return `undefined` silently.

### waitFor (about 14 copies)

- Copies have no required message, so a timeout reports only "waitUntil
  condition timed out". The helper throws a `TypeError` when the message is
  missing or empty.
- A predicate that throws inside the page (missing element) fails the wait on
  the first poll. That is kept: it is a loud failure, not a silent one.
- The timeout is always finite (default 10 s). A zero, negative, or non-finite
  timeout is rejected, since it could mean an unbounded wait.

### clickById (9 copies, 2 behaviors)

- `main.spec.js` and `deno-installer.spec.js` use `getElementById(id)?.click()`.
  A missing element does nothing, the following wait either passes on stale
  state or times out far from the cause. The strict `app-bridge.js` version
  throws `missing element <id>` and is the shared one.
- A disabled button ignores `click()` silently. The helper does not hide this;
  specs that need an enabled button wait for it first. It is listed so a later
  change does not add a `force` option.

### waitForModal and clickModalButton (10 and 16 copies)

- Copies wait for either `open` (boolean) or a title. Some match the title with
  `includes`, some exactly, one also requires the modal is not hiding. A title
  wait with `includes` can match an older modal that shares a prefix. The
  helper matches exactly by default and requires the modal not to be hiding;
  `match: "includes"` is opt-in.
- While the modal hides, `active` is still set and `hiding` is added; `active` is
  removed after the animation. A wait for "open" that reads only `active` can
  match a modal that is going away. The helper requires `active` and not
  `hiding` for open, and no `active` for closed.
- `clickModalButton` copies that do `button?.click()` and return nothing pass
  when the label is wrong. The helper throws and lists the buttons it saw.
- Labels compare after `trim()`. A copy that compares untrimmed text fails on
  padded labels, never passes falsely; the helper trims.

### setControl (9 copies, 4 behaviors)

- Copies without the missing-control check throw a `TypeError` from the page,
  which hides the control id. The helper names the id.
- Copies assign `control.checked = next` without coercion, so a string such as
  `"false"` checks the box. The helper requires a boolean for checkboxes.
- Copies assign `control.value = next` for `undefined` or `null`, which sets the
  text `"undefined"` or clears a select. The helper rejects `undefined` and
  `null` values.
- Most copies fire only `change`; `markup.spec.js` also fires `input`. The
  helper fires `change`, and `input: true` adds an `input` event first.
- A select with no option equal to the value ends up with an empty value and the
  copies move on. The helper checks the value stuck for selects and throws
  otherwise.

### waitForBackendSetting (5 copies)

- Copies compare with `===`, so an object or array value never matches and the
  wait times out with the caller's message. The helper compares with a JSON
  deep equal for non-primitive values.
- `getSettings` returning an error envelope reads as "key is undefined" and
  keeps polling until the timeout. That fails (not passes), but the message
  hides the cause; the helper surfaces the last observed value in the timeout
  message.
- Timeouts differ (10 s, 15 s). The helper takes a `timeout` option.

### reloadRenderer (10 copies)

- A copy that reloads and then checks `ready` can read the flag from the page
  that is about to unload, and pass before the reload. The helper sets `ready`
  to false first and waits for it to turn true on the new page.
- A copy that omits the deferred `setTimeout` loses the WebDriver reply on
  WebView2 and hangs. The helper defers the reload.
- The wait has a 60 s timeout and a message.

### stubBridge (4 copies, 4 registries)

- Each copy stores originals and calls on its own `window.__x` registry, so a
  stub installed by one helper is invisible to another's restore. The helper
  uses one registry shared with `main.spec.js` (`window.__rosiStubs`).
- Re-stubbing a name must keep the first original. A copy that overwrote the
  original with the previous stub would "restore" a stub. The helper keeps the
  first original.
- A stub that is never restored leaks into the next scenario and can make it
  pass against a fake. `restoreBridge` returns the recorded calls and clears
  the registry; callers restore in `finally`.
- Held calls that are never released hang the renderer. `releaseHeldStubs`
  resolves every held call, and `restoreBridge` releases them too.
- Stubbing a method that does not exist on the bridge would create it, so a
  typo passes. The helper throws when the method is missing.

### activityFor (10 copies, 3 behaviors)

- Copies read `.data` without checking `ok`. A failed `getDownloadActivity`
  gives `undefined.filter` or, worse, an empty list that looks like "no
  activity". The helper asserts the envelope is `ok` with an array `data`.
- An empty `url` filters nothing and returns every entry. The helper rejects a
  non-string or empty url.
