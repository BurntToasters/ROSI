#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
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
import { fileURLToPath, pathToFileURL } from "node:url";

import npmCli from "./npm-cli.cjs";

const { npmInvocation } = npmCli;
const npmDevAuditScript = fileURLToPath(
  new URL("./npm-dev-audit.cjs", import.meta.url),
);

export const MINIMUM_NPM_VERSION = "12.0.1";
export const SUPPORTED_NODE_VERSIONS = "^22.22.2 || ^24.15.0 || >=26.0.0";

export function readPinnedRustToolchain(root) {
  const filePath = path.join(root, "rust-toolchain.toml");
  let contents;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Rust toolchain pin is missing: ${filePath}`, {
        cause: error,
      });
    }
    throw error;
  }

  const channel = contents.match(/^\s*channel\s*=\s*"([^"]+)"\s*$/mu)?.[1];
  if (!channel || !/^\d+\.\d+\.\d+$/u.test(channel)) {
    throw new Error(
      `rust-toolchain.toml must pin an exact Rust version; found ${channel || "no channel"}`,
    );
  }
  return channel;
}

export function parseVersion(value) {
  const match = String(value)
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return match.slice(1).map(Number);
}

export function isVersionAtLeast(value, minimum) {
  const current = parseVersion(value);
  const required = parseVersion(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (current[index] > required[index]) return true;
    if (current[index] < required[index]) return false;
  }
  return true;
}

export function isSupportedNodeVersion(value) {
  const [major] = parseVersion(value);
  if (major === 22) return isVersionAtLeast(value, "22.22.2");
  if (major === 24) return isVersionAtLeast(value, "24.15.0");
  return major >= 26;
}

export function hasRustToolchain(output, toolchain) {
  if (!/^\d+\.\d+\.\d+$/u.test(String(toolchain))) return false;
  return String(output)
    .split(/\r?\n/u)
    .some(
      (line) =>
        line === toolchain ||
        line.startsWith(`${toolchain}-`) ||
        line.startsWith(`${toolchain} `),
    );
}

export function npmUpdateArguments(cachePath) {
  return [
    "update",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--min-release-age=3",
    `--cache=${cachePath}`,
  ];
}

export function assertVendoredUpdaterParity(root, lockBytes) {
  const packageJson = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const declared = packageJson.dependencies?.["@tauri-apps/plugin-updater"];
  const vendorManifestPath = path.join(
    root,
    "src-tauri",
    "vendor",
    "tauri-plugin-updater",
    "Cargo.toml",
  );
  if (!declared && !existsSync(vendorManifestPath)) return;
  const vendorManifest = readFileSync(vendorManifestPath, "utf8");
  const packageStart = vendorManifest.indexOf("[package]");
  const packageEnd = vendorManifest.indexOf("\n[", packageStart + 1);
  const packageSection = vendorManifest.slice(
    packageStart,
    packageEnd === -1 ? undefined : packageEnd,
  );
  const vendored = packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/mu)?.[1];
  const lock = JSON.parse(lockBytes.toString("utf8"));
  const locked =
    lock.packages?.["node_modules/@tauri-apps/plugin-updater"]?.version;

  if (!vendored) {
    throw new Error("Cannot read the vendored tauri-plugin-updater version");
  }
  if (declared !== vendored) {
    throw new Error(
      `@tauri-apps/plugin-updater must be pinned exactly to vendored Rust version ${vendored}; found ${declared || "missing"}`,
    );
  }
  if (locked !== vendored) {
    throw new Error(
      `Updated package-lock resolved @tauri-apps/plugin-updater ${locked || "missing"}; vendored Rust version is ${vendored}`,
    );
  }
}

export function npmAuditPlan(root, cachePath, npm) {
  return [
    {
      command: npm.command,
      args: [
        ...npm.prefixArgs,
        "audit",
        "--omit=dev",
        "--audit-level=high",
        "--ignore-scripts",
        `--cache=${cachePath}`,
      ],
    },
    {
      command: process.execPath,
      args: [npmDevAuditScript, "--root", root],
    },
  ];
}

export function npmUpdateInvocation(options = {}) {
  try {
    return npmInvocation(options);
  } catch (error) {
    const platform = options.platform ?? process.platform;
    if (
      platform === "win32" &&
      /npm_execpath is unavailable/u.test(String(error?.message || error))
    ) {
      const env = options.env ?? process.env;
      const execPath = options.execPath ?? process.execPath;
      const prefixes = [
        String(env.npm_config_prefix || "").trim(),
        env.APPDATA ? path.join(env.APPDATA, "npm") : "",
        path.dirname(execPath),
      ].filter(Boolean);
      for (const prefix of prefixes) {
        const cliPath = path.join(
          prefix,
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        );
        if (existsSync(cliPath)) {
          return { command: execPath, prefixArgs: [cliPath] };
        }
      }
      return { command: "npm.cmd", prefixArgs: [] };
    }
    throw error;
  }
}

export function usesWindowsCmdShell(command) {
  return process.platform === "win32" && /\.cmd$/i.test(String(command));
}

function run(
  command,
  args,
  { cwd = process.cwd(), env = process.env, capture = false } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    shell: usesWindowsCmdShell(command),
    windowsHide: true,
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture
      ? [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
      : "";
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}${detail ? `\n${detail}` : ""}`,
    );
  }
  return capture ? result.stdout.trim() : "";
}

function readSnapshot(filePath) {
  try {
    return { existed: true, bytes: readFileSync(filePath) };
  } catch (error) {
    if (error?.code === "ENOENT") return { existed: false, bytes: null };
    throw error;
  }
}

function snapshotMatches(filePath, snapshot) {
  const current = readSnapshot(filePath);
  return (
    current.existed === snapshot.existed &&
    (!current.existed || current.bytes.equals(snapshot.bytes))
  );
}

export function restoreSnapshot(filePath, snapshot, expectedCurrent = null) {
  if (expectedCurrent && !snapshotMatches(filePath, expectedCurrent)) {
    throw new Error(
      "Concurrent package-lock edit detected; refusing to overwrite " +
        filePath,
    );
  }
  if (!snapshot.existed) {
    if (existsSync(filePath)) rmSync(filePath, { force: true });
    return;
  }

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.restore`;
  writeFileSync(temporaryPath, snapshot.bytes, { flag: "wx" });
  try {
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function acquireUpdateLock(root) {
  const lockPath = path.join(root, ".npm-safe-update.lock");
  const owner = `${process.pid}:${randomUUID()}\n`;
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(descriptor, owner);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      if (existsSync(lockPath)) rmSync(lockPath, { force: true });
    }
    if (error?.code === "EEXIST") {
      throw new Error(`Another npm dependency update holds ${lockPath}`, {
        cause: error,
      });
    }
    throw error;
  }
  closeSync(descriptor);
  return () => {
    if (existsSync(lockPath) && readFileSync(lockPath, "utf8") === owner) {
      rmSync(lockPath, { force: true });
    }
  };
}

export function assertUpdateEnvironment() {
  const nodeVersion = process.versions.node;
  if (!isSupportedNodeVersion(nodeVersion)) {
    throw new Error(
      `Node.js ${SUPPORTED_NODE_VERSIONS} required; found ${nodeVersion}`,
    );
  }

  const npm = npmUpdateInvocation();
  const npmVersion = run(npm.command, [...npm.prefixArgs, "--version"], {
    capture: true,
  });
  if (!isVersionAtLeast(npmVersion, MINIMUM_NPM_VERSION)) {
    throw new Error(
      `npm ${MINIMUM_NPM_VERSION}+ required; found ${npmVersion}`,
    );
  }

  const rustToolchains = run("rustup", ["toolchain", "list"], {
    capture: true,
  });
  const updaterRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const rustToolchain = readPinnedRustToolchain(updaterRoot);
  if (!hasRustToolchain(rustToolchains, rustToolchain)) {
    throw new Error(
      `Rust ${rustToolchain} must already be installed before updating dependencies`,
    );
  }
}

function main() {
  assertUpdateEnvironment();
  const root = process.cwd();
  const npm = npmUpdateInvocation();
  const packageLock = path.join(root, "package-lock.json");
  const releaseUpdateLock = acquireUpdateLock(root);
  let tempRoot;

  try {
    const snapshot = readSnapshot(packageLock);
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "npm-safe-update-"));
    const cachePath = path.join(tempRoot, "cache");
    const env = {
      ...process.env,
      npm_config_cache: cachePath,
      npm_config_ignore_scripts: "true",
      npm_config_min_release_age: "3",
    };
    if (
      process.platform === "win32" &&
      npm.command === process.execPath &&
      npm.prefixArgs[0]
    ) {
      env.npm_execpath = npm.prefixArgs[0];
    }

    try {
      run(npm.command, [...npm.prefixArgs, ...npmUpdateArguments(cachePath)], {
        cwd: root,
        env,
      });
    } catch (error) {
      restoreSnapshot(packageLock, snapshot);
      throw error;
    }

    const candidate = readSnapshot(packageLock);
    let auditError;
    try {
      assertVendoredUpdaterParity(root, candidate.bytes);
      for (const step of npmAuditPlan(root, cachePath, npm)) {
        run(step.command, step.args, { cwd: root, env });
      }
    } catch (error) {
      auditError = error;
    }

    if (!snapshotMatches(packageLock, candidate)) {
      throw new Error(
        "Concurrent package-lock edit detected after npm update; preserved " +
          packageLock,
        { cause: auditError },
      );
    }
    if (auditError) {
      restoreSnapshot(packageLock, snapshot, candidate);
      throw auditError;
    }
  } finally {
    try {
      if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    } finally {
      releaseUpdateLock();
    }
  }
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  try {
    main();
  } catch (error) {
    console.error(`npm-safe-update: ${error.message}`);
    process.exitCode = 1;
  }
}
