// @ts-check
"use strict";

/**
 * fetch-ytdlp.cjs
 *
 * Downloads the pinned yt-dlp binaries from the GitHub release into assets/.
 * Each download is checked against three anchors before it is written:
 *   1. SHA2-256SUMS, whose GPG signature must come from the pinned key;
 *   2. the committed manifest (assets/ytdlp-checksums.json), which must agree
 *      with the signed sums before anything is downloaded;
 *   3. the downloaded bytes themselves.
 *
 * Usage:
 *   node scripts/fetch-ytdlp.cjs                       host platform binaries
 *   node scripts/fetch-ytdlp.cjs --missing-only        skip files already valid
 *   node scripts/fetch-ytdlp.cjs --all                 every tracked binary
 *   node scripts/fetch-ytdlp.cjs --target <triple>     explicit Rust triple(s)
 *   node scripts/fetch-ytdlp.cjs --update <version>    bump the manifest from
 *       the signed upstream sums and fetch the matching license file
 *   node scripts/fetch-ytdlp.cjs --allow-unsigned-sums
 *       Only when gpg is unavailable outside CI. Refused when CI or
 *       ROSI_RELEASE is set, and refused with --update.
 *
 * gpg: ROSI_GPG, then `gpg` on PATH, then (Windows) Git for Windows' gpg.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ASSETS_DIR = path.join(ROOT, "assets");
const MANIFEST_PATH = path.join(ASSETS_DIR, "ytdlp-checksums.json");
const PUBLIC_KEY_PATH = path.join(ASSETS_DIR, "yt-dlp-public.asc");
const TAURI_CONF_PATH = path.join(ROOT, "src-tauri", "tauri.conf.json");
const NOTICES_PATH = path.join(ASSETS_DIR, "YT-DLP-NOTICES.txt");

/** Signing key of the yt-dlp maintainer (checked against the committed key). */
const PINNED_FINGERPRINT = "AC0CBBE6848D6A873464AF4E57CF65933B5A7581";

const REPO = "yt-dlp/yt-dlp";
const FILE_NAMES = Object.freeze([
  "yt-dlp.exe",
  "yt-dlp_arm64.exe",
  "yt-dlp_macos",
  "yt-dlp_linux",
  "yt-dlp_linux_aarch64",
]);

/** Rust target triple to the yt-dlp file ROSI bundles for it. */
const TARGET_FILES = Object.freeze({
  "x86_64-pc-windows-msvc": ["yt-dlp.exe"],
  "aarch64-pc-windows-msvc": ["yt-dlp_arm64.exe"],
  "x86_64-apple-darwin": ["yt-dlp_macos"],
  "aarch64-apple-darwin": ["yt-dlp_macos"],
  "universal-apple-darwin": ["yt-dlp_macos"],
  "x86_64-unknown-linux-gnu": ["yt-dlp_linux"],
  "aarch64-unknown-linux-gnu": ["yt-dlp_linux_aarch64"],
});

const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 60_000;

function log(message) {
  console.log(`[ytdlp] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function isTruthyEnv(value) {
  return Boolean(value) && value !== "0" && value.toLowerCase() !== "false";
}

function isReleaseEnvironment(env = process.env) {
  return isTruthyEnv(env.CI) || isTruthyEnv(env.ROSI_RELEASE);
}

/** Git for Windows locations of its MSYS gpg, most specific first. */
function windowsGitGpgCandidates(env = process.env) {
  const roots = [
    env.ProgramFiles,
    env.ProgramW6432,
    env["ProgramFiles(x86)"],
    "C:\\Program Files",
  ].filter(Boolean);
  return [
    ...new Set(
      roots.map((root) =>
        path.win32.join(root, "Git", "usr", "bin", "gpg.exe"),
      ),
    ),
  ];
}

function gpgRuns(command) {
  const probe = spawnSync(command, ["--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
}

/**
 * Picks the gpg executable. Fails closed when none runs.
 * @returns {string} a command name or an absolute path
 */
function resolveGpg({
  env = process.env,
  platform = process.platform,
  runs = gpgRuns,
  exists = fs.existsSync,
} = {}) {
  if (env.ROSI_GPG) {
    if (!exists(env.ROSI_GPG)) {
      fail(`ROSI_GPG points at a missing file: ${env.ROSI_GPG}`);
    }
    return env.ROSI_GPG;
  }
  if (runs("gpg")) return "gpg";
  if (platform === "win32") {
    for (const candidate of windowsGitGpgCandidates(env)) {
      if (exists(candidate) && runs(candidate)) return candidate;
    }
  }
  fail(
    "gpg is not available. Install GnuPG to verify yt-dlp release signatures" +
      (platform === "win32"
        ? " (Git for Windows includes gpg, or set ROSI_GPG)."
        : "."),
  );
  return "";
}

/**
 * MSYS gpg (Git for Windows) reads Windows paths only with forward slashes.
 * Native Windows gpg accepts them too, so every Windows path is converted.
 */
function gpgPath(filePath, platform = process.platform) {
  return platform === "win32" ? filePath.replace(/\\/g, "/") : filePath;
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function readManifest() {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch (error) {
    fail(
      `Could not read ${MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!manifest || !VERSION_PATTERN.test(manifest.version || "")) {
    fail("assets/ytdlp-checksums.json has no valid version");
  }
  for (const name of FILE_NAMES) {
    if (!SHA256_PATTERN.test((manifest.files || {})[name] || "")) {
      fail(`assets/ytdlp-checksums.json has no sha256 for ${name}`);
    }
  }
  return manifest;
}

/** Parses `<sha256>  <name>` lines (sha256sum format). @param {string} text */
function parseSums(text) {
  /** @type {Map<string, string>} */
  const sums = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{64})\s+\*?(\S+)$/);
    if (!match) fail(`Malformed SHA2-256SUMS line: ${line}`);
    if (sums.has(match[2])) fail(`Duplicate SHA2-256SUMS entry: ${match[2]}`);
    sums.set(match[2], match[1]);
  }
  if (sums.size === 0) fail("SHA2-256SUMS is empty");
  return sums;
}

/**
 * Verifies the detached signature over SHA2-256SUMS with a throwaway keyring
 * and requires the signing primary key to equal the pinned fingerprint.
 * @returns {string} the verified primary fingerprint
 */
function verifySumsSignature({
  sumsPath,
  sigPath,
  keyPath = PUBLIC_KEY_PATH,
  pinnedFingerprint = PINNED_FINGERPRINT,
}) {
  const gpg = resolveGpg();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-gpg-"));
  try {
    fs.chmodSync(home, 0o700);
    const base = [
      "--homedir",
      gpgPath(home),
      "--batch",
      "--no-autostart",
      "--quiet",
    ];
    const imported = spawnSync(gpg, [...base, "--import", gpgPath(keyPath)], {
      encoding: "utf8",
    });
    if (imported.error) {
      fail(`gpg failed to run (${imported.error.message}).`);
    }
    if (imported.status !== 0) {
      fail(`gpg could not import ${keyPath}: ${imported.stderr}`);
    }
    const verified = spawnSync(
      gpg,
      [
        "--status-fd",
        "1",
        ...base,
        "--verify",
        gpgPath(sigPath),
        gpgPath(sumsPath),
      ],
      { encoding: "utf8" },
    );
    if (verified.error) {
      fail(`gpg failed to run: ${verified.error.message}`);
    }
    const lines = String(verified.stdout).split("\n");
    const validLine = lines.find((line) =>
      line.startsWith("[GNUPG:] VALIDSIG "),
    );
    if (verified.status !== 0 || !validLine) {
      fail("SHA2-256SUMS signature verification failed");
    }
    // Last field of VALIDSIG is the primary key fingerprint.
    const primary = validLine.trim().split(" ").pop().toUpperCase();
    if (primary !== pinnedFingerprint.toUpperCase()) {
      fail(
        `SHA2-256SUMS signed by ${primary}, not the pinned yt-dlp key ${pinnedFingerprint}`,
      );
    }
    return primary;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Streams an https URL to destPath, following up to MAX_REDIRECTS redirects.
 * @param {string} url
 * @param {string} destPath
 * @returns {Promise<void>}
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    /** @param {string} current @param {number} hops */
    const follow = (current, hops) => {
      let parsed;
      try {
        parsed = new URL(current);
      } catch {
        reject(new Error(`Invalid URL: ${current}`));
        return;
      }
      if (parsed.protocol !== "https:") {
        reject(new Error(`Refusing non-https URL: ${current}`));
        return;
      }
      const request = https.get(
        parsed,
        { headers: { "user-agent": "ROSI-ytdlp-fetch" } },
        (response) => {
          const status = response.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            response.resume();
            const location = response.headers.location;
            if (!location) {
              reject(new Error(`Redirect without Location from ${current}`));
              return;
            }
            if (hops >= MAX_REDIRECTS) {
              reject(new Error(`Too many redirects from ${url}`));
              return;
            }
            follow(new URL(location, current).toString(), hops + 1);
            return;
          }
          if (status !== 200) {
            response.resume();
            reject(new Error(`HTTP ${status} for ${current}`));
            return;
          }
          const out = fs.createWriteStream(destPath);
          out.on("error", (error) => {
            fs.rmSync(destPath, { force: true });
            reject(error);
          });
          response.on("error", (error) => {
            out.destroy();
            fs.rmSync(destPath, { force: true });
            reject(error);
          });
          out.on("close", () => resolve());
          response.pipe(out);
        },
      );
      request.setTimeout(IDLE_TIMEOUT_MS, () => {
        request.destroy(new Error(`Timed out fetching ${current}`));
      });
      request.on("error", (error) => {
        fs.rmSync(destPath, { force: true });
        reject(error);
      });
    };
    follow(url, 0);
  });
}

/**
 * Downloads one binary to a temp file in destDir, verifies its SHA-256, and
 * only then renames it into place. A mismatch leaves no file behind.
 * @param {{name: string, url: string, expectedSha256: string, destDir?: string}} options
 * @returns {Promise<string>} the final path
 */
async function downloadVerified({
  name,
  url,
  expectedSha256,
  destDir = ASSETS_DIR,
}) {
  if (!FILE_NAMES.includes(name)) fail(`Unknown yt-dlp file: ${name}`);
  if (!SHA256_PATTERN.test(expectedSha256))
    fail(`Bad expected hash for ${name}`);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, name);
  const temp = path.join(
    destDir,
    `.ytdlp-download-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await downloadFile(url, temp);
    const actual = sha256File(temp);
    if (actual !== expectedSha256) {
      fail(
        `SHA-256 mismatch for ${name}\n  expected: ${expectedSha256}\n  actual:   ${actual}`,
      );
    }
    if (process.platform !== "win32") fs.chmodSync(temp, 0o755);
    if (process.platform === "win32") fs.rmSync(dest, { force: true });
    fs.renameSync(temp, dest);
    return dest;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function hostFileNames(platform = process.platform) {
  if (platform === "darwin") return ["yt-dlp_macos"];
  if (platform === "win32") return ["yt-dlp.exe", "yt-dlp_arm64.exe"];
  if (platform === "linux") return ["yt-dlp_linux", "yt-dlp_linux_aarch64"];
  fail(`Unsupported host platform for yt-dlp: ${platform}`);
  return [];
}

function parseArgs(argv, env = process.env) {
  const options = {
    all: false,
    missingOnly: false,
    targets: /** @type {string[]} */ ([]),
    update: /** @type {string | null} */ (null),
    allowUnsignedSums: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") {
      options.all = true;
    } else if (arg === "--missing-only") {
      options.missingOnly = true;
    } else if (arg === "--allow-unsigned-sums") {
      options.allowUnsignedSums = true;
    } else if (arg === "--target") {
      const value = argv[index + 1];
      if (!value || !TARGET_FILES[value]) {
        fail(
          `--target requires one of: ${Object.keys(TARGET_FILES).join(", ")}`,
        );
      }
      options.targets.push(value);
      index += 1;
    } else if (arg === "--update") {
      const value = argv[index + 1];
      if (!value || !VERSION_PATTERN.test(value)) {
        fail(
          "--update requires a yt-dlp version such as 2026.08.19 (invalid version)",
        );
      }
      options.update = value;
      index += 1;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  if (options.allowUnsignedSums && isReleaseEnvironment(env)) {
    fail("--allow-unsigned-sums is not allowed when CI or ROSI_RELEASE is set");
  }
  if (options.update) {
    if (options.allowUnsignedSums) {
      fail("--allow-unsigned-sums is not allowed with --update");
    }
    if (options.all || options.missingOnly || options.targets.length > 0) {
      fail(
        "--update cannot be combined with --all, --missing-only or --target",
      );
    }
  }
  return options;
}

/** @param {{allowUnsignedSums: boolean}} options */
function verifySignedSums(options, sumsPath, sigPath) {
  if (options.allowUnsignedSums) {
    log("WARNING: gpg signature check skipped (--allow-unsigned-sums).");
    return;
  }
  verifySumsSignature({ sumsPath, sigPath });
  log(`SHA2-256SUMS signature verified (${PINNED_FINGERPRINT}).`);
}

function releaseBase(version) {
  return `https://github.com/${REPO}/releases/download/${version}/`;
}

function localMatches(name, manifest) {
  const file = path.join(ASSETS_DIR, name);
  return fs.existsSync(file) && sha256File(file) === manifest.files[name];
}

const FETCH_ATTEMPTS = 3;

/** True for failures worth retrying: network errors, 5xx and hash mismatches. */
function isTransient(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/^HTTP 4\d\d /.test(message)) return false;
  return true;
}

/**
 * Runs `action` up to FETCH_ATTEMPTS times. Only transient failures are
 * retried; the last error is reported with every attempt's message.
 */
async function withRetries(label, action, attempts = FETCH_ATTEMPTS) {
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`attempt ${attempt}: ${message}`);
      if (!isTransient(error) || attempt === attempts) break;
      log(`${label} failed (${message}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw new Error(
    `${label} failed after ${errors.length} attempt(s):\n  ${errors.join("\n  ")}`,
  );
}

async function fetchBinaries(options) {
  const manifest = readManifest();
  let names;
  if (options.all) {
    names = [...FILE_NAMES];
  } else if (options.targets.length > 0) {
    names = [...new Set(options.targets.flatMap((t) => TARGET_FILES[t]))];
  } else {
    names = hostFileNames();
  }
  const work = options.missingOnly
    ? names.filter((name) => !localMatches(name, manifest))
    : names;
  if (work.length === 0) {
    log(
      `All requested binaries already present and verified: ${names.join(", ")}`,
    );
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-sums-"));
  try {
    const sumsPath = path.join(tempDir, "SHA2-256SUMS");
    const sigPath = path.join(tempDir, "SHA2-256SUMS.sig");
    const base = releaseBase(manifest.version);
    log(`Fetching SHA2-256SUMS for ${manifest.version}`);
    await withRetries("Downloading SHA2-256SUMS", () =>
      downloadFile(`${base}SHA2-256SUMS`, sumsPath),
    );
    await withRetries("Downloading SHA2-256SUMS.sig", () =>
      downloadFile(`${base}SHA2-256SUMS.sig`, sigPath),
    );
    verifySignedSums(options, sumsPath, sigPath);
    const sums = parseSums(fs.readFileSync(sumsPath, "utf8"));

    for (const name of work) {
      const upstream = sums.get(name);
      if (!upstream) fail(`SHA2-256SUMS has no entry for ${name}`);
      if (manifest.files[name] !== upstream) {
        fail(
          `${name}: committed manifest (${manifest.files[name]}) disagrees with ` +
            `signed upstream sums (${upstream}). Bump with --update or restore the manifest.`,
        );
      }
      log(`Downloading ${name}`);
      await withRetries(`Downloading ${name}`, () =>
        downloadVerified({
          name,
          url: `${base}${name}`,
          expectedSha256: upstream,
        }),
      );
      log(`Verified ${name} (${upstream})`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Writes a file atomically via a temp file in the same directory. */
function writeAtomic(filePath, contents) {
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, contents);
  fs.renameSync(temp, filePath);
}

/**
 * Bumps the committed manifest to `version` from the signed upstream sums,
 * fetches the matching THIRD_PARTY_LICENSES.txt, and updates the references
 * that name the version. Binaries are NOT downloaded here; they are fetched and
 * verified by `ytdlp:fetch` against the new manifest.
 */
async function updateManifest(version) {
  const old = readManifest();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-update-"));
  try {
    const base = releaseBase(version);
    const sumsPath = path.join(tempDir, "SHA2-256SUMS");
    const sigPath = path.join(tempDir, "SHA2-256SUMS.sig");
    log(`Fetching signed SHA2-256SUMS for ${version}`);
    await downloadFile(`${base}SHA2-256SUMS`, sumsPath);
    await downloadFile(`${base}SHA2-256SUMS.sig`, sigPath);
    verifySumsSignature({ sumsPath, sigPath });
    const sums = parseSums(fs.readFileSync(sumsPath, "utf8"));

    const files = {};
    for (const name of FILE_NAMES) {
      const hash = sums.get(name);
      if (!hash) fail(`Upstream ${version} has no ${name} in SHA2-256SUMS`);
      files[name] = hash;
    }

    const licenseName = `yt-dlp-${version}-THIRD_PARTY_LICENSES.txt`;
    const licensePath = path.join(tempDir, "THIRD_PARTY_LICENSES.txt");
    await downloadFile(
      `https://raw.githubusercontent.com/${REPO}/${version}/THIRD_PARTY_LICENSES.txt`,
      licensePath,
    );
    const licenseSha = sha256File(licensePath);
    writeAtomic(
      path.join(ASSETS_DIR, licenseName),
      fs.readFileSync(licensePath),
    );

    const manifest = {
      _comment:
        "Pinned yt-dlp release. Hashes are copied from the GPG-verified upstream " +
        "SHA2-256SUMS; scripts/fetch-ytdlp.cjs refuses any download that disagrees. " +
        "Bump with: node scripts/fetch-ytdlp.cjs --update <version>",
      version,
      source: `https://github.com/${REPO}/releases/tag/${version}`,
      files,
      license: { file: licenseName, sha256: licenseSha },
    };
    writeAtomic(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

    const followUps = [];
    if (old.license.file !== licenseName) {
      fs.rmSync(path.join(ASSETS_DIR, old.license.file), { force: true });
      replaceOnce(TAURI_CONF_PATH, old.license.file, licenseName);
      followUps.push("src-tauri/tauri.conf.json resource path updated");
    }
    if (fs.existsSync(NOTICES_PATH)) {
      const notices = fs.readFileSync(NOTICES_PATH, "utf8");
      writeAtomic(NOTICES_PATH, notices.split(old.version).join(version));
    }
    log(`Manifest bumped ${old.version} -> ${version}.`);
    log(`License written: assets/${licenseName} (${licenseSha})`);
    for (const item of followUps) log(`Manual/follow-up: ${item}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Replaces exactly one occurrence of `from` in a text file. */
function replaceOnce(filePath, from, to) {
  const text = fs.readFileSync(filePath, "utf8");
  const count = text.split(from).length - 1;
  if (count !== 1) {
    fail(
      `${path.relative(ROOT, filePath)} has ${count} occurrences of ${from}; expected 1`,
    );
  }
  writeAtomic(filePath, text.replace(from, to));
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.update) {
    await updateManifest(options.update);
    return;
  }
  await fetchBinaries(options);
}

module.exports = {
  ASSETS_DIR,
  FILE_NAMES,
  MANIFEST_PATH,
  PINNED_FINGERPRINT,
  PUBLIC_KEY_PATH,
  TARGET_FILES,
  downloadFile,
  downloadVerified,
  isReleaseEnvironment,
  isTransient,
  withRetries,
  parseArgs,
  gpgPath,
  parseSums,
  resolveGpg,
  sha256File,
  verifySumsSignature,
  windowsGitGpgCandidates,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `[ytdlp] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
