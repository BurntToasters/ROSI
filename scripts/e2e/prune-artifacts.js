// Bounded retention for timestamped E2E run folders. A runner calls this with
// its own folder pattern before it writes a new run. It removes only the oldest
// matching directories beyond `keep`, and never anything else.

import fs from "node:fs";
import path from "node:path";

// Folders that hold gate-level evidence, never run folders.
const RESERVED_NAMES = new Set(["core", "adhoc"]);

function realpathOr(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Deletes the oldest directories in artifactsDir whose names match pattern,
 * keeping the newest `keep` (mtime order). The current run directory, any
 * symlink target, reserved folders, files, and symlinks are never removed.
 * Returns { deleted, retained, failed } with directory names; a failed removal
 * is reported and does not stop the others.
 */
export function pruneRunnerArtifacts({
  artifactsDir,
  pattern,
  keep = 20,
  currentRunDir,
} = {}) {
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("artifactsDir must be an absolute path");
  }
  if (!(pattern instanceof RegExp) || pattern.global || pattern.sticky) {
    throw new TypeError("pattern must be a RegExp without the g or y flags");
  }
  if (!Number.isInteger(keep) || keep < 0) {
    throw new TypeError("keep must be a non-negative integer");
  }
  const result = { deleted: [], retained: [], failed: [] };
  const root = path.resolve(artifactsDir);
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      result.failed.push({ name: ".", reason: error.message });
    }
    return result;
  }

  const entries = names.flatMap((name) => {
    const full = path.join(root, name);
    try {
      return [{ name, full, stat: fs.lstatSync(full) }];
    } catch {
      return [];
    }
  });
  // A symlink may point at a matching folder; that folder is protected.
  const protectedTargets = new Set();
  for (const entry of entries) {
    if (entry.stat.isSymbolicLink()) {
      const target = realpathOr(entry.full);
      if (target) protectedTargets.add(target);
    }
  }

  const current = currentRunDir
    ? (realpathOr(path.resolve(currentRunDir)) ?? path.resolve(currentRunDir))
    : null;
  const candidates = [];
  for (const entry of entries) {
    if (!entry.stat.isDirectory() || RESERVED_NAMES.has(entry.name)) continue;
    if (!pattern.test(entry.name)) continue;
    const real = realpathOr(entry.full) ?? path.resolve(entry.full);
    if (protectedTargets.has(real)) continue;
    candidates.push({
      name: entry.name,
      full: entry.full,
      mtimeMs: entry.stat.mtimeMs,
      isCurrent: current !== null && real === current,
    });
  }
  candidates.sort(
    (a, b) =>
      b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0),
  );

  const retain = new Set(candidates.slice(0, keep).map((item) => item.name));
  for (const item of candidates) {
    if (item.isCurrent) retain.add(item.name);
  }
  for (const item of candidates) {
    if (retain.has(item.name)) {
      result.retained.push(item.name);
      continue;
    }
    try {
      const stat = fs.lstatSync(item.full);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("no longer a plain directory");
      }
      fs.rmSync(item.full, { recursive: true });
      result.deleted.push(item.name);
    } catch (error) {
      result.failed.push({
        name: item.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
