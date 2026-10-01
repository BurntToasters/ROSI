#!/usr/bin/env node
/**
 * Fail if tracked text files contain U+2014 EM DASH.
 * ROSI uses ASCII punctuation only (hyphen, comma, colon) for portability
 * (PowerShell, tooling, and editors on all platforms).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EM_DASH = "\u2014";

const SKIP_SUFFIXES = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".icns",
  ".exe",
  ".dll",
  ".dylib",
  ".so",
  ".app",
  ".dmg",
  ".zip",
  ".7z",
  ".gz",
  ".tar",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pdf",
  ".lock",
]);

function listTrackedFiles() {
  const raw = execFileSync("git", ["ls-files", "-z"], { cwd: root });
  const files = [];
  for (const entry of raw.toString("utf8").split("\0")) {
    if (!entry) continue;
    const ext = path.extname(entry).toLowerCase();
    if (SKIP_SUFFIXES.has(ext)) continue;
    files.push(entry);
  }
  return files;
}

const hits = [];
for (const rel of listTrackedFiles()) {
  const abs = path.join(root, rel);
  let text;
  try {
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) continue;
    text = buf.toString("utf8");
  } catch {
    continue;
  }
  if (!text.includes(EM_DASH)) continue;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(EM_DASH)) {
      hits.push(`${rel}:${i + 1}`);
    }
  }
}

if (hits.length) {
  console.error(
    "no-em-dash: EM DASH (U+2014) is not allowed in tracked files. Use ASCII `-`, `,`, or `:` instead.",
  );
  for (const hit of hits) {
    console.error(`  ${hit}`);
  }
  process.exit(1);
}

console.log("no-em-dash: ok");
