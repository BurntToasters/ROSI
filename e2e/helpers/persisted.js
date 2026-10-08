import fs from "node:fs";

/**
 * Items of a persisted list file (download queue or activity). Current files
 * are `{ "schemaVersion": n, "items": [...] }`; legacy files are bare arrays.
 * Throws when the file is missing, not JSON, or has neither shape.
 */
export function readListFile(filePath) {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  throw new Error(`${filePath} is neither a bare array nor a versioned list`);
}
