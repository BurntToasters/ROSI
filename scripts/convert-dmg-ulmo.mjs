#!/usr/bin/env node
// Converts the release DMGs from UDZO (zlib) to ULMO (LZMA). Failure modes in
// e2e/dmg-ulmo.failure-modes.md. Writes e2e/artifacts/dmg-ulmo-report.json.
//
// Release mode (no --dmg): converts target/<triple>/release/bundle/dmg/
// ROSI-MacOS-<arch>.dmg for every macOS target, then signs, notarizes, and
// staples each image. Local mode: --dmg <path> [--out <path>] --no-notarize
// converts one image and runs every check except signing and notarization.

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { MACOS_TARGETS, macosPackageName } from "./zip-macos.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(root, "e2e", "artifacts", "dmg-ulmo-report.json");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

export function imageFormat(dmgPath) {
  const info = run("hdiutil", ["imageinfo", dmgPath]);
  const match = info.match(/^Format:\s*(\S+)/m);
  if (!match)
    throw new Error(`hdiutil imageinfo gave no format for ${dmgPath}`);
  return match[1];
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Every entry under `dir`: relative path, type, mode, size, hash or link target. */
export function treeOf(dir) {
  const entries = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const relative = path.relative(dir, full);
      const stat = fs.lstatSync(full);
      const mode = (stat.mode & 0o7777).toString(8);
      if (stat.isSymbolicLink()) {
        entries.push({
          relative,
          type: "link",
          mode,
          target: fs.readlinkSync(full),
        });
      } else if (stat.isDirectory()) {
        entries.push({ relative, type: "dir", mode });
        walk(full);
      } else if (stat.isFile()) {
        entries.push({
          relative,
          type: "file",
          mode,
          size: stat.size,
          sha256: sha256File(full),
        });
      } else {
        throw new Error(`unexpected entry type in DMG: ${relative}`);
      }
    }
  };
  walk(dir);
  return entries;
}

function attach(dmgPath, mountPoint, attached) {
  fs.mkdirSync(mountPoint, { recursive: true });
  run("hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-noautoopen",
    "-noverify",
    "-mountpoint",
    mountPoint,
    dmgPath,
  ]);
  attached.push(mountPoint);
}

function detachAll(attached) {
  for (const mountPoint of attached.splice(0)) {
    try {
      run("hdiutil", ["detach", "-quiet", mountPoint]);
    } catch {
      try {
        run("hdiutil", ["detach", "-force", "-quiet", mountPoint]);
      } catch (error) {
        console.error(`could not detach ${mountPoint}: ${error.message}`);
      }
    }
  }
}

/** The app tree only: the DMG's own .DS_Store and background differ by design. */
function appTree(mountPoint) {
  const appPath = path.join(mountPoint, "ROSI.app");
  if (!fs.existsSync(appPath)) throw new Error(`no ROSI.app in ${mountPoint}`);
  return treeOf(appPath);
}

function firstDifference(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) {
      return {
        index,
        original: left[index] ?? null,
        converted: right[index] ?? null,
      };
    }
  }
  return null;
}

function notarizationArgs(env) {
  if (env.APPLE_API_KEY && env.APPLE_API_ISSUER && env.APPLE_API_KEY_PATH) {
    return [
      "--key",
      env.APPLE_API_KEY_PATH,
      "--key-id",
      env.APPLE_API_KEY,
      "--issuer",
      env.APPLE_API_ISSUER,
    ];
  }
  if (env.APPLE_ID && env.APPLE_PASSWORD && env.APPLE_TEAM_ID) {
    return [
      "--apple-id",
      env.APPLE_ID,
      "--password",
      env.APPLE_PASSWORD,
      "--team-id",
      env.APPLE_TEAM_ID,
    ];
  }
  return null;
}

/**
 * Converts one DMG. `output` defaults to replacing `input` in place, which
 * happens only after every check passed.
 */
export function convertDmg({
  input,
  output = input,
  notarize,
  env = process.env,
}) {
  const record = { input, output, steps: [] };
  const step = (name, details = {}) => record.steps.push({ name, ...details });
  const format = imageFormat(input);
  record.inputFormat = format;
  record.inputBytes = fs.statSync(input).size;
  if (format === "ULMO") {
    if (output !== input) fs.copyFileSync(input, output);
    record.outputFormat = "ULMO";
    record.outputBytes = record.inputBytes;
    record.skipped = "already ULMO";
    return record;
  }
  if (format !== "UDZO") {
    throw new Error(
      `${path.basename(input)} is ${format}, expected UDZO from Tauri`,
    );
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-dmg-ulmo-"));
  const staged = path.join(
    path.dirname(output),
    `.${path.basename(output)}.ulmo-${process.pid}.dmg`,
  );
  const attached = [];
  try {
    run("hdiutil", [
      "convert",
      input,
      "-format",
      "ULMO",
      "-o",
      staged,
      "-quiet",
    ]);
    step("convert", { format: imageFormat(staged) });
    if (imageFormat(staged) !== "ULMO")
      throw new Error("converted image is not ULMO");

    run("hdiutil", ["verify", "-quiet", staged]);
    step("verify");

    attach(input, path.join(scratch, "original"), attached);
    attach(staged, path.join(scratch, "converted"), attached);
    const originalTree = appTree(path.join(scratch, "original"));
    const convertedTree = appTree(path.join(scratch, "converted"));
    detachAll(attached);
    const difference = firstDifference(originalTree, convertedTree);
    if (difference) {
      throw new Error(
        `ROSI.app differs after conversion: ${JSON.stringify(difference)}`,
      );
    }
    step("app-tree-identical", {
      entries: convertedTree.length,
      sha256: crypto
        .createHash("sha256")
        .update(JSON.stringify(convertedTree))
        .digest("hex"),
    });

    const stagedBytes = fs.statSync(staged).size;
    if (stagedBytes >= record.inputBytes) {
      throw new Error(
        `ULMO image is ${stagedBytes} bytes, not smaller than the ${record.inputBytes}-byte input`,
      );
    }
    step("smaller", { bytes: stagedBytes });

    if (notarize) {
      const identity = env.APPLE_SIGNING_IDENTITY;
      const credentials = notarizationArgs(env);
      if (!identity || !credentials) {
        throw new Error(
          "signing identity or notarization credentials are missing",
        );
      }
      run("codesign", ["--force", "--timestamp", "--sign", identity, staged]);
      run("codesign", ["--verify", "--strict", staged]);
      step("signed");
      run("xcrun", ["notarytool", "submit", staged, "--wait", ...credentials], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      step("notarized");
      run("xcrun", ["stapler", "staple", staged]);
      run("xcrun", ["stapler", "validate", staged]);
      step("stapled");
    }

    fs.renameSync(staged, output);
    record.outputFormat = "ULMO";
    record.outputBytes = fs.statSync(output).size;
    record.savedBytes = record.inputBytes - record.outputBytes;
    record.outputSha256 = sha256File(output);
    return record;
  } finally {
    detachAll(attached);
    fs.rmSync(staged, { force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function releaseInputs() {
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
  return Object.keys(MACOS_TARGETS).map((target) => {
    const dmg = path.join(
      root,
      "src-tauri",
      "target",
      target,
      "release",
      "bundle",
      "dmg",
      macosPackageName(target, "dmg"),
    );
    if (!fs.existsSync(dmg)) throw new Error(`Missing release DMG: ${dmg}`);
    if (fs.statSync(dmg).mtimeMs < session.startedAt - 2000) {
      throw new Error(`${dmg} is older than the release session`);
    }
    return dmg;
  });
}

function parseArgs(argv) {
  const options = { dmg: null, out: null, notarize: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dmg") options.dmg = argv[++index];
    else if (argument === "--out") options.out = argv[++index];
    else if (argument === "--no-notarize") options.notarize = false;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.dmg && !options.notarize) {
    throw new Error("release mode always notarizes; --no-notarize needs --dmg");
  }
  if (options.out && !options.dmg) throw new Error("--out needs --dmg");
  return options;
}

function main() {
  if (process.platform !== "darwin")
    throw new Error("convert-dmg-ulmo runs on macOS only");
  const options = parseArgs(process.argv.slice(2));
  if (options.notarize) {
    if (!process.env.APPLE_SIGNING_IDENTITY || !notarizationArgs(process.env)) {
      throw new Error(
        "APPLE_SIGNING_IDENTITY and notarization credentials (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID or an API key) are required.",
      );
    }
  }
  const jobs = options.dmg
    ? [
        {
          input: path.resolve(options.dmg),
          output: path.resolve(options.out ?? options.dmg),
        },
      ]
    : releaseInputs().map((dmg) => ({ input: dmg, output: dmg }));
  const report = {
    generatedAt: new Date().toISOString(),
    mode: options.dmg ? "single" : "release",
    notarized: options.notarize,
    host: `${os.platform()}-${os.arch()} ${run("sw_vers", ["-productVersion"]).trim()}`,
    images: [],
    ok: false,
  };
  try {
    for (const job of jobs) {
      const record = convertDmg({ ...job, notarize: options.notarize });
      report.images.push(record);
      console.log(
        `${path.basename(job.output)}: ${record.inputFormat} ${record.inputBytes} -> ULMO ${record.outputBytes} bytes`,
      );
    }
    report.ok = true;
  } finally {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report: ${path.relative(root, reportPath)}`);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(`convert-dmg-ulmo: FAILED: ${error.message}`);
    process.exit(1);
  }
}
