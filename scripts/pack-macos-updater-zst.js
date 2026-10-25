#!/usr/bin/env node
// Repack the per-arch Tauri updater archives (`ROSI.app.tar.gz` from
// `tauri build --target {aarch64,x86_64}-apple-darwin`) as zstd with a long
// window, then sign them for the updater. A long window dedupes rosi-ffmpeg
// against rosi-ffprobe, which gzip's 32 KB window cannot.
//
// The tar bytes stay identical, so the code signature and notarization staple
// inside the bundle survive. Failure modes: e2e/updater-zst.failure-modes.md (Z04).

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { Transform, Writable } from "stream";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";
import zlib from "zlib";
import { isDirectExecutionOf } from "./direct-execution.mjs";
import { verifyReleaseSession } from "./release-session.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ARCHES = {
  aarch64: { rustTarget: "aarch64-apple-darwin", lipoArch: "arm64" },
  x86_64: { rustTarget: "x86_64-apple-darwin", lipoArch: "x86_64" },
};
// Must match MACOS_ZSTD_WINDOW_LOG_MAX in the vendored updater plugin.
const ZSTD_WINDOW_LOG = 27;
const ZSTD_LEVEL = 19;
const BUNDLE_PREFIX = "ROSI.app/";
// Executables that must be thin for the target arch. The size win comes from
// these; a universal one means the input is not a per-arch build.
const THIN_MEMBERS = [
  "ROSI.app/Contents/MacOS/rosi",
  "ROSI.app/Contents/MacOS/rosi-ffmpeg",
  "ROSI.app/Contents/MacOS/rosi-ffprobe",
];
// Upstream ships yt-dlp_macos only as universal2, so every bundle carries
// the same file. It must still run on the target arch.
const MULTI_ARCH_MEMBERS = ["ROSI.app/Contents/MacOS/rosi-yt-dlp"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(
        `${command} was not found.${command === "zstd" ? " Install it with: brew install zstd" : ""}`,
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function bundleArchivePath(
  arch,
  targetRoot = path.join(root, "src-tauri", "target"),
) {
  return path.join(
    targetRoot,
    ARCHES[arch].rustTarget,
    "release",
    "bundle",
    "macos",
    "ROSI.app.tar.gz",
  );
}

function compactArchiveName(arch) {
  return `ROSI-${arch}.app.tar.zst`;
}

/** Z04.2: one top-level ROSI.app, and executables built for `arch`. */
function assertPerArchBundle(input, arch) {
  const members = run("tar", ["-tzf", input], { maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
  const outside = members.filter((name) => !name.startsWith(BUNDLE_PREFIX));
  if (members.length === 0 || outside.length > 0) {
    throw new Error(
      `${input}: archive must contain only ${BUNDLE_PREFIX}; found ${outside.slice(0, 3).join(", ") || "nothing"}`,
    );
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-updater-zst-"));
  try {
    run("tar", [
      "-xzf",
      input,
      "-C",
      scratch,
      ...THIN_MEMBERS,
      ...MULTI_ARCH_MEMBERS,
    ]);
    const expected = ARCHES[arch].lipoArch;
    for (const member of [...THIN_MEMBERS, ...MULTI_ARCH_MEMBERS]) {
      const archs = run("lipo", ["-archs", path.join(scratch, member)]).trim();
      const thin = THIN_MEMBERS.includes(member);
      if (thin ? archs !== expected : !archs.split(/\s+/).includes(expected)) {
        throw new Error(
          `${input}: ${member} has architectures "${archs}", expected ${thin ? "" : "to include "}"${expected}"`,
        );
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function hashingPassThrough(hash) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

function childExit(child, label) {
  return new Promise((resolve, reject) => {
    child.on("error", (error) =>
      reject(
        error.code === "ENOENT"
          ? new Error("zstd was not found. Install it with: brew install zstd")
          : error,
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${label} exited with ${code}`)),
    );
  });
}

/** Gunzip `input` into zstd at `output`. Returns the tar stream's SHA-256. */
async function repackGzipAsZstd(input, output) {
  const hash = crypto.createHash("sha256");
  const child = spawn(
    "zstd",
    [
      `-${ZSTD_LEVEL}`,
      `--long=${ZSTD_WINDOW_LOG}`,
      "-T0",
      "-q",
      "-f",
      "-o",
      output,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const exited = childExit(child, "zstd");
  await Promise.all([
    pipeline(
      fs.createReadStream(input),
      zlib.createGunzip(),
      hashingPassThrough(hash),
      child.stdin,
    ),
    exited,
  ]);
  return hash.digest("hex");
}

/** Decode `file` the way the updater will (window capped at 2^27). */
async function zstdContentSha256(file) {
  const hash = crypto.createHash("sha256");
  const child = spawn(
    "zstd",
    ["-dc", `--long=${ZSTD_WINDOW_LOG}`, "-q", file],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const exited = childExit(child, "zstd -d");
  await Promise.all([
    pipeline(
      child.stdout,
      hashingPassThrough(hash),
      new Writable({ write: (_c, _e, cb) => cb() }),
    ),
    exited,
  ]);
  return hash.digest("hex");
}

function signUpdaterArtifact(file, version) {
  const tauri = path.join(root, "node_modules", ".bin", "tauri");
  run(tauri, ["signer", "sign", "--app-version", version, file], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const signature = `${file}.sig`;
  if (!fs.existsSync(signature) || fs.statSync(signature).size === 0) {
    throw new Error(`tauri signer did not write ${signature}`);
  }
  return signature;
}

/**
 * Pack one per-arch archive. `sign: false` skips the minisign step (callers
 * that sign with their own key, such as the E2E harness, do it afterwards).
 */
async function packMacosUpdaterArchive({
  input,
  arch,
  version,
  outputDir,
  sign = true,
}) {
  if (!ARCHES[arch]) throw new Error(`unsupported macOS arch: ${arch}`);
  if (!fs.existsSync(input))
    throw new Error(`missing per-arch updater archive: ${input}`);
  assertPerArchBundle(input, arch);

  const output = path.join(
    outputDir ?? path.dirname(input),
    compactArchiveName(arch),
  );
  fs.rmSync(output, { force: true });
  fs.rmSync(`${output}.sig`, { force: true });
  const tarSha256 = await repackGzipAsZstd(input, output);
  // Z04.3: the zstd archive must decode to the exact tar Tauri produced.
  const roundTripSha256 = await zstdContentSha256(output);
  if (roundTripSha256 !== tarSha256) {
    fs.rmSync(output, { force: true });
    throw new Error(`${output}: zstd round trip changed the tar stream`);
  }
  const signature = sign ? signUpdaterArtifact(output, version) : null;
  return {
    arch,
    input,
    output,
    signature,
    tarSha256,
    gzipBytes: fs.statSync(input).size,
    zstdBytes: fs.statSync(output).size,
  };
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("pack-macos-updater-zst can only run on macOS.");
  }
  const session = verifyReleaseSession(root);
  const version = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).version;
  for (const arch of Object.keys(ARCHES)) {
    const input = bundleArchivePath(arch);
    if (!fs.existsSync(input)) {
      throw new Error(
        `missing ${input}. Run tauri build --target ${ARCHES[arch].rustTarget} --bundles app first.`,
      );
    }
    // Permit coarse filesystem timestamp resolution, as gpg-sign does.
    if (fs.statSync(input).mtimeMs < session.startedAt - 2000) {
      throw new Error(`${input} predates this release session; rebuild it.`);
    }
    const result = await packMacosUpdaterArchive({ input, arch, version });
    const saved = 100 - (result.zstdBytes / result.gzipBytes) * 100;
    console.log(
      `  + ${path.basename(result.output)} (${(result.zstdBytes / 1e6).toFixed(1)} MB; gzip ${(result.gzipBytes / 1e6).toFixed(1)} MB; ${saved.toFixed(0)}% smaller)`,
    );
  }
}

if (isDirectExecutionOf(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `pack-macos-updater-zst: FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

export {
  ARCHES,
  ZSTD_WINDOW_LOG,
  assertPerArchBundle,
  bundleArchivePath,
  compactArchiveName,
  packMacosUpdaterArchive,
};
