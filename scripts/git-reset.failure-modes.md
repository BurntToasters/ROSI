# `npm run git:reset` failure modes

Written before the script (AGENTS.md). The script re-syncs a clone after the
remote history was rewritten (see docs/HISTORY-PRUNE.md), then frees space.
Checked by `scripts/git-reset.test.mjs` against throwaway repositories.

1. Uncommitted changes to tracked files are lost by `reset --hard`.
   Expected: refuse before touching anything unless `--force`.
2. Untracked files (such as the downloaded yt-dlp binaries) are deleted.
   Expected: never deleted; only tracked files are reset.
3. A branch has real local commits that are not upstream, and the reset drops
   them. Expected: refuse that branch unless `--force`; with `--force`, keep a
   `backup/git-reset-<branch>-<time>` branch first and report it.
4. Rewritten history makes every old local commit look unpushed, so the script
   refuses a clean clone. Patch comparison (`git cherry`) is not enough: the
   prune changed the patches of commits that added binaries. Expected: a local
   commit counts as upstream when an upstream commit has the same author email,
   author time, committer time and full message, which history rewrites keep.
   A genuinely new local commit never matches and is protected (mode 3).
5. Detached HEAD, a branch without an upstream, or an upstream that no longer
   exists on the remote. Expected: the current branch fails with a clear
   message; other branches are skipped and reported.
6. Another local branch keeps the old history reachable, so no space is freed.
   Expected: every local branch that tracks the remote is moved under the same
   safety rules.
7. Garbage collection runs after a refusal and discards the only copy of local
   work kept in reflogs. Expected: reflog expiry and gc run only when every
   branch synced without refusal.
8. The fetch fails (offline, no access). Expected: stop before any reset.
9. `--dry-run` changes something. Expected: it only reports.
10. Tags moved by the rewrite stay at their old commits locally. Expected:
    tags are fetched with `--force`.
