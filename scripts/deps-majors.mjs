#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const USER_AGENT = "tauri-deps-majors-report";
export const CRATES_IO_INDEX_URL = "https://index.crates.io";
export const FETCH_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 30000;
const MAX_BUFFER = 512 * 1024 * 1024;
const DEFAULT_CARGO_MANIFEST = "src-tauri/Cargo.toml";
const FALLBACK_CARGO_MANIFEST = "Cargo.toml";
export const NPM_OUTDATED_COMMAND =
  process.platform === "win32"
    ? "npm.cmd outdated --json --all=false"
    : "npm outdated --json --all=false";
const CRATES_IO_SOURCES = new Set([
  "registry+https://github.com/rust-lang/crates.io-index",
  "registry+sparse+https://index.crates.io",
  "registry+sparse+https://index.crates.io/",
]);
const CRATE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/u;
const CORE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u;
const PRERELEASE_PATTERN = /^\d+\.\d+\.\d+-/u;
const NPM_EXACT_PIN_PATTERN =
  /^=?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const NPM_SECTIONS = ["dependencies", "devDependencies"];

export function crateIndexPath(name) {
  if (typeof name !== "string" || !CRATE_NAME_PATTERN.test(name)) {
    throw new Error(`invalid crate name: ${JSON.stringify(name)}`);
  }
  const lower = name.toLowerCase();
  if (lower.length === 1) return `1/${lower}`;
  if (lower.length === 2) return `2/${lower}`;
  if (lower.length === 3) return `3/${lower[0]}/${lower}`;
  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

function parseCoreVersion(version) {
  const match = CORE_VERSION_PATTERN.exec(String(version));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function requireCoreVersion(version) {
  const core = parseCoreVersion(version);
  if (!core) throw new Error(`invalid version: ${version}`);
  return core;
}

export function isPrereleaseVersion(version) {
  return PRERELEASE_PATTERN.test(String(version));
}

export function compareVersions(left, right) {
  const a = requireCoreVersion(left);
  const b = requireCoreVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function selectLatestStable(entries) {
  let latest = null;
  for (const release of entries) {
    if (release.yanked === true) continue;
    if (isPrereleaseVersion(release.vers) || !parseCoreVersion(release.vers)) {
      continue;
    }
    if (latest === null || compareVersions(release.vers, latest) > 0) {
      latest = release.vers;
    }
  }
  return latest;
}

export function parseIndexLines(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const release = JSON.parse(line);
      if (typeof release?.vers !== "string") {
        throw new Error(`index line has no version: ${line}`);
      }
      return { vers: release.vers, yanked: release.yanked === true };
    });
}

export function isCargoCompatible(locked, latest) {
  const [lockedMajor, lockedMinor, lockedPatch] = requireCoreVersion(locked);
  const [latestMajor, latestMinor, latestPatch] = requireCoreVersion(latest);
  if (lockedMajor !== latestMajor) return false;
  if (lockedMajor > 0) return true;
  if (lockedMinor !== latestMinor) return false;
  if (lockedMinor > 0) return true;
  return lockedPatch === latestPatch;
}

export function isCratesIoSource(source) {
  return typeof source === "string" && CRATES_IO_SOURCES.has(source);
}

export function isExactRequirement(requirement) {
  return typeof requirement === "string" && requirement.trim().startsWith("=");
}

export function cargoReportLabel(dependency, latest) {
  if (!latest || compareVersions(latest, dependency.locked) <= 0) return null;
  if (isExactRequirement(dependency.requirement)) return "pinned";
  return isCargoCompatible(dependency.locked, latest) ? null : "outside range";
}

function detailSuffix(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed ? `: ${trimmed}` : "";
}

export function runCargoMetadata(manifestPath, run = spawnSync) {
  const result = run(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--all-features",
      "--manifest-path",
      manifestPath,
    ],
    { encoding: "utf8", maxBuffer: MAX_BUFFER, windowsHide: true },
  );
  if (result.error) {
    throw new Error(`could not run cargo: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `cargo metadata failed (exit ${result.status})${detailSuffix(result.stderr)}`,
    );
  }
  try {
    return JSON.parse(String(result.stdout));
  } catch {
    throw new Error("cargo metadata did not print JSON");
  }
}

function aliasOf(declaration) {
  return declaration.rename && declaration.rename !== declaration.name
    ? declaration.rename
    : null;
}

function findLockedPackage(declaration, node, packagesById) {
  const externName = (declaration.rename ?? declaration.name).replaceAll(
    "-",
    "_",
  );
  const kind = declaration.kind ?? "normal";
  const target = declaration.target ?? null;
  for (const edge of node.deps ?? []) {
    if (edge.name !== externName) continue;
    const matchesKind = (edge.dep_kinds ?? []).some(
      (entry) =>
        (entry.kind ?? "normal") === kind && (entry.target ?? null) === target,
    );
    if (!matchesKind) continue;
    const pkg = packagesById.get(edge.pkg);
    if (pkg && pkg.name === declaration.name) return pkg;
  }
  return null;
}

export function collectDirectCargoDependencies(metadata) {
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodesById = new Map(
    metadata.resolve.nodes.map((node) => [node.id, node]),
  );
  const dependencies = [];
  for (const memberId of metadata.workspace_members) {
    const member = packagesById.get(memberId);
    const node = nodesById.get(memberId);
    if (!member || !node) continue;
    for (const declaration of member.dependencies ?? []) {
      if (!isCratesIoSource(declaration.source)) continue;
      const locked = findLockedPackage(declaration, node, packagesById);
      if (!locked || !isCratesIoSource(locked.source)) continue;
      dependencies.push({
        name: declaration.name,
        alias: aliasOf(declaration),
        requirement: declaration.req,
        kind: declaration.kind ?? "normal",
        target: declaration.target ?? null,
        locked: locked.version,
      });
    }
  }
  return dependencies;
}

export function parseArguments(argv) {
  const options = { json: false, manifestPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--manifest-path") {
      const value = argv[index + 1];
      if (!value) throw new Error("--manifest-path requires a path");
      options.manifestPath = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--manifest-path=")) {
      const value = argument.slice("--manifest-path=".length);
      if (!value) throw new Error("--manifest-path requires a path");
      options.manifestPath = value;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export function selectManifestPath(manifestPath, exists = existsSync) {
  if (manifestPath) return manifestPath;
  return exists(DEFAULT_CARGO_MANIFEST)
    ? DEFAULT_CARGO_MANIFEST
    : FALLBACK_CARGO_MANIFEST;
}

export async function mapWithConcurrency(items, limit, worker) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`invalid concurrency: ${limit}`);
  }
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

export async function fetchCrateVersions(name, fetchImpl = globalThis.fetch) {
  const url = `${CRATES_IO_INDEX_URL}/${crateIndexPath(name)}`;
  const response = await fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return parseIndexLines(await response.text());
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareCargoItems(a, b) {
  return (
    compareText(a.name, b.name) ||
    compareText(a.kind, b.kind) ||
    compareText(a.target ?? "", b.target ?? "") ||
    compareText(a.locked, b.locked)
  );
}

export async function collectCargoReport({
  dependencies,
  fetchVersions = fetchCrateVersions,
  concurrency = FETCH_CONCURRENCY,
}) {
  const names = [...new Set(dependencies.map((dependency) => dependency.name))];
  const outcomes = await mapWithConcurrency(
    names,
    concurrency,
    async (name) => {
      try {
        const latest = selectLatestStable(await fetchVersions(name));
        return latest === null
          ? {
              name,
              latest: null,
              error: "no stable, non-yanked release in the index",
            }
          : { name, latest, error: null };
      } catch (error) {
        return { name, latest: null, error: error.message };
      }
    },
  );
  if (
    outcomes.length > 0 &&
    outcomes.every((outcome) => outcome.error !== null)
  ) {
    throw new Error(
      `could not reach the crates.io index: ${outcomes[0].error}`,
    );
  }
  const latestByName = new Map(
    outcomes
      .filter((outcome) => outcome.error === null)
      .map((outcome) => [outcome.name, outcome.latest]),
  );
  const errors = outcomes
    .filter((outcome) => outcome.error !== null)
    .map((outcome) => ({
      source: "cargo",
      name: outcome.name,
      message: outcome.error,
    }));
  const items = new Map();
  for (const dependency of dependencies) {
    const latest = latestByName.get(dependency.name);
    const label = cargoReportLabel(dependency, latest);
    if (label === null) continue;
    const item = {
      name: dependency.name,
      alias: dependency.alias,
      requirement: dependency.requirement,
      kind: dependency.kind,
      target: dependency.target,
      locked: dependency.locked,
      latest,
      label,
    };
    items.set(JSON.stringify(Object.values(item)), item);
  }
  return {
    cargo: [...items.values()].sort(compareCargoItems),
    errors,
  };
}

export function isNpmExactPin(spec) {
  return typeof spec === "string" && NPM_EXACT_PIN_PATTERN.test(spec.trim());
}

export function buildNpmItems(outdated, packageJson) {
  return Object.entries(outdated)
    .filter(
      ([, info]) =>
        typeof info?.latest === "string" && info.latest !== info.wanted,
    )
    .map(([name, info]) => {
      const kind =
        NPM_SECTIONS.find(
          (section) => packageJson[section]?.[name] !== undefined,
        ) ?? null;
      const requirement = kind ? packageJson[kind][name] : null;
      return {
        name,
        requirement,
        kind,
        current: info.current ?? null,
        wanted: info.wanted ?? null,
        latest: info.latest,
        label: isNpmExactPin(requirement) ? "pinned" : "outside range",
      };
    })
    .sort((a, b) => compareText(a.name, b.name));
}

export function parseNpmOutdatedResult(result) {
  const stderr = String(result.stderr ?? "");
  if (result.error) {
    throw new Error(`could not run npm outdated: ${result.error.message}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `npm outdated failed (exit ${result.status})${detailSuffix(stderr)}`,
    );
  }
  const stdout = String(result.stdout ?? "").trim();
  if (stdout === "") {
    throw new Error(`npm outdated printed no report${detailSuffix(stderr)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`npm outdated did not print JSON${detailSuffix(stderr)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("npm outdated printed an unexpected report");
  }
  if (parsed.error?.code) {
    throw new Error(`npm outdated reported an error: ${parsed.error.code}`);
  }
  return parsed;
}

export function readNpmOutdated(run = spawnSync) {
  return parseNpmOutdatedResult(
    run(NPM_OUTDATED_COMMAND, {
      shell: true,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    }),
  );
}

function formatTable(headers, rows, indent) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => String(row[column]).length)),
  );
  const render = (cells) =>
    `${indent}${cells
      .map((cell, column) => String(cell).padEnd(widths[column]))
      .join("  ")
      .trimEnd()}`;
  return [render(headers), ...rows.map(render)];
}

function cargoDisplayName(item) {
  return item.alias ? `${item.name} (as ${item.alias})` : item.name;
}

function cargoKindLabel(item) {
  return item.target ? `${item.kind}, ${item.target}` : item.kind;
}

export function formatTextReport(report, { manifestPath }) {
  const lines = [`Cargo dependencies (${manifestPath})`];
  if (report.cargo.length === 0) {
    lines.push(
      "  No Cargo dependencies are outside their declared requirements.",
    );
  } else {
    lines.push(
      ...formatTable(
        ["Name", "Requirement", "Kind", "Locked", "Latest", "Label"],
        report.cargo.map((item) => [
          cargoDisplayName(item),
          item.requirement,
          cargoKindLabel(item),
          item.locked,
          item.latest,
          item.label,
        ]),
        "  ",
      ),
    );
  }
  lines.push("", "npm dependencies (package.json)");
  if (report.npm.length === 0) {
    lines.push(
      "  No npm dependencies are outside their declared requirements.",
    );
  } else {
    lines.push(
      ...formatTable(
        ["Name", "Requirement", "Section", "Current", "Latest", "Label"],
        report.npm.map((item) => [
          item.name,
          item.requirement ?? "-",
          item.kind ?? "-",
          item.current ?? "-",
          item.latest,
          item.label,
        ]),
        "  ",
      ),
    );
  }
  if (report.errors.length > 0) {
    lines.push("", "Errors:");
    for (const error of report.errors) {
      lines.push(`  ${error.source} ${error.name}: ${error.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function isEntryPoint(moduleUrl, entryArgument) {
  return (
    typeof entryArgument === "string" &&
    moduleUrl === pathToFileURL(entryArgument).href
  );
}

function readPackageJson() {
  return JSON.parse(readFileSync("package.json", "utf8"));
}

async function buildReport(manifestPath) {
  const metadata = runCargoMetadata(manifestPath);
  const cargoReport = await collectCargoReport({
    dependencies: collectDirectCargoDependencies(metadata),
  });
  const npm = buildNpmItems(readNpmOutdated(), readPackageJson());
  return { cargo: cargoReport.cargo, npm, errors: cargoReport.errors };
}

async function main(argv) {
  const options = parseArguments(argv);
  const manifestPath = selectManifestPath(options.manifestPath);
  const report = await buildReport(manifestPath);
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatTextReport(report, { manifestPath }),
  );
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`deps-majors: ${error.message}`);
    process.exitCode = 1;
  });
}
