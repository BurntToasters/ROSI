# Release VM guard failure modes

Written before the guard (AGENTS.md). `scripts/require-release-vm.cjs` runs
first in `b`, `r` and `release:finalize`, which run `git reset --hard` and
`git clean -fd`. On a developer machine that deletes uncommitted work.
Checked by `scripts/require-release-vm.test.mjs`, which runs the real script
as a child process with a temporary HOME.

1. A developer runs `npm run b`, `npm run r` or `npm run release:finalize`
   with no marker. Expected: exit 1 before any git command runs, with a
   message that names the script and both ways to opt in.
2. `ROSI_RELEASE_VM=1` is set. Expected: exit 0.
3. `ROSI_RELEASE_VM` is set to another value (`0`, `true`, empty). Expected:
   refused. Only `1` opts in, so a stray `0` or `false` cannot count as a
   release VM.
4. The marker file `~/.rosi-release-vm` exists. Expected: exit 0. The marker
   is read through `os.homedir()`, so HOME (POSIX) or USERPROFILE (Windows)
   selects it.
5. HOME points at a directory without the marker. Expected: refused.
6. The marker name is near-miss (`rosi-release-vm`, `.rosi-release-vm.txt`).
   Expected: refused. Only the exact name counts.
7. The marker exists as a directory rather than a file. Expected: exit 0.
   The guard only tests existence; a directory marker is a deliberate
   misconfiguration, not a bypass of anything else.
8. The guard is chained with `&&` so a refusal stops the rest of the script.
   Expected: the guard is the first command of each script in package.json,
   so the git commands never start. The test reads package.json to confirm.
9. The message is missing or unclear. Expected: stderr names the npm script
   (from `npm_lifecycle_event`, when set), says what it deletes, and gives the
   opt-in steps.
10. Refusal exit code is 0 by mistake, so `&&` continues. Expected: nonzero.
