#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REVIEW_EXPIRES = "2026-12-01";
const EXPECTED_IGNORES = new Set([
  "RUSTSEC-2024-0411",
  "RUSTSEC-2024-0412",
  "RUSTSEC-2024-0413",
  "RUSTSEC-2024-0414",
  "RUSTSEC-2024-0415",
  "RUSTSEC-2024-0416",
  "RUSTSEC-2024-0417",
  "RUSTSEC-2024-0418",
  "RUSTSEC-2024-0419",
  "RUSTSEC-2024-0420",
  "RUSTSEC-2024-0429",
  "RUSTSEC-2024-0370",
  "RUSTSEC-2025-0075",
  "RUSTSEC-2025-0080",
  "RUSTSEC-2025-0081",
  "RUSTSEC-2025-0098",
  "RUSTSEC-2025-0100",
]);

function ignoredAdvisories(text) {
  const section = text.match(
    /(?:^|\r?\n)\s*\[advisories\]\s*\r?\n([\s\S]*?)(?=\r?\n\s*\[|$)/,
  )?.[1];
  const ignoreArray = section?.match(
    /(?:^|\r?\n)\s*ignore\s*=\s*\[([\s\S]*?)\]/,
  )?.[1];
  if (!ignoreArray) return new Set();

  // Only quoted values in the actual ignore array count. IDs in comments or
  // another TOML table must not satisfy the policy.
  const uncommented = ignoreArray
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^\\])#.*/, "$1"))
    .join("\n");
  return new Set(
    [...uncommented.matchAll(/"(RUSTSEC-\d{4}-\d{4})"/g)].map(([, id]) => id),
  );
}

function evaluateIgnorePolicy(text, now = new Date()) {
  const actual = ignoredAdvisories(text);
  const errors = [];
  for (const id of actual) {
    if (!EXPECTED_IGNORES.has(id)) errors.push(`unreviewed ignore ${id}`);
  }
  for (const id of EXPECTED_IGNORES) {
    if (!actual.has(id))
      errors.push(`expected reviewed ignore ${id} is missing`);
  }
  if (
    actual.size > 0 &&
    now.getTime() >= Date.parse(`${REVIEW_EXPIRES}T00:00:00Z`)
  ) {
    errors.push(
      `RustSec transitive-debt review expired on ${REVIEW_EXPIRES}; re-check whether Tauri/wry still require these ignores`,
    );
  }
  return errors;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const configPath = path.join(root, "src-tauri", ".cargo", "audit.toml");
  const errors = evaluateIgnorePolicy(fs.readFileSync(configPath, "utf8"));
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`[rustsec-ignore-policy] FAILED: ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `[rustsec-ignore-policy] ${EXPECTED_IGNORES.size} reviewed transitive warnings; review expires ${REVIEW_EXPIRES}.`,
  );
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) main();

export {
  EXPECTED_IGNORES,
  REVIEW_EXPIRES,
  evaluateIgnorePolicy,
  ignoredAdvisories,
};
