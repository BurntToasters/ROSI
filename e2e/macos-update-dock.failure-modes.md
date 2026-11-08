# macOS update keeps the Dock item: failure modes

Bug (5.1.0-beta.1): after an in-app update and restart, the Dock shows two
ROSI icons. The pinned one is the old app; the second is the relaunched one.
Quitting the second and clicking the pinned one opens the installed app.

Cause: the vendored updater moved the whole installed `ROSI.app` directory to a
sibling backup, moved the new bundle into its place, then deleted the backup.
The running app's Dock tile follows its bundle by file id (inode), not by
path, so the pinned tile followed the old directory into the backup. The
backup was then deleted, and the relaunched app at the original path got a
tile of its own. Zinnia had the same bug and fixed it the same
way (Zinnia commit f9d0c75).

Fix: the outer `ROSI.app` directory stays where it is. Only its `Contents`
directory is swapped. The backup is a sibling directory that holds the old
`Contents`, so it still passes the same bundle identity checks.

Written before the change:

| #   | Failure mode                                                                         | Required behavior                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The update replaces the outer `.app` directory, so the Dock tile follows the old one | The outer directory keeps its inode through a successful update, and a file reference URL made before the update resolves to the installed path afterward, not to the backup.                            |
| 2   | The staged bundle has no `Contents`, or the wrong identity                           | Install fails before anything in the installed app changes (existing staged checks run first).                                                                                                           |
| 3   | Moving the new `Contents` in fails partway (cross-volume copy error)                 | The partial new `Contents` is removed and the old `Contents` is moved back. The outer inode is unchanged and the backup directory is gone.                                                               |
| 4   | The rollback in row 3 also fails                                                     | The backup directory with the old `Contents` is kept for the next recovery pass, and the error says so.                                                                                                  |
| 5   | A backup from an earlier interrupted update exists and the installed app is complete | The validated backup is retired first (existing recovery), then the update proceeds.                                                                                                                     |
| 6   | The installed app is incomplete and a complete backup exists (interrupted update)    | Recovery moves the backup's `Contents` into the installed directory instead of renaming the backup over it, so the outer inode survives recovery too. A 5.0.x whole-bundle backup recovers the same way. |
| 7   | The installed path is missing, a file, or a symlink, and a complete backup exists    | Recovery replaces it with a real directory and moves the backup's `Contents` into it.                                                                                                                    |
| 8   | `/Applications` is not user-writable, so the AppleScript admin path runs             | The admin script swaps `Contents` the same way, keeps every identity check, quotes every path, and restores the old `Contents` on failure without nesting it inside a partial `Contents`.                |
| 9   | The staging directory is left behind next to the app                                 | After a successful install the empty staging directory is removed (it was kept on purpose before, because it had become the live app).                                                                   |
| 10  | LaunchServices keeps the old version's metadata                                      | The installed directory is still touched after the swap, as before.                                                                                                                                      |

Proof:

- `macos_update_keeps_dock_identity` in
  `src-tauri/vendor/tauri-plugin-updater/src/updater.rs` runs the real
  `install_inner` against a fixture install in a temporary directory. Before
  the update it makes a Foundation file reference URL (by file id, through
  `osascript -l JavaScript`) for the installed app, then checks rows 1, 9 and 10. A control first runs the old whole-bundle rename and requires the same
  probe to resolve to the backup, so the probe can see the bug. A path
  bookmark is not used as proof: it resolves by path while the path exists,
  so it passes with the old code too. Rows 2 to 7 run the same transaction
  with bad input or injected failures. Row 8 runs the real AppleScript handler
  without the administrator clause: once normally, once with the `Contents`
  move replaced by `/usr/bin/false`, and once recovering from a backup.
- These tests run in the gate's `vendorUpdater` step on macOS. With
  `ROSI_MACOS_DOCK_REPORT=<path>` set, `macos_update_keeps_dock_identity` writes its
  measurements to that file. `npm run test:e2e:macos-update-dock` runs it and
  writes `e2e/artifacts/macos-update-dock-report.json`.
- Manual (needs a signed build and a real Dock): pin ROSI, update from the
  previous beta in the app, restart, and confirm that one ROSI icon is in the
  Dock. Do it once with a user-writable `/Applications/ROSI.app` and once with
  an admin-owned one.
