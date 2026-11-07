// E2E binary build, reuse, and generated-schema restore.

import fs from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  e2eBinaryPath,
  e2eStampPath,
} from "../../e2e/helpers/profile.js";
import { npmCommand, npxCommand, run } from "./common.js";

const STAMP = "e2e-feature-1\n";

export function e2eBinaryIsFresh() {
  const binary = e2eBinaryPath();
  const stamp = e2eStampPath();
  if (!fs.existsSync(binary) || !fs.existsSync(stamp)) return false;
  if (fs.readFileSync(stamp, "utf8") !== STAMP) return false;
  // cargo test / clippy rebuild target/debug/rosi without --features e2e.
  return fs.statSync(stamp).mtimeMs >= fs.statSync(binary).mtimeMs;
}

export function mayReuseE2eBinary({ onlySpec, reuseRequested, binaryFresh }) {
  return onlySpec === true && reuseRequested === true && binaryFresh === true;
}

function snapshotGeneratedSchemas() {
  const schemaDir = path.join(REPO_ROOT, "src-tauri", "gen", "schemas");
  if (!fs.existsSync(schemaDir)) return [];
  return fs
    .readdirSync(schemaDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(schemaDir, entry.name);
      return [file, fs.readFileSync(file)];
    });
}

function restoreGeneratedSchemas(snapshots) {
  for (const [file, contents] of snapshots) {
    fs.writeFileSync(file, contents);
  }
}

export function buildE2eBinary() {
  // Development stubs are acceptable: E2E uses a debug build and supplies a
  // real FFmpeg through the custom-path setting when one is available.
  run(npmCommand(), ["run", "prepare:rust-tests"]);
  // The licenses scenario renders these git-ignored notices; release builds
  // generate them in build:*, so a fresh checkout or CI runner has none yet.
  run(npmCommand(), ["run", "licenses"]);
  const schemaSnapshots = snapshotGeneratedSchemas();
  try {
    run(npxCommand(), [
      "tauri",
      "build",
      "--debug",
      "--no-bundle",
      "--config",
      path.join(REPO_ROOT, "src-tauri", "tauri.e2e.conf.json"),
      "--",
      "--features",
      "e2e",
    ]);
  } finally {
    // Tauri writes feature-dependent ACL schemas into this tracked directory.
    // An E2E build must not dirty a clean release checkout with test-only ACLs.
    restoreGeneratedSchemas(schemaSnapshots);
  }
  const binary = e2eBinaryPath();
  if (!fs.existsSync(binary)) {
    throw new Error(`E2E binary missing after build: ${binary}`);
  }
  fs.mkdirSync(path.dirname(e2eStampPath()), { recursive: true });
  fs.writeFileSync(e2eStampPath(), STAMP);
}
