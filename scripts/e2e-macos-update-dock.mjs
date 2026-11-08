#!/usr/bin/env node
// Runs the vendored updater's macOS Dock identity tests and keeps their report
// as e2e/artifacts/macos-update-dock-report.json. Failure modes:
// e2e/macos-update-dock.failure-modes.md. Requires macOS.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(
  root,
  "e2e",
  "artifacts",
  "macos-update-dock-report.json",
);

if (process.platform !== "darwin") {
  console.error("e2e-macos-update-dock: FAILED: needs macOS");
  process.exit(1);
}
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.rmSync(reportPath, { force: true });
const result = spawnSync(
  "cargo",
  [
    "test",
    "--locked",
    "--manifest-path",
    "src-tauri/vendor/tauri-plugin-updater/Cargo.toml",
    "--lib",
    "macos_",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ROSI_MACOS_DOCK_REPORT: reportPath },
  },
);
if (result.status !== 0) {
  console.error("e2e-macos-update-dock: FAILED: cargo test failed");
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const swap = report.contentsSwap;
if (
  report.ok !== true ||
  swap.outerInodeBefore !== swap.outerInodeAfter ||
  swap.fileIdResolvesToInstalledApp !== true ||
  swap.leftoversNextToApp.length !== 0
) {
  console.error("e2e-macos-update-dock: FAILED: report does not prove the fix");
  process.exit(1);
}
console.log(
  `macOS update keeps the Dock identity: ${path.relative(root, reportPath)}`,
);
