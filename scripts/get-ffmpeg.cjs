// @ts-check
"use strict";

/**
 * get-ffmpeg.cjs
 *
 * Downloads ffmpeg/ffprobe binaries from the internal server defined by
 * FFMPEG_DL_SERVER in .env, then extracts them into resources/ffmpeg/.
 *
 * Usage:
 *   node scripts/get-ffmpeg.cjs               # current OS (x64 and arm64)
 *   node scripts/get-ffmpeg.cjs --all          # all 6 platform/arch combos
 *   node scripts/get-ffmpeg.cjs --target mac:arm64 --target win:x64
 *
 * Requires: 7z or 7zz installed and on PATH
 */

const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

// FFMPEG_DL_SERVER comes from .env via `dotenv -e .env --` (see package.json).

const projectRoot = path.resolve(__dirname, "..");
const CHECKSUMS_PATH = path.join(
  projectRoot,
  "resources",
  "ffmpeg",
  "checksums.json",
);

// ─── Platform / arch maps ────────────────────────────────────────────────────

/** Maps process.platform / user-facing aliases → internal dir name
 * @type {Record<string, string>}
 */
const PLATFORM_DIR = {
  win32: "win",
  darwin: "mac",
  linux: "linux",
  win: "win",
  mac: "mac",
};

/** Maps internal dir name → server filename segment
 * @type {Record<string, string>}
 */
const PLATFORM_URL_SEGMENT = {
  win: "win",
  mac: "macOS",
  linux: "linux",
};

/** @type {Record<string, string>} */
const ARCH_ALIASES = {
  x64: "x64",
  arm64: "arm64",
  aarch64: "arm64",
};

/** All supported targets */
const ALL_TARGETS = [
  { platform: "win", arch: "x64" },
  { platform: "win", arch: "arm64" },
  { platform: "mac", arch: "x64" },
  { platform: "mac", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * @param {string} value
 */
function normalizePlatform(value) {
  return PLATFORM_DIR[value] || null;
}

/**
 * @param {string} value
 */
function normalizeArch(value) {
  return ARCH_ALIASES[value] || null;
}

function usage() {
  console.error(
    "Usage: node scripts/get-ffmpeg.cjs [--all] [--target <platform:arch>]...\n" +
      "  Platforms: win, mac, linux\n" +
      "  Architectures: x64, arm64\n" +
      "  Default: current OS (x64 and arm64)\n" +
      "\n" +
      "  Requires FFMPEG_DL_SERVER to be set in .env",
  );
  process.exit(1);
}

/**
 * @param {string[]} args
 */
function parseArgs(args) {
  let explicitAll = false;
  const targets = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--all") {
      explicitAll = true;
      continue;
    }
    if (arg === "--target") {
      const value = args[i + 1];
      if (!value) usage();
      const parts = value.split(":");
      if (parts.length !== 2) {
        console.error(
          `Invalid target format "${value}". Expected <platform:arch>, e.g. mac:arm64`,
        );
        process.exit(1);
      }
      const platform = normalizePlatform(parts[0]);
      const arch = normalizeArch(parts[1]);
      if (!platform || !arch) {
        console.error(
          `Invalid target "${value}". Valid platforms: win, mac, linux. Valid arches: x64, arm64.`,
        );
        process.exit(1);
      }
      targets.push({ platform, arch });
      i++;
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    usage();
  }

  if (explicitAll) {
    return ALL_TARGETS;
  }

  if (targets.length > 0) {
    // Deduplicate
    const seen = new Set();
    return targets.filter(({ platform, arch }) => {
      const key = `${platform}:${arch}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Default: current OS, both x64 and arm64 architectures
  const platform = normalizePlatform(process.platform);
  if (!platform) {
    console.error(`Unsupported current platform: ${process.platform}`);
    process.exit(1);
  }
  return [
    { platform, arch: "x64" },
    { platform, arch: "arm64" },
  ];
}

const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 60_000;

/**
 * Returns the URL unchanged when it is a plain https URL.
 * @param {string} url
 * @param {string} label
 * @returns {string}
 */
function assertHttpsUrl(url, label) {
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`${label} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use https (got ${parsed.protocol}//).`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain credentials.`);
  }
  return String(url);
}

/**
 * Validates FFMPEG_DL_SERVER and returns it without a trailing slash.
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function assertHttpsServer(env = process.env) {
  const server = env.FFMPEG_DL_SERVER;
  if (!server) throw new Error("FFMPEG_DL_SERVER is not set.");
  assertHttpsUrl(server, "FFMPEG_DL_SERVER");
  return server.replace(/\/+$/, "");
}

/**
 * Download an https URL to a local file path. Every redirect must stay on
 * https, and a short body or any failure removes the partial file.
 * @param {string} url
 * @param {string} destPath
 * @param {{ get?: Function }} [options]
 * @returns {Promise<void>}
 */
function download(url, destPath, options = {}) {
  const get =
    options.get ||
    ((/** @type {string} */ target, /** @type {Function} */ onResponse) =>
      https.get(target, onResponse));
  return new Promise((resolve, reject) => {
    /** @type {fs.WriteStream | null} */
    let file = null;
    let settled = false;
    let receivedBytes = 0;
    let lastLoggedPercent = -1;

    /** @param {Error} err */
    function fail(err) {
      if (settled) return;
      settled = true;
      const finish = () => {
        fs.rm(destPath, { force: true }, () => reject(err));
      };
      if (file) file.close(finish);
      else finish();
    }

    /**
     * @param {string} requestUrl
     * @param {number} redirects
     */
    function doRequest(requestUrl, redirects) {
      try {
        assertHttpsUrl(requestUrl, "Download URL");
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const request = get(requestUrl, (/** @type {any} */ res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          const location = res.headers["location"];
          if (!location) {
            fail(
              new Error(`Redirect with no Location header from ${requestUrl}`),
            );
            return;
          }
          if (redirects >= MAX_REDIRECTS) {
            fail(new Error(`Too many redirects from ${url}`));
            return;
          }
          doRequest(new URL(location, requestUrl).href, redirects + 1);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`HTTP ${res.statusCode} for ${requestUrl}`));
          return;
        }

        const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
        file = fs.createWriteStream(destPath);
        res.on("data", (/** @type {Buffer} */ chunk) => {
          receivedBytes += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.floor((receivedBytes / totalBytes) * 100);
            if (pct !== lastLoggedPercent && pct % 10 === 0) {
              process.stdout.write(`  ${pct}%\r`);
              lastLoggedPercent = pct;
            }
          }
        });
        res.on("error", fail);
        res.on("aborted", () => fail(new Error("Download was interrupted.")));
        file.on("error", fail);
        file.on("finish", () => {
          if (totalBytes > 0 && receivedBytes !== totalBytes) {
            fail(
              new Error(
                `Download incomplete: got ${receivedBytes} of ${totalBytes} bytes (Content-Length).`,
              ),
            );
            return;
          }
          if (settled) return;
          settled = true;
          resolve();
        });
        res.pipe(file);
      });
      request.on("error", fail);
      if (typeof request.setTimeout === "function") {
        request.setTimeout(IDLE_TIMEOUT_MS, () =>
          request.destroy(new Error(`Timed out waiting for ${requestUrl}`)),
        );
      }
    }

    doRequest(url, 0);
  });
}

/** Find the 7z executable: prefer 7zz (standalone), fall back to 7z. */
function find7z() {
  const candidates = ["7zz", "7z"];
  if (process.platform === "win32") {
    // winget/7-Zip installers do not add 7z.exe to PATH.
    for (const base of [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
    ]) {
      if (base) candidates.push(path.join(base, "7-Zip", "7z.exe"));
    }
  }
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["i"], { stdio: "ignore" });
      return bin;
    } catch {
      // not found or errored - try next
    }
  }
  return null;
}

/** Extract a .7z archive into a destination directory.
 * @param {string} sevenZipBin
 * @param {string} archivePath
 * @param {string} destDir
 */
function extract7z(sevenZipBin, archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync(sevenZipBin, ["x", archivePath, `-o${destDir}`, "-y"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * @param {{ platform: string, arch: string }} target
 */
function targetIsPresent({ platform, arch }) {
  const ext = platform === "win" ? ".exe" : "";
  return ["ffmpeg", "ffprobe"].every((binary) =>
    fs.existsSync(
      path.join(
        projectRoot,
        "resources",
        "ffmpeg",
        platform,
        arch,
        `${binary}${ext}`,
      ),
    ),
  );
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * Reads checksums.json. A missing file is null; a damaged one fails closed.
 * @param {string} file
 * @returns {Record<string, any> | null}
 */
function loadManifest(file = CHECKSUMS_PATH) {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`resources/ffmpeg/checksums.json is unreadable: ${msg}`);
  }
}

/**
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]} relative paths of regular files
 */
function listStagedFiles(dir, prefix = "") {
  /** @type {string[]} */
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`Archive contains a symlink (${relative}); refusing it.`);
    }
    if (entry.isDirectory()) {
      files.push(...listStagedFiles(path.join(dir, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`Archive contains a special file (${relative}).`);
    }
  }
  return files;
}

/**
 * @typedef {{ stageDir: string, destDir: string, platform: string, arch: string }} StagePaths
 * @typedef {StagePaths & { manifest: Record<string, any> | null }} VerifyOptions
 */

/**
 * Checks extracted binaries against the manifest, then installs them into
 * destDir. Every file is verified before anything is copied, and the install
 * swaps files in with a rollback, so a failure leaves destDir as it was.
 * @param {VerifyOptions} options
 * @returns {{ verified: string[], unverified: string[] }}
 */
function verifyAndInstall({
  stageDir,
  destDir,
  platform,
  arch,
  manifest,
  allowUnlisted = false,
}) {
  const ext = platform === "win" ? ".exe" : "";
  const key = `${platform}:${arch}`;
  const entry = manifest?.[key];
  const files = listStagedFiles(stageDir);
  /** @type {string[]} */
  const verified = [];
  /** @type {string[]} */
  const unverified = [];

  for (const binary of ["ffmpeg", "ffprobe"]) {
    const fileName = `${binary}${ext}`;
    const expectedPath = `resources/ffmpeg/${platform}/${arch}/${fileName}`;
    const expected =
      entry?.binaries?.[binary] ??
      (binary === "ffmpeg" && entry?.path && entry?.sha256
        ? { path: entry.path, sha256: entry.sha256 }
        : null);
    const present = files.includes(fileName);
    if (!expected) {
      // Only the update flow may install an unlisted binary; it regenerates the
      // manifest from what it installed and then verifies it.
      if (!allowUnlisted) {
        throw new Error(
          `${key} ${binary}: no checksum entry in checksums.json. Run the update flow (npm run get:ffmpeg:update) to add one.`,
        );
      }
      if (present) unverified.push(binary);
      continue;
    }
    if (
      typeof expected.sha256 !== "string" ||
      !SHA256_PATTERN.test(expected.sha256)
    ) {
      throw new Error(`${key} ${binary}: malformed sha256 in checksums.json.`);
    }
    if (expected.path !== expectedPath) {
      throw new Error(
        `${key} ${binary}: checksums.json path ${expected.path} does not match ${expectedPath}.`,
      );
    }
    if (!present) {
      throw new Error(
        `${key}: archive has no ${fileName} but checksums.json lists it.`,
      );
    }
    const actual = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(stageDir, fileName)))
      .digest("hex");
    if (actual !== expected.sha256.toLowerCase()) {
      throw new Error(
        `${key}: SHA-256 mismatch for ${binary}\n  expected: ${expected.sha256}\n  actual:   ${actual}`,
      );
    }
    verified.push(binary);
  }

  installFiles(stageDir, destDir, files);
  return { verified, unverified };
}

/**
 * @param {string} stageDir
 * @param {string} destDir
 * @param {string[]} files
 */
function installFiles(stageDir, destDir, files) {
  const tag = `${process.pid}-${Date.now()}`;
  /** @type {{ source: string, final: string, fresh: string, old: string | null }[]} */
  const plan = files.map((relative) => {
    const final = path.join(destDir, ...relative.split("/"));
    return {
      source: path.join(stageDir, ...relative.split("/")),
      final,
      fresh: `${final}.new-${tag}`,
      old: null,
    };
  });
  /** @type {typeof plan} */
  const swapped = [];
  try {
    for (const item of plan) {
      fs.mkdirSync(path.dirname(item.final), { recursive: true });
      fs.copyFileSync(item.source, item.fresh);
    }
    for (const item of plan) {
      if (fs.existsSync(item.final)) {
        item.old = `${item.final}.old-${tag}`;
        fs.renameSync(item.final, item.old);
      }
      swapped.push(item);
      fs.renameSync(item.fresh, item.final);
    }
  } catch (err) {
    for (const item of swapped.reverse()) {
      try {
        fs.rmSync(item.final, { force: true });
        if (item.old) fs.renameSync(item.old, item.final);
      } catch {
        /* keep rolling back the rest */
      }
    }
    for (const item of plan) fs.rmSync(item.fresh, { force: true });
    throw err;
  }
  for (const item of plan) {
    if (item.old) fs.rmSync(item.old, { force: true });
  }
}

async function main() {
  // --missing-only: fetch only targets whose ffmpeg/ffprobe are absent. Used
  // by workspace:bootstrap so release VMs self-provision; present binaries
  // are left alone and still verified later by prepare-sidecars.
  const rawArgs = process.argv.slice(2);
  const missingOnly = rawArgs.includes("--missing-only");
  // Set only by update-ffmpeg, which drops the old manifest before downloading.
  const allowUnlisted = rawArgs.includes("--allow-unlisted");
  let targets = parseArgs(
    rawArgs.filter(
      (arg) => arg !== "--missing-only" && arg !== "--allow-unlisted",
    ),
  );
  if (missingOnly) {
    targets = targets.filter((target) => !targetIsPresent(target));
    if (targets.length === 0) {
      console.log("ffmpeg binaries already present for the requested targets.");
      return;
    }
  }

  /** @type {string} */
  let base = "";
  try {
    base = assertHttpsServer();
  } catch (err) {
    console.error(
      `\nError: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error("Add it to your .env file:");
    console.error(
      "  FFMPEG_DL_SERVER=https://your-server.example/ffmpeg/latest/",
    );
    process.exit(1);
  }

  /** @type {Record<string, any> | null} */
  let manifest = null;
  try {
    manifest = loadManifest();
  } catch (err) {
    console.error(
      `\nError: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Validate 7z
  const sevenZipBin = find7z();
  if (!sevenZipBin) {
    console.error("\nError: 7z (or 7zz) not found on PATH.");
    console.error("Install it first:");
    console.error("  macOS:  brew install sevenzip");
    console.error("  Linux:  sudo apt install p7zip-full");
    console.error("  Win:    winget install 7zip.7zip");
    process.exit(1);
  }

  console.log(
    `\nDownloading ffmpeg binaries for: ${targets.map((t) => `${t.platform}:${t.arch}`).join(", ")}`,
  );
  console.log(`Server: ${base}\n`);

  for (const { platform, arch } of targets) {
    const urlSegment = PLATFORM_URL_SEGMENT[platform];
    const filename = `ffmpeg_${urlSegment}_${arch}.7z`;
    const url = `${base}/${filename}`;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosi-ffmpeg-"));
    const tmpFile = path.join(workDir, filename);
    const stageDir = path.join(workDir, "extracted");
    const destDir = path.join(
      projectRoot,
      "resources",
      "ffmpeg",
      platform,
      arch,
    );
    const tag = `[${platform}:${arch}]`;
    let failure = "";

    try {
      console.log(`${tag} Downloading ${filename} ...`);
      try {
        await download(url, tmpFile);
        console.log(`${tag} Download complete.`);
      } catch (err) {
        failure = `Download failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      if (!failure) {
        console.log(`${tag} Extracting for verification ...`);
        try {
          extract7z(sevenZipBin, tmpFile, stageDir);
        } catch (err) {
          failure = `Extraction failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (!failure) {
        try {
          const result = verifyAndInstall({
            stageDir,
            destDir,
            platform,
            arch,
            manifest,
            allowUnlisted,
          });
          for (const binary of result.unverified) {
            console.warn(
              `${tag} Warning: no checksums.json entry for ${binary}; installed unverified.`,
            );
          }
          if (result.verified.length > 0) {
            console.log(`${tag} Verified: ${result.verified.join(", ")}`);
          }
        } catch (err) {
          failure = `Verification or install failed: ${err instanceof Error ? err.message : String(err)}\n${tag} Nothing was installed.`;
        }
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    if (failure) {
      console.error(`\n${tag} ${failure}`);
      process.exit(1);
    }
    console.log(`${tag} Done.\n`);
  }

  console.log(
    `✓ ffmpeg binaries ready for: ${targets.map((t) => `${t.platform}:${t.arch}`).join(", ")}`,
  );
  console.log(`  Run 'npm run ffmpeg:check:current' to verify.\n`);
}

module.exports = {
  assertHttpsServer,
  assertHttpsUrl,
  download,
  loadManifest,
  verifyAndInstall,
};

if (require.main === module) {
  main().catch((err) => {
    console.error("\nUnexpected error:", err);
    process.exit(1);
  });
}
