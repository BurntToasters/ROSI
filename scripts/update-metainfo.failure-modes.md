# AppStream release date failure modes

Written before the code (AGENTS.md). Covers `scripts/update-metainfo.js`, which
`npm run sync-version` runs on every build (`tauri:dev`, `tauri:build`, every
`build:*`, `npm run u`, `workspace:bootstrap`).

Rule since 5.1.0-beta.1: a build never changes the date of a release entry that
already exists. The date is written once, when the entry for a new
`package.json` version is added, and changed only on request with `--redate`
(release preparation, committed with the release). Before this rule every build
re-dated the current entry to today (UTC), so a release machine running on a
later day than the release commit left `run.rosie.rosi.metainfo.xml` modified
and `test:all` refused the quality-gate proof.

1. The current version's entry exists, with any date. Expected: a plain run
   writes nothing and reports up to date, on any day. This is the build path.
2. `--redate` and the entry has an older date. Expected: only that entry's
   `date` value changes to today (UTC); every other byte and every other
   release entry stays the same.
3. `--redate` and the entry carries other attributes (`type`, `urgency`), puts
   `date` before `version`, or has child elements (`<description>`). Expected:
   only the `date` value changes; the attributes, their order and the children
   stay.
4. Another entry's version starts with the current one (`5.0.2` and `5.0.20`,
   or `5.0.2` and `5.0.2-beta.1`). Expected: only the exact version is ever
   touched.
5. The entry has no `date`. Expected: today's date is added, since an entry
   without a date is invalid AppStream.
6. A stable version with stale prereleases of the same base version. Expected:
   one write that removes the prereleases; the stable entry's date changes only
   with `--redate`.
7. `--check`. Expected: never writes, and a date that differs from today is not
   an error.
8. A release machine runs on a later UTC day than the release commit. Expected:
   the build leaves the file unchanged, so `test:all` can record its proof.
9. A new version is not listed yet. Expected: an entry with today's date is
   added at the top, and older entries keep their dates, so a version bump
   never re-dates shipped releases.
