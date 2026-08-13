# GitHub Copilot Instructions

Spec version: 1.0.0

- (This is an identifier for the user maintaining these specialized instructions)

## Commit messages

When generating Git commit messages, follow these rules.

Use this format:

`<Category>: <Description>.`

For new features:

`NEW - <Feature>: <Description>.`

Keep commit messages brief and informative.

- Prefer one concise summary line.
- Target 60 characters or fewer and avoid exceeding 72 characters.
- Use imperative, present-tense wording such as `Add`, `Fix`, `Update`, `Remove`, or `Refactor`.
- Use sentence casing.
- End the summary with a period.
- Describe the logical change rather than listing changed files.
- Do not use emojis.
- Do not use Unicode em dashes.
- Do not add issue or PR numbers unless they are relevant to the change.
- Do not invent details that cannot be inferred from the changes.
- Do not add `Co-authored-by`, `Signed-off-by`, or other git trailers.
- In GitHub Desktop, leave the description field empty unless the summary cannot capture the change.

Use these BCLS-derived categories when applicable:

- `PKG` - dependencies and packages.
- `Electron` - Electron changes.
- `Tauri` - Tauri changes.
- `TypeScript` - TypeScript changes.
- `Codebase` - refactoring, cleanup, scripts, or internal changes.
- `Testing` - tests and test infrastructure.
- `UI` - user interface or interaction changes.
- `Logo` - branding, logos, or icons.
- `Updater` - update-system changes.
- `Security` - security fixes or hardening.
- `Licenses` - licensing or attribution changes.
- `Ver` - version-only changes.
- `macOS` - macOS-specific changes.
- `Windows` - Windows-specific changes.
- `Linux` - Linux-specific changes.
- `Misc` - only when no more specific category fits.
- `NEW - <Feature>` - a genuinely new capability.

Examples:

`UI: Improve settings navigation.`

`Security: Validate updater signatures.`

`PKG: Update packages.`

`Codebase: Remove obsolete migration logic.`

`NEW - Search: Add fuzzy result matching.`
