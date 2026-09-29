#!/usr/bin/env node
/**
 * Fail the Windows build if an NSIS installer's app payload (app-*.7z) uses a
 * 7z filter the installer's 7z plugin cannot decode. The plugin silently
 * skips such files, so the broken installer still exits 0 (v4.1.0 to v4.3.2
 * on ARM64 installed no Rosi.exe).
 *
 * electron-builder stores each payload uncompressed inside the installer, so
 * the payloads are found by their 7z signature and checked start-header CRC.
 * That works with the reduced 7za bundled on Windows, which cannot open NSIS.
 *
 * Usage: node build-scripts/check-nsis-payload.js [release-dir]
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
// Filters added in 7-Zip 23+, unknown to the NSIS 7z plugin.
const UNSUPPORTED_FILTERS = ['ARM64', 'RISCV'];
const REQUIRED_ENTRIES = ['Rosi.exe', 'resources/app.asar'];
const SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const START_HEADER_BYTES = 32;
const MIN_PAYLOAD_BYTES = 1024 * 1024;

function parseSlt(output) {
  const entries = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    const match = /^(Path|Method|Folder) = (.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === 'Path') {
      current = { path: match[2].replace(/\\/g, '/'), method: '', folder: false };
      entries.push(current);
    } else if (current && match[1] === 'Method') {
      current.method = match[2];
    } else if (current && match[1] === 'Folder') {
      current.folder = match[2] === '+';
    }
  }
  // The first Path block describes the archive itself.
  return entries.slice(1).filter((entry) => !entry.folder);
}

/** Offsets and lengths of every well-formed 7z archive embedded in `file`. */
function findEmbeddedArchives(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    const candidates = [];
    for (let position = 0; position < size; position += chunk.length - SIGNATURE.length) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, position);
      let index = chunk.subarray(0, read).indexOf(SIGNATURE);
      while (index !== -1) {
        if (!candidates.includes(position + index)) candidates.push(position + index);
        index = chunk.subarray(0, read).indexOf(SIGNATURE, index + 1);
      }
      if (position + read >= size) break;
    }
    const archives = [];
    const header = Buffer.alloc(START_HEADER_BYTES);
    for (const offset of candidates) {
      if (offset + START_HEADER_BYTES > size) continue;
      fs.readSync(fd, header, 0, START_HEADER_BYTES, offset);
      if (zlib.crc32(header.subarray(12, 32)) !== header.readUInt32LE(8)) continue;
      const length =
        START_HEADER_BYTES +
        Number(header.readBigUInt64LE(12)) +
        Number(header.readBigUInt64LE(20));
      if (length >= MIN_PAYLOAD_BYTES && offset + length <= size) {
        archives.push({ offset, length });
      }
    }
    return archives;
  } finally {
    fs.closeSync(fd);
  }
}

function carve(file, { offset, length }, destination) {
  const input = fs.openSync(file, 'r');
  const output = fs.openSync(destination, 'w');
  try {
    const buffer = Buffer.alloc(8 * 1024 * 1024);
    for (let done = 0; done < length;) {
      const read = fs.readSync(
        input,
        buffer,
        0,
        Math.min(buffer.length, length - done),
        offset + done
      );
      if (read <= 0) throw new Error(`Unexpected end of ${file}`);
      fs.writeSync(output, buffer, 0, read);
      done += read;
    }
  } finally {
    fs.closeSync(input);
    fs.closeSync(output);
  }
}

function checkPayload(sevenZip, archive) {
  const result = spawnSync(sevenZip, ['l', '-slt', archive], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`7za could not list ${archive}: ${result.stderr || result.stdout}`);
  }
  const entries = parseSlt(result.stdout);
  const problems = [];
  for (const entry of entries) {
    const bad = UNSUPPORTED_FILTERS.find((filter) => entry.method.split(/\s+/).includes(filter));
    if (bad) problems.push(`${entry.path} uses the ${bad} filter (${entry.method})`);
  }
  const names = new Set(entries.map((entry) => entry.path));
  for (const required of REQUIRED_ENTRIES) {
    if (!names.has(required)) problems.push(`${required} is missing`);
  }
  return { entries: entries.length, problems };
}

function isNsisInstaller(name) {
  return /\.exe$/i.test(name) && !/^(elevate|Uninstall .*)\.exe$/i.test(name);
}

async function main() {
  const releaseDir = path.resolve(process.argv[2] || path.join(ROOT, 'release'));
  const installers = fs.existsSync(releaseDir)
    ? fs.readdirSync(releaseDir).filter(isNsisInstaller)
    : [];
  if (installers.length === 0) {
    throw new Error(`No NSIS installers found in ${releaseDir}.`);
  }
  const { getPath7za } = require('app-builder-lib/out/toolsets/7zip');
  const sevenZip = await getPath7za();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rosi-nsis-payload-'));
  let failed = false;
  try {
    for (const name of installers) {
      const installer = path.join(releaseDir, name);
      const archives = findEmbeddedArchives(installer);
      if (archives.length === 0) {
        failed = true;
        console.error(`[check-nsis-payload] ${name}: no embedded app payload found`);
      }
      for (const [index, archive] of archives.entries()) {
        const carved = path.join(workDir, `${path.parse(name).name}-${index}.7z`);
        carve(installer, archive, carved);
        const label = `${name} payload ${index + 1}/${archives.length}`;
        const { entries, problems } = checkPayload(sevenZip, carved);
        fs.rmSync(carved, { force: true });
        if (problems.length > 0) {
          failed = true;
          console.error(`[check-nsis-payload] ${label}: ${problems.length} problem(s)`);
          for (const problem of problems) console.error(`  - ${problem}`);
        } else {
          console.log(`[check-nsis-payload] ${label}: ok (${entries} files)`);
        }
      }
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[check-nsis-payload] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

module.exports = { parseSlt, findEmbeddedArchives, checkPayload, UNSUPPORTED_FILTERS };
