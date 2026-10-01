#!/usr/bin/env node
/**
 * Fail a Linux release when a shipped ELF needs a newer glibc than the
 * documented floor (Ubuntu 24.04 = glibc 2.39). Building on a newer distro
 * silently raises the requirement, and older systems then refuse to start ROSI
 * ("version `GLIBC_2.xx' not found").
 *
 * Usage: node scripts/check-linux-glibc.js --target <triple> [--max 2.39]
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_MAX = "2.39";
const SIDECARS = ["rosi-yt-dlp", "rosi-ffmpeg", "rosi-ffprobe"];

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Highest GLIBC_x.y version an ELF references, or null for none (static). */
export function maxGlibcVersion(readelfOutput) {
  const versions = [
    ...readelfOutput.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/g),
  ].map((match) => match[1]);
  return versions.sort(compareVersions).at(-1) ?? null;
}

function requiredGlibc(file) {
  const result = spawnSync("readelf", ["--version-info", "--wide", file], {
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(
      `readelf is required (install binutils): ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`readelf failed for ${file}: ${result.stderr.trim()}`);
  }
  return maxGlibcVersion(result.stdout);
}

function main() {
  if (process.platform !== "linux") {
    console.log("[check-linux-glibc] Not a Linux host; skipping.");
    return;
  }
  const target = argValue("--target");
  const max = argValue("--max") ?? DEFAULT_MAX;
  if (!target || !/^\d+(?:\.\d+)+$/.test(max)) {
    console.error(
      "Usage: node scripts/check-linux-glibc.js --target <triple> [--max 2.39]",
    );
    process.exit(2);
  }
  const root = process.cwd();
  const files = [
    path.join(root, "src-tauri", "target", target, "release", "rosi"),
    ...SIDECARS.map((name) =>
      path.join(root, "src-tauri", "binaries", `${name}-${target}`),
    ),
  ];
  const failures = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      failures.push(`${path.relative(root, file)} is missing`);
      continue;
    }
    const needed = requiredGlibc(file);
    const label = needed ? `GLIBC_${needed}` : "no glibc symbols";
    console.log(`[check-linux-glibc] ${path.relative(root, file)}: ${label}`);
    if (needed && compareVersions(needed, max) > 0) {
      failures.push(
        `${path.relative(root, file)} needs GLIBC_${needed} (> ${max}); build on the documented release distro`,
      );
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exit(1);
  }
  console.log(`[check-linux-glibc] All binaries run on glibc ${max}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
