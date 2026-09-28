import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STABLE_METADATA_PATHS = new Set([
  "CHANGELOG.md",
  "package.json",
  "package-lock.json",
  "run.rosie.rosi.metainfo.xml",
  "src-tauri/Cargo.lock",
  "src-tauri/Cargo.toml",
  "src-tauri/Info.plist",
  "src-tauri/tauri.conf.json",
]);

export function validateStableMetadataChange({
  baseVersion,
  headVersion,
  changedPaths,
}) {
  const match = String(baseVersion).match(/^(\d+\.\d+\.\d+)-beta\.(\d+)$/u);
  if (!match || headVersion !== match[1]) {
    throw new Error(
      `Stable metadata must remove only the beta suffix (${baseVersion} -> ${headVersion}).`,
    );
  }
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    throw new Error("Stable metadata pull request has no changed files.");
  }
  const unexpected = changedPaths.filter(
    (file) => !STABLE_METADATA_PATHS.has(file.replaceAll("\\", "/")),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Stable metadata pull request changed files that are not release metadata:\n${unexpected.join("\n")}`,
    );
  }
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function packageVersionAt(ref) {
  return JSON.parse(git(["show", `${ref}:package.json`])).version;
}

function main() {
  const [baseRef, headRef] = process.argv.slice(2);
  if (!baseRef || !headRef) {
    throw new Error(
      "Usage: node scripts/check-stable-metadata-pr.mjs <base-ref> <head-ref>",
    );
  }
  const changedPaths = git([
    "diff",
    "--name-only",
    "--diff-filter=ACMRTUXB",
    `${baseRef}..${headRef}`,
  ])
    .split(/\r?\n/u)
    .filter(Boolean);
  validateStableMetadataChange({
    baseVersion: packageVersionAt(baseRef),
    headVersion: packageVersionAt(headRef),
    changedPaths,
  });
  console.log("Stable metadata pull request scope is valid.");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
