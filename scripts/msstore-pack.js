#!/usr/bin/env node
/**
 * Packs the no-bundle Microsoft Store exe, sidecars and resources into an MSIX
 * per architecture, then bundles both into one .msixbundle for Partner Center.
 * Run on Windows with the Windows SDK (makeappx.exe). Partner Center signs the
 * bundle; Store packages are stable-only. See build-setup.md, Microsoft Store.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const srcTauriDir = path.join(root, "src-tauri");
const TAURI_CONF = path.join(srcTauriDir, "tauri.conf.json");
const CARGO_TOML = path.join(srcTauriDir, "Cargo.toml");
const ASSETS_DIR = path.join(srcTauriDir, "msstore-assets");
const MANIFEST_TEMPLATE = path.join(ASSETS_DIR, "AppxManifest.xml");
const BINARIES_DIR = path.join(srcTauriDir, "binaries");
const MSSTORE_DIR = path.join(root, "msstore");

// ROSI 4's last Store package version. A Store version must be greater.
export const STORE_BASELINE_VERSION = "4.4.1.0";
export const SIDECAR_NAMES = ["rosi-yt-dlp", "rosi-ffmpeg", "rosi-ffprobe"];
export const STUB_MARKER = "ROSI-SIDECAR-STUB";
export const ARCHES = {
  x64: { msixArch: "x64", rustTarget: "x86_64-pc-windows-msvc" },
  arm64: { msixArch: "arm64", rustTarget: "aarch64-pc-windows-msvc" },
};
const USAGE = "Usage: msstore-pack.js [x64|arm64] [--allow-prerelease]";
const STORE_ENV = {
  MSSTORE_IDENTITY_NAME:
    "Identity name from Partner Center (ROSI 4: BurntToasters.ROSI)",
  MSSTORE_PUBLISHER:
    "Publisher CN from Partner Center (ROSI 4: CN=BC0CB990-55E8-4580-97B7-1E2DAA4B44F6)",
  MSSTORE_PUBLISHER_DISPLAY_NAME:
    "Publisher display name (ROSI 4: BurntToasters)",
};

export function nonWindowsMessage(platform = process.platform) {
  return (
    `MSIX packaging must run on Windows with the Windows SDK (makeappx.exe). ` +
    `This host is ${platform}. Run npm run build:msstore on a Windows machine.`
  );
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function compareStoreVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 4; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

// Maps a stable X.Y.Z to the Store's X.Y.Z.0 (revision must be 0).
export function toStoreVersion(version, { allowPrerelease = false } = {}) {
  const match = SEMVER.exec(String(version ?? "").trim());
  if (!match) {
    throw new Error(`Store package version must be X.Y.Z (got "${version}").`);
  }
  if (match[4] !== undefined && !allowPrerelease) {
    throw new Error(
      `Microsoft Store packages must be stable releases, but "${version}" is a prerelease. ` +
        `--allow-prerelease is for local packaging tests only; never submit that package.`,
    );
  }
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => part > 65535)) {
    throw new Error(
      `Store version components must be 65535 or lower (got "${version}").`,
    );
  }
  const storeVersion = `${parts.join(".")}.0`;
  if (compareStoreVersions(storeVersion, STORE_BASELINE_VERSION) <= 0) {
    throw new Error(
      `Store version ${storeVersion} must be greater than the ROSI 4 Store version ${STORE_BASELINE_VERSION}.`,
    );
  }
  return storeVersion;
}

export function parseArgs(argv) {
  let arch = null;
  let allowPrerelease = false;
  for (const arg of argv) {
    if (arg === "--allow-prerelease") {
      allowPrerelease = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}. ${USAGE}`);
    } else if (arch !== null) {
      throw new Error(
        `Only one architecture may be given (got ${arch} and ${arg}). ${USAGE}`,
      );
    } else if (!Object.hasOwn(ARCHES, arg)) {
      throw new Error(
        `Unknown architecture: ${arg}. Use x64 or arm64. ${USAGE}`,
      );
    } else {
      arch = arg;
    }
  }
  return { arch, allowPrerelease };
}

export function readStoreEnv(env = process.env) {
  const values = {};
  const missing = [];
  for (const [key, description] of Object.entries(STORE_ENV)) {
    const value = String(env[key] ?? "").trim();
    if (value) values[key] = value;
    else missing.push(`  ${key}: ${description}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing Microsoft Store environment variables:\n${missing.join("\n")}\nSet them in .env (see .env.example).`,
    );
  }
  const identityName = values.MSSTORE_IDENTITY_NAME;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(identityName)) {
    throw new Error(
      `MSSTORE_IDENTITY_NAME may contain only letters, digits, "." and "-" (got "${identityName}").`,
    );
  }
  const publisher = values.MSSTORE_PUBLISHER;
  if (!publisher.startsWith("CN=")) {
    throw new Error(
      `MSSTORE_PUBLISHER must start with CN= (got "${publisher}").`,
    );
  }
  return {
    identityName,
    publisher,
    publisherDisplayName: values.MSSTORE_PUBLISHER_DISPLAY_NAME,
  };
}

export function escapeXml(value) {
  const entities = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  };
  return String(value).replace(/[&<>"']/g, (char) => entities[char]);
}

export function renderManifest(template, values) {
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`Manifest template placeholder {{${key}}} has no value.`);
    }
    return escapeXml(values[key]);
  });
  const leftover = /\{\{[^}]*\}\}/.exec(rendered);
  if (leftover) {
    throw new Error(
      `Manifest still contains template text after rendering: ${leftover[0]}`,
    );
  }
  return rendered;
}

// Asset references in the manifest, such as Assets\StoreLogo.png.
export function manifestAssetRefs(manifestXml) {
  return [
    ...new Set(
      [...manifestXml.matchAll(/Assets\\[^"<\s]+?\.png/g)].map((m) => m[0]),
    ),
  ];
}

export function assertManifestAssets(manifestXml, packDir) {
  const missing = manifestAssetRefs(manifestXml).filter(
    (ref) => !fs.existsSync(path.join(packDir, ...ref.split("\\"))),
  );
  if (missing.length > 0) {
    throw new Error(
      `Manifest references assets missing from the package: ${missing.join(", ")}`,
    );
  }
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function isPngBytes(bytes) {
  return (
    bytes.length >= PNG_SIGNATURE.length &&
    bytes.subarray(0, 8).equals(PNG_SIGNATURE)
  );
}

// PNG files in dir, sorted. Any .png that is not really a PNG is an error.
export function listPngAssets(dir) {
  const names = fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".png"))
    .sort();
  const invalid = names.filter(
    (name) => !isPngBytes(fs.readFileSync(path.join(dir, name))),
  );
  if (invalid.length > 0) {
    throw new Error(`Not valid PNG files: ${invalid.join(", ")}`);
  }
  return names;
}

export function sidecarFileName(name, rustTarget) {
  return `${name}-${rustTarget}.exe`;
}

// Same rule as src-tauri/build.rs: a small file that contains the marker.
export function isStubBytes(bytes) {
  return bytes.length < 4096 && bytes.toString("utf8").includes(STUB_MARKER);
}

export function planSidecars({ binariesDir, rustTarget, manifest }) {
  const plan = [];
  const problems = [];
  for (const name of SIDECAR_NAMES) {
    const fileName = sidecarFileName(name, rustTarget);
    const from = path.join(binariesDir, fileName);
    const entry = manifest?.[fileName];
    if (!entry) {
      problems.push(
        `${fileName}: not in .sidecar-manifest.json (run npm run prepare:sidecars)`,
      );
      continue;
    }
    if (entry.stub === true) {
      problems.push(
        `${fileName}: development stub (manifest stub: true); run npm run prepare:sidecars with real FFmpeg`,
      );
      continue;
    }
    if (!fs.existsSync(from)) {
      problems.push(
        `${fileName}: missing from ${binariesDir} (run npm run prepare:sidecars)`,
      );
      continue;
    }
    const bytes = fs.readFileSync(from);
    if (isStubBytes(bytes)) {
      problems.push(`${fileName}: contains the ${STUB_MARKER} stub marker`);
      continue;
    }
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (typeof entry.sha256 !== "string" || entry.sha256 !== digest) {
      problems.push(
        `${fileName}: sha256 does not match the prepared sidecar manifest`,
      );
      continue;
    }
    plan.push({ name, from, to: `${name}.exe` });
  }
  if (problems.length > 0) {
    throw new Error(
      `Sidecars are not ready for ${rustTarget}:\n  ${problems.join("\n  ")}`,
    );
  }
  return plan;
}

// Maps tauri.conf.json bundle.resources (source relative to src-tauri, dest
// relative to the exe folder) onto the pack folder.
export function planResources({ tauriConf, srcTauriDir: sourceRoot, packDir }) {
  const resources = tauriConf?.bundle?.resources;
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
    throw new Error(
      "tauri.conf.json bundle.resources must be an object map of source to destination.",
    );
  }
  const plan = [];
  const problems = [];
  for (const [source, dest] of Object.entries(resources)) {
    if (typeof dest !== "string" || !dest.trim()) {
      problems.push(`${source}: destination must be a non-empty string`);
      continue;
    }
    if (
      path.isAbsolute(dest) ||
      /^[\\/]/.test(dest) ||
      /^[A-Za-z]:/.test(dest) ||
      dest.split(/[\\/]+/).includes("..")
    ) {
      problems.push(
        `${source}: destination ${dest} must stay inside the app folder`,
      );
      continue;
    }
    const from = path.resolve(sourceRoot, source);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) {
      problems.push(`${source}: resource file missing (expected ${from})`);
      continue;
    }
    plan.push({ from, rel: dest, to: path.join(packDir, dest) });
  }
  if (problems.length > 0) {
    throw new Error(`Resources are not ready:\n  ${problems.join("\n  ")}`);
  }
  return plan;
}

export function cargoPackageName(cargoToml) {
  let inPackage = false;
  for (const line of cargoToml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      inPackage = line.trim() === "[package]";
    } else if (inPackage) {
      const match = /^\s*name\s*=\s*"([^"]+)"/.exec(line);
      if (match) return match[1];
    }
  }
  throw new Error(
    "Could not read the [package] name from src-tauri/Cargo.toml.",
  );
}

function listSubdirectories(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function whereOnPath() {
  try {
    const out = execFileSync("where.exe", ["makeappx.exe"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (
      out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? null
    );
  } catch {
    return null;
  }
}

function compareSdkVersionsDesc(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function locateMakeappx({
  platform = process.platform,
  programFiles = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
  findOnPath = whereOnPath,
  exists = fs.existsSync,
  listDirs = listSubdirectories,
} = {}) {
  if (platform !== "win32") throw new Error(nonWindowsMessage(platform));
  const onPath = findOnPath();
  if (onPath) return onPath;
  const binRoot = path.win32.join(programFiles, "Windows Kits", "10", "bin");
  const versions = listDirs(binRoot)
    .filter((name) => /^\d+(\.\d+)+$/.test(name))
    .sort(compareSdkVersionsDesc);
  for (const version of versions) {
    const candidate = path.win32.join(binRoot, version, "x64", "makeappx.exe");
    if (exists(candidate)) return candidate;
  }
  throw new Error(
    "makeappx.exe was not found. Install the Windows SDK (Windows 10 SDK 10.0.19041 or later) " +
      "or put makeappx.exe on PATH.",
  );
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function removeIfExists(file) {
  fs.rmSync(file, { recursive: true, force: true });
}

function readSidecarManifest() {
  const file = path.join(BINARIES_DIR, ".sidecar-manifest.json");
  return fs.existsSync(file) ? readJson(file) : {};
}

function run(command, args) {
  console.log(
    `> ${command} ${args.map((arg) => JSON.stringify(arg)).join(" ")}`,
  );
  execFileSync(command, args, { stdio: "inherit", cwd: root });
}

export function main(argv = process.argv.slice(2), env = process.env) {
  if (process.platform !== "win32") throw new Error(nonWindowsMessage());
  const { arch, allowPrerelease } = parseArgs(argv);
  const tauriConf = readJson(TAURI_CONF);
  const version = toStoreVersion(tauriConf.version, { allowPrerelease });
  const identity = readStoreEnv(env);
  const makeappx = locateMakeappx();
  const exeName = `${cargoPackageName(fs.readFileSync(CARGO_TOML, "utf8"))}.exe`;
  const template = fs.readFileSync(MANIFEST_TEMPLATE, "utf8");
  const sidecarManifest = readSidecarManifest();
  if (allowPrerelease) {
    console.warn(
      `[msstore-pack] LOCAL TEST PACKAGE: ${tauriConf.version} is packed as ${version}. Do not submit it to Partner Center.`,
    );
  }

  // Plan every architecture before touching msstore/, so bad inputs leave no output.
  const jobs = (arch ? [arch] : Object.keys(ARCHES)).map((name) => {
    const { msixArch, rustTarget } = ARCHES[name];
    const exe = path.join(
      srcTauriDir,
      "target",
      rustTarget,
      "release",
      exeName,
    );
    if (!fs.existsSync(exe)) {
      throw new Error(
        `Built exe not found: ${exe}. Run npm run build:msstore:win:${name} first.`,
      );
    }
    const packDir = path.join(MSSTORE_DIR, `pack-${name}`);
    const manifestXml = renderManifest(template, {
      IDENTITY_NAME: identity.identityName,
      PUBLISHER: identity.publisher,
      PUBLISHER_DISPLAY_NAME: identity.publisherDisplayName,
      VERSION: version,
      ARCH: msixArch,
      DESCRIPTION: tauriConf.bundle.shortDescription,
      EXECUTABLE: exeName,
    });
    return {
      name,
      packDir,
      exe,
      manifestXml,
      sidecars: planSidecars({
        binariesDir: BINARIES_DIR,
        rustTarget,
        manifest: sidecarManifest,
      }),
      resources: planResources({ tauriConf, srcTauriDir, packDir }),
      msix: path.join(MSSTORE_DIR, `ROSI_${version}_${name}.msix`),
    };
  });

  fs.mkdirSync(MSSTORE_DIR, { recursive: true });
  // Any new .msix makes an older bundle stale, so both go first.
  removeIfExists(path.join(MSSTORE_DIR, `ROSI_${version}.msixbundle`));
  for (const job of jobs) {
    removeIfExists(job.msix);
    removeIfExists(job.packDir);
    fs.mkdirSync(path.join(job.packDir, "Assets"), { recursive: true });
    try {
      fs.copyFileSync(job.exe, path.join(job.packDir, exeName));
      for (const sidecar of job.sidecars) {
        fs.copyFileSync(sidecar.from, path.join(job.packDir, sidecar.to));
      }
      for (const resource of job.resources) {
        fs.mkdirSync(path.dirname(resource.to), { recursive: true });
        fs.copyFileSync(resource.from, resource.to);
      }
      for (const png of listPngAssets(ASSETS_DIR)) {
        fs.copyFileSync(
          path.join(ASSETS_DIR, png),
          path.join(job.packDir, "Assets", png),
        );
      }
      fs.writeFileSync(
        path.join(job.packDir, "AppxManifest.xml"),
        job.manifestXml,
        "utf8",
      );
      assertManifestAssets(job.manifestXml, job.packDir);
      run(makeappx, ["pack", "/d", job.packDir, "/p", job.msix, "/nv"]);
      if (!fs.existsSync(job.msix))
        throw new Error(`makeappx did not create ${job.msix}`);
      console.log(`Created: ${path.basename(job.msix)}`);
    } finally {
      removeIfExists(job.packDir);
    }
  }

  if (jobs.length === Object.keys(ARCHES).length) {
    const bundleName = `ROSI_${version}.msixbundle`;
    const bundleInput = path.join(MSSTORE_DIR, "bundle-input");
    removeIfExists(bundleInput);
    fs.mkdirSync(bundleInput, { recursive: true });
    try {
      for (const job of jobs)
        fs.copyFileSync(
          job.msix,
          path.join(bundleInput, path.basename(job.msix)),
        );
      run(makeappx, [
        "bundle",
        "/d",
        bundleInput,
        "/p",
        path.join(MSSTORE_DIR, bundleName),
      ]);
    } finally {
      removeIfExists(bundleInput);
    }
    console.log(`Created bundle: ${bundleName}`);
  } else {
    console.log(
      "Single-architecture run: no .msixbundle. Run npm run build:msstore for the bundle.",
    );
  }
  console.log(`\nPackages are in: ${MSSTORE_DIR}`);
  console.log(
    "Upload the .msixbundle to Partner Center. Partner Center signs it. Store packages are stable-only.",
  );
}

function isDirectExecution() {
  return Boolean(
    process.argv[1] &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url,
  );
}

if (isDirectExecution()) {
  try {
    main();
  } catch (error) {
    console.error(
      `[msstore-pack] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
