#!/usr/bin/env node
// Checks the vendored tauri-plugin-updater fork against crates.io and the
// RustSec advisory database. cargo-audit cannot see this crate (path
// dependency, no registry source), so advisories are read from advisory-db.
// Exit 0: no applicable advisory (warnings allowed). Exit 1: an advisory
// applies to the vendored version. Exit 2: an input could not be interpreted.
// Warnings (behind newest 2.x, crates.io or advisory-db unreachable) exit 0
// so unrelated CI runs are not blocked; they are annotated and summarized.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CRATE = "tauri-plugin-updater";
const DEFAULT_ADVISORY_URL = "https://github.com/rustsec/advisory-db.git";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  vendorDir: path.join(root, "src-tauri/vendor", CRATE),
};

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    crateJson: null,
    advisoryDb: null,
    advisoryUrl: DEFAULT_ADVISORY_URL,
    vendorDir: defaults.vendorDir,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--crates-json") options.crateJson = argv[++i];
    else if (arg === "--advisory-db")
      options.advisoryDb = path.resolve(argv[++i] ?? "");
    else if (arg === "--advisory-url") options.advisoryUrl = argv[++i];
    else if (arg === "--vendor-dir")
      options.vendorDir = path.resolve(argv[++i] ?? "");
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (options.advisoryDb && !fs.existsSync(options.advisoryDb))
    throw new UsageError(`--advisory-db does not exist: ${options.advisoryDb}`);
  return options;
}

function annotate(kind, message) {
  // One line per annotation; git error text can span several lines.
  console.log(`::${kind}::${message.replace(/\s*\r?\n\s*/g, " ")}`);
}

function summarize(line) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? null,
  };
}

function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

function vendoredVersion(vendorDir) {
  const manifest = fs.readFileSync(path.join(vendorDir, "Cargo.toml"), "utf8");
  const pkg = /^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(manifest);
  const version = pkg && /^version\s*=\s*"([^"]+)"/m.exec(pkg[1]);
  if (!version)
    throw new UsageError(`no [package] version in ${vendorDir}/Cargo.toml`);
  const parsed = parseVersion(version[1]);
  if (!parsed)
    throw new UsageError(`unparseable vendored version ${version[1]}`);
  return { text: version[1], parsed };
}

async function fetchCrateMetadata(crateJson) {
  if (crateJson) return JSON.parse(fs.readFileSync(crateJson, "utf8"));
  const response = await fetch(`https://crates.io/api/v1/crates/${CRATE}`, {
    headers: {
      "User-Agent":
        "ROSI-check-vendored-updater (https://github.com/BurntToasters/ROSI)",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`crates.io responded ${response.status}`);
  return response.json();
}

function newestTwoX(metadata) {
  if (!Array.isArray(metadata?.versions))
    throw new UsageError("crates.io response has no versions array");
  let newest = null;
  for (const entry of metadata.versions) {
    if (entry.yanked) continue;
    if (!/^2\.\d+\.\d+$/.test(entry.num)) continue;
    const parsed = parseVersion(entry.num);
    if (!parsed) continue;
    if (!newest || compareVersions(parsed, newest.parsed) > 0)
      newest = { text: entry.num, parsed };
  }
  if (!newest)
    throw new UsageError("no stable 2.x versions found in crates.io response");
  return newest;
}

function satisfiesComparator(version, comparator) {
  const match = /^(>=|<=|>|<|=|\^)?\s*(\d+\.\d+\.\d+)$/.exec(comparator.trim());
  if (!match)
    throw new UsageError(
      `unsupported RustSec version requirement: ${comparator}`,
    );
  const op = match[1] ?? "^";
  const target = parseVersion(match[2]);
  const cmp = compareVersions(version, target);
  switch (op) {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
    case "^":
      if (target.major === 0)
        throw new UsageError(
          `caret requirement on 0.x is not supported: ${comparator}`,
        );
      return cmp >= 0 && version.major === target.major;
    default:
      throw new UsageError(`unsupported operator in ${comparator}`);
  }
}

// A range list is OR-ed; one entry may AND comma-separated comparators.
function inRanges(version, ranges) {
  return ranges.some((range) =>
    range
      .split(",")
      .every((comparator) => satisfiesComparator(version, comparator)),
  );
}

/**
 * Reads the TOML front matter of one RustSec advisory. Only the keys this
 * check needs are returned: advisory id/package/withdrawn and the
 * versions.patched and versions.unaffected arrays.
 */
function parseAdvisory(text, file) {
  const block = /^```toml\r?\n([\s\S]*?)^```/m.exec(text);
  if (!block) throw new UsageError(`${file}: no toml front matter`);
  const advisory = { id: null, package: null, withdrawn: false };
  const versions = { patched: [], unaffected: [] };
  let section = null;
  const lines = block[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    const kv = /^(\w+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    let [, key, value] = kv;
    // Arrays may span lines; keep reading until the closing bracket.
    if (value.startsWith("[") && !value.includes("]")) {
      while (i + 1 < lines.length && !lines[i + 1].includes("]")) {
        value += ` ${lines[++i].trim()}`;
      }
      value += ` ${(lines[++i] ?? "").trim()}`;
    }
    const strings = [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
      (m) => m[1],
    );
    if (section === "advisory") {
      if (key === "id") advisory.id = strings[0] ?? null;
      if (key === "package") advisory.package = strings[0] ?? null;
      if (key === "withdrawn") advisory.withdrawn = true;
    } else if (section === "versions" && key in versions) {
      if (!value.startsWith("[")) {
        throw new UsageError(`${file}: versions.${key} is not an array`);
      }
      versions[key] = strings;
    }
  }
  if (!advisory.id) throw new UsageError(`${file}: advisory has no id`);
  if (advisory.package !== CRATE)
    throw new UsageError(
      `${file}: advisory package is ${advisory.package}, not ${CRATE}`,
    );
  return { ...advisory, ...versions, file };
}

/** Returns the advisories that cover the vendored version as affected. */
function applicableAdvisories(dbRoot, vendored) {
  const dir = path.join(dbRoot, "crates", CRATE);
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  const hits = [];
  for (const name of files) {
    const advisory = parseAdvisory(
      fs.readFileSync(path.join(dir, name), "utf8"),
      name,
    );
    if (advisory.withdrawn) continue;
    // Affected unless the vendored version is patched or known unaffected.
    if (inRanges(vendored.parsed, advisory.patched)) continue;
    if (inRanges(vendored.parsed, advisory.unaffected)) continue;
    hits.push(advisory);
  }
  return hits;
}

/**
 * Clones the advisory database sparsely (only crates/tauri-plugin-updater) into
 * a temporary directory. Returns the directory, or throws when the clone fails.
 */
function cloneAdvisoryDb(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rustsec-adb-"));
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const clone = spawnSync(
    "git",
    [
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--filter=blob:none",
      "--sparse",
      url,
      dir,
    ],
    { encoding: "utf8", env, timeout: 180_000 },
  );
  if (clone.status !== 0)
    throw new Error(
      `git clone ${url} failed: ${(clone.stderr || clone.error?.message || "").trim()}`,
    );
  const sparse = spawnSync(
    "git",
    ["-C", dir, "sparse-checkout", "set", path.join("crates", CRATE)],
    { encoding: "utf8", env, timeout: 180_000 },
  );
  if (sparse.status !== 0)
    throw new Error(`sparse checkout failed: ${sparse.stderr.trim()}`);
  return dir;
}

function withAdvisoryDb(options, use) {
  if (options.advisoryDb) return use(options.advisoryDb);
  const dir = cloneAdvisoryDb(options.advisoryUrl);
  try {
    return use(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const vendored = vendoredVersion(options.vendorDir);
  console.log(`vendored ${CRATE} ${vendored.text}`);

  let newest = null;
  try {
    newest = newestTwoX(await fetchCrateMetadata(options.crateJson));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    const message = `could not query crates.io for ${CRATE} (${error.message}); version check skipped`;
    annotate("warning", message);
    summarize(`- WARNING: ${message}`);
  }

  let advisories = [];
  try {
    advisories = withAdvisoryDb(options, (dbRoot) =>
      applicableAdvisories(dbRoot, vendored),
    );
  } catch (error) {
    if (error instanceof UsageError) throw error;
    const message = `RustSec advisory database unavailable (${error.message}); advisory check skipped for ${CRATE} ${vendored.text}`;
    annotate("warning", message);
    summarize(`- WARNING: ${message}`);
  }

  if (newest) console.log(`newest stable 2.x on crates.io: ${newest.text}`);

  if (advisories.length > 0) {
    for (const advisory of advisories) {
      const patched = advisory.patched.join(" | ") || "none";
      annotate(
        "error",
        `${CRATE} ${vendored.text} is affected by ${advisory.id} (patched: ${patched}). Rebase the vendored fork (see PATCHES.md).`,
      );
    }
    return 1;
  }

  if (newest && compareVersions(vendored.parsed, newest.parsed) < 0) {
    annotate(
      "warning",
      `vendored ${CRATE} ${vendored.text} is behind ${newest.text}. Rebase the fork per src-tauri/vendor/${CRATE}/PATCHES.md.`,
    );
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`check-vendored-updater: ${error.message}`);
    process.exitCode = 2;
  },
);
