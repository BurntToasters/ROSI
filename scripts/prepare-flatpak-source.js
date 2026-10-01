#!/usr/bin/env node
/** Export the exact committed tree used for a sideload Flatpak build. */

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exportDirectory = path.join(root, ".flatpak-source");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  // Keep leading spaces: git porcelain uses " M path" / "M  path" and trim()
  // would turn the first into "M path", breaking XY/path parsing.
  return result.stdout.replace(/\r?\n$/, "");
}

function porcelainPaths(statusText) {
  return statusText
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean)
    .map((line) => {
      // XY PATH  or  XY ORIG -> PATH  (XY is always two status columns)
      const pathPart = line.length >= 3 ? line.slice(3) : line;
      return pathPart.includes(" -> ")
        ? pathPart.split(" -> ").at(-1)
        : pathPart;
    });
}

const dirtyEntries = run("git", [
  "status",
  "--porcelain=v1",
  "--untracked-files=all",
]);
// `tauri build` rewrites generated ACL schemas under src-tauri/gen/schemas/.
// Flatpak exports `git archive HEAD`, so those dirty generated files never enter
// the bundle; only refuse unexpected workspace dirt.
const blockingDirty = porcelainPaths(dirtyEntries).filter(
  (filePath) => !filePath.startsWith("src-tauri/gen/schemas/"),
);
if (blockingDirty.length) {
  throw new Error(
    `Flatpak source export requires a clean committed tree:\n${blockingDirty.join("\n")}`,
  );
}
const commit = run("git", ["rev-parse", "--verify", "HEAD"]);
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "rosi-flatpak-source-"),
);
const archive = path.join(temporaryDirectory, "source.tar");
try {
  fs.rmSync(exportDirectory, { recursive: true, force: true });
  fs.mkdirSync(exportDirectory, { recursive: true });
  run("git", ["archive", "--format=tar", `--output=${archive}`, "HEAD"]);
  run("tar", ["-xf", archive, "-C", exportDirectory]);
  fs.writeFileSync(
    path.join(exportDirectory, ".rosi-source-commit"),
    `${commit}\n`,
  );
  // FFmpeg binaries are fetched (npm run get:ffmpeg) and never committed, so
  // `git archive` omits them. Copy the Linux builds into the export; the
  // Flatpak build re-verifies them against resources/ffmpeg/checksums.json.
  let copiedFfmpeg = 0;
  for (const arch of ["x64", "arm64"]) {
    for (const binary of ["ffmpeg", "ffprobe"]) {
      const relative = path.join("resources", "ffmpeg", "linux", arch, binary);
      const source = path.join(root, relative);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(exportDirectory, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, 0o755);
      copiedFfmpeg += 1;
    }
  }
  if (copiedFfmpeg === 0) {
    throw new Error(
      "No Linux FFmpeg binaries under resources/ffmpeg/linux/. Run npm run get:ffmpeg first.",
    );
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
console.log(`Flatpak source exported from ${commit}.`);
