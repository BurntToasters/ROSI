import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function canonicalPath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * True when `moduleUrl` is the script Node was started with. Both sides are
 * compared as real paths: `import.meta.url` is already resolved through
 * symlinks, so a plain `path.resolve(argv[1])` comparison silently skipped
 * `main()` (and exited 0) when a script was run through a symlinked path such
 * as macOS `/var` -> `/private/var`.
 */
export function isDirectExecutionOf(
  moduleUrl,
  executablePath = process.argv[1],
) {
  if (!executablePath) return false;
  return (
    canonicalPath(path.resolve(executablePath)) ===
    canonicalPath(fileURLToPath(moduleUrl))
  );
}
