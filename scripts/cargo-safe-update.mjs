#!/usr/bin/env node

/* Temporary stable-Cargo fallback. Remove after supported stable Cargo ships
 * global minimum publish age; then restore direct `cargo update` call sites. */

import { execFile, spawnSync } from "node:child_process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createServer } from "node:http";
import { URL, pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const CARGO_SAFE_UPDATE_POLICY_VERSION = 5;
export const CARGO_SAFE_UPDATE_VERSION = 5;
export const MIN_PUBLISH_AGE_MS = 72 * 60 * 60 * 1000;
const CRATES_IO_INDEX = "https://index.crates.io";
const CRATES_IO_REGISTRY_SOURCES = new Set([
  "registry+https://github.com/rust-lang/crates.io-index",
  "registry+sparse+https://index.crates.io",
  "registry+sparse+https://index.crates.io/",
]);
const execFileAsync = promisify(execFile);
const IGNORED_COPY_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "release",
  "coverage",
]);

export function parseArguments(argv) {
  const cargoArgs = [];
  const allowYoung = [];
  const allowGit = [];
  let reason = "";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-young" || argument === "--allow-git") {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires package@value`);
      (argument === "--allow-young" ? allowYoung : allowGit).push(value);
      continue;
    }
    if (argument.startsWith("--allow-young=")) {
      allowYoung.push(argument.slice("--allow-young=".length));
      continue;
    }
    if (argument.startsWith("--allow-git=")) {
      allowGit.push(argument.slice("--allow-git=".length));
      continue;
    }
    if (argument === "--reason") {
      reason = argv[++index] ?? "";
      continue;
    }
    if (argument.startsWith("--reason=")) {
      reason = argument.slice("--reason=".length);
      continue;
    }
    cargoArgs.push(argument);
  }

  if ((allowYoung.length > 0 || allowGit.length > 0) && !reason.trim()) {
    throw new Error("--reason is required with every emergency override");
  }

  return {
    cargoArgs,
    allowYoung: new Set(
      allowYoung.map(parsePackageVersion).map((entry) => entry.key),
    ),
    allowGit: new Set(
      allowGit.map(parsePackageVersion).map((entry) => entry.key),
    ),
    reason: reason.trim(),
    dryRun: cargoArgs.some(
      (argument) => argument === "--dry" || argument === "--dry-run",
    ),
  };
}

function parsePackageVersion(value) {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Expected package@value, got ${value}`);
  }
  return {
    packageName: value.slice(0, separator),
    value: value.slice(separator + 1),
    key: value,
  };
}

export function parsePublishTime(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function isPublishAgeAllowed(publishTime, now = Date.now()) {
  return (
    Number.isFinite(publishTime) &&
    Number.isFinite(now) &&
    now - publishTime >= MIN_PUBLISH_AGE_MS
  );
}

export function crateIndexPath(crateName) {
  const name = crateName.toLowerCase();
  if (name.length === 1) return `1/${name}`;
  if (name.length === 2) return `2/${name}`;
  if (name.length === 3) return `3/${name[0]}/${name}`;
  return `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
}

function run(command, args, { cwd = process.cwd(), env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`,
    );
  }
  return result;
}

async function runAsync(
  command,
  args,
  { cwd = process.cwd(), env = process.env } = {},
) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
    });
  } catch (error) {
    const detail = [error.stdout, error.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`,
      {
        cause: error,
      },
    );
  }
}

function cargoMetadata(cargoArgs, cwd, env) {
  const result = run(
    "cargo",
    [
      "metadata",
      "--locked",
      "--format-version=1",
      ...manifestArguments(cargoArgs),
    ],
    { cwd, env },
  );
  return JSON.parse(result.stdout);
}

function manifestArguments(cargoArgs) {
  for (let index = 0; index < cargoArgs.length; index += 1) {
    const argument = cargoArgs[index];
    if (argument === "--manifest-path") {
      return [argument, cargoArgs[index + 1]];
    }
    if (argument.startsWith("--manifest-path=")) return [argument];
  }
  return [];
}

export function manifestPath(cargoArgs, cwd) {
  for (let index = 0; index < cargoArgs.length; index += 1) {
    const argument = cargoArgs[index];
    if (argument === "--manifest-path") {
      if (!cargoArgs[index + 1])
        throw new Error("--manifest-path requires a value");
      return path.resolve(cwd, cargoArgs[index + 1]);
    }
    if (argument.startsWith("--manifest-path=")) {
      return path.resolve(cwd, argument.slice("--manifest-path=".length));
    }
  }
  return path.join(cwd, "Cargo.toml");
}

export function selectedPackages(metadata) {
  const packages = Array.isArray(metadata.packages) ? metadata.packages : [];
  const nodes = Array.isArray(metadata.resolve?.nodes)
    ? metadata.resolve.nodes
    : [];
  if (nodes.length === 0) return packages;
  const selected = new Set(nodes.map((node) => node.id));
  return packages.filter((pkg) => selected.has(pkg.id));
}

function packageKey(pkg) {
  return `${pkg.name}\u0000${pkg.version}\u0000${pkg.source ?? ""}`;
}

function sourceKind(source) {
  if (!source) return "path";
  if (source.startsWith("registry+")) return "registry";
  if (source.startsWith("git+")) return "git";
  if (source.startsWith("path+")) return "path";
  return "unknown";
}

function gitRevision(source) {
  const hash = source.split("#", 2)[1]?.split("?", 1)[0] ?? "";
  return hash.trim();
}

function packageOverride(set, pkg, value) {
  return set.has(`${pkg.name}@${value}`);
}

export function cargoSupportsTemporaryLockfile(env = process.env) {
  const version = run("cargo", ["--version"], { env }).stdout;
  const match = version.match(/cargo\s+(\d+)\.(\d+)/i);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 97);
}

// P1: Authoritative workspace root via `cargo locate-project --workspace`.
// Fails closed if Cargo cannot determine the workspace root.
// Do NOT fall back silently to dirname(manifest) for ambiguous workspaces.
export function locateWorkspaceRoot(
  manifest,
  cwd = process.cwd(),
  env = process.env,
) {
  const result = run(
    "cargo",
    [
      "locate-project",
      "--workspace",
      "--message-format",
      "plain",
      "--manifest-path",
      manifest,
    ],
    { cwd, env },
  );

  const workspaceManifest = result.stdout.trim();
  if (!workspaceManifest || path.basename(workspaceManifest) !== "Cargo.toml") {
    throw new Error(
      `Unable to determine Cargo workspace root for ${manifest}: cargo locate-project returned unexpected output`,
    );
  }

  return path.dirname(path.resolve(workspaceManifest));
}

// Kept for backward compatibility and for unit tests that construct synthetic workspaces.
// Production flow uses locateWorkspaceRoot() exclusively.
export function findWorkspaceRoot(manifest) {
  let directory = path.dirname(path.resolve(manifest));
  let outermostWorkspace = null;
  while (true) {
    const candidateToml = path.join(directory, "Cargo.toml");
    if (existsSync(candidateToml)) {
      try {
        const contents = readFileSync(candidateToml, "utf8");
        if (/^\[workspace\]/m.test(contents)) {
          outermostWorkspace = directory;
        }
      } catch {
        // ignore read errors
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (outermostWorkspace !== null) return outermostWorkspace;
  return path.dirname(path.resolve(manifest));
}

function copyWorkspace(sourceRoot, destinationRoot) {
  cpSync(sourceRoot, destinationRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source);
      if (!relative) return true;
      const first = relative.split(path.sep)[0];
      if (IGNORED_COPY_DIRECTORIES.has(first)) return false;
      try {
        return !lstatSync(source).isSymbolicLink();
      } catch {
        return false;
      }
    },
  });
}

function rewriteManifestArguments(
  cargoArgs,
  originalCwd,
  copiedRoot,
  sourceRoot,
) {
  const rewritten = [...cargoArgs];
  for (let index = 0; index < rewritten.length; index += 1) {
    if (rewritten[index] === "--manifest-path") {
      const original = path.resolve(originalCwd, rewritten[index + 1]);
      rewritten[index + 1] = path.join(
        copiedRoot,
        path.relative(sourceRoot, original),
      );
    } else if (rewritten[index].startsWith("--manifest-path=")) {
      const original = path.resolve(
        originalCwd,
        rewritten[index].slice("--manifest-path=".length),
      );
      rewritten[index] =
        `--manifest-path=${path.join(copiedRoot, path.relative(sourceRoot, original))}`;
    }
  }
  return rewritten;
}

export function prepareCandidate({
  cargoArgs,
  cwd,
  realLock,
  baselineMetadata,
  tempRoot,
  workspaceRoot,
  cargoEnv = process.env,
}) {
  const useTemporaryLockfile = cargoSupportsTemporaryLockfile(cargoEnv);
  const dryArgs = cargoArgs.filter(
    (argument) => argument !== "--dry" && argument !== "--dry-run",
  );
  if (useTemporaryLockfile) {
    const candidateLock = path.join(tempRoot, "Cargo.lock");
    if (realLock && existsSync(realLock)) {
      copyFileSync(realLock, candidateLock);
    }
    // IMPORTANT: if no existing lockfile, leave candidateLock NONEXISTENT!
    return {
      args: dryArgs,
      cwd,
      env: { ...cargoEnv, CARGO_RESOLVER_LOCKFILE_PATH: candidateLock },
      candidateLock,
      copiedWorkspace: false,
    };
  }

  // Fallback for Cargo < 1.97: copy entire workspace
  const sourceRoot =
    workspaceRoot ??
    baselineMetadata?.workspace_root ??
    path.dirname(manifestPath(cargoArgs, cwd));
  const copiedRoot = path.join(tempRoot, "workspace");
  copyWorkspace(sourceRoot, copiedRoot);
  return {
    args: rewriteManifestArguments(dryArgs, cwd, copiedRoot, sourceRoot),
    cwd: copiedRoot,
    env: cargoEnv,
    candidateLock: path.join(copiedRoot, "Cargo.lock"),
    copiedWorkspace: true,
  };
}

function registryIndexBase(source) {
  const registry = source.slice("registry+".length).replace(/\/$/u, "");
  if (CRATES_IO_REGISTRY_SOURCES.has(source)) return CRATES_IO_INDEX;
  if (registry.startsWith("sparse+")) return registry.slice("sparse+".length);
  return registry;
}

function isCratesIoRegistry(source) {
  return CRATES_IO_REGISTRY_SOURCES.has(source);
}

export function filterRegistryIndex(
  body,
  baseline,
  overrides,
  now = Date.now(),
) {
  const baselineVersions = new Set(
    baseline
      .filter((pkg) => isCratesIoRegistry(pkg.source))
      .map((pkg) => `${pkg.name}@${pkg.version}`),
  );
  const filtered = [];

  for (const line of body.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error("crates.io index returned malformed JSON", {
        cause: error,
      });
    }

    const key = `${record.name}@${record.vers}`;
    const published = parsePublishTime(record.pubtime);
    if (
      baselineVersions.has(key) ||
      overrides.allowYoung.has(key) ||
      isPublishAgeAllowed(published, now)
    ) {
      filtered.push(line);
    }
  }

  return filtered.length > 0 ? `${filtered.join("\n")}\n` : "";
}

async function startCratesIoAgeFilter({
  baseline,
  overrides,
  tempRoot,
  now = Date.now(),
}) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
      }

      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const upstreamUrl = `${CRATES_IO_INDEX}${pathname}`;
      const upstream = await globalThis.fetch(upstreamUrl, {
        headers: { accept: "application/json" },
        signal: globalThis.AbortSignal.timeout(30_000),
      });
      const upstreamBody = await upstream.text();
      if (!upstream.ok) {
        response.writeHead(upstream.status, { "content-type": "text/plain" });
        response.end(request.method === "HEAD" ? undefined : upstreamBody);
        return;
      }

      const body =
        pathname === "/config.json"
          ? upstreamBody
          : filterRegistryIndex(upstreamBody, baseline, overrides, now);
      response.writeHead(200, {
        "content-type": upstream.headers.get("content-type") ?? "text/plain",
        "cache-control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(
        `cargo-safe-update registry filter failed: ${error.message}`,
      );
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to start local crates.io age filter");
  }

  const configPath = path.join(tempRoot, "cargo-age-filter.toml");
  writeFileSync(
    configPath,
    [
      "[source.crates-io]",
      'replace-with = "cargo-safe-age-filter"',
      "",
      "[source.cargo-safe-age-filter]",
      `registry = "sparse+http://127.0.0.1:${address.port}/"`,
      "",
    ].join("\n"),
  );

  return {
    cargoArgs: ["--config", configPath],
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}

async function readRegistryRecord(pkg) {
  if (!isCratesIoRegistry(pkg.source)) {
    throw new Error(`unsupported registry source ${pkg.source}`);
  }
  const url = `${registryIndexBase(pkg.source)}/${crateIndexPath(pkg.name)}`;
  const response = await globalThis.fetch(url, {
    headers: { accept: "application/json" },
    signal: globalThis.AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `registry index returned HTTP ${response.status} for ${url}`,
    );
  const body = await response.text();
  for (const line of body.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.vers === pkg.version) return record;
  }
  throw new Error(
    `registry index has no exact ${pkg.name} ${pkg.version} record at ${url}`,
  );
}

function nowTimestamp() {
  return Date.now();
}

function formatAge(ageMs) {
  const sign = ageMs < 0 ? "-" : "";
  let remaining = Math.abs(ageMs);
  const hours = Math.floor(remaining / (60 * 60 * 1000));
  remaining %= 60 * 60 * 1000;
  const minutes = Math.floor(remaining / (60 * 1000));
  return `${sign}${hours}h ${minutes}m`;
}

export async function validateCandidate(
  baseline,
  candidate,
  overrides,
  now = nowTimestamp(),
) {
  const unsupportedRegistries = candidate.filter(
    (pkg) =>
      sourceKind(pkg.source) === "registry" && !isCratesIoRegistry(pkg.source),
  );
  if (unsupportedRegistries.length > 0) {
    throw new Error(
      [
        "Blocked dependency from unsupported registry:",
        ...unsupportedRegistries.map(
          (pkg) => `${pkg.name} ${pkg.version} ${pkg.source ?? "<missing>"}`,
        ),
        "Only exact canonical crates.io registry sources are allowed.",
        "",
        "Cargo.lock was not modified.",
      ].join("\n"),
    );
  }

  const baselineKeys = new Set(baseline.map(packageKey));
  const baselineByName = new Map();
  for (const pkg of baseline) {
    const values = baselineByName.get(pkg.name) ?? [];
    values.push(pkg.source ?? "");
    baselineByName.set(pkg.name, values);
  }

  const newlySelected = candidate.filter(
    (pkg) => !baselineKeys.has(packageKey(pkg)),
  );
  const violations = [];
  const approved = [];

  for (const pkg of newlySelected) {
    const kind = sourceKind(pkg.source);
    if (kind === "path") continue;

    if (kind === "git") {
      const revision = gitRevision(pkg.source);
      const override = packageOverride(overrides.allowGit, pkg, revision);
      if (!override) {
        const oldSources = baselineByName.get(pkg.name) ?? [];
        violations.push(
          [
            "Blocked Git dependency update:",
            pkg.name,
            oldSources.length > 0 ? oldSources.join(", ") : "<none>",
            pkg.source,
            'Use --allow-git package@commit --reason "..." for one exact update.',
          ].join("\n"),
        );
      } else {
        approved.push(`GIT OVERRIDE ${pkg.name}@${revision}`);
      }
      continue;
    }

    if (kind !== "registry") {
      violations.push(
        `Blocked dependency with unsupported source: ${pkg.name} ${pkg.version} ${pkg.source ?? "<missing>"}`,
      );
      continue;
    }

    if (packageOverride(overrides.allowYoung, pkg, pkg.version)) {
      approved.push(`YOUNG OVERRIDE ${pkg.name} ${pkg.version}`);
      continue;
    }

    try {
      const record = await readRegistryRecord(pkg);
      const published = parsePublishTime(record.pubtime);
      if (published === null) {
        violations.push(
          `Blocked ${pkg.name} ${pkg.version}: registry record has missing or invalid pubtime`,
        );
        continue;
      }
      const age = now - published;
      if (!isPublishAgeAllowed(published, now)) {
        violations.push(
          [
            "BLOCKED: dependency update violates 72-hour publish-age policy",
            `${pkg.name} ${pkg.version}`,
            `published: ${new Date(published).toISOString()}`,
            `age:       ${formatAge(age)}`,
            "required:  72h",
          ].join("\n"),
        );
      } else {
        approved.push(
          `NEW ${pkg.name} ${pkg.version} published ${new Date(published).toISOString()} age ${formatAge(age)}`,
        );
      }
    } catch (error) {
      violations.push(
        `Blocked ${pkg.name} ${pkg.version}: cannot prove publish age (${error.message})`,
      );
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `${violations.join("\n\n")}\n\nCargo.lock was not modified.`,
    );
  }

  return { newlySelected, approved };
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Windows and some filesystems do not allow directory fsync.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeBytesAtomically(targetPath, bytes) {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o666);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, targetPath);
    syncDirectory(path.dirname(targetPath));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function assertOriginalLockUnchanged(targetPath, existed, previousBytes) {
  if (!existed) {
    if (existsSync(targetPath)) {
      throw new Error(
        "Cargo.lock changed since dependency update started; refusing to overwrite it",
      );
    }
    return;
  }

  if (
    previousBytes === null ||
    !existsSync(targetPath) ||
    !readFileSync(targetPath).equals(previousBytes)
  ) {
    throw new Error(
      "Cargo.lock changed since dependency update started; refusing to overwrite it",
    );
  }
}

export function acquireUpdateLock(workspaceRoot) {
  const lockPath = path.join(workspaceRoot, ".cargo-safe-update.lock");
  const owner = `${JSON.stringify({ pid: process.pid, host: os.hostname(), id: randomUUID() })}\n`;
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(descriptor, owner);
    fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      if (existsSync(lockPath)) rmSync(lockPath, { force: true });
    }
    if (error?.code === "EEXIST") {
      throw new Error(`Another Cargo dependency update holds ${lockPath}`, {
        cause: error,
      });
    }
    throw error;
  }
  closeSync(descriptor);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, "utf8") === owner) {
        rmSync(lockPath, { force: true });
      }
    } catch {
      // Never delete a lock whose ownership cannot be verified.
    }
  };
}

function finalMetadata(cargoArgs, cwd, env) {
  return cargoMetadata(cargoArgs, cwd, env);
}

export function installValidatedLock(
  candidateLock,
  originalLockOrPath,
  cargoArgs,
  cwd,
  env = process.env,
) {
  const targetPath =
    typeof originalLockOrPath === "object" &&
    originalLockOrPath !== null &&
    "path" in originalLockOrPath
      ? originalLockOrPath.path
      : originalLockOrPath;
  const existed =
    typeof originalLockOrPath === "object" &&
    originalLockOrPath !== null &&
    "existed" in originalLockOrPath
      ? originalLockOrPath.existed
      : existsSync(targetPath);
  const previousBytes =
    typeof originalLockOrPath === "object" &&
    originalLockOrPath !== null &&
    "bytes" in originalLockOrPath
      ? originalLockOrPath.bytes
      : existed && existsSync(targetPath)
        ? readFileSync(targetPath)
        : null;

  assertOriginalLockUnchanged(targetPath, existed, previousBytes);
  writeBytesAtomically(targetPath, readFileSync(candidateLock));
  try {
    finalMetadata(cargoArgs, cwd, env);
  } catch (error) {
    if (existed && previousBytes !== null) {
      writeBytesAtomically(targetPath, previousBytes);
    } else {
      rmSync(targetPath, { force: true });
    }
    throw new Error(
      `Final Cargo.lock verification failed; original lock restored.\n${error.message}`,
      { cause: error },
    );
  }
}

export function restoreRealLock(realLock, original) {
  if (!realLock && (!original || !original.path)) return;
  const targetPath = realLock || original.path;
  const existed =
    typeof original === "object" && original !== null && "existed" in original
      ? original.existed
      : original !== null && original !== undefined;
  const bytes =
    typeof original === "object" && original !== null && "bytes" in original
      ? original.bytes
      : original;

  if (existed && bytes !== null) {
    if (!existsSync(targetPath) || !readFileSync(targetPath).equals(bytes)) {
      writeBytesAtomically(targetPath, bytes);
    }
  } else {
    if (existsSync(targetPath)) {
      rmSync(targetPath, { force: true });
    }
  }
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const cwd = process.cwd();
  const manifest = manifestPath(parsed.cargoArgs, cwd);
  if (!existsSync(manifest))
    throw new Error(`Cargo manifest not found: ${manifest}`);

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "cargo-safe-update-"));
  const cargoEnv = {
    ...process.env,
    CARGO_HOME: path.join(tempRoot, "cargo-home"),
  };
  let releaseUpdateLock;

  try {
    // Use Cargo's authoritative workspace root determination inside isolated Cargo state.
    const workspaceRoot = locateWorkspaceRoot(manifest, cwd, cargoEnv);
    releaseUpdateLock = acquireUpdateLock(workspaceRoot);
    const destinationLock = path.join(workspaceRoot, "Cargo.lock");
    const originalLock = {
      path: destinationLock,
      existed: existsSync(destinationLock),
      bytes: existsSync(destinationLock) ? readFileSync(destinationLock) : null,
    };
    const baselineMetadata = originalLock.existed
      ? cargoMetadata(parsed.cargoArgs, cwd, cargoEnv)
      : null;
    const baseline = baselineMetadata ? selectedPackages(baselineMetadata) : [];

    const candidate = prepareCandidate({
      cargoArgs: parsed.cargoArgs,
      cwd,
      realLock: originalLock.existed ? originalLock.path : null,
      baselineMetadata,
      tempRoot,
      workspaceRoot,
      cargoEnv,
    });

    let updateResult;
    const ageFilter = await startCratesIoAgeFilter({
      baseline,
      overrides: parsed,
      tempRoot,
    });
    try {
      updateResult = await runAsync(
        "cargo",
        ["update", ...ageFilter.cargoArgs, ...candidate.args],
        {
          cwd: candidate.cwd,
          env: candidate.env,
        },
      );
    } catch (error) {
      restoreRealLock(originalLock.path, originalLock);
      throw error;
    } finally {
      await ageFilter.close();
    }
    if (updateResult.stdout) process.stdout.write(updateResult.stdout);
    if (updateResult.stderr) process.stderr.write(updateResult.stderr);

    // Verify real workspace lock was not created or modified before approval
    if (!originalLock.existed) {
      if (existsSync(originalLock.path)) {
        restoreRealLock(originalLock.path, originalLock);
        throw new Error("Cargo created real Cargo.lock before age approval");
      }
    } else {
      if (
        !existsSync(originalLock.path) ||
        !readFileSync(originalLock.path).equals(originalLock.bytes)
      ) {
        restoreRealLock(originalLock.path, originalLock);
        throw new Error(
          "Cargo modified real Cargo.lock despite temporary-lockfile policy",
        );
      }
    }

    const candidateMetadata = cargoMetadata(
      candidate.args,
      candidate.cwd,
      candidate.env,
    );
    const candidateLock = candidate.candidateLock;
    if (!existsSync(candidateLock)) {
      throw new Error(`Candidate Cargo.lock not found: ${candidateLock}`);
    }

    let validation;
    try {
      validation = await validateCandidate(
        baseline,
        selectedPackages(candidateMetadata),
        parsed,
      );
    } catch (validationError) {
      restoreRealLock(originalLock.path, originalLock);
      throw validationError;
    }

    if (validation.newlySelected.length === 0) {
      console.log("No new dependency versions selected.");
    } else {
      for (const line of validation.approved) console.log(line);
    }

    if (parsed.dryRun) {
      console.log("Dry run: real Cargo.lock was not modified.");
      return;
    }

    installValidatedLock(
      candidateLock,
      originalLock,
      parsed.cargoArgs,
      cwd,
      cargoEnv,
    );
    console.log(`Validated Cargo.lock installed: ${originalLock.path}`);
    if (parsed.reason)
      console.log(`Emergency override reason: ${parsed.reason}`);
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } finally {
      releaseUpdateLock?.();
    }
  }
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  main().catch((error) => {
    console.error(`cargo-safe-update: ${error.message}`);
    process.exitCode = 1;
  });
}
