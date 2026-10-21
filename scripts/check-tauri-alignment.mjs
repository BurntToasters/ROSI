#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const options = {
    cargoLock: path.join(root, "src-tauri", "Cargo.lock"),
    npmLock: path.join(root, "package-lock.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === "--cargo-lock" && value) {
      options.cargoLock = path.resolve(value);
      index += 1;
    } else if (argv[index] === "--npm-lock" && value) {
      options.npmLock = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return options;
}

function cargoPackages(text) {
  const packages = [];
  for (const block of text.split("[[package]]").slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    if (name && version) packages.push([name, version]);
  }
  return packages;
}

function npmPackages(text, file) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  const packages = new Map();
  for (const [key, entry] of Object.entries(parsed?.packages ?? {})) {
    const name = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key)?.[1];
    if (name && typeof entry?.version === "string") {
      packages.set(name, entry.version);
    }
  }
  return packages;
}

function minorLine(version) {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  return match ? `${match[1]}.${match[2]}` : null;
}

function findMisalignments(cargoText, npmText, npmFile = "npm lock") {
  const cargo = cargoPackages(cargoText);
  const npm = npmPackages(npmText, npmFile);
  const tauriVersions = cargo.filter(([name]) => name === "tauri");
  if (tauriVersions.length !== 1) {
    throw new Error(
      `Cargo.lock must contain exactly one tauri crate (found ${tauriVersions.length}).`,
    );
  }
  const tauri = tauriVersions[0][1];
  const line = minorLine(tauri);
  const problems = [];

  for (const [name, version] of cargo) {
    if (
      (name === "tauri-runtime" || name === "tauri-runtime-wry") &&
      minorLine(version) !== line
    ) {
      problems.push(`${name} ${version} is not on the line of tauri ${tauri}`);
    }
  }
  for (const name of ["@tauri-apps/api", "@tauri-apps/cli"]) {
    const version = npm.get(name);
    if (version && minorLine(version) !== line) {
      problems.push(`${name} ${version} is not on the line of tauri ${tauri}`);
    }
  }
  for (const [name, version] of cargo) {
    const plugin = /^tauri-plugin-(.+)$/.exec(name)?.[1];
    const jsVersion = plugin ? npm.get(`@tauri-apps/plugin-${plugin}`) : null;
    if (jsVersion && minorLine(jsVersion) !== minorLine(version)) {
      problems.push(
        `@tauri-apps/plugin-${plugin} ${jsVersion} does not match ${name} ${version}`,
      );
    }
  }
  return problems;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const problems = findMisalignments(
    fs.readFileSync(options.cargoLock, "utf8"),
    fs.readFileSync(options.npmLock, "utf8"),
    options.npmLock,
  );
  if (problems.length > 0) {
    process.stderr.write(
      `Tauri packages are misaligned:\n${problems.map((p) => `  - ${p}`).join("\n")}\nMove the whole family together (Cargo.toml pins, Cargo.lock, package.json).\n`,
    );
    process.exit(1);
  }
  process.stdout.write("check-tauri-alignment: ok\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `check-tauri-alignment: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
