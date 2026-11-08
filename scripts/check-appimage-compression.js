#!/usr/bin/env node
/**
 * Fails a Linux release unless the AppImage payload is zstd SquashFS and the
 * AppImage runtime can extract it. Failure modes in
 * e2e/appimage-zstd.failure-modes.md.
 *
 * Usage:
 *   node scripts/check-appimage-compression.js --target <triple>
 *   node scripts/check-appimage-compression.js --appimage <path>
 *   node scripts/check-appimage-compression.js --self-test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(
  root,
  "e2e",
  "artifacts",
  "appimage-compression-report.json",
);

export const SQUASHFS_COMPRESSION = Object.freeze({
  1: "gzip",
  2: "lzma",
  3: "lzo",
  4: "xz",
  5: "lz4",
  6: "zstd",
});

/** Offset where the payload starts: the end of the ELF section header table. */
export function elfPayloadOffset(buffer) {
  if (buffer.readUInt32BE(0) !== 0x7f454c46) {
    throw new Error("not an ELF file");
  }
  const is64 = buffer[4] === 2;
  const little = buffer[5] === 1;
  const u16 = (offset) =>
    little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const u32 = (offset) =>
    little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const u64 = (offset) =>
    Number(
      little ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset),
    );
  const shoff = is64 ? u64(0x28) : u32(0x20);
  const shentsize = is64 ? u16(0x3a) : u16(0x2e);
  const shnum = is64 ? u16(0x3c) : u16(0x30);
  return shoff + shentsize * shnum;
}

/** Reads the SquashFS superblock that follows the runtime. */
export function squashfsCompression(buffer) {
  const offset = elfPayloadOffset(buffer);
  if (buffer.length < offset + 22)
    throw new Error("file ends before the payload");
  const magic = buffer.toString("latin1", offset, offset + 4);
  if (magic !== "hsqs") {
    throw new Error(`no SquashFS magic at payload offset ${offset}`);
  }
  const id = buffer.readUInt16LE(offset + 20);
  return { offset, id, name: SQUASHFS_COMPRESSION[id] ?? `unknown(${id})` };
}

/** A minimal 64-bit little-endian ELF header followed by a SquashFS superblock. */
export function syntheticAppImage(compressionId) {
  const elf = Buffer.alloc(64 + 64 * 2);
  elf.writeUInt32BE(0x7f454c46, 0);
  elf[4] = 2;
  elf[5] = 1;
  elf.writeBigUInt64LE(64n, 0x28);
  elf.writeUInt16LE(64, 0x3a);
  elf.writeUInt16LE(2, 0x3c);
  const superblock = Buffer.alloc(96);
  superblock.write("hsqs", 0, "latin1");
  superblock.writeUInt16LE(compressionId, 20);
  return Buffer.concat([elf, superblock]);
}

function selfTest() {
  const results = [];
  for (const [id, name] of Object.entries(SQUASHFS_COMPRESSION)) {
    const found = squashfsCompression(syntheticAppImage(Number(id)));
    if (found.name !== name || found.offset !== 192) {
      throw new Error(
        `self-test: id ${id} read as ${found.name} at ${found.offset}`,
      );
    }
    results.push({ id: Number(id), name, offset: found.offset });
  }
  const shifted = Buffer.concat([Buffer.alloc(1), syntheticAppImage(6)]);
  let rejected = false;
  try {
    squashfsCompression(shifted);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("self-test: a non-ELF input was accepted");
  const noMagic = syntheticAppImage(6);
  noMagic.write("xxxx", 192, "latin1");
  rejected = false;
  try {
    squashfsCompression(noMagic);
  } catch {
    rejected = true;
  }
  if (!rejected)
    throw new Error("self-test: missing SquashFS magic was accepted");
  return results;
}

function appImageForTarget(target) {
  const dir = path.join(
    root,
    "src-tauri",
    "target",
    target,
    "release",
    "bundle",
    "appimage",
  );
  const candidates = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith(".AppImage"))
    : [];
  if (candidates.length !== 1) {
    throw new Error(
      `expected one AppImage in ${dir}, found ${candidates.length}`,
    );
  }
  const appImage = path.join(dir, candidates[0]);
  const sessionPath = path.join(root, "release", ".build-session.json");
  if (!fs.existsSync(sessionPath)) {
    throw new Error(
      "Release build session is missing; run release:prepare first.",
    );
  }
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  if (!Number.isFinite(session.startedAt)) {
    throw new Error("Release build session start time is invalid.");
  }
  if (fs.statSync(appImage).mtimeMs < session.startedAt - 2000) {
    throw new Error(`${appImage} is older than the release session`);
  }
  return appImage;
}

/** The payload is read with the AppImage's own runtime, as a user's launch would. */
function extractWithRuntime(appImage) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-appimage-"));
  try {
    const result = spawnSync(appImage, ["--appimage-extract"], {
      cwd: scratch,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `--appimage-extract exited ${result.status}: ${result.stderr}`,
      );
    }
    const squashRoot = path.join(scratch, "squashfs-root");
    const required = ["AppRun", path.join("usr", "bin", "rosi")];
    for (const member of required) {
      if (!fs.existsSync(path.join(squashRoot, member))) {
        throw new Error(`extracted AppImage has no ${member}`);
      }
    }
    return required;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  if (process.argv.includes("--self-test")) {
    const results = selfTest();
    console.log(
      `check-appimage-compression self-test: ${results.length} ids read, 2 bad inputs refused`,
    );
    return;
  }
  const target = argValue("--target");
  const explicit = argValue("--appimage");
  if (!target && !explicit)
    throw new Error("pass --target <triple> or --appimage <path>");
  const appImage = explicit
    ? path.resolve(explicit)
    : appImageForTarget(target);
  const compression = squashfsCompression(fs.readFileSync(appImage));
  const report = {
    generatedAt: new Date().toISOString(),
    appImage: path.relative(root, appImage),
    bytes: fs.statSync(appImage).size,
    compression,
    extracted: null,
    ok: false,
  };
  try {
    if (compression.name !== "zstd") {
      throw new Error(
        `${path.basename(appImage)} payload is ${compression.name}, expected zstd`,
      );
    }
    if (process.platform !== "linux") {
      throw new Error("the runtime extraction check needs Linux");
    }
    report.extracted = extractWithRuntime(appImage);
    report.ok = true;
    console.log(
      `${path.basename(appImage)}: zstd SquashFS, ${report.bytes} bytes, runtime extract ok`,
    );
  } finally {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(`check-appimage-compression: FAILED: ${error.message}`);
    process.exit(1);
  }
}
