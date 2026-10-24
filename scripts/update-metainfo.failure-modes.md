# AppStream date refresh failure modes

Written before the code (AGENTS.md). Covers the date refresh in
`scripts/update-metainfo.js`: when `package.json` still has the version of an
existing `<release>` entry, the entry's date is set to today (UTC). `npm run
sync-version` runs the script, so `tauri:dev`, `tauri:build`, `npm run u` and
`workspace:bootstrap` all refresh the date.

1. The entry already has today's date. Rewriting the file anyway changes
   nothing but can still touch it. Expected: no write, reports up to date.
2. The entry has an older date. Expected: only that entry's `date` value
   changes; every other byte and every other release entry stays the same.
3. The entry carries other attributes (`type`, `urgency`), puts `date` before
   `version`, or has child elements (`<description>`). Expected: only the
   `date` value changes; the attributes, their order and the children stay.
4. Another entry's version starts with the current one (`5.0.2` and `5.0.20`,
   or `5.0.2` and `5.0.2-beta.1`). Expected: only the exact version is
   re-dated.
5. The entry has no `date`. Expected: today's date is added, as before.
6. A stable version with stale prereleases of the same base version and a
   stale date. Expected: one write that removes the prereleases and refreshes
   the date.
7. `--check`. Expected: never writes. A date that differs from today is not an
   error, otherwise the check fails every day after the release commit.
8. A release VM runs on a later UTC day than the release commit. The refresh
   dirties the tree and `test:all` refuses the proof. Accepted: release VMs
   must run on the same UTC day as the commit, or the entry must be
   recommitted with that day's date.
9. Only the entry for the current `package.json` version is refreshed. Older
   entries keep their dates, so a later version bump never re-dates shipped
   releases.
